// 调度：选哪个任务、并行几个由程序决定。纯函数。
import type { TaskFile } from '../state/schemas.ts';
import { conflictsWith, remainingPath } from '../state/dag.ts';
import { IN_FLIGHT, isAuxKind } from '../state/state-machine.ts';

/**
 * 从 ready 中按关键路径优先挑选可派发的任务，总运行数不超过 maxParallel。
 * writes 互斥只是优先级：先挑不与在途任务、也不彼此重叠的；名额还有剩而只剩重叠的，也派出去——
 * 冲突由只追加合并与交回 worker 解决，串行等待比解决冲突更贵。
 */
export function selectDispatchable(tasks: readonly TaskFile[], stage: string, maxParallel: number, maxParallelAux: number = maxParallel): string[] {
  const priority = remainingPath(tasks);
  const inflight = tasks.filter((t) => IN_FLIGHT.includes(t.status));
  // 两个池：实施池与辅助池（review、qa）各自计数，与状态机的 dispatch 检查一致
  const running = tasks.filter((t) => t.status === 'in_progress');
  const capacity = { impl: maxParallel - running.filter((t) => !isAuxKind(t.kind)).length, aux: maxParallelAux - running.filter((t) => isAuxKind(t.kind)).length };
  const pool = (t: TaskFile): 'impl' | 'aux' => (isAuxKind(t.kind) ? 'aux' : 'impl');
  const ready = tasks.filter((t) => t.status === 'ready' && t.stage === stage)
    .sort((a, b) => (priority.get(b.id)! - priority.get(a.id)!) || a.id.localeCompare(b.id));
  const picked: TaskFile[] = [];
  const overlapping: TaskFile[] = [];
  for (const t of ready) {
    if (capacity[pool(t)] <= 0) continue;
    // merge-fix 任务不与它所修复的（挂起中的）原任务互斥
    if (inflight.some((x) => x.id !== t.merge_fix_for && conflictsWith(x, t)) || picked.some((x) => conflictsWith(x, t))) { overlapping.push(t); continue; }
    picked.push(t);
    capacity[pool(t)]--;
  }
  // 没别的可跑时，重叠的也派（仍按关键路径顺序）
  for (const t of overlapping) {
    if (capacity[pool(t)] <= 0) continue;
    picked.push(t);
    capacity[pool(t)]--;
  }
  return picked.map((t) => t.id);
}
