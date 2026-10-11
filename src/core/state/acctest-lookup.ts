// 从 acceptance/acceptance-flow.ts 抽出的纯函数（state/waits 在最底层也要用，偏离 106）：只依赖 TaskFile。
import type { TaskFile } from './schemas.ts';

export const roundOf = (id: string) => Number(/\.at-(\d+)$/.exec(id)?.[1] ?? 1);

/** 某个 impl 最新的验收测试 task（忽略已取消的）；没有时为 undefined */
export function latestAcctest<T extends Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status'>>(tasks: readonly T[], impl: string): T | undefined {
  return tasks.filter((t) => t.kind === 'acctest' && t.for_task === impl && t.status !== 'cancelled').sort((a, b) => roundOf(a.id) - roundOf(b.id)).at(-1);
}

/** impl 合入前要等的验收测试：最新一轮，但硬依赖 impl 的（impl 合入后才写，第 9.5 节单独合并）不等；纯函数 */
export function awaitedAcctest<T extends Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status' | 'depends_on'>>(tasks: readonly T[], impl: string): T | undefined {
  const latest = latestAcctest(tasks, impl);
  return latest && !latest.depends_on.some((d) => d.type === 'hard' && d.task === impl) ? latest : undefined;
}
