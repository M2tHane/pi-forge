// 来源：pi-flow src/core/requirements.ts @ 31f3f15（M2 按 P0 规格与人工修订改编）
// 程序校验后通过独立索引提交产物，所有流程与修订状态只经 StateStore 写入。
import type { StateStore } from '../state/state-store.ts';
import { isLightFlow, type FlowFile } from '../state/schemas.ts';
import { git, gitOk } from '../state/git.ts';
import { commitFilesToBranch } from './intake.ts';
import { lintSpec, type SpecFiles, type LintResult } from './spec.ts';
import { planStageTransition } from '../state/state-machine.ts';

export const SPEC_PATHS = ['requirements', 'screens', 'permissions', 'glossary'] as const;
export class SpecFlowError extends Error {}
export function readSpec(root: string, branch: string): { files: SpecFiles } {
  const ref = `refs/heads/${branch}`;
  const files = Object.fromEntries(SPEC_PATHS.map((name) => {
    const rel = `docs/spec/${name}.md`;
    if (!gitOk(root, ['cat-file', '-e', `${ref}:${rel}`])) throw new SpecFlowError(`集成分支上没有规格文件 ${rel}，请用 forge_spec 提交四份规格。`);
    return [name, git(root, ['show', `${ref}:${rel}`])];
  })) as unknown as SpecFiles;
  return { files };
}
export function specGateLint(root: string, flow: FlowFile): LintResult {
  try {
    return lintSpec(readSpec(root, flow.integration_branch).files);
  } catch (e) { return { errors: [{ file: 'docs/spec', rule: 'missing-spec', message: (e as Error).message }], warnings: [] }; }
}
export async function submitSpec(root: string, store: StateStore, flowId: string, files: SpecFiles): Promise<{ sha: string | null; lint: LintResult }> {
  return store.transaction((tx) => {
    const flow = tx.readFlow(flowId);
    if (store.readState().active_flow !== flowId || isLightFlow(flow) || flow.stage !== 'P0' || flow.stage_status !== 'active') throw new SpecFlowError('只能在活动流程的 P0 规格阶段为 active 时提交；已提交时请等待用户 /forge-approve 或 /forge-reject。');
    const lint = lintSpec(files);
    if (lint.errors.length) throw new SpecFlowError(`spec-lint 未通过，未写入任何文件：\n${lint.errors.map((e) => `- ${e.message}`).join('\n')}`);
    const errors = planStageTransition(flow.stage_status, 'awaiting_gate', 'submit_gate', { actor: 'orchestrator' });
    if (errors.length) throw new SpecFlowError(errors.join('；'));
    const sha = commitFilesToBranch(root, flow.integration_branch, SPEC_PATHS.map((n) => ({ rel: `docs/spec/${n}.md`, content: files[n] })), `pi-forge: ${flowId} 提交规格`);
    tx.putFlow({ ...flow, stage_status: 'awaiting_gate', spec: { submitted: true, errors: [], warnings: lint.warnings.map((i) => i.message), ...(sha ? { sha } : {}) } });
    tx.event({ flow: flowId, actor: 'orchestrator', type: 'note', reason: '四份规格已提交，spec-lint 通过', data: { sha, warnings: lint.warnings } });
    tx.event({ flow: flowId, actor: 'orchestrator', type: 'transition', from: 'active', to: 'awaiting_gate', trigger: 'submit_gate', data: { entity: 'stage', stage: 'P0' } });
    return { sha, lint };
  });
}
