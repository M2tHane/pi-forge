// 工作区的依赖准备（F1）：install → codegen。所有会运行命令的工作区（任务 worktree、门禁、stage-qa、合并临时 worktree、隔离工作区）共用。
// 两条路径：
//   readonly：依赖目录按"锁文件内容 + install 命令"哈希缓存，命中时硬链接复制，未命中时 install 后写入缓存。只给不会改依赖的工作区用（硬链接共享同一份文件）。
//   writable：直接运行 install，不用缓存、不复制缓存目录（包管理器自带缓存），worker 改依赖不会污染共享缓存。
// 工作区里没有任何包清单与锁文件（例如 S0 刚开始）、或没有 install 命令时跳过，不报错。失败不抛异常，返回 ok:false 与原因。
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import { git } from '../state/git.ts';
import { worktreesRoot } from './worktree.ts';
import { failureSummary, runShell } from '../verify/verify-runner.ts';

/** 计算缓存键的锁文件名（任意目录层级） */
export const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Gemfile.lock', 'composer.lock'];
/** 包清单文件名（任意目录层级）：有清单或锁文件才需要 install */
export const MANIFESTS = ['package.json', 'pnpm-workspace.yaml', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts'];
const SETUP_TIMEOUT_MS = 15 * 60_000;

export const acctestCacheRoot = (root: string) => path.join(worktreesRoot(root), '.acctest-cache');

/** 锁文件哈希（纯函数）：按路径排序后把路径与内容一起哈希；没有锁文件时为 null，不缓存 */
export function lockHash(files: readonly { path: string; content: Buffer | string }[]): string | null {
  const locks = files.filter((f) => LOCKFILES.includes(path.posix.basename(f.path)) && !f.path.split('/').includes('node_modules'))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!locks.length) return null;
  const h = createHash('sha256');
  for (const f of locks) h.update(f.path).update('\0').update(f.content).update('\0');
  return h.digest('hex').slice(0, 32);
}

/** 缓存键 = 锁文件哈希 + install 命令内容（纯函数）；没有锁文件时为 null */
export function cacheKey(lock: string | null, install: string): string | null {
  return lock ? createHash('sha256').update(lock).update('\0').update(install).digest('hex').slice(0, 32) : null;
}

/** 文件列表里是否有包清单或锁文件（纯函数；node_modules 下的不算） */
export function hasManifest(files: readonly string[]): boolean {
  return files.some((f) => !f.split('/').includes('node_modules') && [...MANIFESTS, ...LOCKFILES].includes(path.posix.basename(f)));
}

/** 硬链接复制目录树（cp -al 的等价做法）：文件硬链接，符号链接照抄，目录新建 */
export function hardlinkTree(src: string, dst: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) { symlinkSync(readlinkSync(src), dst); return; }
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) hardlinkTree(path.join(src, name), path.join(dst, name));
    return;
  }
  linkSync(src, dst);
}

/** 缓存目录只接受工作区内的相对路径 */
export const cacheDirsOf = (config: FlowConfig) => (config.raw.acctest_workspace?.cache ?? []).filter((d) => d && !path.isAbsolute(d) && !d.split(/[\\/]/).includes('..'));

export interface SetupLog { step: string; ok: boolean; detail?: string }
export type WorkspaceMode = 'readonly' | 'writable';
export interface WorkspaceResult {
  ok: boolean;
  skipped?: boolean;
  /** 跳过或失败的原因 */
  reason?: string;
  /** readonly 模式下依赖目录来自缓存 */
  cached?: boolean;
  ms: number;
  log: SetupLog[];
}

/** 工作区里的文件（已跟踪 + 未跟踪未忽略），用来找清单与锁文件；不是 git 仓库时为空 */
function listFiles(dir: string): string[] {
  try { return git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean); } catch { return []; }
}

/**
 * 准备工作区：install（readonly 命中缓存时跳过）→ codegen。失败不抛异常。
 * 没有清单与锁文件、或没有 install 命令时跳过 install 与 codegen（codegen 通常依赖已安装的依赖）。
 */
