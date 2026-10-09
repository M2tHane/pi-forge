// 来源：pi-flow src/core/flow-watch.ts @ 31f3f15（改名）
// 流程层面的时间与停滞（第六轮 B6）：流程墙钟（不含等用户的时间）、停滞看守、"流程卡住"判定。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { FlowEvent, FlowFile, TaskFile } from './schemas.ts';
import { DESIGN_STAGES } from '../modes/plan.ts';

export const DEFAULT_STALL_MINUTES = 20;

/** 不计入流程墙钟的时段：等用户审批，以及需求阶段（和用户讨论、接收检查） */
const userTime = (stage: string, status: string) => status === 'awaiting_human' || stage === 'D0';

/** 流程已用的分钟数：从创建起，按阶段事件排除等用户的时段 */
export function activeMinutes(flow: FlowFile, events: readonly FlowEvent[], now: Date): number {
  let stage = flow.stages[0]!;
  let status = 'active';
  let since = Date.parse(flow.created_at);
  let ms = 0;
  for (const e of events) {
    if (e.flow !== flow.id || e.data?.['entity'] !== 'stage' || !e.to) continue;
    const at = Date.parse(e.ts);
    if (!userTime(stage, status)) ms += Math.max(0, at - since);
    since = at;
    // 阶段内状态转移带 data.stage；进入下一阶段的事件 to 是新阶段名
    if (typeof e.data['stage'] === 'string') status = e.to;
    else { stage = e.to; status = 'active'; }
  }
  if (!userTime(stage, status)) ms += Math.max(0, now.getTime() - since);
  return ms / 60_000;
}

const OPEN = (t: TaskFile) => t.status !== 'done' && t.status !== 'cancelled';

/**
 * 流程卡住：当前阶段还有没完成的任务，但它们全部 blocked，或者还没开始、只因为（直接或间接）依赖 blocked 任务。
 * 返回要用户决定的 blocked 任务；没有卡住返回 null。
 */
export function stuckTasks(flow: FlowFile, tasks: readonly TaskFile[]): TaskFile[] | null {
  if (flow.stage_status !== 'active' || DESIGN_STAGES.has(flow.stage)) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = tasks.filter((t) => t.stage === flow.stage && OPEN(t));
  if (!open.length) return null;
  const memo = new Map<string, boolean>();
  const waitsOnBlocked = (t: TaskFile, seen: Set<string>): boolean => {
    if (t.status === 'blocked') return true;
    if (t.status !== 'pending') return false;
    if (memo.has(t.id)) return memo.get(t.id)!;
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    const r = t.depends_on.some((d) => { const x = byId.get(d.task); return !!x && OPEN(x) && waitsOnBlocked(x, seen); });
    memo.set(t.id, r);
    return r;
  };
  if (!open.every((t) => waitsOnBlocked(t, new Set()))) return null;
  return open.filter((t) => t.status === 'blocked');
}

export interface Stall { minutes: number; since: string; seq: number }

/**
 * 停滞：执行阶段、不在等用户、没有运行中的任务（没有租约）、limits.stall_minutes 内这个流程没有任何事件。
 * 卡住（stuckTasks）另外报告，这里不重复。
 */
export function stallOf(store: StateStore, config: FlowConfig, flow: FlowFile, now: Date): Stall | null {
  if (flow.stage_status !== 'active' || DESIGN_STAGES.has(flow.stage)) return null;
  if (flow.replan_request || store.readRevision(flow.id)?.status === 'proposed') return null;
  const tasks = store.listTasks(flow.id);
  if (tasks.some((t) => t.lease) || stuckTasks(flow, tasks)) return null;
  const last = [...store.readEvents()].reverse().find((e) => e.flow === flow.id);
  if (!last) return null;
  const minutes = (now.getTime() - Date.parse(last.ts)) / 60_000;
  const limit = config.limits.stall_minutes ?? DEFAULT_STALL_MINUTES;
  return minutes >= limit ? { minutes: Math.floor(minutes), since: last.ts, seq: last.seq } : null;
}
