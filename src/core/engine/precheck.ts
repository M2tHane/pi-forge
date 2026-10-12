// 预检（规格第 8.2 节，checking 状态的程序步骤）。偏离 117：不再运行 typecheck、lint、test、acceptance（用户决定，省时间），
// 只剩不跑命令的两步：1 合入最新的验收测试（acc 分支）；2 契约只能追加的检查（contractAppendCheck）。
// diff 越界在 forge_submit 时已由状态机检查；本 task 自己的测试由审查者运行（stage/review-tests.ts），全量验证在阶段门禁。
import { gitOk, git, taskBaseOf } from '../state/git.ts';
import type { FlowConfig } from '../state/config.ts';
import type { TaskFile } from '../state/schemas.ts';
import type { StateStore } from '../state/state-store.ts';
import { contractViolationsAt } from '../plan/contract-diff.ts';
import { accBranch } from '../acceptance/acctest.ts';
import { branchExists } from '../workspace/worktree.ts';

export type PrecheckOutcome =
  | { ok: true; evidence: string[] }
  | { ok: false; reason: string; command: string; output: string };

/** 把最新的验收测试合进任务分支（只涉及本 task 的测试目录，不会冲突）；冲突时放弃并报错 */
export function mergeAcceptance(root: string, flowId: string, t: TaskFile): { merged: boolean; error?: string } {
  const impl = t.for_task ?? t.id;
  const branch = accBranch(flowId, impl);
  if (!t.worktree || !branchExists(root, branch)) return { merged: false };
  if (gitOk(t.worktree, ['merge-base', '--is-ancestor', branch, 'HEAD'])) return { merged: false };
  try {
    git(t.worktree, ['merge', '--no-edit', '--no-ff', '--no-verify', '-m', `[${flowId}/${t.id}] 合入验收测试`, branch], { engineIdentity: true });
    return { merged: true };
  } catch (e) {
    gitOk(t.worktree, ['merge', '--abort']);
    return { merged: false, error: `合入验收测试分支 ${branch} 失败：${(e as Error).message.slice(0, 500)}` };
  }
}

/** 契约检查的基线（任务 worktree 与集成分支的合并基点，见 taskBaseOf） */
export const contractBaseOf = taskBaseOf;

/** docs/contracts/** 只能追加（第 12.1、12.2 节）：基线（contractBaseOf）对比任务 worktree。有违规返回中文原因（最多列 20 条），否则 null */
export function contractAppendCheck(root: string, t: TaskFile, integrationBranch?: string): string | null {
  const base = contractBaseOf(t, integrationBranch);
  if (!base || !t.worktree) return null;
  const vs = contractViolationsAt(root, base, t.worktree, t.module);
  if (!vs.length) return null;
  const lines = vs.slice(0, 20).map((v) => `- ${v.file}${v.path ? ` ${v.path}` : ''}：${v.message}`);
  const more = vs.length > 20 ? `\n……还有 ${vs.length - 20} 条` : '';
  return `预检未通过：契约只能追加（共 ${vs.length} 处违规）。修改已有契约时用 forge_block 说明，由用户决定。\n${lines.join('\n')}${more}`;
}

/**
 * 对一个 impl / fix task 做预检（偏离 117）：不再运行 typecheck、lint、test、acceptance（省时间，由审查者读代码并运行本 task 自己的测试，
 * 全量验证在阶段门禁）。只剩两个不跑命令的步骤：合入最新的验收测试（acc 分支）、契约只能追加的检查。
 */
export async function runPrecheck(root: string, store: StateStore, config: FlowConfig, flowId: string, t: TaskFile): Promise<PrecheckOutcome> {
  void config;
  const acc = mergeAcceptance(root, flowId, t);
  if (acc.error) return { ok: false, reason: acc.error, command: 'merge', output: '' };
  const contract = contractAppendCheck(root, t, store.readFlow(flowId).integration_branch);
  if (contract) return { ok: false, reason: contract, command: 'contracts', output: '' };
  return { ok: true, evidence: [] };
}

/**
 * 提交时的 diff 里，与 acc 分支内容一致的本 task 验收测试文件是程序合入的，不算 worker 的改动（第 8.2 节第 1 步之后返工再提交）。
 */
export function withoutMergedAcceptance(root: string, flowId: string, t: Pick<TaskFile, 'id' | 'for_task' | 'worktree'>, diff: readonly string[]): string[] {
  const impl = t.for_task ?? t.id;
  const branch = accBranch(flowId, impl);
  if (!t.worktree || !branchExists(root, branch)) return [...diff];
  const blob = (ref: string, f: string, cwd: string) => { try { return git(cwd, ['rev-parse', `${ref}:${f}`]).trim(); } catch { return null; } };
  return diff.filter((f) => {
    if (!f.startsWith(`tests/acceptance/${impl}/`) && !f.startsWith(`tests/acceptance/_support/${impl}/`)) return true;
    const mine = blob('HEAD', f, t.worktree!);
    return mine === null || mine !== blob(branch, f, root);
  });
}
