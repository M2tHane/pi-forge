// 来源：pi-flow src/core/lineage.ts @ 31f3f15
// 模块谱系（第六轮 B4）：一个模块连同它派生的任务（合并冲突 merge-fix、验收与复查、验收修复、审查修复、闸门修复）。
// 派生任务各自从 0 计失败次数，整条链没有总上限时可以一直绕圈；这里按谱系累计运行次数与时长，超过上限就交给用户。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { RunFile, TaskFile } from './schemas.ts';
import { runBudgetMinutes } from './run-budget.ts';

export const DEFAULT_MODULE_RUNS = 8;
export const MODULE_MINUTES_FACTOR = 4;

/** 派生任务指向的上游任务 */
const parentOf = (t: TaskFile): string | undefined => t.merge_fix_for ?? t.accept_of ?? t.fork_from_task;

/** 谱系的根（模块任务本身）：沿 merge_fix_for、accept_of、fork_from_task 一路向上 */
export function lineageRoot(t: TaskFile, byId: ReadonlyMap<string, TaskFile>): TaskFile {
  let cur = t;
  const seen = new Set<string>();
  for (let p = parentOf(cur); p && byId.has(p) && !seen.has(p); p = parentOf(cur)) {
    seen.add(cur.id);
    cur = byId.get(p)!;
  }
  return cur;
}

/** 谱系里的全部任务（根与所有派生任务） */
export function lineageTasks(root: TaskFile, tasks: readonly TaskFile[]): TaskFile[] {
  const byId = new Map(tasks.map((x) => [x.id, x]));
  return tasks.filter((x) => lineageRoot(x, byId).id === root.id);
}

export interface LineageUsage { root: TaskFile; tasks: string[]; runs: RunFile[]; minutes: number; maxRuns: number; maxMinutes: number }

/** 谱系自用户最近一次解除阻塞以来的运行（模型暂停的不算） */
export function lineageUsage(store: StateStore, config: FlowConfig, flowId: string, task: TaskFile, now: Date): LineageUsage {
  const all = store.listTasks(flowId);
  const root = lineageRoot(task, new Map(all.map((x) => [x.id, x])));
  const ids = new Set(lineageTasks(root, all).map((x) => x.id));
  // 用户解除阻塞后重新计算：给用户一个"再试一轮"的余地
  const since = store.readEvents().filter((e) => e.flow === flowId && e.task && ids.has(e.task) && e.type === 'transition' && e.trigger === 'unblock').at(-1)?.ts ?? '';
  const runs = store.listRuns().filter((r) => r.flow === flowId && r.task && ids.has(r.task) && r.started_at >= since && r.outcome !== 'unavailable');
  const minutes = runs.reduce((n, r) => n + Math.max(0, (Date.parse(r.ended_at ?? now.toISOString()) - Date.parse(r.started_at)) / 60_000), 0);
  return {
    root, tasks: [...ids], runs, minutes,
    maxRuns: config.limits.module_runs ?? DEFAULT_MODULE_RUNS,
    maxMinutes: config.limits.module_minutes ?? MODULE_MINUTES_FACTOR * runBudgetMinutes(config, root),
  };
}

/** 超过谱系预算时返回交给用户的原因（含各次运行的结果与最近的失败），否则 null */
export function lineageExceeded(store: StateStore, config: FlowConfig, flowId: string, task: TaskFile, now: Date): string | null {
  const u = lineageUsage(store, config, flowId, task, now);
  if (u.runs.length < u.maxRuns && u.minutes < u.maxMinutes) return null;
  const tasks = store.listTasks(flowId).filter((t) => u.tasks.includes(t.id));
  const fails = tasks.filter((t) => t.last_failure).map((t) => `${t.id}：${t.last_failure!.replace(/\s+/g, ' ').slice(0, 160)}`);
  const outcomes = u.runs.map((r) => `${r.task}/${r.role}:${r.outcome ?? '运行中'}`).join('、');
  return `模块 ${u.root.id}「${u.root.title.slice(0, 40)}」连同派生任务（${u.tasks.join('、')}）已运行 ${u.runs.length} 次、累计 ${Math.round(u.minutes)} 分钟，超过上限（${u.maxRuns} 次 / ${u.maxMinutes} 分钟），再做下去多半是在绕圈。各次运行：${outcomes}${fails.length ? `。最近的失败：${fails.join('；')}` : ''}。请看看要不要拆小、改需求或换模型，处理后 /forge unblock ${task.id}`;
}
