// 每轮注入程序状态与主会话可执行的下一步；主工作区改动检测保留。
import { P1_STAGE, planApprovalSummary } from '../plan/plan-flow.ts';
import type { StateStore } from '../state/state-store.ts';
import type { FlowConfig } from '../state/config.ts';
import { budgetState } from '../insight/cost-control.ts';
import type { ModelPause, TaskFile } from '../state/schemas.ts';
import { REVIEW_GUIDE, awaitingReview } from './run-budget.ts';
import { DECISION_GUIDE, pendingDecisions } from './decisions.ts';
import { pendingRejection } from '../stage/gates.ts';

export interface NextStep { summary: string; next: string; tool: 'forge_spec' | 'forge_wait' | 'forge_resolve_timeout' | 'forge_decide' | 'none'; task?: string }
export type PausedOf = (flowId: string, t: TaskFile) => ModelPause | null;
export function nextStep(store: StateStore, _maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): NextStep {
  const flowId = store.readState().active_flow;
  if (!flowId) return { summary: '没有进行中的流程。', next: '请用户执行 /forge-build 开始。', tool: 'none' };
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const summary = `流程 ${flow.id}「${flow.title}」阶段 ${flow.stage}（${flow.stage_status}）；任务 ${tasks.length} 个，完成 ${tasks.filter((t) => t.status === 'done').length} 个。`;
  if (flow.stage === 'P0') {
    if (flow.stage_status === 'awaiting_gate') return { summary, next: '规格已提交，程序正在重读集成分支并执行 spec-lint，等待闸门结果。', tool: 'none' };
    if (flow.stage_status === 'awaiting_human') return { summary, next: '规格已提交，spec-lint 通过。向用户概述规格，等待用户 /forge-approve stage:P0 或 /forge-reject stage:P0 "<意见>"。等待期间要修改（例如修警告）可以直接用 forge_spec 重交改动的那几份。', tool: 'none' };
    const read = flow.intake?.files.length ? '用 forge_read 阅读集成分支 docs/spec/inputs/ 的需求文档与可选原型（只就有疑问的地方向用户提问）' : '用户没有提供需求文档：按技能 grilling 详细地向用户了解需求';
    return { summary, next: `${read}；和用户确认后用 forge_spec 提交四份规格。${flow.spec?.feedback ? `\n规格被打回或检查失败，意见：${flow.spec.feedback}` : ''}`, tool: 'forge_spec' };
  }
  const pending = pendingDecisions(store, flowId);
  if (pending.length) return { summary, next: `等你决定：${pending.map((p) => p.id).join('、')}（材料见 forge_status）。${DECISION_GUIDE}`, tool: 'forge_decide', task: pending[0]!.id };
  if (flow.stage === P1_STAGE) {
    if (flow.stage_status === 'awaiting_human') return { summary, next: `契约与计划已通过程序检查。用 forge_read 阅读 docs/plan/plan.yaml、docs/arch/overview.md 与 docs/contracts/，向用户概述：阶段与每个阶段交付什么、task 数与并行度、报告里的提醒；assumptions 与 extras 逐条列给用户确认。然后等待用户 /forge-approve stage:P1 或 /forge-reject stage:P1 "<意见>"。\n${planApprovalSummary(store, flowId)}`, tool: 'none' };
    if (flow.stage_status === 'awaiting_gate') return { summary, next: '程序正在检查集成分支上的契约与计划，等待闸门结果。', tool: 'none' };
    const stuck = tasks.filter((t) => t.stage === P1_STAGE && t.status === 'blocked' && t.blocked_owner !== 'orchestrator');
    if (flow.stage_status === 'active' && stuck.length) return { summary, next: `向用户报告阻塞：${stuck.map((t) => `${t.id}（${t.blocked_reason ?? ''}）`).join('；')}；请其 /forge unblock <任务>，或 /forge-reject stage:P1 "<意见>" 让 architect 重做。`, tool: 'none' };
    if (flow.stage_status === 'active') return { summary, next: `architect 正在起草契约与计划，调用 forge_wait 等待。${flow.plan_rework ? `\n返工原因：${flow.plan_rework.reason}` : ''}`, tool: 'forge_wait' };
  }
  if (flow.stage_status === 'awaiting_human') return { summary, next: `阶段 ${flow.stage} 等待用户签收，请其 /forge-approve 或 /forge-reject "<意见>"。`, tool: 'none' };
  if (flow.stage_status === 'needs_human') return { summary, next: `阶段 ${flow.stage} 门禁用尽，请用户处理后 /forge gate 重跑，或 /forge-reject "<意见>"。`, tool: 'none' };
  const review = tasks.find(awaitingReview);
  if (review) return { summary, next: `${review.id} 运行超时，调用 forge_resolve_timeout 复核。${REVIEW_GUIDE}`, tool: 'forge_resolve_timeout', task: review.id };
  if (config && budgetState(store, config, flow)?.exceeded) return { summary, next: '本流程的预算已用完，请用户用 /forge budget 提高预算。', tool: 'none' };
  const waiting = tasks.filter((t) => paused?.(flowId, t));
  if (waiting.length && !activeRunCount) return { summary, next: `${waiting.map((t) => `${paused?.(flowId, t)?.model} 暂停中：${t.id}`).join('；')}；请用户 /forge models resume 或 /forge-config 换模型。`, tool: 'none' };
  if (tasks.some((t) => t.lease || ['awaiting_inputs', 'checking', 'in_review', 'queued_merge', 'merging'].includes(t.status)) || activeRunCount) return { summary, next: '任务由程序推进，调用 forge_wait 等待结果。', tool: 'forge_wait' };
  const blocked = tasks.filter((t) => t.status === 'blocked' && t.blocked_owner !== 'orchestrator');
  if (blocked.length) return { summary, next: `向用户报告阻塞：${blocked.map((t) => `${t.id}（${t.blocked_reason ?? ''}）`).join('；')}；请其 /forge unblock <任务>。`, tool: 'none' };
  // 只看当前阶段：后面阶段的 task 总是 pending，算进来会让打回的意见永远轮不到
  if (tasks.some((t) => t.stage === flow.stage && ['pending', 'ready'].includes(t.status))) return { summary, next: '任务由程序自动派发；关闭自动派发时请用户执行 /forge next。', tool: 'forge_wait' };
  const rejected = pendingRejection(store, flowId, flow.stage);
  if (rejected !== null) return { summary, next: `用户打回了阶段 ${flow.stage}：${rejected}\n用 forge_change_request 把要改的内容加进本阶段（程序在有新的任务变化之前不会重新提交门禁）；需要用户澄清的先问用户。`, tool: 'none' };
  return { summary, next: '等待程序阶段检查或用户指示。', tool: 'none' };
}
export function turnContext(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): string {
  const s = nextStep(store, maxParallel, activeRunCount, config, paused);
  const id = store.readState().active_flow;
  const flow = id ? store.readFlow(id) : null;
  const inputs = flow?.stage === 'P0' ? flow.intake?.files.map((f) => `- ${f.path}（${f.size} 字节，${f.type}）`).join('\n') : '';
  return `[pi-forge 状态] ${s.summary}\n[唯一允许的下一步] ${s.next}${inputs ? `\n[输入清单：用 forge_read 阅读]\n${inputs}` : ''}`;
}
export function newDrift(before: Set<string>, after: Set<string>): string[] { return [...after].filter((f) => !before.has(f)).sort(); }
