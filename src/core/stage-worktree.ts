// 阶段级只读任务（stage-qa 的 .qa 与精简模式的阶段审查 .rv）使用的临时 worktree（规格第 7.6、11、14 节）。
// 它们没有自己的任务分支：在集成分支 HEAD 上新建一个 detached 的 worktree，放在 worktreesRoot(root) 下，
// 任务结束（done 或 cancelled）后删除。这类任务的流水线只有 ready → in_progress → done（report），
// 不经过预检、合并、同步，也不会在其中提交；branch 字段只是记账（集成分支名），检出本身是 detached。
// forge_service 因此永远不必（也不允许）在主工作区运行服务。
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { TaskFile } from './schemas.ts';
import type { StateStore } from './state-store.ts';
import { git, gitOk } from './git.ts';
import { headSha, removeWorktree, worktreePath, type TaskWorktree } from './worktree.ts';

/** 阶段级审查 task 的编号：S1.rv、S1.rv-2 */
export const STAGE_RV_ID = /^[A-Za-z][A-Za-z0-9_]*\.rv(?:-\d+)?$/;

/** 需要临时 worktree 的任务：qa，以及没有 for_task 的阶段级 review（纯函数） */
export const isStageLevelTask = (t: Pick<TaskFile, 'id' | 'kind' | 'for_task'>): boolean =>
  t.kind === 'qa' || (t.kind === 'review' && !t.for_task && STAGE_RV_ID.test(t.id));

/**
 * 在 at（默认集成分支 HEAD）上建 detached 的临时 worktree；已存在（重新派发）时复用。
 * 返回的 branch 是集成分支名（记账用，检出是 detached）；base_sha 是检出的提交。
 */
export function createStageTempWorktree(root: string, flow: string, taskId: string, integrationBranch: string, at?: string): TaskWorktree {
  const wt = worktreePath(root, flow, taskId);
  if (existsSync(path.join(wt, '.git'))) return { path: wt, branch: integrationBranch, base_sha: headSha(wt) };
  const sha = headSha(root, at ?? `refs/heads/${integrationBranch}`);
  mkdirSync(path.dirname(wt), { recursive: true });
  git(root, ['worktree', 'add', '-q', '--detach', wt, sha]);
  return { path: wt, branch: integrationBranch, base_sha: sha };
}

/** 删除临时 worktree（不删任何分支：集成分支不能被清理掉）；不存在时什么也不做 */
export function removeStageTempWorktree(root: string, flow: string, taskId: string): boolean {
  const wt = worktreePath(root, flow, taskId);
  if (!existsSync(wt)) return false;
  removeWorktree(root, wt);
  return true;
}

/** 已经 done 或 cancelled 的阶段级任务，清理它们的临时 worktree；返回清理的任务编号 */
export function cleanupStageWorktrees(root: string, store: StateStore, flowId: string): string[] {
  const out: string[] = [];
  for (const t of store.listTasks(flowId)) {
    if (!isStageLevelTask(t) || (t.status !== 'done' && t.status !== 'cancelled')) continue;
    try { if (removeStageTempWorktree(root, flowId, t.id)) out.push(t.id); } catch { /* 清理失败不影响流程 */ }
  }
  return out;
}

/**
 * 阶段基线：本阶段 impl/fix/doc 任务中最早的 base_sha（祖先提交最少的那个；它们都从集成分支的同一条线上分出）。
 * 找不到（阶段里还没有任务开过工）时返回 null，调用方回退到流程的 base_sha。
 */
export function stageBaseOf(root: string, tasks: readonly Pick<TaskFile, 'stage' | 'kind' | 'base_sha'>[], stage: string): string | null {
  const shas = [...new Set(tasks.filter((t) => t.stage === stage && ['impl', 'fix', 'doc'].includes(t.kind) && t.base_sha).map((t) => t.base_sha!))];
  const known = shas.filter((s) => gitOk(root, ['cat-file', '-e', `${s}^{commit}`]));
  if (!known.length) return null;
  return known.map((s) => ({ s, n: Number(git(root, ['rev-list', '--count', s]).trim()) })).sort((a, b) => a.n - b.n)[0]!.s;
}
