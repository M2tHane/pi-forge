// 共享构建环境：S0 结束后一次性装好依赖、起好数据库服务器等，之后所有 worktree 链接同一份依赖目录，不再各自 install。
//  - 环境目录 <项目>.worktrees/.env-shared/：集成分支 HEAD 的导出树（不是 git worktree，doctor 不会当孤儿清理）+ 安装好的依赖目录；
//    元数据 <项目>.worktrees/.env-shared.json（与 .resources.json 同一做法：不在 .forge/ 内，程序写）；独占锁 .env-shared.lock。
//  - worktree 准备（workspace.ts）：依赖清单与共享环境相同 → 符号链接；纯追加（只限根目录 package.json）→ 先在锁内装进共享环境再链接；
//    有改动（版本变化、overrides、其他生态的清单）→ 私有副本（照旧在 worktree 里 install）。
//  - 共享环境存在之前（S0 期间）完全沿用原来的做法。
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { FlowConfig } from '../state/config.ts';
import { git } from '../state/git.ts';
import {
  LOCKFILES, MANIFESTS, addableToShared, classifyDeps, defaultAddCommand, depNameOfKey, depSnapshot, depSpecProblem, hasManifest, listWorkspaceFiles, lockHash,
  type DepSnapshot,
} from './dep-files.ts';
import { allocateResources, releaseResources, resourceEnv, resourceOptions, type AllocateOptions, type ResourceEntry } from './resources.ts';
import { ensureLocalExcludes, worktreesRoot } from './worktree.ts';
import { failureSummary, runShell } from './verify-runner.ts';

const ENV_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_SHARED_DEPS = ['node_modules'];

export const sharedEnvDir = (root: string) => path.join(worktreesRoot(root), '.env-shared');
export const sharedEnvMetaPath = (root: string) => path.join(worktreesRoot(root), '.env-shared.json');

export interface SharedEnvMeta {
  version: 1;
  created_at: string;
  updated_at: string;
  /** 最近一次对齐的集成分支提交 */
  ref: string;
  /** 最近一次对齐的标记（流程:阶段），同一阶段不重复检查 */
  synced: string;
  lock_hash: string | null;
  install: string;
  /** 链接进 worktree 的依赖目录 */
  deps: string[];
  /** 共享环境当前的依赖快照（dep-files.ts） */
  snapshot: DepSnapshot;
  /** env_up 的结果：ok 已运行一次，skipped 没有配置 */
  env_up: 'ok' | 'skipped';
  /** 任务追加进共享环境的依赖（记账） */
  added: { name: string; spec: string; by: string; at: string }[];
}

export const sharedEnvEnabled = (config: FlowConfig) => config.sharedEnv?.enabled !== false;
/** 依赖目录：shared_env.deps，默认 node_modules；只接受工作区内的相对路径 */
export function sharedDepsDirs(config: FlowConfig): string[] {
  const raw: string[] = config.sharedEnv?.deps ?? DEFAULT_SHARED_DEPS;
  const ok = raw.filter((d) => d && !path.isAbsolute(d) && !d.split(/[\\/]/).includes('..'));
  return ok.length ? ok : DEFAULT_SHARED_DEPS;
}

export function readSharedEnv(root: string): SharedEnvMeta | null {
  try {
    const m = JSON.parse(readFileSync(sharedEnvMetaPath(root), 'utf8')) as SharedEnvMeta;
    return m.version === 1 && existsSync(sharedEnvDir(root)) ? m : null;
  } catch { return null; }
}
function writeMeta(root: string, m: SharedEnvMeta): void {
  const p = sharedEnvMetaPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  renameSync(tmp, p);
}

/** 独占锁：两次安装永远不会同时进行（跨进程，proper-lockfile；安装可能很久，锁文件会持续续期） */
export async function withSharedEnvLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = worktreesRoot(root);
  mkdirSync(dir, { recursive: true });
  const release = await lockfile.lock(dir, { lockfilePath: path.join(dir, '.env-shared.lock'), retries: { retries: 1800, factor: 1, minTimeout: 500, maxTimeout: 500 }, stale: 60_000 });
  try { return await fn(); } finally { await release().catch(() => {}); }
}

