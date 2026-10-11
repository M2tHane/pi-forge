// 从 spec/spec-flow.ts 抽出（偏离 106）：批准规格修订会自动发起变更请求，状态与批准清单要列出待批准的变更，都依赖 plan/change-flow，
// spec 目录不能反向依赖 plan。函数体原样搬运。
import type { StateStore } from '../state/state-store.ts';
import { amendRel } from '../state/state-store.ts';
import type { AmendFile } from '../state/schemas.ts';
import type { FlowConfig } from '../state/config.ts';
import { commitFilesToBranch } from '../spec/intake.ts';
import { diffAcs, effectiveSpec, lintSpec } from '../spec/spec.ts';
import { SpecFlowError, amendSummary, readSpec } from '../spec/spec-flow.ts';
import { ChangeError, changeApprovalText, pendingChanges, requestChange } from './change-flow.ts';

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
