// 预检（规格第 8.2 节，checking 状态的程序步骤）：替换 M1 的临时直通。
// 1 合入最新的验收测试（acc 分支）；2 带第 4.1 节分配的资源运行 typecheck、lint、test、acceptance -- <task>；
// 3 diff 越界在 forge_submit 时已由状态机检查（契约只能追加的检查在 M5 接入，见 contractAppendCheck）；4 失败输出压缩后交给 worker，通过时存 evidence。
import { gitOk, git } from './git.ts';
import type { FlowConfig } from './config.ts';
import type { TaskFile } from './schemas.ts';
import type { StateStore } from './state-store.ts';
import { accBranch } from './acctest.ts';
import { branchExists } from './worktree.ts';
import { evidenceText, failureSummary, runShell } from './verify-runner.ts';
import { resourceOptions, withResources } from './resources.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 预检要跑的命令（纯函数）：已定义且非空的 typecheck、lint、test，以及有验收测试目录时的 acceptance -- <task> */
export function precheckCommands(commands: Record<string, string>, implId: string, hasAcceptance: boolean): { name: string; shell: string }[] {
  const out = ['typecheck', 'lint', 'test'].filter((n) => commands[n]?.trim()).map((n) => ({ name: n, shell: commands[n]!.replace('{files}', '').trim() }));
  if (hasAcceptance && commands['acceptance']?.trim()) out.push({ name: 'acceptance', shell: `${commands['acceptance'].trim()} -- ${implId}` });
  return out;
}

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

/** M5 接入：docs/contracts/** 只能追加（第 12.1 节）。M4 只在 forge_submit 时检查删除行 */
export const contractAppendCheck = (_root: string, _t: TaskFile): string | null => null;

/** 对一个 impl / fix task 跑预检（在任务 worktree 中，带资源） */
export async function runPrecheck(root: string, store: StateStore, config: FlowConfig, flowId: string, t: TaskFile, timeoutMs?: number): Promise<PrecheckOutcome> {
  const wt = t.worktree!;
  const impl = t.for_task ?? t.id;
  const acc = mergeAcceptance(root, flowId, t);
  if (acc.error) return { ok: false, reason: acc.error, command: 'merge', output: '' };
  const contract = contractAppendCheck(root, t);
  if (contract) return { ok: false, reason: contract, command: 'contracts', output: '' };
  const hasAcceptance = existsSync(path.join(wt, 'tests/acceptance', impl));
  const plan = precheckCommands(config.commands, impl, hasAcceptance);
  const attempt = t.precheck_failures ?? 0;
  return withResources(root, `pc-${flowId}-${t.id}`, resourceOptions(config), async (env) => {
    const evidence: string[] = [];
    for (const c of plan) {
      const r = { command: c.name, ...(await runShell(c.shell, wt, timeoutMs, env)) };
      evidence.push(await store.saveEvidence(flowId, t.id, `precheck-a${attempt}-${c.name}.log`, evidenceText(r, c.shell), 'precheck'));
      if (r.exit_code !== 0) {
        const what = c.name === 'acceptance' ? `验收测试（tests/acceptance/${impl}/）` : c.name;
        return { ok: false, reason: `预检未通过：${what} 退出码 ${r.exit_code}${r.timed_out ? '（超时）' : ''}\n${failureSummary(r.output)}`, command: c.name, output: r.output };
      }
    }
    const stat = t.base_sha ? git(wt, ['diff', '--stat', t.base_sha, 'HEAD']) : '';
    evidence.push(await store.saveEvidence(flowId, t.id, `precheck-a${attempt}-diff.txt`, stat || '（无改动）', 'precheck'));
    return { ok: true, evidence };
  });
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
