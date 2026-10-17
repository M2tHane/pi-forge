// 运行时资源隔离：每次运行、门禁、合并验证分配一段端口、一个数据库名与一个临时目录，经环境变量注入。
// 登记在 <项目>.worktrees/.resources.json（不在 .forge/ 内），文件锁保护；正常结束时释放，resume 与 doctor --fix 回收残留。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { worktreesRoot } from './worktree.ts';
import { runShell } from './verify-runner.ts';

/** 每次分配的端口数（limits.port_block 的默认值） */
export const PORT_BLOCK = 10;
/** 端口段的取值范围：[start, end)，按 PORT_BLOCK 对齐 */
export const PORT_RANGE = { start: 41000, end: 60000 } as const;
const DB_COMMAND_TIMEOUT_MS = 120_000;

export interface ResourceEntry {
  /** run id；门禁等程序步骤用带前缀的标签（gate-、merge-） */
  run: string;
  /** 分配时的引擎进程；子进程 run 另以 run 记录判断是否结束 */
  pid: number;
  port_base: number;
  /** 端口段长度（limits.port_block） */
  port_count?: number;
  db_name: string;
  tmp: string;
  allocated_at: string;
  /** 分配时调用过 commands.db_create（回收时要 db_drop） */
  db_created?: boolean;
}
export interface ResourceFile { version: 1; entries: ResourceEntry[] }

export const resourcesPath = (root: string) => path.join(worktreesRoot(root), '.resources.json');
export const resourceTmpDir = (root: string, run: string) => path.join(worktreesRoot(root), '.tmp', run);

/** 注入给子进程、服务与命令的四个变量 */
export function resourceEnv(e: Pick<ResourceEntry, 'port_base' | 'db_name' | 'tmp'>): Record<string, string> {
  return { PORT: String(e.port_base), FORGE_PORT_BASE: String(e.port_base), FORGE_DB_NAME: e.db_name, FORGE_TMP: e.tmp };
}

