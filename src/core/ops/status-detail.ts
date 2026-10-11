// M8：/forge-status 的 --detail、--metrics、--cost 视图。纯函数：只读 store，当前时间由调用者传入（测试用固定时钟）。
// 默认视图（status-view.ts）只显示高层阶段；内部状态、任务类型、计数器都放在这里。
import type { FlowConfig } from '../state/config.ts';
import { budgetState, formatBudget } from '../insight/cost-control.ts';
import { costReport, formatCost } from '../insight/cost.ts';
import { flowMetrics, renderMetrics } from '../stage/signoff.ts';
import type { FlowEvent, FlowFile, TaskFile } from '../state/schemas.ts';
import type { StateStore } from '../state/state-store.ts';
import { actionsNeeded, renderFlow, renderStatus, visibleFlows } from './status-view.ts';

const one = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ').replace(/\|/g, '/');
const sum = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
const naturalId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** 任务排序：先按阶段在流程里的顺序，再按编号（自然序），保证同样的数据输出同样的表 */
export function sortTasks(flow: Pick<FlowFile, 'stages' | 's_stages'>, tasks: readonly TaskFile[]): TaskFile[] {
  const order = [...flow.stages, ...(flow.s_stages ?? []).map((s) => s.id)];
  const rank = (t: TaskFile) => { const i = order.indexOf(t.stage); return i < 0 ? order.length : i; };
  return [...tasks].sort((a, b) => rank(a) - rank(b) || naturalId(a.stage, b.stage) || naturalId(a.id, b.id));
}

/** 完整任务表（Markdown 表格）：编号、类型、角色、状态、阶段、计数器 */
export function taskTable(flow: Pick<FlowFile, 'stages' | 's_stages'>, tasks: readonly TaskFile[]): string {
  if (!tasks.length) return '（还没有任务）';
  const head = '| 任务 | 类型 | 角色 | 状态 | 阶段 | 预检失败 | 审查轮 | 合并失败 | 争议 | 尝试 | 阻塞原因 |';
  const rows = sortTasks(flow, tasks).map((t) => `| ${[t.id, t.kind, t.lease?.role ?? t.role, t.status, t.stage, t.precheck_failures ?? 0, t.review_rounds ?? 0, t.merge_failures ?? 0, sum(t.disputes), t.attempts, t.blocked_by ?? '-'].join(' | ')} |`);
  return [head, `|${' --- |'.repeat(11)}`, ...rows].join('\n');
}

/** 最近的事件（按 seq 升序，最后 n 条）：序号、时间、类型、任务、转移、触发、原因 */
export function recentEvents(events: readonly FlowEvent[], flowId: string, n = 15): string[] {
  return events.filter((e) => e.flow === flowId).slice(-n).map((e) =>
    `#${e.seq} ${e.ts} ${e.type}${e.task ? ` ${e.task}` : ''}${e.from || e.to ? ` ${e.from ?? '?'}→${e.to ?? '?'}` : ''}${e.trigger ? ` [${e.trigger}]` : ''}${e.reason ? `：${one(e.reason, 80)}` : ''}`);
}

function flowDetail(store: StateStore, config: FlowConfig, flow: FlowFile, now: Date): string {
  const tasks = store.listTasks(flow.id);
  const events = store.readEvents();
  const budget = budgetState(store, config, flow, now);
  const lines = [
    `## ${flow.id}「${one(flow.title, 60)}」内部状态`,
    `- 模式 ${flow.mode}；阶段序列 ${flow.stages.join(' → ')}${flow.s_stages?.length ? `（S 阶段：${flow.s_stages.map((s) => s.id).join('、')}）` : ''}`,
    `- 当前阶段 ${flow.stage}：${flow.stage_status}；集成分支 ${flow.integration_branch}`,
    `- 已批准的闸门：${Object.keys(flow.approvals).join('、') || '无'}`,
    ...(flow.sync ? [`- 与 ${config.raw.main_branch} 同步：${flow.sync.status}（${flow.sync.stage}）${flow.sync.reason ? `：${one(flow.sync.reason, 80)}` : ''}`] : []),
    ...(flow.gate_rounds?.length ? [`- 门禁修复轮次：${flow.gate_rounds.map((g) => `${g.stage}:${g.tasks.join('+')}`).join('；')}`] : []),
    ...(budget ? [`- ${formatBudget(budget)}`] : []),
    '',
    `### 任务表（${tasks.length} 个）`,
    taskTable(flow, tasks),
    '',
    '### 最近事件',
    ...(recentEvents(events, flow.id).length ? recentEvents(events, flow.id) : ['（无）']),
  ];
  return lines.join('\n');
}

/**
 * /forge-status --detail：先是默认视图（需要你处理的事项与阶段概览），再给出每个流程的内部状态、完整任务表和最近事件。
 * 没有进行中的流程时只给默认视图的空状态。
 */
export function renderDetail(store: StateStore, config: FlowConfig, now = new Date()): string {
  const flows = visibleFlows(store);
  const actions = actionsNeeded(store, config, now);
  if (!flows.length) return renderStatus(store, config, now);
  return [
    actions.length ? `需要你处理：\n${actions.map((a) => `- ${a.text}\n  → ${a.command}`).join('\n')}` : '需要你处理：无',
    ...flows.flatMap((f) => [renderFlow(store, config, f, now), flowDetail(store, config, f, now)]),
  ].join('\n\n');
}

/** 度量要看的流程：进行中的；都没有时取最近一个流程（结束后也能看总结） */
function metricsFlows(store: StateStore): string[] {
  const visible = visibleFlows(store).map((f) => f.id);
  if (visible.length) return visible;
  return store.listFlows().slice(-1);
}

/** /forge-status --metrics（规格第 17 节）。没有运行记录、没有流程时都不抛错 */
export function renderMetricsView(store: StateStore, now = new Date(), root?: string): string {
  const ids = metricsFlows(store);
  if (!ids.length) return '没有流程，暂无度量。';
  return ids.map((id) => renderMetrics(flowMetrics(store, id, now, root))).join('\n\n');
}

/** /forge-status --cost：成本统计 + 各流程预算 */
export function renderCostView(store: StateStore, config: FlowConfig, now = new Date()): string {
  const budgets = visibleFlows(store).flatMap((f) => { const b = budgetState(store, config, f, now); return b ? [`${f.id} ${formatBudget(b)}`] : []; });
  return [formatCost(costReport(store), store.listFixLogs()), ...budgets].join('\n\n');
}
