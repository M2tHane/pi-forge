// plan.yaml 的校验、DAG 推导与派生 task。全部是纯函数，不做 IO。
import { parse as parseYaml } from 'yaml';
import { Value } from 'typebox/value';
import type { ContractCatalog } from './contract-check.ts';
import { HTTP_METHODS } from './contract-check.ts';
import type { EffectiveSpec } from '../spec/spec.ts';
import { PlanFile, validate, type TaskFile } from '../state/schemas.ts';
import type { TaskInput } from '../state/state-store.ts';
import { conflictsWith, dagReport, findCycle, mutexPairs, type DagReport } from '../state/dag.ts';
import { globsOverlap, ownAcceptanceGlob } from '../state/paths.ts';

export const PLAN_PATH = 'docs/plan/plan.yaml';
/** S0（由 architect 执行）额外可写的验收目录与项目规则 rules/** */
export const S0_EXTRA_WRITES = ['tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**', 'rules/**'] as const;
/** impl 的 writes 不能覆盖这些路径：验收测试目录由程序派生，规格只经 forge_spec，契约只能由程序核实的追加修改 */
export const FORBIDDEN_WRITES = ['tests/acceptance/**', 'docs/PRD.md', 'docs/prototype/**', 'docs/contracts/**', '.forge/**', '.git/**', 'workflow.yaml', 'rules/**', '.pi/**'] as const;

export { isTestWrite } from '../state/paths.ts';

/** writes 与 FORBIDDEN_WRITES 重叠时返回重叠的那一项；没有则 undefined */
export const forbiddenWriteOf = (w: string): string | undefined => FORBIDDEN_WRITES.find((f) => globsOverlap(w, f));

export type SymbolKind = 'api' | 'table' | 'error' | 'fn' | 'page' | 'lib';
export interface PlanSymbol { kind: SymbolKind; /** 规范写法，例如 `api:POST /api/x` */ key: string; soft: boolean }

export interface PlanContext {
  catalog: ContractCatalog;
  spec: Pick<EffectiveSpec, 'reqs' | 'screens'>;
  /** 流程里已有的 task 编号（P1 的 architect task 等），plan 不能复用 */
  existingTaskIds: readonly string[];
  /** 变更请求的修订才允许 task 写 modifies；P1 的计划里不能写 */
  allowModifies?: boolean;
  /** critical_fanout：被这么多 task 硬依赖的是底座，审查用强模型（报告里列出）；0 或不给时不算 */
  limits: { max_parallel: number; max_task_files: number; critical_fanout?: number };
}

export interface PlanReport {
  stages: { id: string; goal: string; tasks: string[] }[];
  mutex: [string, string][];
  dag: DagReport;
  /** 审查会用强模型的 task 与原因（批准页列给用户看） */
  strong: { task: string; why: string }[];
}

export interface PlanCheck {
  errors: string[];
  warnings: string[];
  /** 没有错误时给出 */
  report: PlanReport | null;
  /** 推导出的依赖边，键是 task 编号 */
  deps: Map<string, TaskFile['depends_on']>;
}

const PLAN_LISTS = ['layers', 'ac', 'writes', 'produces', 'requires'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 解析 plan.yaml 文本并按 schema 校验形状：没见过的字段忽略，task 的列表字段、阶段的 exit 缺省为空 */
export function parsePlan(text: string): { plan: PlanFile | null; errors: string[] } {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (e) { return { plan: null, errors: [`${PLAN_PATH} 不是合法的 YAML：${(e as Error).message.split('\n')[0]}`] }; }
  if (isObj(raw)) {
    const fill = (x: unknown, defaults: Record<string, unknown>) => isObj(x) ? { ...defaults, ...Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null)) } : x;
    raw = Value.Clean(PlanFile, {
      ...raw,
      ...(Array.isArray(raw['stages']) ? { stages: raw['stages'].map((s) => fill(s, { exit: [] })) } : {}),
      ...(Array.isArray(raw['tasks']) ? { tasks: raw['tasks'].map((t) => fill(t, Object.fromEntries(PLAN_LISTS.map((k) => [k, []])))) } : {}),
    });
  }
  const errors = validate('plan', raw);
  return errors.length ? { plan: null, errors: errors.map((e) => `${PLAN_PATH}：${e}`) } : { plan: raw as PlanFile, errors: [] };
}

