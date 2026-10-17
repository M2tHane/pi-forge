// 每轮注入程序状态与主会话可执行的下一步；主工作区改动检测保留。
import { isArchitectStage, planApprovalSummary } from '../plan/plan-flow.ts';
import type { StateStore } from '../state/state-store.ts';
import type { FlowConfig } from '../state/config.ts';
import { budgetState } from '../insight/cost-control.ts';
import type { ModelPause, TaskFile } from '../state/schemas.ts';
import { REVIEW_GUIDE, awaitingReview } from './run-budget.ts';
import { DECISION_GUIDE, openRejection, pendingDecisions } from './decisions.ts';
import { openMainConsults, undeliveredAnswers } from './consult.ts';

export interface NextStep { summary: string; next: string; tool: 'forge_wait' | 'forge_resolve_timeout' | 'forge_decide' | 'none'; task?: string }
export type PausedOf = (flowId: string, t: TaskFile) => ModelPause | null;
export function nextStep(store: StateStore, _maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): NextStep {
  const flowId = store.readState().active_flow;
  if (!flowId) return { summary: '没有进行中的流程。', next: '请用户执行 /forge-build 开始。', tool: 'none' };
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const summary = `流程 ${flow.id}「${flow.title}」阶段 ${flow.stage}（${flow.stage_status}）；任务 ${tasks.length} 个，完成 ${tasks.filter((t) => t.status === 'done').length} 个。`;
  const pending = pendingDecisions(store, flowId);
  if (pending.length) return { summary, next: `等你决定：${pending.map((p) => p.id).join('、')}（材料见 forge_status）。${DECISION_GUIDE}`, tool: 'forge_decide', task: pending[0]!.id };
  if (undeliveredAnswers(store, flowId).length || openMainConsults(tasks).length) return { summary, next: '架构师在回答你的问题：调用 forge_wait，回答会随它返回，再转达给用户。', tool: 'forge_wait' };
  if (isArchitectStage(flow.stage) && flow.stage_status === 'awaiting_human' && !flow.s_stages?.length) {
    return { summary, next: `架构阶段已通过审查与门禁。用 forge_read 阅读 docs/plan.md 与 docs/arch/overview.md，先给结论，再向用户汇报要点：技术栈、domain 划分、批次与每批交付什么、风险与假设、下面的提醒。然后提醒用户 /forge-approve 批准或 /forge-reject "<意见>" 打回（只有用户能执行）。\n${planApprovalSummary(store.root, store, flowId)}`, tool: 'none' };
  }
  if (flow.stage_status === 'awaiting_human') return { summary, next: `阶段 ${flow.stage} 等待用户签收，请其 /forge-approve 或 /forge-reject "<意见>"。`, tool: 'none' };
  if (flow.stage_status === 'needs_human') return { summary, next: `阶段 ${flow.stage} 门禁用尽，请用户处理后 /forge gate 重跑，或 /forge-reject "<意见>"。`, tool: 'none' };
  const review = tasks.find(awaitingReview);
  if (review) return { summary, next: `${review.id} 运行超时，调用 forge_resolve_timeout 复核。${REVIEW_GUIDE}`, tool: 'forge_resolve_timeout', task: review.id };
  if (config && budgetState(store, config, flow)?.exceeded) return { summary, next: '本流程的预算已用完，请用户用 /forge budget 提高预算。', tool: 'none' };
  const waiting = tasks.filter((t) => paused?.(flowId, t));
  if (waiting.length && !activeRunCount) return { summary, next: `${waiting.map((t) => `${paused?.(flowId, t)?.model} 暂停中：${t.id}`).join('；')}；请用户 /forge models resume 或 /forge-config 换模型。`, tool: 'none' };
  if (tasks.some((t) => t.lease || ['in_review', 'queued_merge', 'merging'].includes(t.status)) || activeRunCount) return { summary, next: '任务由程序推进，调用 forge_wait 等待结果。', tool: 'forge_wait' };
  const blocked = tasks.filter((t) => t.status === 'blocked' && t.blocked_owner !== 'orchestrator' && t.blocked_by !== 'architect');
  if (blocked.length) return { summary, next: `向用户报告阻塞：${blocked.map((t) => `${t.id}（${t.blocked_reason ?? ''}）`).join('；')}；请其 /forge unblock <任务>。`, tool: 'none' };
  // 只看当前阶段：后面阶段的 task 总是 pending，算进来会让打回的意见永远轮不到
  if (tasks.some((t) => t.stage === flow.stage && ['pending', 'ready'].includes(t.status))) return { summary, next: '任务由程序自动派发；关闭自动派发时请用户执行 /forge next。', tool: 'forge_wait' };
  const rejected = openRejection(store, flow);
  if (rejected !== null) return { summary, next: `用户打回了阶段 ${flow.stage}：${rejected}\n${REJECTION_GUIDE}\n已完成的实现任务：${tasks.filter((t) => t.kind === 'impl' && t.status === 'done').map((t) => `${t.id} ${t.title}`).join('；') || '（无）'}`, tool: 'none' };
  return { summary, next: '等待程序阶段检查或用户指示。', tool: 'none' };
}
/** 签收打回后主会话的做法 */
export const REJECTION_GUIDE = '判断每处要改的内容属于哪个任务：能明确归属的用 forge_decide(target=<任务>, decision=fix, note=<要改什么>) 交给它（程序建修复任务，接着它的会话）；涉及多个任务或归属不清的用 forge_ask_architect(kind=change) 交给架构师。全部交出后用 forge_wait 等待，修改合入后程序重新验收。需要用户澄清的先问用户。';
export function turnContext(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): string {
  const s = nextStep(store, maxParallel, activeRunCount, config, paused);
  return `[pi-forge 状态] ${s.summary}\n[唯一允许的下一步] ${s.next}`;
}
export function newDrift(before: Set<string>, after: Set<string>): string[] { return [...after].filter((f) => !before.has(f)).sort(); }
