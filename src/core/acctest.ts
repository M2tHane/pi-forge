// test-author 的隔离工作区（规格第 9.2 节）：不用 git worktree，而是导出允许的路径到一个独立仓库（不共享对象库，读不到实现代码），
// 先 install 再 codegen（依赖目录按锁文件哈希缓存，命中时硬链接复制）；提交时只取本 task 的测试目录，以补丁形式应用到主仓库的 acc 分支。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { TaskFile } from './schemas.ts';
import { git, gitOk } from './git.ts';
import { isSensitive, matchesAny } from './paths.ts';
import { branchExists, headSha, removeWorktree, taskBranch, worktreesRoot } from './worktree.ts';
import { failureSummary, runShell } from './verify-runner.ts';

/** 第 9.2 节第 1 条：总是导出的路径；acctest_workspace.include 追加在后 */
export const ACCTEST_BASE_PATHS = [
  'docs/spec/**', 'docs/contracts/**', 'docs/arch/overview.md', 'AGENTS.md', 'tests/acceptance/**',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb',
];
/** 计算缓存键的锁文件名（任意目录层级） */
export const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Gemfile.lock', 'composer.lock'];
const SETUP_TIMEOUT_MS = 15 * 60_000;
const LIST_TIMEOUT_MS = 5 * 60_000;
const ARCHIVE_CHUNK = 500;

/** 本 task 的测试目录（.at、.at-n 都写进原 impl 的目录） */
export const acctestDirs = (impl: string) => [`tests/acceptance/${impl}/**`, `tests/acceptance/_support/${impl}/**`];
/** 主仓库中保存某个 impl 的验收测试的分支 */
export const accBranch = (flow: string, impl: string) => `flow/${flow}/acc/${impl}`;
export const acctestWorkspacePath = (root: string, run: string) => path.join(worktreesRoot(root), `${run}-at`);
export const acctestCacheRoot = (root: string) => path.join(worktreesRoot(root), '.acctest-cache');

export function exportPatterns(config: FlowConfig): string[] {
  return [...ACCTEST_BASE_PATHS, ...(config.raw.acctest_workspace?.include ?? [])];
}

/** ref 上匹配 patterns 的文件（排除敏感文件） */
export function filesAt(root: string, ref: string, patterns: readonly string[]): string[] {
  return git(root, ['ls-tree', '-r', '--name-only', '-z', ref]).split('\0').filter(Boolean)
    .filter((f) => matchesAny(f, patterns) && !isSensitive(f));
}

