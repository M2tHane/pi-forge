// DAG：依赖校验、环检测、ready 计算、关键路径与宽度统计。纯函数，不做 IO。依赖只有硬依赖（done 之后才能开工）。
import type { TaskFile } from './schemas.ts';
import { globWithin } from './paths.ts';

type DagTask = Pick<TaskFile, 'id' | 'kind' | 'role' | 'scopes' | 'depends_on' | 'writes' | 'verify'>;

export interface DagCatalog {
  roles: Record<string, { scopes: string[] }>;
  scopes: Record<string, string[]>;
  commands: string[];
  maxTaskFiles: number;
}

export interface DagValidation {
  errors: string[];
  warnings: string[];
}

export function validateDag(tasks: readonly DagTask[], catalog: DagCatalog): DagValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, DagTask>();

  for (const t of tasks) {
    if (byId.has(t.id)) errors.push(`任务 id 重复：${t.id}`);
    byId.set(t.id, t);
  }

  for (const t of tasks) {
    const role = catalog.roles[t.role];
    if (!role) errors.push(`${t.id}：角色 ${t.role} 不存在`);
    for (const s of t.scopes) {
      if (!(s in catalog.scopes)) errors.push(`${t.id}：scope ${s} 不存在`);
      else if (role && !role.scopes.includes(s)) errors.push(`${t.id}：角色 ${t.role} 不拥有 scope ${s}`);
    }
    for (const c of t.verify) {
      if (!catalog.commands.includes(c)) errors.push(`${t.id}：verify 引用了未定义的命令 ${c}，只能使用 workflow.yaml 的 commands`);
    }
    if (role) {
      const allowed = t.scopes.filter((s) => role.scopes.includes(s)).flatMap((s) => catalog.scopes[s] ?? []);
      for (const w of t.writes) {
        if (!allowed.some((o) => globWithin(w, o))) errors.push(`${t.id}：writes ${w} 越出了任务 scopes 的可写范围`);
      }
    }
    if (t.writes.length > catalog.maxTaskFiles) {
      warnings.push(`${t.id}：writes 有 ${t.writes.length} 项，超过 max_task_files=${catalog.maxTaskFiles}，建议拆分`);
    }
    const seen = new Set<string>();
    for (const d of t.depends_on) {
      if (d.task === t.id) errors.push(`${t.id}：不能依赖自己`);
      if (!byId.has(d.task)) errors.push(`${t.id}：依赖的任务 ${d.task} 不存在`);
      if (seen.has(d.task)) errors.push(`${t.id}：对 ${d.task} 的依赖重复声明`);
      seen.add(d.task);
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) errors.push(`依赖存在环：${cycle.join(' -> ')}`);

  return { errors, warnings };
}

/** 返回环上的任务 id 序列（首尾相同），无环返回 null。 */
export function findCycle(tasks: readonly Pick<TaskFile, 'id' | 'depends_on'>[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on.map((d) => d.task)]));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const n of deps.get(id) ?? []) {
      if (!deps.has(n)) continue;
      const c = color.get(n) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(n)), n];
      if (c === 0) {
        const r = visit(n);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) === 0) {
      const r = visit(t.id);
      if (r) return r;
    }
  }
  return null;
}

type ReadyTask = Pick<TaskFile, 'id' | 'stage' | 'status' | 'depends_on'>;

/** 依赖直接取真实状态；只有 done 满足依赖。 */
export function depStatus(t: Pick<TaskFile, 'status'>): string {
  return t.status;
}

/** 当前 stage 中所有依赖都已 done 的 pending 任务。 */
export function computeReady(tasks: readonly ReadyTask[], stage: string): string[] {
  const status = new Map(tasks.map((t) => [t.id, depStatus(t)]));
  return tasks
    .filter((t) => t.stage === stage && t.status === 'pending' && hardDepsDone(t, status))
    .map((t) => t.id);
}

export function hardDepsDone(t: Pick<TaskFile, 'depends_on'>, status: ReadonlyMap<string, string>): boolean {
  return t.depends_on.every((d) => status.get(d.task) === 'done');
}

type StatTask = Pick<TaskFile, 'id' | 'depends_on'>;

/** 每个任务到汇点的最长硬依赖路径（含自身），用于调度优先级。要求无环。 */
export function remainingPath(tasks: readonly StatTask[]): Map<string, number> {
  const succ = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const d of t.depends_on) if (d.type === 'hard') succ.get(d.task)?.push(t.id);
  }
  const memo = new Map<string, number>();
  const go = (id: string): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const r = 1 + Math.max(0, ...(succ.get(id) ?? []).map(go));
    memo.set(id, r);
    return r;
  };
  for (const t of tasks) go(t.id);
  return memo;
}

export interface DagStats {
  taskCount: number;
  criticalPathLength: number;
  criticalPath: string[];
  maxWidth: number;
  hardRatio: number;
}

