// 来源：pi-flow src/core/requirements.ts @ 31f3f15
// 需求（D0）：用户带了 PRD 时主会话做就绪检查（只就缺口提问），没有时和用户逐轮讨论；结论经 forge_requirements 提交。
// 程序把标准化的需求说明（验收条目带 AC 编号）提交到集成分支（不经过工作区），闸门检查通过后直接进入规划（第六轮不再单独审批需求）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StateStore } from './state-store.ts';
import { git, gitOk } from './git.ts';
import { requirementsFile } from '../modes/plan.ts';

export const REQUIREMENTS_STAGE = 'D0';
export const REQUIREMENTS_MAX = 60_000;

export class RequirementsError extends Error {}

/** 把一个文件直接提交到分支上（独立索引，update-ref 带旧值）；内容没变时不提交，返回 null */
export function commitFileToBranch(root: string, branch: string, rel: string, content: string, message: string): string | null {
  return commitFilesToBranch(root, branch, [{ rel, content }], message);
}

/** 一次把多个文件提交到分支上（内容可以是二进制）；全部没变时不提交，返回 null */
export function commitFilesToBranch(root: string, branch: string, files: readonly { rel: string; content: string | Buffer }[], message: string): string | null {
  const ref = `refs/heads/${branch}`;
  const parent = git(root, ['rev-parse', ref]).trim();
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-req-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    git(root, ['read-tree', parent], { env });
    let changed = false;
    files.forEach((f, i) => {
      const file = path.join(dir, `content-${i}`);
      writeFileSync(file, f.content);
      const blob = git(root, ['hash-object', '-w', '--path', f.rel, file]).trim();
      if (gitOk(root, ['cat-file', '-e', `${parent}:${f.rel}`]) && git(root, ['rev-parse', `${parent}:${f.rel}`]).trim() === blob) return;
      changed = true;
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${f.rel}`], { env });
    });
    if (!changed) return null;
    const tree = git(root, ['write-tree'], { env }).trim();
    const sha = git(root, ['commit-tree', tree, '-p', parent, '-m', message], { engineIdentity: true }).trim();
    git(root, ['update-ref', ref, sha, parent]);
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 提交需求说明：写到集成分支；之后由引擎执行阶段闸门，通过即进入规划 */
export async function submitRequirements(root: string, store: StateStore, flowId: string, content: string, actor: string): Promise<{ path: string; sha: string | null }> {
  const flow = store.readFlow(flowId);
  if (flow.mode === 'fix') throw new RequirementsError('修复流程没有需求讨论阶段。');
  if (flow.stage !== REQUIREMENTS_STAGE) throw new RequirementsError(`当前是阶段 ${flow.stage}，需求讨论（${REQUIREMENTS_STAGE}）已结束；要改需求请用户 /forge-reject 或用 forge_replan。`);
  if (flow.stage_status !== 'active') throw new RequirementsError(flow.stage_status === 'awaiting_human' ? '需求说明已提交，等待用户审批（/forge-approve 或 /forge-reject "<意见>"）。' : `阶段 ${flow.stage} 当前是 ${flow.stage_status}，不能提交需求说明。`);
  const text = content.trim();
  if (!text) throw new RequirementsError('需求说明不能为空。');
  if (text.length > REQUIREMENTS_MAX) throw new RequirementsError(`需求说明超过 ${REQUIREMENTS_MAX} 字，请精简。`);
  const rel = flow.requirements?.path ?? requirementsFile(flow.mode, flow.title);
  const sha = commitFileToBranch(root, flow.integration_branch, rel, `${text}\n`, `pi-forge: ${flowId} 需求说明${(flow.requirements?.rounds ?? 0) ? `（第 ${flow.requirements!.rounds + 1} 版）` : ''}`);
  await store.setRequirements(flowId, { submitted: true, rounds: flow.requirements?.rounds ?? 0, path: rel }, actor, `提交需求说明 ${rel}`);
  return { path: rel, sha };
}

/** 用户打回或闸门未通过：回到讨论，带上意见 */
export async function reopenRequirements(store: StateStore, flowId: string, feedback: string, actor: string): Promise<void> {
  const r = store.readFlow(flowId).requirements;
  await store.setRequirements(flowId, { submitted: false, rounds: (r?.rounds ?? 0) + 1, ...(r?.path ? { path: r.path } : {}), feedback }, actor, '需求说明需要修改');
}

/** 需求说明的闸门检查：在集成分支上、验收条目带 AC 编号且不重复；接收的 PRD 也在 */
export function requirementsProblems(root: string, flow: { integration_branch: string; requirements?: { path?: string }; intake?: { prd: string } }): string[] {
  const rel = flow.requirements?.path;
  if (!rel) return ['还没有提交需求说明（主会话用 forge_requirements 提交）'];
  const branch = flow.integration_branch;
  if (!gitOk(root, ['cat-file', '-e', `${branch}:${rel}`])) return [`集成分支上没有需求说明 ${rel}`];
  const out: string[] = [];
  if (flow.intake && !gitOk(root, ['cat-file', '-e', `${branch}:${flow.intake.prd}`])) out.push(`集成分支上没有接收的 PRD ${flow.intake.prd}`);
  const ids = [...git(root, ['show', `${branch}:${rel}`]).matchAll(/\bAC-(\d+)\b/g)].map((m) => `AC-${m[1]}`);
  if (!ids.length) out.push('需求说明里的验收条目要带编号 AC-01、AC-02…（独立验收与模块分配都靠它）');
  return out;
}

/** 需求说明里的 AC 编号（按出现顺序去重） */
export function acceptanceIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bAC-(\d+)\b/g)].map((m) => `AC-${m[1]}`))];
}