/** 目录里的包清单与锁文件（不是 git 仓库时的遍历；跳过 node_modules、.git） */
function manifestFilesIn(dir: string, rel = '', depth = 0): { path: string; content: Buffer }[] {
  const out: { path: string; content: Buffer }[] = [];
  if (depth > 6) return out;
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...manifestFilesIn(dir, r, depth + 1));
    else if (e.isFile() && [...MANIFESTS, ...LOCKFILES].includes(e.name)) out.push({ path: r, content: readFileSync(path.join(dir, r)) });
  }
  return out;
}
/** worktree 里的包清单与锁文件（已跟踪 + 未跟踪未忽略） */
export function manifestFilesOf(wt: string, files = listWorkspaceFiles(wt)): { path: string; content: Buffer }[] {
  return files.filter((f) => !f.split('/').includes('node_modules') && [...MANIFESTS, ...LOCKFILES].includes(path.posix.basename(f)) && existsSync(path.join(wt, f)))
    .map((f) => ({ path: f, content: readFileSync(path.join(wt, f)) }));
}

export type SharedDecision = { action: 'link' } | { action: 'install-shared'; added: string[] } | { action: 'private'; reason: string };
/** worktree 的依赖清单相对共享环境该怎么处理（纯函数） */
export function decideSharedDeps(shared: DepSnapshot, wt: DepSnapshot): SharedDecision {
  const c = classifyDeps(shared, wt);
  if (c.kind === 'same') return { action: 'link' };
  if (c.kind === 'additive' && addableToShared(c.added)) return { action: 'install-shared', added: c.added };
  if (c.kind === 'additive') return { action: 'private', reason: `追加的依赖不在根目录 package.json（${c.added.slice(0, 3).join('、')}），程序不自动装进共享环境` };
  return { action: 'private', reason: `依赖有改动（${c.changed.slice(0, 3).join('、')}${c.changed.length > 3 ? ' 等' : ''}）` };
}

const symlinkTarget = (p: string): string | null => {
  try { return lstatSync(p).isSymbolicLink() ? realpathSync(p) : null; } catch { return null; }
};
const within = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

/** worktree 里哪些依赖目录是指向共享环境的符号链接 */
export function linkedDeps(root: string, config: FlowConfig, wt: string): string[] {
  let shared: string;
  try { shared = realpathSync(sharedEnvDir(root)); } catch { return []; }
  return sharedDepsDirs(config).filter((d) => { const t = symlinkTarget(path.join(wt, d)); return !!t && within(shared, t); });
}

/** 把共享环境的依赖目录链接进 worktree；已有真实目录（私有副本或提交进仓库的）不动。返回链接了的目录 */
export function linkSharedDeps(root: string, config: FlowConfig, wt: string): string[] {
  const dirs = sharedDepsDirs(config);
  const linked: string[] = [];
  for (const d of dirs) {
    const src = path.join(sharedEnvDir(root), d);
    const dst = path.join(wt, d);
    if (!existsSync(src)) continue;
    if (symlinkTarget(dst) !== null) rmSync(dst, { force: true });
    else if (existsSync(dst)) continue;
    mkdirSync(path.dirname(dst), { recursive: true });
    symlinkSync(src, dst, 'dir');
    linked.push(d);
  }
  // 符号链接不会被 `node_modules/` 之类只匹配目录的忽略规则忽略，写进本地 exclude，避免进入任务快照
  if (linked.length) try { ensureLocalExcludes(root, dirs.map((d) => `/${d}`)); } catch { /* 写不了 exclude 不影响链接 */ }
  return linked;
}
/** 去掉 worktree 里指向共享环境的链接（改成私有副本之前） */
export function unlinkSharedDeps(root: string, config: FlowConfig, wt: string): string[] {
  const l = linkedDeps(root, config, wt);
  for (const d of l) rmSync(path.join(wt, d), { force: true });
  return l;
}