export async function prepareWorkspace(root: string, config: FlowConfig, dir: string, opts: { mode: WorkspaceMode; timeoutMs?: number }): Promise<WorkspaceResult> {
  const t0 = Date.now();
  const log: SetupLog[] = [];
  const done = (r: Omit<WorkspaceResult, 'ms' | 'log'>): WorkspaceResult => ({ ...r, ms: Date.now() - t0, log });
  const timeout = opts.timeoutMs ?? SETUP_TIMEOUT_MS;
  const install = config.commands['install']?.trim();
  const codegen = config.commands['codegen']?.trim();
  if (!install) return done({ ok: true, skipped: true, reason: '没有定义 install 命令' });
  const files = listFiles(dir);
  if (!hasManifest(files)) return done({ ok: true, skipped: true, reason: '工作区里还没有包清单与锁文件' });

  const dirs = cacheDirsOf(config);
  const key = opts.mode === 'readonly' && dirs.length
    ? cacheKey(lockHash(files.map((f) => ({ path: f, content: existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f)) : '' }))), install)
    : null;
  const cached = key ? path.join(acctestCacheRoot(root), key) : null;
  let hit = false;
  if (cached && existsSync(path.join(cached, '.complete'))) {
    try {
      for (const d of dirs) if (existsSync(path.join(cached, d)) && !existsSync(path.join(dir, d))) hardlinkTree(path.join(cached, d), path.join(dir, d));
      hit = true;
      log.push({ step: 'install', ok: true, detail: `命中缓存 ${key}` });
    } catch {
      // 复制到一半失败：清掉半成品，退回直接 install
      for (const d of dirs) rmSync(path.join(dir, d), { recursive: true, force: true });
    }
  }
  if (!hit) {
    const r = await runShell(install, dir, timeout);
    if (r.exit_code !== 0) {
      log.push({ step: 'install', ok: false });
      return done({ ok: false, reason: `install 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1500)}` });
    }
    log.push({ step: 'install', ok: true });
    if (cached) {
      const tmp = `${cached}.tmp-${process.pid}-${Date.now()}`;
      try {
        const present = dirs.filter((d) => existsSync(path.join(dir, d)));
        if (!present.length) throw new Error('install 没有产生缓存目录，不写缓存');
        for (const d of present) hardlinkTree(path.join(dir, d), path.join(tmp, d));
        mkdirSync(tmp, { recursive: true });
        writeFileSync(path.join(tmp, '.complete'), new Date().toISOString());
        if (!existsSync(cached)) renameSync(tmp, cached);
      } catch { /* 缓存失败不影响本次 */ } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
  }
  if (codegen) {
    const r = await runShell(codegen, dir, timeout);
    if (r.exit_code !== 0) {
      log.push({ step: 'codegen', ok: false });
      return done({ ok: false, ...(hit ? { cached: true } : {}), reason: `codegen 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1500)}` });
    }
    log.push({ step: 'codegen', ok: true });
  }
  return done({ ok: true, ...(hit ? { cached: true } : {}) });
}

/** 准备工作区并记一条事件（type note，data.kind = workspace_prepare），供 /forge-status --metrics 汇总 */
export async function prepareWorkspaceRecorded(
  store: StateStore, root: string, config: FlowConfig, dir: string, mode: WorkspaceMode, who: { flow: string; task?: string; actor: string },
  timeoutMs?: number,
): Promise<WorkspaceResult> {
  const r = await prepareWorkspace(root, config, dir, { mode, ...(timeoutMs ? { timeoutMs } : {}) });
  const what = !r.ok ? `失败（${(r.reason ?? '').split('\n')[0]}）` : r.skipped ? `跳过（${r.reason}）` : r.cached ? '命中缓存' : '已安装';
  try {
    await store.recordEvent({
      flow: who.flow, ...(who.task ? { task: who.task } : {}), actor: who.actor, type: 'note', reason: `工作区准备（${mode}）：${what}，${r.ms}ms`,
      data: { kind: 'workspace_prepare', mode, cached: !!r.cached, skipped: !!r.skipped, ok: r.ok, ms: r.ms },
    });
  } catch { /* 记账失败不影响流程 */ }
  return r;
}
