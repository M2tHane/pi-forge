// 来源：pi-flow src/core/context-injector.ts @ 31f3f15（M1 改编）
// 每轮注入程序状态与主会话可执行的下一步；主工作区改动检测保留。
import type { StateStore } from './state-store.ts';
import type { FlowConfig } from './config.ts';
import { budgetState } from './cost-control.ts';
import { git } from './git.ts';
import type { ModelPause, TaskFile } from './schemas.ts';
import { REVIEW_GUIDE, awaitingReview } from './run-budget.ts';

export interface NextStep { summary: string; next: string; tool: 'forge_wait' | 'forge_resolve_timeout' | 'forge_resolve_scope' | 'none'; task?: string }
export type PausedOf = (flowId: string, t: TaskFile) => ModelPause | null;
export function nextStep(store: StateStore, _maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): NextStep {
  const flowId = store.readState().active_flow;
  if (!flowId) return { summary: '没有进行中的流程。', next: '请用户执行 /forge-build 开始。', tool: 'none' };
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const summary = `流程 ${flow.id}「${flow.title}」阶段 ${flow.stage}（${flow.stage_status}）；任务 ${tasks.length} 个，完成 ${tasks.filter((t) => t.status === 'done').length} 个。`;
  if (flow.stage === 'P0') return { summary, next: 'P0（规格）在 M2 实现。', tool: 'none' };
  if (flow.stage === 'P1') return { summary, next: 'P1（契约与计划）在 M3 实现。', tool: 'none' };
  if (flow.stage_status === 'awaiting_human') return { summary, next: `阶段 ${flow.stage} 等待用户签收，请其 /forge-approve 或 /forge-reject "<意见>"。`, tool: 'none' };
  if (flow.stage_status === 'needs_human') return { summary, next: `阶段 ${flow.stage} 门禁用尽，请用户处理后 /forge gate 重跑，或 /forge-reject "<意见>"。`, tool: 'none' };
  const scope = tasks.find((t) => t.scope_request);
  if (scope) return { summary, next: `${scope.id} 申请 ${scope.scope_request!.paths.join('、')}：${scope.scope_request!.reason}。看过范围后用 forge_resolve_scope 决定。`, tool: 'forge_resolve_scope', task: scope.id };
  const review = tasks.find(awaitingReview);
  if (review) return { summary, next: `${review.id} 运行超时，调用 forge_resolve_timeout 复核。${REVIEW_GUIDE}`, tool: 'forge_resolve_timeout', task: review.id };
  if (config && budgetState(store, config, flow)?.exceeded) return { summary, next: '本流程的预算已用完，请用户用 /forge budget 提高预算。', tool: 'none' };
  const waiting = tasks.filter((t) => paused?.(flowId, t));
  if (waiting.length && !activeRunCount) return { summary, next: `${waiting.map((t) => `${paused?.(flowId, t)?.model} 暂停中：${t.id}`).join('；')}；请用户 /forge models resume 或 /forge-config 换模型。`, tool: 'none' };
  if (tasks.some((t) => t.lease || ['awaiting_inputs', 'checking', 'in_review', 'disputed', 'queued_merge', 'merging'].includes(t.status)) || activeRunCount) return { summary, next: '任务由程序推进，调用 forge_wait 等待结果。', tool: 'forge_wait' };
  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) return { summary, next: `向用户报告阻塞：${blocked.map((t) => `${t.id}（${t.blocked_reason ?? ''}）`).join('；')}；请其 /forge unblock <任务>。`, tool: 'none' };
  if (tasks.some((t) => ['pending', 'ready'].includes(t.status))) return { summary, next: '任务由程序自动派发；关闭自动派发时请用户执行 /forge next。', tool: 'forge_wait' };
  return { summary, next: '等待程序阶段检查或用户指示。', tool: 'none' };
}
export function turnContext(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): string {
  const s = nextStep(store, maxParallel, activeRunCount, config, paused);
  return `[pi-forge 状态] ${s.summary}\n[唯一允许的下一步] ${s.next}`;
}
export function dirtyFiles(root: string): Set<string> {
  const out = git(root, ['status', '--porcelain', '-uall', '--', '.', ':(exclude).forge']).split('\n').filter(Boolean);
  return new Set(out.map((l) => l.slice(3)));
}
export function newDrift(before: Set<string>, after: Set<string>): string[] { return [...after].filter((f) => !before.has(f)).sort(); }
