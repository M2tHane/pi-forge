// "一个 task 在等谁"的唯一定义（纯函数，不读写文件）。
// 派发器（advanceInputs）、状态仓库（转移的 facts、合并队列的合格判断）、合并队列、状态视图、doctor 与测试辅助都从这里取，
// 不再各写一份；规则变了（例如偏离 72 的 awaitedAcctest）只改这里和 acceptance-flow.ts。
import type { TaskFile } from './schemas.ts';
import { awaitedAcctest, latestAcctest } from './acceptance-flow.ts';

type WaitTask = Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status' | 'depends_on' | 'waits_for' | 'acctest_round' | 'blocked_reason'>;

const isDone = (tasks: readonly Pick<TaskFile, 'id' | 'status'>[], id: string) => tasks.find((x) => x.id === id)?.status === 'done';

/** 软依赖的生产方都已 done */
export function softDepsDone(task: Pick<TaskFile, 'depends_on'>, tasks: readonly Pick<TaskFile, 'id' | 'status'>[]): boolean {
  return task.depends_on.every((d) => d.type !== 'soft' || isDone(tasks, d.task));
}

/** 合入前要等的验收测试（awaitedAcctest）已 done，或没有要等的 */
export function awaitedAcctestDone(task: Pick<TaskFile, 'id' | 'for_task'>, tasks: readonly WaitTask[]): boolean {
  const at = awaitedAcctest(tasks, task.for_task ?? task.id);
  return !at || at.status === 'done';
}

/**
 * 没结束的 task 在等哪些 task（未 done 的）：
 * pending 等未 done 的硬依赖；awaiting_inputs 等 awaitedAcctest、未 done 的软依赖、未 done 的 waits_for；
 * disputed 等它的争议 .at-n（最新一轮，且是这个 task 提的争议或裁决轮，规则同 resolveDisputes）。
 * 其余状态由运行者或程序步骤推进，不等别的 task。
 */
export function waitsOn(task: WaitTask, tasks: readonly WaitTask[]): string[] {
  const notDone = (id: string) => !isDone(tasks, id);
  if (task.status === 'pending') return task.depends_on.filter((d) => d.type === 'hard' && notDone(d.task)).map((d) => d.task);
  if (task.status === 'awaiting_inputs') {
    const at = awaitedAcctest(tasks, task.for_task ?? task.id);
    return [...new Set([
      ...(at && !awaitedAcctestDone(task, tasks) ? [at.id] : []),
      ...task.depends_on.filter((d) => d.type === 'soft' && notDone(d.task)).map((d) => d.task),
      ...(task.waits_for ?? []).filter(notDone),
    ])];
  }
  if (task.status === 'disputed') {
    const at = latestAcctest(tasks, task.for_task ?? task.id);
    if (at && (at.acctest_round?.from_task === task.id || at.acctest_round?.kind === 'decide') && at.status !== 'done') return [at.id];
  }
  return [];
}

export interface Stall {
  /** cycle：互相等待；blocked / cancelled：等的 task 已阻塞或已取消，不会自己好 */
  kind: 'cycle' | 'blocked' | 'cancelled';
  /** 涉及的 task（环里的全部成员；blocked / cancelled 时是等待方） */
  tasks: string[];
  /** blocked / cancelled 时是被等的 task */
  target?: string;
  reason: string;
}

/** 停滞：等待图中的环，以及等待链走到 blocked / cancelled 的 task（只报直接等待方，更上游的等待者是它的后果）。结果稳定排序、去重 */
export function stalls(tasks: readonly WaitTask[]): Stall[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const out = new Map<string, Stall>();
  const edges = new Map(open.map((t) => [t.id, waitsOn(t, tasks)]));
  for (const t of open) {
    for (const w of edges.get(t.id)!) {
      const target = byId.get(w);
      if (target?.status === 'cancelled') out.set(`cancelled:${t.id}:${w}`, { kind: 'cancelled', tasks: [t.id], target: w, reason: `${t.id} 在等 ${w}，但 ${w} 已取消` });
      else if (target?.status === 'blocked') out.set(`blocked:${t.id}:${w}`, { kind: 'blocked', tasks: [t.id], target: w, reason: `${t.id} 在等 ${w}，但 ${w} 已阻塞${target.blocked_reason ? `：${target.blocked_reason.replace(/\s+/g, ' ').slice(0, 120)}` : ''}` });
    }
    // 最短的回到自己的路径 = 经过 t 的环
    const parent = new Map<string, string>();
    const queue = [t.id];
    let closing: string | null = null;
    for (let i = 0; i < queue.length && !closing; i++) {
      for (const w of edges.get(queue[i]!) ?? []) {
        if (w === t.id) { closing = queue[i]!; break; }
        if (!parent.has(w) && edges.has(w)) { parent.set(w, queue[i]!); queue.push(w); }
      }
    }
    if (!closing) continue;
    const members = [closing];
    while (members[0] !== t.id) members.unshift(parent.get(members[0]!)!);
    const sorted = [...members].sort();
    const key = `cycle:${sorted.join(',')}`;
    if (out.has(key)) continue;
    // 从最小的成员开始写，原因文字与从哪个 task 开始搜无关
    members.push(...members.splice(0, members.indexOf(sorted[0]!)));
    const hops = members.map((m, i) => `${m} 等 ${members[(i + 1) % members.length]}`);
    out.set(key, { kind: 'cycle', tasks: sorted, reason: `${sorted.join('、')} 互相等待，谁也不会先动（${hops.join('，')}）` });
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
}

/** 停滞的可读摘要（测试辅助与 doctor 用） */
export const formatStalls = (list: readonly Stall[]): string => list.map((s) => s.reason).join('；');