/** 解析符号；不合法时返回错误说明 */
export function parseSymbol(text: string): PlanSymbol | string {
  const soft = text.startsWith('~');
  const s = soft ? text.slice(1) : text;
  const m = s.match(/^(api|table|error|fn|page|lib):(.+)$/);
  if (!m) return `符号 ${text} 必须以 api:、table:、error:、fn:、page:、lib: 之一开头`;
  const kind = m[1] as SymbolKind;
  const body = m[2]!.trim();
  if (kind === 'api') {
    const a = body.match(/^([A-Za-z]+)\s+(\/\S*)$/);
    if (!a || !(HTTP_METHODS as readonly string[]).includes(a[1]!.toLowerCase())) return `符号 ${text} 应写成 api:<METHOD> <path>，例如 api:POST /api/datasources`;
    return { kind, key: `api:${a[1]!.toUpperCase()} ${a[2]}`, soft };
  }
  if (kind === 'fn' && !/^[^#\s]+#[^#\s]+$/.test(body)) return `符号 ${text} 应写成 fn:<module>#<name>`;
  if (kind === 'page' && !body.startsWith('/')) return `符号 ${text} 应写成 page:<route>，route 以 / 开头`;
  if (!body || /\s/.test(body)) return `符号 ${text} 的名字不能为空或包含空白`;
  return { kind, key: `${kind}:${body}`, soft };
}

/** 符号在契约（或规格的页面）里能否找到；lib: 只要求有生产方 */
function symbolExists(sym: PlanSymbol, ctx: PlanContext): boolean {
  const body = sym.key.slice(sym.kind.length + 1);
  switch (sym.kind) {
    case 'api': return ctx.catalog.apis.has(body);
    case 'table': return ctx.catalog.tables.has(body);
    case 'error': return ctx.catalog.errors.has(body);
    case 'fn': return ctx.catalog.fns.has(body);
    case 'page': return ctx.spec.screens.some((s) => s.route === body);
    case 'lib': return true;
  }
}

const acKeys = (spec: PlanContext['spec']) => {
  const out = new Map<string, { req: string; manual: boolean; mvp: boolean }>();
  for (const r of spec.reqs) for (const ac of r.acs) out.set(`${r.id}.${ac.id}`, { req: r.id, manual: ac.manual, mvp: r.priority === 'MVP' });
  return out;
};

export function checkPlan(plan: PlanFile, ctx: PlanContext): PlanCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const deps = new Map<string, TaskFile['depends_on']>();

  // 阶段：S0、S1……连续编号；exit 引用存在的 REQ
  const stageIdx = new Map<string, number>();
  plan.stages.forEach((s, i) => {
    if (s.id !== `S${i}`) errors.push(`阶段编号必须按顺序写成 S0、S1、S2……，第 ${i + 1} 个阶段是 ${s.id}`);
    if (stageIdx.has(s.id)) errors.push(`阶段 ${s.id} 重复`);
    stageIdx.set(s.id, i);
  });
  const reqIds = new Set(ctx.spec.reqs.map((r) => r.id));
  const exitOf = new Map<string, string[]>();
  for (const s of plan.stages) {
    for (const r of s.exit) {
      if (!reqIds.has(r)) errors.push(`阶段 ${s.id} 的 exit 引用了不存在的需求 ${r}`);
      exitOf.set(r, [...(exitOf.get(r) ?? []), s.id]);
    }
  }
  // 需求与 AC 的分配只提醒（覆盖率报告按它对账），不拦计划
  for (const r of ctx.spec.reqs.filter((x) => x.priority === 'MVP')) {
    const at = exitOf.get(r.id) ?? [];
    if (!at.length) warnings.push(`MVP 需求 ${r.id} 没有出现在任何阶段的 exit 中`);
    if (at.length > 1) warnings.push(`需求 ${r.id} 出现在多个阶段的 exit 中：${at.join('、')}`);
  }

  // task：编号、阶段、S0 的数量
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (!/^T-\d{3,}$/.test(t.id)) errors.push(`task 编号 ${t.id} 必须写成 T-数字（.at、.rv、.fx 后缀由程序派生）`);
    if (ids.has(t.id)) errors.push(`task 编号 ${t.id} 重复`);
    if (ctx.existingTaskIds.includes(t.id)) errors.push(`task 编号 ${t.id} 已被流程里的 task 使用，请从 ${nextFree(ctx.existingTaskIds)} 起编号`);
    ids.add(t.id);
    if (!stageIdx.has(t.stage)) errors.push(`${t.id} 的阶段 ${t.stage} 不在 stages 中`);
    if (t.modifies && !ctx.allowModifies) errors.push(`${t.id} 写了 modifies：只有变更请求的修订可以新增"修改 task"，P1 的计划不能写`);
    if (t.writes.length > ctx.limits.max_task_files) warnings.push(`${t.id} 的 writes 有 ${t.writes.length} 项，超过 max_task_files=${ctx.limits.max_task_files}，建议拆分`);
  }
  for (const s of plan.stages) {
    const n = plan.tasks.filter((t) => t.stage === s.id).length;
    if (s.id === 'S0' && n !== 1) errors.push(`S0 只能有 1 个 task，现在有 ${n} 个`);
    else if (n === 0) errors.push(`阶段 ${s.id} 没有 task`);
    if (n > ctx.limits.max_parallel * 3) warnings.push(`阶段 ${s.id} 有 ${n} 个 task，超过 max_parallel × 3 = ${ctx.limits.max_parallel * 3}，固定开销会很高，考虑合并`);
  }

  const planIds = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const t of plan.tasks) {
    if (!t.modifies || !ctx.allowModifies) continue;
    const target = planIds.get(t.modifies);
    if (!target) errors.push(`${t.id} 的 modifies ${t.modifies} 不在计划里`);
    else if (target.modifies) errors.push(`${t.id} 的 modifies ${t.modifies} 本身也是修改 task，请指向最初的 task`);
    else if (t.modifies === t.id) errors.push(`${t.id} 的 modifies 不能指向自己`);
  }

  // AC：存在、不含 manual；MVP 的非 manual AC 恰好分配一次；exit 需求的 AC 分配在本阶段或更早
  const acs = acKeys(ctx.spec);
  const owner = new Map<string, string[]>();
  // 修改 task 重复列出原 task 已负责的 AC 不算再分配一次（先算普通 task，再算修改 task）
  for (const t of [...plan.tasks.filter((x) => !x.modifies), ...plan.tasks.filter((x) => x.modifies)]) {
    for (const ac of t.ac) {
      const info = acs.get(ac);
      if (!info) { errors.push(`${t.id} 的 ac ${ac} 在规格中不存在（写成 REQ-012.AC1）`); continue; }
      if (info.manual) warnings.push(`${t.id} 的 ac ${ac} 是 manual 条目，由用户验收，不需要分配给 task`);
      if (!info.mvp) warnings.push(`${t.id} 的 ac ${ac} 属于非 MVP 需求 ${info.req}`);
      if (t.modifies && owner.get(ac)?.includes(t.modifies)) continue;
      owner.set(ac, [...(owner.get(ac) ?? []), t.id]);
    }
  }
  for (const [ac, info] of acs) {
    if (!info.mvp || info.manual) continue;
    const o = owner.get(ac) ?? [];
    if (!o.length) warnings.push(`MVP 验收标准 ${ac} 没有分配给任何 task`);
    if (o.length > 1) warnings.push(`验收标准 ${ac} 分配给了多个 task：${o.join('、')}`);
  }
  const taskStage = new Map(plan.tasks.map((t) => [t.id, t.stage]));
  for (const s of plan.stages) {
    for (const req of s.exit) {
      for (const [ac, info] of acs) {
        if (info.req !== req || info.manual) continue;
        for (const tid of owner.get(ac) ?? []) {
          if ((stageIdx.get(taskStage.get(tid)!) ?? 0) > stageIdx.get(s.id)!) warnings.push(`阶段 ${s.id} 的 exit 含 ${req}，但它的 ${ac} 分配给了更晚阶段的 ${tid}`);
        }
      }
    }
  }

  // 符号：用来推导依赖边；写错、找不到、多个生产方都只提醒（推导不出的边不加）。
  // 契约只写跨 task 的边界：没有别的 task 需要的产出不要求在契约里
  const requiredBy = new Map<string, Set<string>>();
  for (const t of plan.tasks) for (const r of t.requires) {
    const sym = parseSymbol(r);
    if (typeof sym !== 'string') requiredBy.set(sym.key, (requiredBy.get(sym.key) ?? new Set()).add(t.id));
  }
  const producer = new Map<string, string>();
  for (const t of plan.tasks) {
    for (const p of t.produces) {
      const sym = parseSymbol(p);
      if (typeof sym === 'string') { warnings.push(`${t.id} 的 produces：${sym}`); continue; }
      const others = [...(requiredBy.get(sym.key) ?? [])].some((id) => id !== t.id);
      if (others && !symbolExists(sym, ctx)) warnings.push(`${t.id} 产出的 ${sym.key} 在${sym.kind === 'page' ? '规格的 screens.md' : '契约'}中找不到`);
      const prev = producer.get(sym.key);
      if (prev) warnings.push(`${sym.key} 有多个生产方：${prev}、${t.id}（依赖按第一个推导）`);
      else producer.set(sym.key, t.id);
      const defined = sym.kind === 'api' ? ctx.catalog.apis.get(sym.key.slice(4)) : sym.kind === 'error' ? ctx.catalog.errors.get(sym.key.slice(6)) : undefined;
      if (defined?.module && defined.module !== 'common' && defined.module !== t.module) {
        warnings.push(`${t.id}（module ${t.module}）产出的 ${sym.key} 定义在模块 ${defined.module} 的契约文件里，实施中只能追加到自己模块的文件`);
      }
    }
  }
  for (const t of plan.tasks) {
    const edges = new Map<string, { hard: boolean; symbols: string[] }>();
    for (const r of t.requires) {
      const sym = parseSymbol(r);
      if (typeof sym === 'string') { warnings.push(`${t.id} 的 requires：${sym}`); continue; }
      const from = producer.get(sym.key);
      if (!from) { warnings.push(`${t.id} 需要的 ${sym.key} 没有 task 在 produces 中声明`); continue; }
      if (from === t.id) continue;
      const e = edges.get(from) ?? { hard: false, symbols: [] };
      e.hard ||= !sym.soft;
      e.symbols.push(sym.key);
      edges.set(from, e);
      const fs = stageIdx.get(taskStage.get(from)!);
      const ts = stageIdx.get(t.stage);
      // 依赖更晚阶段的 task 会让本阶段永远完不成（与依赖环一样调度不了），仍然拦
      if (fs !== undefined && ts !== undefined && fs > ts) errors.push(`${t.id}（${t.stage}）需要的 ${sym.key} 由更晚阶段的 ${from}（${taskStage.get(from)}）产出：本阶段要等下一阶段，调度不了`);
    }
    deps.set(t.id, [...edges].map(([task, e]) => ({ task, type: e.hard ? 'hard' : 'soft', reason: e.symbols.join('、') })));
  }

  // 环、互斥、报告
  const graph = plan.tasks.map((t) => ({ id: t.id, stage: t.stage, depends_on: deps.get(t.id) ?? [], writes: t.writes }));
  const cycle = findCycle(graph);
  if (cycle) errors.push(`依赖存在环：${cycle.join(' -> ')}`);
  if (errors.length) return { errors, warnings, report: null, deps };
  const mutex = mutexPairs(graph);
  const strong = strongReviews(plan, deps, ctx.limits.critical_fanout ?? 0);
  const impl = plan.tasks.filter((t) => t.stage !== 'S0');
  const high = impl.filter((t) => t.risk === 'high');
  if (high.length >= 2 && high.length * 2 > impl.length) {
    warnings.push(`${high.length} / ${impl.length} 个 task 标了 risk: high（${high.map((t) => t.id).join('、')}）：high 只给涉及权限与鉴权、金额计算、不可恢复的批量数据操作的 task，普通增删改查的删除不算；多数 task 都是 high 说明标错了`);
  }
  const dag = dagReport(graph, warnings);
  return {
    errors, warnings: dag.warnings, deps,
    report: { stages: plan.stages.map((s) => ({ id: s.id, goal: s.goal, tasks: plan.tasks.filter((t) => t.stage === s.id).map((t) => t.id) })), mutex, dag, strong },
  };
}