/** 用 git archive 把 ref 上的这些文件解压到 dir（保留可执行位） */
export function extractFiles(root: string, ref: string, files: readonly string[], dir: string): void {
  for (let i = 0; i < files.length; i += ARCHIVE_CHUNK) {
    const tar = execFileSync('git', ['archive', '--format=tar', ref, '--', ...files.slice(i, i + ARCHIVE_CHUNK)], { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-f', '-', '-C', dir], { input: tar, maxBuffer: 64 * 1024 * 1024 });
  }
}

export interface ExportLayer { ref: string; files: string[] }

/**
 * 导出基准（第 9.2 节第 1 条）：首个 .at 用集成分支 HEAD；.at-n 叠加 acc 分支上本 task 尚未合并的测试与任务分支追加的契约；
 * impl 已 done 时只用集成分支 HEAD。
 */
export function exportLayers(root: string, config: FlowConfig, flowId: string, integration: string, task: Pick<TaskFile, 'for_task' | 'id'>, implDone: boolean): ExportLayer[] {
  const impl = task.for_task ?? task.id;
  const layers: ExportLayer[] = [{ ref: integration, files: filesAt(root, integration, exportPatterns(config)) }];
  if (implDone) return layers;
  const acc = accBranch(flowId, impl);
  if (branchExists(root, acc)) layers.push({ ref: acc, files: filesAt(root, acc, acctestDirs(impl)) });
  const tb = taskBranch(flowId, impl);
  if (branchExists(root, tb)) {
    const contracts = git(root, ['diff', '--name-only', '--no-renames', '--diff-filter=AM', `${integration}...${tb}`, '--', 'docs/contracts']).split('\n').filter(Boolean);
    if (contracts.length) layers.push({ ref: tb, files: contracts });
  }
  return layers.filter((l) => l.files.length);
}

/** 锁文件哈希（纯函数）：按路径排序后把路径与内容一起哈希；没有锁文件时为 null，不缓存 */
export function lockHash(files: readonly { path: string; content: Buffer | string }[]): string | null {
  const locks = files.filter((f) => LOCKFILES.includes(path.posix.basename(f.path)) && !f.path.split('/').includes('node_modules'))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!locks.length) return null;
  const h = createHash('sha256');
  for (const f of locks) h.update(f.path).update('\0').update(f.content).update('\0');
  return h.digest('hex').slice(0, 32);
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
const cacheDirsOf = (config: FlowConfig) => (config.raw.acctest_workspace?.cache ?? []).filter((d) => d && !path.isAbsolute(d) && !d.split(/[\\/]/).includes('..'));

export interface SetupLog { step: string; ok: boolean; detail?: string }

/** install（命中缓存时跳过）与 codegen；失败时抛错，说明在哪一步 */
async function installAndCodegen(root: string, config: FlowConfig, ws: string, hash: string | null, log: SetupLog[]): Promise<void> {
  const dirs = cacheDirsOf(config);
  const cached = hash ? path.join(acctestCacheRoot(root), hash) : null;
  const install = config.commands['install']?.trim();
  if (cached && dirs.length && existsSync(path.join(cached, '.complete'))) {
    for (const d of dirs) if (existsSync(path.join(cached, d))) hardlinkTree(path.join(cached, d), path.join(ws, d));
    log.push({ step: 'install', ok: true, detail: `命中缓存 ${hash}` });
  } else if (install) {
    const r = await runShell(install, ws, SETUP_TIMEOUT_MS);
    if (r.exit_code !== 0) throw new Error(`隔离工作区的 install 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1500)}`);
    log.push({ step: 'install', ok: true });
    if (cached && dirs.length) {
      const tmp = `${cached}.tmp-${process.pid}-${Date.now()}`;
      try {
        for (const d of dirs) if (existsSync(path.join(ws, d))) hardlinkTree(path.join(ws, d), path.join(tmp, d));
        mkdirSync(tmp, { recursive: true });
        writeFileSync(path.join(tmp, '.complete'), new Date().toISOString());
        if (!existsSync(cached)) renameSync(tmp, cached);
      } catch { /* 缓存失败不影响本次 */ } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
  }
  const codegen = config.commands['codegen']?.trim();
  if (codegen) {
    const r = await runShell(codegen, ws, SETUP_TIMEOUT_MS);
    if (r.exit_code !== 0) throw new Error(`隔离工作区的 codegen 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1500)}`);
    log.push({ step: 'codegen', ok: true });
  }
}

export interface AcctestWorkspace { path: string; branch: string; base_sha: string; log: SetupLog[] }

/** 建立隔离工作区（已存在时复用）；基线提交包含导出的文件与 codegen 生成的代码，依赖目录不提交 */
export async function prepareAcctestWorkspace(root: string, config: FlowConfig, flowId: string, integration: string, task: TaskFile, runId: string, implDone: boolean): Promise<AcctestWorkspace> {
  const impl = task.for_task ?? task.id;
  const branch = accBranch(flowId, impl);
  if (task.worktree && existsSync(path.join(task.worktree, '.git'))) {
    return { path: task.worktree, branch, base_sha: git(task.worktree, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n')[0]!, log: [] };
  }
  const ws = acctestWorkspacePath(root, runId);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  const log: SetupLog[] = [];
  try {
    const layers = exportLayers(root, config, flowId, integration, task, implDone);
    for (const l of layers) extractFiles(root, l.ref, l.files, ws);
    log.push({ step: 'export', ok: true, detail: layers.map((l) => `${l.ref}（${l.files.length} 个文件）`).join(' + ') });
    git(ws, ['init', '-q', '-b', 'main']);
    const exclude = ['node_modules/', ...cacheDirsOf(config).map((d) => `/${d.replace(/\/+$/, '')}/`)];
    writeFileSync(path.join(ws, '.git', 'info', 'exclude'), `${[...new Set(exclude)].join('\n')}\n`);
    const exported = layers.flatMap((l) => l.files).map((f) => ({ path: f, content: existsSync(path.join(ws, f)) ? readFileSync(path.join(ws, f)) : '' }));
    await installAndCodegen(root, config, ws, lockHash(exported), log);
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `[${flowId}/${task.id}] 隔离工作区基线`], { engineIdentity: true });
    return { path: ws, branch, base_sha: headSha(ws), log };
  } catch (e) {
    rmSync(ws, { recursive: true, force: true });
    throw e;
  }
}

/** 扫描测试文件中的 AC 编号（纯函数）：`[REQ-012.AC2]` → 出现的文件 */
export function scanAcCoverage(files: readonly { path: string; content: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) {
    for (const m of f.content.matchAll(/\[(REQ-\d{3,}\.AC\d+)\]/g)) {
      const list = out.get(m[1]!) ?? [];
      if (!list.includes(f.path)) list.push(f.path);
      out.set(m[1]!, list);
    }
  }
  return out;
}

export interface AcctestSubmitCheck { outside: string[]; missing: string[]; unknown: string[] }

/** 提交检查（纯函数）：改动只能在本 task 的测试目录；task 的每条 AC 至少有一个带编号的测试；未知编号只提醒 */
export function checkAcctestSubmit(changed: readonly string[], impl: string, ac: readonly string[], coverage: ReadonlyMap<string, string[]>): AcctestSubmitCheck {
  const dirs = acctestDirs(impl);
  return {
    outside: changed.filter((f) => !matchesAny(f, dirs)),
    missing: ac.filter((a) => !coverage.has(a)),
    unknown: [...coverage.keys()].filter((k) => !ac.includes(k)).sort(),
  };
}

/** 工作区里本 task 测试目录下的文件 */
export function testFilesIn(ws: string, impl: string): { path: string; content: string }[] {
  const dirs = acctestDirs(impl);
  return git(ws, ['ls-files', '-z']).split('\0').filter((f) => f && matchesAny(f, dirs))
    .map((f) => ({ path: f, content: readFileSync(path.join(ws, f), 'utf8') }));
}

/** 把越界改动还原到基线（test-author 的 bash 不能用 git 还原，由程序代为还原） */
export function revertOutside(ws: string, base: string, files: readonly string[]): void {
  for (const f of files) {
    if (gitOk(ws, ['cat-file', '-e', `${base}:${f}`])) git(ws, ['checkout', base, '--', f]);
    else { git(ws, ['rm', '-q', '--cached', '--ignore-unmatch', '--', f]); rmSync(path.join(ws, f), { force: true }); }
  }
  if (!gitOk(ws, ['diff', '--cached', '--quiet']) || git(ws, ['status', '--porcelain']).trim()) {
    git(ws, ['add', '-A']);
    if (!gitOk(ws, ['diff', '--cached', '--quiet'])) git(ws, ['commit', '-q', '--no-verify', '-m', '程序还原越界改动'], { engineIdentity: true });
  }
}

/** acceptance_list -- <impl>：只收集、不执行 */
export async function acceptanceList(config: FlowConfig, ws: string, impl: string, env: Record<string, string>): Promise<{ ok: boolean; output: string } | null> {
  const cmd = config.commands['acceptance_list']?.trim();
  if (!cmd) return null;
  const r = await runShell(`${cmd} -- ${impl}`, ws, LIST_TIMEOUT_MS, env);
  return { ok: r.exit_code === 0, output: r.output };
}

/**
 * 把隔离工作区里本 task 测试目录的改动作为补丁应用到主仓库的 acc 分支（第 9.2 节第 4 条）。
 * 分支不存在、或 impl 已 done（测试单独合并，基准只有集成分支）时从集成分支 HEAD 重建。返回 acc 分支的新提交；没有改动时返回 null。
 */
export function applyToAccBranch(root: string, ws: string, base: string, flowId: string, taskId: string, impl: string, integration: string, implDone: boolean): string | null {
  const dirs = [`tests/acceptance/${impl}`, `tests/acceptance/_support/${impl}`];
  const patch = execFileSync('git', ['diff', '--binary', '--no-renames', base, 'HEAD', '--', ...dirs], { cwd: ws, maxBuffer: 256 * 1024 * 1024 });
  if (!patch.length) return null;
  const branch = accBranch(flowId, impl);
  if (implDone || !branchExists(root, branch)) git(root, ['branch', '-f', branch, integration]);
  const tmp = path.join(worktreesRoot(root), `${flowId}-${taskId}-acc-apply`);
  removeWorktree(root, tmp);
  git(root, ['worktree', 'add', '-q', tmp, branch]);
  try {
    execFileSync('git', ['apply', '--index', '--whitespace=nowarn', '-'], { cwd: tmp, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
    git(tmp, ['commit', '-q', '--no-verify', '-m', `[${flowId}/${taskId}] 验收测试`], { engineIdentity: true });
    return headSha(tmp);
  } finally {
    removeWorktree(root, tmp);
  }
}
