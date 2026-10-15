// 程序校验后通过独立索引提交产物，所有流程与修订状态只经 StateStore 写入。
import type { StateStore } from '../state/state-store.ts';
import { isLightFlow, type FlowFile } from '../state/schemas.ts';
import { git, gitOk } from '../state/git.ts';
import { commitFilesToBranch } from './intake.ts';
import { lintSpec, type SpecFiles, type LintResult } from './spec.ts';
import { planStageTransition } from '../state/state-machine.ts';

export const SPEC_PATHS = ['requirements', 'screens', 'permissions', 'glossary'] as const;
/** 可以不交的规格（没有界面的项目没有 screens.md），缺省为空 */
const OPTIONAL_SPECS: readonly string[] = ['screens'];
export class SpecFlowError extends Error {}
export function readSpec(root: string, branch: string): { files: SpecFiles } {
  const ref = `refs/heads/${branch}`;
  const files = Object.fromEntries(SPEC_PATHS.map((name) => {
    const rel = `docs/spec/${name}.md`;
    if (!gitOk(root, ['cat-file', '-e', `${ref}:${rel}`])) {
      if (OPTIONAL_SPECS.includes(name)) return [name, ''];
      throw new SpecFlowError(`集成分支上没有规格文件 ${rel}，请用 forge_spec 提交规格。`);
    }
    return [name, git(root, ['show', `${ref}:${rel}`])];
  })) as unknown as SpecFiles;
  return { files };
}
export function specGateLint(root: string, flow: FlowFile): LintResult {
  try {
    return lintSpec(readSpec(root, flow.integration_branch).files);
  } catch (e) { return { errors: [{ file: 'docs/spec', rule: 'missing-spec', message: (e as Error).message }], warnings: [] }; }
}
/** 上一次提交的四份规格（不论 spec-lint 是否通过）；重新提交时没交的文件沿用这里 */
export const specDraftRel = (flowId: string, name: string) => `flows/${flowId}/spec-draft/${name}.md`;

export interface SubmitResult { ok: boolean; sha: string | null; lint: LintResult; reused: string[]; missing: string[] }

/**
 * 提交规格：这次没交的文件沿用上一次提交，没有上一次时取集成分支上的规格（用户打回后），
 * 这样 spec-lint 指出一处问题时只需重交改动的那份，不必重新生成四份。
 * 还没交齐时只保存这次交的几份（missing 列出还差的）；spec-lint 不通过时不写集成分支，只保存这次的四份，返回 ok: false。
 */
export async function submitSpec(root: string, store: StateStore, flowId: string, input: Partial<SpecFiles>): Promise<SubmitResult> {
  return store.transaction((tx) => {
    const flow = tx.readFlow(flowId);
    if (store.readState().active_flow !== flowId || isLightFlow(flow) || flow.stage !== 'P0' || flow.stage_status !== 'active') throw new SpecFlowError('只能在活动流程的 P0 规格阶段为 active 时提交；已提交时请等待用户 /forge-approve 或 /forge-reject。');
    const ref = `refs/heads/${flow.integration_branch}`;
    const onBranch = (rel: string) => (gitOk(root, ['cat-file', '-e', `${ref}:${rel}`]) ? git(root, ['show', `${ref}:${rel}`]) : null);
    const reused: string[] = [];
    const missing: string[] = [];
    const files = Object.fromEntries(SPEC_PATHS.map((name) => {
      const given = input[name];
      if (given) return [name, given];
      const prev = tx.readText(specDraftRel(flowId, name)) ?? onBranch(`docs/spec/${name}.md`);
      if (prev === null) { if (!OPTIONAL_SPECS.includes(name)) missing.push(name); } else reused.push(name);
      return [name, prev ?? ''];
    })) as unknown as SpecFiles;
    // 还没交齐：先存这次交的草稿，等剩下的。四份一次交可能超出模型单次输出的上限（stock 实验：截断两次才交上）
    if (missing.length) {
      for (const name of SPEC_PATHS) if (input[name]) tx.putText(specDraftRel(flowId, name), files[name]);
      tx.event({ flow: flowId, actor: 'orchestrator', type: 'note', reason: `规格草稿已保存，还差 ${missing.join('、')}`, data: { missing } });
      return { ok: false, sha: null, lint: { errors: [], warnings: [] }, reused, missing };
    }
    for (const name of SPEC_PATHS) tx.putText(specDraftRel(flowId, name), files[name]);
    const lint = lintSpec(files);
    if (lint.errors.length) {
      tx.event({ flow: flowId, actor: 'orchestrator', type: 'note', reason: `规格未通过 spec-lint（${lint.errors.length} 处），未写入集成分支`, data: { errors: lint.errors.length, reused } });
      return { ok: false, sha: null, lint, reused, missing };
    }
    const errors = planStageTransition(flow.stage_status, 'awaiting_gate', 'submit_gate', { actor: 'orchestrator' });
    if (errors.length) throw new SpecFlowError(errors.join('；'));
    const sha = commitFilesToBranch(root, flow.integration_branch, SPEC_PATHS.map((n) => ({ rel: `docs/spec/${n}.md`, content: files[n] })), `pi-forge: ${flowId} 提交规格`);
    tx.putFlow({ ...flow, stage_status: 'awaiting_gate', spec: { submitted: true, errors: [], warnings: lint.warnings.map((i) => i.message), ...(sha ? { sha } : {}) } });
    tx.event({ flow: flowId, actor: 'orchestrator', type: 'note', reason: '四份规格已提交，spec-lint 通过', data: { sha, warnings: lint.warnings, reused } });
    tx.event({ flow: flowId, actor: 'orchestrator', type: 'transition', from: 'active', to: 'awaiting_gate', trigger: 'submit_gate', data: { entity: 'stage', stage: 'P0' } });
    return { ok: true, sha, lint, reused, missing };
  });
}
