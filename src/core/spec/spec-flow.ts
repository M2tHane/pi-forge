// 来源：pi-flow src/core/requirements.ts @ 31f3f15（M2 按 P0 规格与人工修订改编）
// 程序校验后通过独立索引提交产物，所有流程与修订状态只经 StateStore 写入。
import type { StateStore } from '../state/state-store.ts';
import { amendRel } from '../state/state-store.ts';
import type { AmendFile, FlowFile } from '../state/schemas.ts';
import { git, gitOk } from '../state/git.ts';
import { commitFilesToBranch } from './intake.ts';
import { diffAcs, effectiveSpec, lintSpec, type SpecFiles, type SpecFeature, type LintResult } from './spec.ts';
import { planStageTransition } from '../state/state-machine.ts';
import type { FlowConfig } from '../state/config.ts';
import { ChangeError, changeApprovalText, pendingChanges, requestChange } from '../plan/change-flow.ts';

export const SPEC_PATHS = ['requirements', 'screens', 'permissions', 'glossary'] as const;
export class SpecFlowError extends Error {}
export function readSpec(root: string, branch: string): { files: SpecFiles; features: SpecFeature[] } {
  const ref = `refs/heads/${branch}`;
  const files = Object.fromEntries(SPEC_PATHS.map((name) => {
    const rel = `docs/spec/${name}.md`;
    if (!gitOk(root, ['cat-file', '-e', `${ref}:${rel}`])) throw new SpecFlowError(`集成分支上没有规格文件 ${rel}，请用 forge_spec 提交四份规格。`);
    return [name, git(root, ['show', `${ref}:${rel}`])];
  })) as unknown as SpecFiles;
  const features = git(root, ['ls-tree', '-rz', '--name-only', ref, '--', 'docs/spec/features/']).split('\0')
    .filter((f) => /^docs\/spec\/features\/[^/]+\.md$/.test(f)).sort()
    .map((f) => ({ name: f.slice('docs/spec/features/'.length), content: git(root, ['show', `${ref}:${f}`]) }));
  return { files, features };
}
export function specGateLint(root: string, flow: FlowFile): LintResult {
  try {
    const { files, features } = readSpec(root, flow.integration_branch);
    return lintSpec(files, features);
  } catch (e) { return { errors: [{ file: 'docs/spec', rule: 'missing-spec', message: (e as Error).message }], warnings: [] }; }
}
export async function submitSpec(root: string, store: StateStore, flowId: string, files: SpecFiles): Promise<{ sha: string | null; lint: LintResult }> {
  return store.transaction((tx) => {
    const flow = tx.readFlow(flowId);
    if (store.readState().active_flow !== flowId || flow.mode === 'fix' || flow.stage !== 'P0' || flow.stage_status !== 'active') throw new SpecFlowError('只能在活动流程的 P0 规格阶段为 active 时提交；已提交时请等待用户 /forge-approve 或 /forge-reject。');
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
export function amendSummary(a: AmendFile): string {
  return [`amend:${a.id}「${a.name}」（${a.status}）：${a.reason}`, `AC 新增：${a.diff.added.join('、') || '无'}；修改：${a.diff.changed.join('、') || '无'}；删除：${a.diff.removed.join('、') || '无'}`, `受影响的 task：${a.affected_tasks.join('、') || '无'}`, ...(a.feedback ? [`打回意见：${a.feedback}`] : [])].join('\n');
}
export async function proposeSpecAmend(root: string, store: StateStore, flowId: string, input: { name?: string; content: string; reason: string }): Promise<AmendFile> {
  const flow = store.readFlow(flowId);
  if (!flow.approvals['P0']) throw new SpecFlowError('P0 批准之后才能提交规格修订；当前请用 forge_spec。');
  const amends = store.listAmends(flowId);
  if (amends.some((a) => a.status === 'proposed')) throw new SpecFlowError('已有修订等待批准，请先等待用户 /forge-approve 或 /forge-reject。');
  if (!input.content.trim() || !input.reason.trim()) throw new SpecFlowError('修订内容和理由不能为空。');
  const name = input.name?.trim() || '规格修订';
  if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(name)) throw new SpecFlowError('修订名字只能包含文字、数字、下划线和短横线，最多 80 字。');
  const seq = String(Math.max(0, ...amends.map((a) => Number(a.id.slice(2)))) + 1).padStart(3, '0');
  const date = new Date().toISOString().slice(0, 10);
  // 日期回拨时仍在所有已批准 features 后面叠加，避免修订顺序倒置。
  const { files, features } = readSpec(root, flow.integration_branch);
  const latestDate = features.map((f) => f.name.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1);
  const filename = `${latestDate && latestDate > date ? latestDate : date}-${seq}-${name}.md`;
  const next = [...features, { name: filename, content: input.content }];
  const lint = lintSpec(files, next);
  if (lint.errors.length) throw new SpecFlowError(`spec-lint 未通过，未保存修订：\n${lint.errors.map((e) => `- ${e.message}`).join('\n')}`);
  const diff = diffAcs(effectiveSpec(files, features), effectiveSpec(files, next));
  const changed = new Set([...diff.added, ...diff.changed, ...diff.removed]);
  const affected_tasks = store.listTasks(flowId).filter((t) => t.ac?.some((ac) => changed.has(ac))).map((t) => t.id);
  return store.proposeAmend(flowId, { name, path: `docs/spec/features/${filename}`, content: input.content, reason: input.reason.trim(), diff, affected_tasks, base_sha: git(root, ['rev-parse', `refs/heads/${flow.integration_branch}`]).trim() });
}
/**
 * 批准规格修订。P1 之后（计划已批准）、修订改动了 AC 或影响了已有 task 时，自动发起变更请求交给 architect（第 13.5 节）；
 * 没有传 config 时只批准修订，不发起。P0 阶段的修订保持原样。
 */
export async function approveSpecAmend(root: string, store: StateStore, flowId: string, id: string, config?: FlowConfig): Promise<string> {
  const approved = await approveAmendOnly(root, store, flowId, id);
  const { a, text } = approved;
  const flow = store.readFlow(flowId);
  const acs = [...a.diff.added, ...a.diff.changed, ...a.diff.removed];
  if (!config || !flow.s_stages?.length || (!acs.length && !a.affected_tasks.length)) return text;
  const list = (label: string, xs: readonly string[]) => `${label}：${xs.join('、') || '无'}`;
  try {
    const r = await requestChange(root, store, config, flowId, {
      what: `规格修订 ${a.id}「${a.name}」已批准，契约和计划需要跟着调整。${list('AC 新增', a.diff.added)}；${list('修改', a.diff.changed)}；${list('删除', a.diff.removed)}。`,
      why: a.reason,
      impact: `${list('受影响的 task', a.affected_tasks)}。规格修订文件：${a.path}（已进入集成分支）。按覆盖率映射检查这些 task 的验收测试。`,
    }, `amend:${a.id}`, acs);
    return `${text}\n涉及契约或计划，已自动发起变更请求 ${r.change.id}，程序派 architect（${r.task.id}）起草修订，起草好后等你 /forge-approve change:${r.change.id}。`;
  } catch (e) {
    if (!(e instanceof ChangeError)) throw e;
    return `${text}\n未能自动发起变更请求：${e.message}\n之后由 main 调用 forge_change_request 发起（规格修订 ${a.id} 的影响见上）。`;
  }
}
async function approveAmendOnly(root: string, store: StateStore, flowId: string, id: string): Promise<{ a: AmendFile; text: string }> {
  return store.transaction((tx) => {
    const flow = tx.readFlow(flowId);
    const a = tx.readJson<AmendFile>(amendRel(flowId, id));
    if (!a || a.status !== 'proposed') throw new SpecFlowError(`修订 ${id} 没有等待批准。`);
    const { files, features } = readSpec(root, flow.integration_branch);
    const existing = features.find((f) => `docs/spec/features/${f.name}` === a.path);
    // 提交之后、状态事务之前中断时允许恢复；不同内容绝不能覆盖。
    if (existing && existing.content !== a.content) throw new SpecFlowError(`修订文件 ${a.path} 已存在且内容不同，请打回后重提。`);
    const next = existing ? features : [...features, { name: a.path.slice('docs/spec/features/'.length), content: a.content }];
    const lint = lintSpec(files, next);
    if (lint.errors.length) throw new SpecFlowError(`规格已变化，批准前检查未通过：\n${lint.errors.map((i) => i.message).join('\n')}`);
    const before = existing ? features.filter((f) => f !== existing) : features;
    const diff = diffAcs(effectiveSpec(files, before), effectiveSpec(files, next));
    const changed = new Set([...diff.added, ...diff.changed, ...diff.removed]);
    const affected = store.listTasks(flowId).filter((t) => t.ac?.some((ac) => changed.has(ac))).map((t) => t.id);
    if (JSON.stringify(diff) !== JSON.stringify(a.diff) || JSON.stringify(affected) !== JSON.stringify(a.affected_tasks)) throw new SpecFlowError('规格或 task 的影响清单已变化，请打回后重新提交修订，供用户审阅。');
    const sha = commitFilesToBranch(root, flow.integration_branch, [{ rel: a.path, content: a.content }], `pi-forge: ${flowId} 批准规格修订 ${id}`);
    tx.putJson<AmendFile>(amendRel(flowId, id), 'amend', { ...a, status: 'approved', decided_at: tx.ts, ...(sha ? { sha } : {}) });
    tx.event({ flow: flowId, actor: 'human', type: 'approval', reason: `规格修订 ${id} 已批准`, data: { amend: id, sha } });
    return { a, text: `已批准 amend:${id}，规格修订已提交到集成分支 ${a.path}。` };
  });
}
export interface ApprovalTarget { object: string; summary: string }
export function approvalTargets(store: StateStore, flowId: string, includeNeedsHuman = false): ApprovalTarget[] {
  const f = store.readFlow(flowId);
  return [...(f.stage_status === 'awaiting_human' || includeNeedsHuman && f.stage_status === 'needs_human' ? [{ object: `stage:${f.stage}`, summary: `stage:${f.stage} 等待用户${f.stage_status === 'needs_human' ? '处理' : '批准'}` }] : []), ...store.listAmends(flowId).filter((a) => a.status === 'proposed').map((a) => ({ object: `amend:${a.id}`, summary: amendSummary(a) })), ...pendingChanges(store, flowId).map((c) => ({ object: `change:${c.id}`, summary: changeApprovalText(c) }))];
}
export function specStatus(store: StateStore, flowId: string): string {
  const f = store.readFlow(flowId);
  const spec = f.spec;
  return [...(f.stage === 'P0' || spec ? [`规格：${spec?.submitted ? '已提交' : '尚未提交'}；spec-lint：${spec ? spec.errors.length ? '未通过' : '通过' : '尚未检查'}`, ...(spec?.errors ?? []).map((s) => `- ${s}`), ...(spec?.warnings ?? []).map((s) => `警告：${s}`), ...(spec?.feedback ? [`反馈：${spec.feedback}`] : []), ...(spec?.permission_changes ?? [])] : []), ...store.listAmends(flowId).map(amendSummary), ...approvalTargets(store, flowId).map((a) => `等待批准：${a.object}`)].join('\n');
}