/** 审查会用强模型的 task（与 review.ts 的推导一致）：底座（被 critical_fanout 个 task 硬依赖）、layers 含 auth、risk: high */
function strongReviews(plan: PlanFile, deps: ReadonlyMap<string, TaskFile['depends_on']>, criticalFanout: number): { task: string; why: string }[] {
  const fanout = new Map<string, number>();
  for (const ds of deps.values()) for (const d of ds) if (d.type === 'hard') fanout.set(d.task, (fanout.get(d.task) ?? 0) + 1);
  const out: { task: string; why: string }[] = [];
  for (const t of plan.tasks) {
    const n = fanout.get(t.id) ?? 0;
    const why = [
      ...(criticalFanout > 0 && n >= criticalFanout ? [`底座，被 ${n} 个 task 硬依赖`] : []),
      ...(t.layers.includes('auth') ? ['auth 层'] : []),
      ...(t.risk === 'high' ? ['risk: high'] : []),
    ];
    if (why.length) out.push({ task: t.id, why: why.join('；') });
  }
  return out;
}

function nextFree(ids: readonly string[]): string {
  const n = Math.max(0, ...ids.map((id) => Number(id.match(/^T-(\d+)/)?.[1] ?? 0))) + 1;
  return `T-${String(n).padStart(3, '0')}`;
}
export { nextFree as nextPlanTaskId };