/** 在锁内把一批依赖装进共享环境；已经在共享快照里且说明相同的跳过。调用方不需要持锁 */
export async function installIntoShared(root: string, config: FlowConfig, deps: { name: string; spec?: string; dev?: boolean }[], by: string, timeoutMs = ENV_TIMEOUT_MS): Promise<{ ok: boolean; reason?: string; installed: string[] }> {
  return withSharedEnvLock(root, async () => {
    const meta = readSharedEnv(root);
    if (!meta) return { ok: false, reason: '共享环境尚未建立', installed: [] };
    const dir = sharedEnvDir(root);
    const installed: string[] = [];
    for (const d of deps) {
      const bad = depSpecProblem(d.name, d.spec);
      if (bad) return { ok: false, reason: bad, installed };
      if (meta.snapshot[`npm:.:${d.name}`] !== undefined && (d.spec === undefined || meta.snapshot[`npm:.:${d.name}`] === d.spec)) continue;
      const custom = config.commands['add_dep']?.trim();
      const names = readdirSync(dir);
      const cmd = custom || defaultAddCommand(names, !!d.dev);
      if (!cmd) return { ok: false, reason: '共享环境里没有可识别的包清单，无法推断追加依赖的命令（可在 commands.add_dep 里配置，依赖说明从 $FORGE_DEP 取）', installed };
      const dep = d.spec ? `${d.name}@${d.spec}` : d.name;
      const r = await runShell(cmd, dir, timeoutMs, { FORGE_DEP: dep, FORGE_DEP_NAME: d.name, FORGE_DEP_VERSION: d.spec ?? '', FORGE_DEP_DEV: d.dev ? '1' : '', FORGE_SHARED_ENV: dir });
      if (r.exit_code !== 0) return { ok: false, reason: `追加依赖 ${dep} 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1500)}`, installed };
      installed.push(dep);
      const files = manifestFilesIn(dir);
      meta.snapshot = depSnapshot(files);
      meta.lock_hash = lockHash(files);
      meta.added.push({ name: d.name, spec: meta.snapshot[`npm:.:${d.name}`] ?? d.spec ?? '', by, at: new Date().toISOString() });
      meta.updated_at = new Date().toISOString();
      writeMeta(root, meta);
    }
    return { ok: true, installed };
  });
}

export interface SyncResult { status: 'built' | 'refreshed' | 'unchanged' | 'skipped' | 'failed'; reason?: string; ms: number }

/**
 * 把共享环境对齐到集成分支的 ref：不存在就建（导出树 → install → env_up），存在但依赖清单有差别（合入的任务追加或改了依赖）就刷新（重新导出、再 install）。
 * 引擎在每个 S 阶段（S0 之后）开始时调用一次——此时上一阶段的任务都已结束，没有 worktree 在用旧的依赖目录。失败不抛异常；失败后删除元数据，worktree 回到各自 install。
 */
