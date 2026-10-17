// 调度：选哪个任务、并行几个由程序决定。纯函数。
import type { TaskFile } from '../state/schemas.ts';
import { remainingPath } from '../state/dag.ts';
import { poolLimit, poolOf, type Pool, type PoolLimits } from '../state/state-machine.ts';

/**
 * 从 ready 中按关键路径优先挑选可派发的任务。各池分别计数（与状态机的 dispatch 检查一致）：
 * backend 不超过 max_parallel_backend，frontend 同时只有 1 个，aux（审查、验收）不超过 max_parallel_aux，其余不超过 max_parallel。
 * 不按 writes 排优先级：后端按 domain 拆开、前端单人，冲突由只追加合并与交回原 agent 解决。
 */
export function selectDispatchable(tasks: readonly TaskFile[], stage: string, limits: PoolLimits): string[] {
  const priority = remainingPath(tasks);
  const running = tasks.filter((t) => t.status === 'in_progress');
  const capacity = new Map<Pool, number>();
  const left = (p: Pool) => capacity.get(p) ?? poolLimit(p, limits) - running.filter((t) => poolOf(t) === p).length;
  const picked: string[] = [];
  const ready = tasks.filter((t) => t.status === 'ready' && t.stage === stage)
    .sort((a, b) => (priority.get(b.id)! - priority.get(a.id)!) || a.id.localeCompare(b.id));
  for (const t of ready) {
    const p = poolOf(t);
    const n = left(p);
    if (n <= 0) continue;
    picked.push(t.id);
    capacity.set(p, n - 1);
  }
  return picked;
}
