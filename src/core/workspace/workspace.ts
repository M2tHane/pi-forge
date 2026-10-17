// 工作区的依赖准备（F1）：install → codegen。所有会运行命令的工作区（任务 worktree、门禁、stage-qa、合并临时 worktree、隔离工作区）共用。
// 两条路径：
//   readonly：依赖目录按"锁文件内容 + install 命令"哈希缓存，命中时硬链接复制，未命中时 install 后写入缓存。只给不会改依赖的工作区用（硬链接共享同一份文件）。
//   writable：直接运行 install，不用缓存、不复制缓存目录（包管理器自带缓存），worker 改依赖不会污染共享缓存。
// 工作区里没有任何包清单与锁文件（例如 S0 刚开始）、或没有 install 命令时跳过，不报错。失败不抛异常，返回 ok:false 与原因。
import { createHash } from 'node:crypto';
import { depNameOfKey, depSnapshot, hasManifest, listWorkspaceFiles as listFiles, lockHash } from './dep-files.ts';
import { decideSharedDeps, installIntoShared, linkSharedDeps, manifestFilesOf, readSharedEnv, sharedEnvEnabled, unlinkSharedDeps } from './shared-env.ts';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import { worktreesRoot } from './worktree.ts';
import { failureSummary, runShell } from './verify-runner.ts';

export { LOCKFILES, MANIFESTS, lockHash, hasManifest } from './dep-files.ts';

const SETUP_TIMEOUT_MS = 15 * 60_000;

export const depsCacheRoot = (root: string) => path.join(worktreesRoot(root), '.deps-cache');

/** 缓存键 = 锁文件哈希 + install 命令内容（纯函数）；没有锁文件时为 null */
export function cacheKey(lock: string | null, install: string): string | null {
  return lock ? createHash('sha256').update(lock).update('\0').update(install).digest('hex').slice(0, 32) : null;
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

/** 只读工作区（stage-qa）的依赖缓存目录：shared_env.deps 显式配置时才启用；只接受工作区内的相对路径 */
export const cacheDirsOf = (config: FlowConfig): string[] => (config.sharedEnv?.deps ?? []).filter((d: string) => d && !path.isAbsolute(d) && !d.split(/[\\/]/).includes('..'));

export interface SetupLog { step: string; ok: boolean; detail?: string }
export type WorkspaceMode = 'readonly' | 'writable';
export interface WorkspaceResult {
  ok: boolean;
  skipped?: boolean;
  /** 跳过或失败的原因 */
  reason?: string;
  /** readonly 模式下依赖目录来自缓存 */
  cached?: boolean;
  /** 共享构建环境：linked 依赖目录链接自共享环境；added 先把追加的依赖装进共享环境再链接；private 依赖有改动，使用私有副本 */
  shared?: 'linked' | 'added' | 'private';
  ms: number;
  log: SetupLog[];
}

/**
 * 准备工作区：install（readonly 命中缓存时跳过）。失败不抛异常。没有清单与锁文件、或没有 install 命令时跳过。
 * 程序只跑 install；codegen 之类是 commands.yaml 里给 agent 参考的命令，需要时由 worker 自己运行。
 */
export async function prepareWorkspace(root: string, config: FlowConfig, dir: string, opts: { mode: WorkspaceMode; timeoutMs?: number; /** 强制私有依赖副本（worker 改了已有依赖，forge_private_deps） */ forcePrivate?: boolean }): Promise<WorkspaceResult> {
  const t0 = Date.now();
  const log: SetupLog[] = [];
  const done = (r: Omit<WorkspaceResult, 'ms' | 'log'>): WorkspaceResult => ({ ...r, ms: Date.now() - t0, log });
  const timeout = opts.timeoutMs ?? SETUP_TIMEOUT_MS;
  const install = config.commands['install']?.trim();
  if (!install) return done({ ok: true, skipped: true, reason: '没有定义 install 命令' });
  const files = listFiles(dir);
  if (!hasManifest(files)) return done({ ok: true, skipped: true, reason: '工作区里还没有包清单与锁文件' });

  // 共享构建环境：存在时，依赖清单相同的 worktree 直接链接共享依赖目录；纯追加的先装进共享环境；有改动的退回私有副本
  let shared: WorkspaceResult['shared'];
  const env = sharedEnvEnabled(config) && !opts.forcePrivate ? readSharedEnv(root) : null;
  if (env) {
    let dec = decideSharedDeps(env.snapshot, depSnapshot(manifestFilesOf(dir, files)));
    if (dec.action === 'install-shared') {
      const snap = depSnapshot(manifestFilesOf(dir, files));
      const r = await installIntoShared(root, config, dec.added.map((k) => ({ name: depNameOfKey(k), spec: snap[k]! })), `worktree ${path.basename(dir)}`, timeout);
      if (r.ok) { dec = { action: 'link' }; shared = 'added'; log.push({ step: 'install', ok: true, detail: `追加的依赖已装进共享环境：${r.installed.join('、')}` }); }
      else dec = { action: 'private', reason: `装进共享环境失败，退回私有副本：${(r.reason ?? '').split('\n')[0]}` };
    }
    if (dec.action === 'link') {
      const linked = linkSharedDeps(root, config, dir);
      if (linked.length) {
        log.push({ step: 'install', ok: true, detail: `链接共享环境（${linked.join('、')}）` });
        return done({ ok: true, cached: true, shared: shared ?? 'linked' });
      }
    } else if (dec.action === 'private') log.push({ step: 'install', ok: true, detail: `私有依赖副本：${dec.reason}` });
    shared = 'private';
  }
  if (env || opts.forcePrivate) unlinkSharedDeps(root, config, dir);

  const dirs = cacheDirsOf(config);
  const key = opts.mode === 'readonly' && dirs.length
    ? cacheKey(lockHash(files.map((f) => ({ path: f, content: existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f)) : '' }))), install)
    : null;
  const cached = key ? path.join(depsCacheRoot(root), key) : null;
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
  return done({ ok: true, ...(hit ? { cached: true } : {}), ...(shared ? { shared } : {}) });
}

/** 准备工作区并记一条事件（type note，data.kind = workspace_prepare），供 /forge-status --metrics 汇总 */
export async function prepareWorkspaceRecorded(
  store: StateStore, root: string, config: FlowConfig, dir: string, mode: WorkspaceMode, who: { flow: string; task?: string; actor: string },
  timeoutMs?: number, forcePrivate?: boolean,
): Promise<WorkspaceResult> {
  const r = await prepareWorkspace(root, config, dir, { mode, ...(timeoutMs ? { timeoutMs } : {}), ...(forcePrivate ? { forcePrivate } : {}) });
  const what = !r.ok ? `失败（${(r.reason ?? '').split('\n')[0]}）` : r.skipped ? `跳过（${r.reason}）` : r.shared === 'linked' ? '链接共享环境' : r.shared === 'added' ? '追加依赖后链接共享环境' : r.shared === 'private' ? '私有依赖副本' : r.cached ? '命中缓存' : '已安装';
  try {
    await store.recordEvent({
      flow: who.flow, ...(who.task ? { task: who.task } : {}), actor: who.actor, type: 'note', reason: `工作区准备（${mode}）：${what}，${r.ms}ms`,
      data: { kind: 'workspace_prepare', mode, cached: !!r.cached, ...(r.shared ? { shared: r.shared } : {}), skipped: !!r.skipped, ok: r.ok, ms: r.ms },
    });
  } catch { /* 记账失败不影响流程 */ }
  return r;
}