export async function syncSharedEnv(root: string, config: FlowConfig, ref: string, tag: string, o: { timeoutMs?: number } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const done = (status: SyncResult['status'], reason?: string): SyncResult => ({ status, ...(reason ? { reason } : {}), ms: Date.now() - t0 });
  if (!sharedEnvEnabled(config)) return done('skipped', 'shared_env.enabled 为 false');
  const install = config.commands['install']?.trim();
  if (!install) return done('skipped', '没有定义 install 命令');
  const sha = git(root, ['rev-parse', ref]).trim();
  const names = git(root, ['ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean);
  if (!hasManifest(names)) return done('skipped', '集成分支上还没有包清单与锁文件');
  const files = names.filter((f) => !f.split('/').includes('node_modules') && [...MANIFESTS, ...LOCKFILES].includes(path.posix.basename(f)))
    .map((f) => ({ path: f, content: git(root, ['show', `${sha}:${f}`]) }));
  const snap = depSnapshot(files);
  return withSharedEnvLock(root, async () => {
    const cur = readSharedEnv(root);
    if (cur && classifyDeps(cur.snapshot, snap).kind === 'same') {
      writeMeta(root, { ...cur, synced: tag, ref: sha, updated_at: new Date().toISOString() });
      return done('unchanged');
    }
    const dir = sharedEnvDir(root);
    mkdirSync(dir, { recursive: true });
    if (cur) rmSync(sharedEnvMetaPath(root), { force: true }); // 刷新期间 worktree 不要链接
    try {
      execFileSync('sh', ['-c', 'git -C "$0" archive --format=tar "$1" | tar -x -C "$2"', root, sha, dir], { stdio: 'pipe' });
    } catch (e) { return done('failed', `导出集成分支失败：${(e as Error).message.split('\n')[0]}`); }
    const timeout = o.timeoutMs ?? ENV_TIMEOUT_MS;
    const env = { FORGE_SHARED_ENV: dir };
    const r = await runShell(install, dir, timeout, env);
    if (r.exit_code !== 0) return done('failed', `共享环境 install 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1500)}`);
    const up = config.commands['env_up']?.trim();
    if (up && !cur) {
      const u = await runShell(up, dir, timeout, env);
      if (u.exit_code !== 0) return done('failed', `env_up 失败（退出码 ${u.exit_code}）：\n${failureSummary(u.output, 1500)}`);
    }
    const now = new Date().toISOString();
    writeMeta(root, {
      version: 1, created_at: cur?.created_at ?? now, updated_at: now, ref: sha, synced: tag, lock_hash: lockHash(files), install,
      deps: sharedDepsDirs(config), snapshot: snap, env_up: up || cur?.env_up === 'ok' ? 'ok' : 'skipped', added: cur?.added ?? [],
    });
    return done(cur ? 'refreshed' : 'built');
  });
}

/** 停掉共享环境：运行 env_down（可选），删除元数据与目录。给 doctor --fix 与测试用 */
export async function removeSharedEnv(root: string, config: FlowConfig): Promise<void> {
  const down = config.commands['env_down']?.trim();
  const dir = sharedEnvDir(root);
  if (down && existsSync(dir)) await runShell(down, dir, 120_000, { FORGE_SHARED_ENV: dir }).catch(() => {});
  rmSync(sharedEnvMetaPath(root), { force: true });
  rmSync(dir, { recursive: true, force: true });
}

function setDepInPackageJson(file: string, name: string, spec: string, section: string): void {
  const text = readFileSync(file, 'utf8');
  const j = JSON.parse(text) as Record<string, Record<string, string> | unknown>;
  const indent = /^\{\n( +|\t)"/.exec(text)?.[1] ?? 2;
  const m = (j[section] && typeof j[section] === 'object' ? j[section] : {}) as Record<string, string>;
  m[name] = spec;
  j[section] = Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify(j, null, indent) + (text.endsWith('\n') ? '\n' : ''));
}
function sectionOf(pkgJson: string, name: string): string | null {
  try {
    const j = JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, Record<string, string> | undefined>;
    return (['dependencies', 'devDependencies', 'optionalDependencies'] as const).find((s) => j[s] && name in j[s]!) ?? null;
  } catch { return null; }
}

/**
 * worker 的 forge_add_dependency：在锁内装进共享环境，再把结果同步回 worker 的 worktree（根目录 package.json 里这一项、根目录的锁文件），
 * 这样改动会随任务提交。worktree 必须链接着共享环境（私有副本的任务直接用 install）。失败抛出带说明的 Error。
 */
export async function addDependencyForWorktree(root: string, config: FlowConfig, wt: string, p: { name: string; version?: string; dev?: boolean }, by: string): Promise<string> {
  if (!sharedEnvEnabled(config) || !readSharedEnv(root)) throw new Error('共享环境还没有建立（S0 结束后才有），请直接在工作区里用包管理器安装。');
  if (!linkedDeps(root, config, wt).length) throw new Error('本任务使用私有依赖副本（或依赖目录不是共享链接），请直接在工作区里用包管理器安装，不必使用这个工具。');
  const bad = depSpecProblem(p.name, p.version);
  if (bad) throw new Error(bad);
  const r = await installIntoShared(root, config, [{ name: p.name, ...(p.version ? { spec: p.version } : {}), ...(p.dev ? { dev: true } : {}) }], by);
  if (!r.ok) throw new Error(r.reason ?? '追加依赖失败');
  const dir = sharedEnvDir(root);
  const notes: string[] = [];
  const sharedPkg = path.join(dir, 'package.json');
  const wtPkg = path.join(wt, 'package.json');
  if (existsSync(sharedPkg) && existsSync(wtPkg)) {
    const section = sectionOf(sharedPkg, p.name);
    const spec = (JSON.parse(readFileSync(sharedPkg, 'utf8')) as Record<string, Record<string, string> | undefined>)[section ?? 'dependencies']?.[p.name];
    if (section && spec) { setDepInPackageJson(wtPkg, p.name, spec, section); notes.push(`package.json 的 ${section} 已加上 ${p.name}@${spec}`); }
    for (const l of LOCKFILES) if (existsSync(path.join(dir, l)) && existsSync(path.join(wt, l))) { copyFileSync(path.join(dir, l), path.join(wt, l)); notes.push(`${l} 已同步（包含共享环境里别的任务追加过的依赖）`); }
  } else notes.push('没有根目录 package.json，请自己在工作区的依赖清单里补上这一项');
  return `${r.installed.length ? `已装进共享环境：${r.installed.join('、')}` : `${p.name} 共享环境里已经有了`}。${notes.join('；')}。依赖目录是共享链接，不要在工作区里再运行 install/add。`;
}

/** /forge doctor 与状态详情里的共享环境状态行 */
export function shareStatusLines(root: string, config: FlowConfig): string[] {
  const m = readSharedEnv(root);
  if (!sharedEnvEnabled(config)) return ['共享构建环境：已关闭（shared_env.enabled: false）'];
  if (!m) return ['共享构建环境：尚未建立（S0 结束后建立）'];
  return [
    `共享构建环境：${sharedEnvDir(root)}（依赖目录 ${m.deps.join('、')}；对齐 ${m.ref.slice(0, 8)}；建于 ${m.created_at}；env_up ${m.env_up === 'ok' ? '已运行' : '未配置'}）`,
    ...(m.added.length ? [`  任务追加的依赖：${m.added.slice(-8).map((a) => `${a.name}@${a.spec}（${a.by}）`).join('、')}`] : []),
  ];
}

/**
 * 给评审、测试运行器用：带"共享环境 + 本次专用端口段 + 本次专用数据库"执行 fn，结束后释放（删库、删临时目录）。
 * label 要唯一（如 `rv-<flow>-<task>`）；没有配置 commands.db_create 时不建库。env 里除端口、库名、临时目录（FORGE_PORT_BASE、PORT、FORGE_DB_NAME、FORGE_TMP）外，
 * 有共享环境时还带 FORGE_SHARED_ENV。依赖目录由 prepareWorkspace 在建 worktree 时链接，这里不管。
 */
export async function withSharedEnv<T>(root: string, config: FlowConfig, label: string, fn: (env: Record<string, string>, e: ResourceEntry) => Promise<T>, o: AllocateOptions = {}): Promise<T> {
  const opts = { ...resourceOptions(config), ...o };
  const e = await allocateResources(root, label, opts);
  try {
    const shared = readSharedEnv(root);
    return await fn({ ...resourceEnv(e), ...(shared ? { FORGE_SHARED_ENV: sharedEnvDir(root) } : {}) }, e);
  } finally { await releaseResources(root, label, opts.commands); }
}