export function formatPlanReport(r: PlanReport, warnings: readonly string[] = r.dag.warnings): string {
  return [
    ...r.stages.map((s) => `${s.id}（${s.tasks.length} 个 task）：${s.goal}`),
    `任务数 ${r.dag.task_count}，关键路径 ${r.dag.critical_path_length}（${r.dag.critical_path.join(' → ')}），最大并行宽度 ${r.dag.max_width}，硬依赖占比 ${Math.round(r.dag.hard_ratio * 100)}%`,
    r.strong.length ? `强审查（审查用升级模型）${r.strong.length} 个：${r.strong.map((s) => `${s.task}（${s.why}）`).join('、')}` : '强审查：无',
    r.mutex.length ? `writes 重叠（优先错开运行，没别的可派时仍会并行）：${r.mutex.map(([a, b]) => `${a}↔${b}`).join('、')}` : '没有 writes 重叠的 task',
    ...warnings.map((w) => `! ${w}`),
  ].join('\n');
}

/** 计划批准时生成的 task：每个 plan task 一个 impl（S0 为 architect，其余为 worker），writes 加上它自己的验收目录（worker 自己写验收测试，reviewer 审查） */
export function deriveTasks(plan: PlanFile, deps: ReadonlyMap<string, TaskFile['depends_on']>, scopes: { worker: string[] }, opts: { verify?: string[] } = {}): TaskInput[] {
  const out: TaskInput[] = [];
  for (const t of plan.tasks) {
    out.push({
      id: t.id, stage: t.stage, kind: 'impl', role: t.stage === 'S0' ? 'architect' : 'worker', title: t.title, scopes: [...scopes.worker],
      ...(t.description?.trim() ? { description: t.description.trim() } : {}),
      depends_on: (deps.get(t.id) ?? []).map((d) => ({ ...d })), inputs: [],
      writes: [...new Set([...t.writes, ...(t.stage === 'S0' ? S0_EXTRA_WRITES : []), ownAcceptanceGlob(t.id)])], verify: [...(opts.verify ?? [])],
      ...(t.module ? { module: t.module } : {}), ...(t.size ? { size: t.size } : {}), layers: [...t.layers], ac: [...t.ac], produces: [...t.produces], requires: [...t.requires],
      ...(t.shared?.length ? { shared: [...t.shared] } : {}),
      ...(t.manual_checks?.length ? { manual_checks: [...t.manual_checks] } : {}),
      ...(t.risk ? { risk: t.risk } : {}),
    });
  }
  return out;
}

/** writes 互斥的两个 plan task（报告用；shared 不算） */
export const planConflicts = (a: { writes: string[] }, b: { writes: string[] }) => conflictsWith(a, b);