/** 数据库名：forge_<run>，只含小写字母、数字、下划线（Postgres 标识符最长 63） */
export function dbNameFor(run: string): string {
  return `forge_${run.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 63);
}

/** 选一个没有登记占用的端口段起点（纯函数）：从 hint 开始环绕查找，跳过 skip 中的起点；没有时返回 null */
export function pickPortBase(used: readonly { base: number; size: number }[], skip: ReadonlySet<number> = new Set(), hint: number = PORT_RANGE.start,
  range: { start: number; end: number } = PORT_RANGE, block = PORT_BLOCK): number | null {
  const blocks = Math.floor((range.end - range.start) / block);
  const first = Math.max(0, Math.floor((hint - range.start) / block)) % blocks;
  for (let i = 0; i < blocks; i++) {
    const base = range.start + ((first + i) % blocks) * block;
    // 不同运行可能用过不同的段长：按区间判断重叠
    if (!skip.has(base) && !used.some((u) => base < u.base + u.size && u.base < base + block)) return base;
  }
  return null;
}

/** 需要回收的条目（纯函数）：run 已结束，或分配它的进程已不存在；keep 中的 run（本会话仍在运行）不回收 */
export function isStaleResource(e: ResourceEntry, ended: ReadonlySet<string>, alive: (pid: number) => boolean, keep: ReadonlySet<string> = new Set()): boolean {
  if (keep.has(e.run)) return false;
  return ended.has(e.run) || !alive(e.pid);
}
export function staleEntries(entries: readonly ResourceEntry[], isStale: (e: ResourceEntry) => boolean): ResourceEntry[] {
  return entries.filter(isStale);
}

function readFile(root: string): ResourceFile {
  try {
    const j = JSON.parse(readFileSync(resourcesPath(root), 'utf8')) as ResourceFile;
    return Array.isArray(j.entries) ? j : { version: 1, entries: [] };
  } catch { return { version: 1, entries: [] }; }
}
export const listResources = (root: string): ResourceEntry[] => readFile(root).entries;

async function withLock<T>(root: string, fn: (f: ResourceFile) => Promise<T> | T): Promise<T> {
  const dir = worktreesRoot(root);
  mkdirSync(dir, { recursive: true });
  // 目标是不存在的 .resources（锁文件仍是 .resources.lock），不和 shared-env 的锁共用进程内的记账
  const release = await lockfile.lock(path.join(dir, '.resources'), { realpath: false, retries: { retries: 50, minTimeout: 20, maxTimeout: 200 }, stale: 30_000 });
  try {
    const f = readFile(root);
    const out = await fn(f);
    writeFileSync(resourcesPath(root), JSON.stringify(f, null, 2) + '\n');
    return out;
  } finally { await release(); }
}

/** 端口段里的端口当前都能监听（别的程序没占着） */
export async function portBlockFree(base: number, count = PORT_BLOCK): Promise<boolean> {
  for (let p = base; p < base + count; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen({ port: p, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
    });
    if (!ok) return false;
  }
  return true;
}

export interface AllocateOptions {
  pid?: number;
  /** 端口段长度（limits.port_block），默认 10 */
  block?: number;
  /** 项目的 commands.db_create / db_drop（可选） */
  commands?: Record<string, string>;
  /** 测试可替换端口探测 */
  probe?: (base: number) => Promise<boolean>;
  now?: () => Date;
}

/** 为一次运行分配资源；同一 run 已分配时返回原条目 */
export async function allocateResources(root: string, run: string, o: AllocateOptions = {}): Promise<ResourceEntry> {
  const block = o.block ?? PORT_BLOCK;
  const probe = o.probe ?? ((b: number) => portBlockFree(b, block));
  const entry = await withLock(root, async (f) => {
    const existing = f.entries.find((e) => e.run === run);
    if (existing) return existing;
    const skip = new Set<number>();
    const hint = PORT_RANGE.start + Math.floor(Math.random() * ((PORT_RANGE.end - PORT_RANGE.start) / block)) * block;
    for (;;) {
      const base = pickPortBase(f.entries.map((e) => ({ base: e.port_base, size: e.port_count ?? PORT_BLOCK })), skip, hint, PORT_RANGE, block);
      if (base === null) throw new Error(`没有空闲的端口段（${PORT_RANGE.start}–${PORT_RANGE.end}），先用 /forge doctor --fix 回收残留资源`);
      if (await probe(base)) {
        const tmp = resourceTmpDir(root, run);
        mkdirSync(tmp, { recursive: true });
        const e: ResourceEntry = { run, pid: o.pid ?? process.pid, port_base: base, port_count: block, db_name: dbNameFor(run), tmp, allocated_at: (o.now?.() ?? new Date()).toISOString() };
        f.entries.push(e);
        return e;
      }
      skip.add(base);
    }
  });
  const create = o.commands?.['db_create']?.trim();
  if (create && !entry.db_created) {
    const r = await runShell(create, root, DB_COMMAND_TIMEOUT_MS, resourceEnv(entry));
    if (r.exit_code !== 0) {
      await releaseResources(root, run);
      throw new Error(`commands.db_create 失败（${entry.db_name}，退出码 ${r.exit_code}）：${r.output.slice(-500)}`);
    }
    await withLock(root, (f) => { const e = f.entries.find((x) => x.run === run); if (e) e.db_created = true; });
    entry.db_created = true;
  }
  return entry;
}

/** 释放一次运行的资源：db_drop（分配时建过库）、删除临时目录、去掉登记。返回被释放的条目 */
export async function releaseResources(root: string, run: string, commands?: Record<string, string>): Promise<ResourceEntry | null> {
  const entry = await withLock(root, (f) => {
    const i = f.entries.findIndex((e) => e.run === run);
    return i < 0 ? null : f.entries.splice(i, 1)[0]!;
  });
  if (!entry) return null;
  await dropAndClean(root, entry, commands);
  return entry;
}

async function dropAndClean(root: string, e: ResourceEntry, commands?: Record<string, string>): Promise<void> {
  const drop = commands?.['db_drop']?.trim();
  if (drop && e.db_created) await runShell(drop, root, DB_COMMAND_TIMEOUT_MS, resourceEnv(e)).catch(() => {});
  rmSync(e.tmp, { recursive: true, force: true });
}

/** 回收残留条目（resume、doctor --fix）：返回被回收的 run */
export async function reclaimResources(root: string, isStale: (e: ResourceEntry) => boolean, commands?: Record<string, string>): Promise<string[]> {
  if (!existsSync(resourcesPath(root))) return [];
  const removed = await withLock(root, (f) => {
    const stale = staleEntries(f.entries, isStale);
    f.entries = f.entries.filter((e) => !stale.includes(e));
    return stale;
  });
  for (const e of removed) await dropAndClean(root, e, commands);
  return removed.map((e) => e.run);
}

/** 分配选项来自配置：commands（db_create、db_drop）与 limits.port_block */
export const resourceOptions = (config: { commands: Record<string, string>; limits: { port_block?: number | undefined } }): AllocateOptions =>
  ({ commands: config.commands, ...(config.limits.port_block ? { block: config.limits.port_block } : {}) });

/** 带资源执行一个程序步骤（门禁、合并验证），结束后释放 */
export async function withResources<T>(root: string, label: string, o: AllocateOptions, fn: (env: Record<string, string>, e: ResourceEntry) => Promise<T>): Promise<T> {
  const e = await allocateResources(root, label, o);
  try { return await fn(resourceEnv(e), e); } finally { await releaseResources(root, label, o.commands); }
}
