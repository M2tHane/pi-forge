// 预检（规格第 8.2 节，checking 状态的程序步骤）：替换 M1 的临时直通。
// 1 合入最新的验收测试（acc 分支）；2 带第 4.1 节分配的资源运行 typecheck、lint、test、acceptance -- <task>；
// 3 diff 越界在 forge_submit 时已由状态机检查（契约只能追加的检查在 M5 接入，见 contractAppendCheck）；4 失败输出压缩后交给 worker，通过时存 evidence。
import { gitOk, git } from '../state/git.ts';
import type { FlowConfig } from '../state/config.ts';
import type { TaskFile } from '../state/schemas.ts';
import type { StateStore } from '../state/state-store.ts';
import { contractViolationsAt } from '../plan/contract-diff.ts';
import { accBranch } from '../acceptance/acctest.ts';
import { withScopeHint } from '../workspace/scope-hint.ts';
import { branchExists } from '../workspace/worktree.ts';
import { evidenceText, failureSummary, runShell } from '../workspace/verify-runner.ts';
import { resourceOptions, withResources } from '../workspace/resources.ts';
import { cleanTreeOf, recordVerified } from '../verify/verify-cache.ts';
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

/**
 * 契约检查的基线：任务 worktree 与集成分支的合并基点。任务同步过集成分支（forge_sync）后，基点含已批准变更请求对契约的修改，
 * 这些修改不算 worker 的改动；没有集成分支信息或算不出时用 base_sha。
 */
export function contractBaseOf(t: Pick<TaskFile, 'base_sha' | 'worktree'>, integrationBranch?: string): string | undefined {
  const fallback = t.base_sha ?? undefined;
  if (!t.worktree || !integrationBranch) return fallback;
  try { return git(t.worktree, ['merge-base', 'HEAD', integrationBranch]).trim() || fallback; } catch { return fallback; }
}

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

/** 对一个 impl / fix task 跑预检（在任务 worktree 中，带资源） */
export async function runPrecheck(root: string, store: StateStore, config: FlowConfig, flowId: string, t: TaskFile, timeoutMs?: number): Promise<PrecheckOutcome> {
  const wt = t.worktree!;
  const impl = t.for_task ?? t.id;
  const acc = mergeAcceptance(root, flowId, t);
  if (acc.error) return { ok: false, reason: acc.error, command: 'merge', output: '' };
  const contract = contractAppendCheck(root, t, store.readFlow(flowId).integration_branch);
  if (contract) return { ok: false, reason: contract, command: 'contracts', output: '' };
  const hasAcceptance = existsSync(path.join(wt, 'tests/acceptance', impl));
  const plan = precheckCommands(config.commands, impl, hasAcceptance);
  const attempt = t.precheck_failures ?? 0;
  // 运行前的代码树：通过后记下，合并与门禁在同一棵树上沿用（偏离 76）
  const tree = cleanTreeOf(wt);
  return withResources(root, `pc-${flowId}-${t.id}`, resourceOptions(config), async (env) => {
    const evidence: string[] = [];
    const passed: { name: string; shell: string; evidence: string }[] = [];
    for (const c of plan) {
      const r = { command: c.name, ...(await runShell(c.shell, wt, timeoutMs, env)) };
      const ev = await store.saveEvidence(flowId, t.id, `precheck-a${attempt}-${c.name}.log`, evidenceText(r, c.shell), 'precheck');
      evidence.push(ev);
      if (r.exit_code === 0) passed.push({ name: c.name, shell: c.shell, evidence: ev });
      if (r.exit_code !== 0) {
        const what = c.name === 'acceptance' ? `验收测试（tests/acceptance/${impl}/）` : c.name;
        return { ok: false, reason: withScopeHint(`预检未通过：${what} 退出码 ${r.exit_code}${r.timed_out ? '（超时）' : ''}\n${failureSummary(r.output)}`, r.output, t, wt), command: c.name, output: r.output };
      }
    }
    const stat = t.base_sha ? git(wt, ['diff', '--stat', t.base_sha, 'HEAD']) : '';
    evidence.push(await store.saveEvidence(flowId, t.id, `precheck-a${attempt}-diff.txt`, stat || '（无改动）', 'precheck'));
    await recordVerified(store, flowId, tree, passed, { task: t.id, actor: 'precheck' });
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