/** 关键路径只计硬依赖；宽度按硬依赖分层统计；要求无环。 */
export function dagStats(tasks: readonly StatTask[]): DagStats {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const go = (id: string): number => {
    const hit = depth.get(id);
    if (hit !== undefined) return hit;
    let best = 0;
    let from: string | null = null;
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (d.type !== 'hard' || !byId.has(d.task)) continue;
      const v = go(d.task);
      if (v > best) { best = v; from = d.task; }
    }
    depth.set(id, best + 1);
    prev.set(id, from);
    return best + 1;
  };
  for (const t of tasks) go(t.id);

  let end: string | null = null;
  for (const t of tasks) if (end === null || depth.get(t.id)! > depth.get(end)!) end = t.id;
  const path: string[] = [];
  for (let cur = end; cur; cur = prev.get(cur) ?? null) path.unshift(cur);

  const levels = new Map<number, number>();
  for (const v of depth.values()) levels.set(v, (levels.get(v) ?? 0) + 1);

  const edges = tasks.flatMap((t) => t.depends_on);
  const hardCount = edges.filter((d) => d.type === 'hard').length;
  return {
    taskCount: tasks.length,
    criticalPathLength: path.length,
    criticalPath: path,
    maxWidth: Math.max(0, ...levels.values()),
    hardRatio: edges.length === 0 ? 0 : hardCount / edges.length,
  };
}

export interface DagReport {
  task_count: number;
  critical_path: string[];
  critical_path_length: number;
  max_width: number;
  hard_ratio: number;
  warnings: string[];
}

/** 任务数、关键路径长度（只计硬依赖）、最大并行宽度、硬依赖占比；关键路径过长时提示 */
/** 关键路径占任务数的比例超过它时提醒（第三轮 D：0.6 → 0.5） */
export const CRITICAL_PATH_RATIO = 0.5;
/** 同一阶段开头连续这么多层都只有一个任务时提醒 */
export const SERIAL_HEAD_LAYERS = 2;

/**
 * 每个阶段开头只能串行的任务链：按本阶段内的硬依赖分层，从第一层起连续宽度为 1 的层。
 * 任务少于 4 个的阶段不检查（本来就没多少可并行的）。
 */
export function serialHeads(tasks: readonly (StatTask & { stage?: string })[]): { stage: string | undefined; chain: string[]; total: number }[] {
  const out: { stage: string | undefined; chain: string[]; total: number }[] = [];
  for (const stage of [...new Set(tasks.map((t) => t.stage))]) {
    const group = tasks.filter((t) => t.stage === stage);
    if (group.length < 4) continue;
    const ids = new Set(group.map((t) => t.id));
    const local = group.map((t) => ({ id: t.id, depends_on: t.depends_on.filter((d) => ids.has(d.task)) }));
    const byId = new Map(local.map((t) => [t.id, t]));
    const depth = new Map<string, number>();
    const go = (id: string): number => {
      const hit = depth.get(id);
      if (hit !== undefined) return hit;
      depth.set(id, 1); // 防环（调用前已校验无环）
      const v = 1 + Math.max(0, ...(byId.get(id)?.depends_on ?? []).filter((d) => d.type === 'hard').map((d) => go(d.task)));
      depth.set(id, v);
      return v;
    };
    for (const t of local) go(t.id);
    const chain: string[] = [];
    for (let level = 1; ; level++) {
      const at = local.filter((t) => depth.get(t.id) === level);
      if (at.length !== 1) break;
      chain.push(at[0]!.id);
    }
    if (chain.length >= SERIAL_HEAD_LAYERS) out.push({ stage, chain, total: group.length });
  }
  return out;
}

export function dagReport(tasks: readonly (StatTask & { stage?: string })[], warnings: string[] = []): DagReport {
  const s = dagStats(tasks);
  const w = [...warnings];
  if (s.taskCount >= 4 && s.criticalPathLength / s.taskCount > CRITICAL_PATH_RATIO) {
    w.push(`关键路径 ${s.criticalPathLength} / 任务数 ${s.taskCount}：硬依赖可能用多了。只在真的需要对方的代码时才加依赖，让互不依赖的模块并行。`);
  }
  for (const h of serialHeads(tasks)) {
    w.push(`${h.stage ? `阶段 ${h.stage} ` : ''}开头 ${h.chain.length} 层只能串行（${h.chain.join(' → ')}），这段时间只有一个任务在跑：把底座合并成一个模块，让其他模块尽早并行。`);
  }
  return {
    task_count: s.taskCount, critical_path: s.criticalPath, critical_path_length: s.criticalPathLength,
    max_width: s.maxWidth, hard_ratio: Math.round(s.hardRatio * 100) / 100, warnings: w,
  };
}

export function formatDagReport(r: DagReport): string {
  return [
    `任务数 ${r.task_count}，关键路径长度 ${r.critical_path_length}（${r.critical_path.join(' → ')}），最大并行宽度 ${r.max_width}，硬依赖占比 ${Math.round(r.hard_ratio * 100)}%`,
    ...r.warnings.map((x) => `! ${x}`),
  ].join('\n');
}
