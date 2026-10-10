// 来源：pi-flow src/core/scheduler.ts @ 31f3f15
// 调度：选哪个任务、并行几个由程序决定（第 11 节第 8 条）。纯函数。
import type { TaskFile } from './schemas.ts';
import { conflictsWith, remainingPath } from './dag.ts';
import { IN_FLIGHT } from './state-machine.ts';

/** 从 ready 中按关键路径优先挑选可派发的任务：不与在途任务互斥、彼此不互斥、总运行数不超过 maxParallel。 */
export function selectDispatchable(tasks: readonly TaskFile[], stage: string, maxParallel: number): string[] {
  const priority = remainingPath(tasks);
  const inflight = tasks.filter((t) => IN_FLIGHT.includes(t.status));
  let capacity = maxParallel - tasks.filter((t) => t.status === 'in_progress').length;
  const ready = tasks.filter((t) => t.status === 'ready' && t.stage === stage)
    .sort((a, b) => (priority.get(b.id)! - priority.get(a.id)!) || a.id.localeCompare(b.id));
  const picked: TaskFile[] = [];
  for (const t of ready) {
    if (capacity <= 0) break;
    // merge-fix 任务不与它所修复的（挂起中的）原任务互斥；同一 impl 谱系里的验收测试 task 与实现 task 也不互斥（偏离 87）
    if (inflight.some((x) => x.id !== t.merge_fix_for && !sameLineageAcctest(x, t) && conflictsWith(x, t)) || picked.some((x) => !sameLineageAcctest(x, t) && conflictsWith(x, t))) continue;
    picked.push(t);
    capacity--;
  }
  return picked.map((t) => t.id);
}

/**
 * 同一 impl 谱系（impl 本身、它的 .fx-n、.at、.at-n）里一方是验收测试 task：二者由争议与单独合并协调，.at 在隔离工作区里写、
 * 补丁只进 acc 分支，不需要按 writes 互斥。M9 冒烟：S0 的 .fx-1（继承 tests/acceptance/_support/**）提出争议后等 .at-2，
 * .at-2 的 tests/acceptance/_support/T-002/** 与它重叠被互斥挡住，两边互等。
 */
function sameLineageAcctest(a: Pick<TaskFile, 'id' | 'kind' | 'for_task'>, b: Pick<TaskFile, 'id' | 'kind' | 'for_task'>): boolean {
  return (a.kind === 'acctest' || b.kind === 'acctest') && (a.for_task ?? a.id) === (b.for_task ?? b.id);
}
