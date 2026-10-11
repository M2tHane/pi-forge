// plan.yaml 的校验、DAG 推导与派生 task（规格第 7 节）。全部是纯函数，不做 IO。
import { parse as parseYaml } from 'yaml';
import type { ContractCatalog } from './contract-check.ts';
import { HTTP_METHODS } from './contract-check.ts';
import type { EffectiveSpec } from '../spec/spec.ts';
import { validate, type PlanFile, type TaskFile } from '../state/schemas.ts';
import type { TaskInput } from '../state/state-store.ts';
import { conflictsWith, dagReport, findCycle, mutexPairs, type DagReport } from '../state/dag.ts';
import { globsOverlap, SHARED_ACCEPTANCE_GLOB, selfTestGlob } from '../state/paths.ts';

export const PLAN_PATH = 'docs/plan/plan.yaml';
/** S0 的 worker 额外可写的验收目录（规格第 7.5、8.2 节） */
export const S0_EXTRA_WRITES = ['tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**'] as const;
/** impl 的 writes 不能覆盖这些路径：验收测试只归 test-author，规格只经 forge_spec，契约只能由程序核实的追加修改 */
export const FORBIDDEN_WRITES = ['tests/acceptance/**', 'docs/spec/**', 'docs/contracts/**', '.forge/**', '.git/**', 'workflow.yaml', 'rules/**', '.pi/**'] as const;

/**
 * lean 的计划里 writes 属于单元测试 / 测试代码的路径（偏离 110，纯函数）：任一路径段是 test、tests、__tests__、spec、specs、e2e，
 * 或文件名带 test / spec 标记（a.test.js、foo_test.go、test-utils.js）。不用 globsOverlap：`src/**\/*.js` 与 `*.test.*` 会被误判为重叠。
 */
export function isTestWrite(w: string): boolean {
  const segs = w.split('/').filter(Boolean);
  if (segs.slice(0, -1).some((x) => /^(?:tests?|__tests__|specs?|e2e)$/.test(x))) return true;
  const last = segs.at(-1) ?? '';
  return /^(?:tests?|__tests__|specs?|e2e)$/.test(last) || /(?:^|[._-])(?:test|spec)s?(?:[._-]|$)/.test(last);
}

export type SymbolKind = 'api' | 'table' | 'error' | 'fn' | 'page' | 'lib';
export interface PlanSymbol { kind: SymbolKind; /** 规范写法，例如 `api:POST /api/x` */ key: string; soft: boolean }

export interface PlanContext {
  catalog: ContractCatalog;
  spec: Pick<EffectiveSpec, 'reqs' | 'screens'>;
  /** 流程里已有的 task 编号（P1 的 architect task 等），plan 不能复用 */
  existingTaskIds: readonly string[];
  mode: 'build' | 'feature';
  /** 变更请求的修订才允许 task 写 modifies（第 12.3 节）；P1 的计划里不能写 */
  allowModifies?: boolean;
  limits: { max_parallel: number; max_task_files: number; lean_below_loc: number };
}

export interface PlanReport {
  stages: { id: string; goal: string; tasks: string[] }[];
  mutex: [string, string][];
  dag: DagReport;
}

export interface PlanCheck {
  errors: string[];
  warnings: string[];
  /** 没有错误时给出 */
  report: PlanReport | null;
  /** 推导出的依赖边，键是 task 编号 */
  deps: Map<string, TaskFile['depends_on']>;
}

/** 解析 plan.yaml 文本并按 schema 校验形状 */
export function parsePlan(text: string): { plan: PlanFile | null; errors: string[] } {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (e) { return { plan: null, errors: [`${PLAN_PATH} 不是合法的 YAML：${(e as Error).message.split('\n')[0]}`] }; }
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

/** lean 计划的阶段上限：S0 之后每 40 条 AC 一个实施阶段 */
export const LEAN_AC_PER_STAGE = 40;
/** lean 的 S0 exit 最多涉及的 AC 数 */
export const LEAN_S0_MAX_AC = 4;

/**
 * lean 计划的形状检查（纯函数，偏离 109）：S0 exit 涉及的 AC ≤ 4；S0 之后的实施阶段数 ≤ max(1, ceil(S0 之后 exit 的 AC 总数 / 40))。
 * AC 数按 exit 里 REQ 的全部 AC 计算；不存在的 REQ 不计（另有错误报告）。
 */
export function leanShapeErrors(stages: readonly { id: string; exit: readonly string[] }[], reqs: readonly { id: string; acs: readonly unknown[] }[]): string[] {
  const acOf = (ids: readonly string[]) => ids.reduce((n, id) => n + (reqs.find((r) => r.id === id)?.acs.length ?? 0), 0);
  const errors: string[] = [];
  const s0 = stages.find((s) => s.id === 'S0');
  if (s0) {
    const n = acOf(s0.exit);
    if (n > LEAN_S0_MAX_AC) errors.push(`精简模式（lean）的 S0 exit 最多涉及 ${LEAN_S0_MAX_AC} 条 AC，现在 ${s0.exit.join('、')} 共 ${n} 条；把多余的 REQ 移到 S1 的 exit（S0 只做骨架和能跑通的最小闭环）`);
  }
  const rest = stages.filter((s) => s.id !== 'S0');
  const total = rest.reduce((n, s) => n + acOf(s.exit), 0);
  const limit = Math.max(1, Math.ceil(total / LEAN_AC_PER_STAGE));
  if (rest.length > limit) errors.push(`精简模式（lean）S0 之后现在分了 ${rest.length} 个实施阶段（${rest.map((s) => s.id).join('、')}），S0 之后 exit 共 ${total} 条 AC，上限是 ${limit} 个（每 ${LEAN_AC_PER_STAGE} 条 AC 才可多分一个阶段，至少 1 个）；请合并成 ${limit} 个阶段`);
  return errors;
}

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
  for (const r of ctx.spec.reqs.filter((x) => x.priority === 'MVP')) {
    const at = exitOf.get(r.id) ?? [];
    if (!at.length) errors.push(`MVP 需求 ${r.id} 没有出现在任何阶段的 exit 中`);
    if (at.length > 1) errors.push(`需求 ${r.id} 出现在多个阶段的 exit 中：${at.join('、')}（每条需求只能在一个阶段交付）`);
  }

  // task：编号、阶段、S0 与 lean 的数量、writes
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (!/^T-\d{3,}$/.test(t.id)) errors.push(`task 编号 ${t.id} 必须写成 T-数字（.at、.rv、.fx 后缀由程序派生）`);
    if (ids.has(t.id)) errors.push(`task 编号 ${t.id} 重复`);
    if (ctx.existingTaskIds.includes(t.id)) errors.push(`task 编号 ${t.id} 已被流程里的 task 使用，请从 ${nextFree(ctx.existingTaskIds)} 起编号`);
    ids.add(t.id);
    if (!stageIdx.has(t.stage)) errors.push(`${t.id} 的阶段 ${t.stage} 不在 stages 中`);
    if (!t.writes.length) errors.push(`${t.id} 的 writes 不能为空`);
    if (t.modifies && !ctx.allowModifies) errors.push(`${t.id} 写了 modifies：只有变更请求的修订可以新增"修改 task"，P1 的计划不能写`);
    for (const w of t.writes) {
      // S0 的 worker 本来就可写 _support/ 与 S0-smoke/（程序在派生时自动加上），计划里写出来也接受（偏离 83）
      if (t.stage === 'S0' && (S0_EXTRA_WRITES as readonly string[]).includes(w)) continue;
      const bad = FORBIDDEN_WRITES.find((f) => globsOverlap(w, f));
      if (bad) errors.push(`${t.id} 的 writes ${w} 与 ${bad} 重叠：验收测试归 test-author，规格与契约不能由 impl 直接改写`);
      else if (plan.mode === 'lean' && !t.unit_tests?.trim() && isTestWrite(w)) {
        errors.push(`${t.id} 的 writes ${w} 是测试路径：精简模式（lean）不写单元测试，验收测试由程序统一放进 ${SHARED_ACCEPTANCE_GLOB}（所有 task 共用一个目录），不要写进 writes。只有算法、并发、权限矩阵、复杂状态机等复杂逻辑才需要单元测试：在这个 task 上写 unit_tests: "<是哪类复杂逻辑>"；否则从 writes 里去掉 ${w}`);
      }
    }
    if (t.writes.length > ctx.limits.max_task_files) warnings.push(`${t.id} 的 writes 有 ${t.writes.length} 项，超过 max_task_files=${ctx.limits.max_task_files}，建议拆分`);
  }
  for (const s of plan.stages) {
    const n = plan.tasks.filter((t) => t.stage === s.id).length;
    if (s.id === 'S0' && n !== 1) errors.push(`S0 只能有 1 个 task，现在有 ${n} 个`);
    else if (plan.mode === 'lean' && n !== 1) errors.push(`精简模式（lean）每个阶段只能有 1 个 task，阶段 ${s.id} 有 ${n} 个`);
    else if (n === 0) errors.push(`阶段 ${s.id} 没有 task`);
    if (n > ctx.limits.max_parallel * 3) warnings.push(`阶段 ${s.id} 有 ${n} 个 task，超过 max_parallel × 3 = ${ctx.limits.max_parallel * 3}，固定开销会很高，考虑合并`);
  }
  if (plan.mode === 'lean') errors.push(...leanShapeErrors(plan.stages, ctx.spec.reqs));
  if (plan.mode === 'standard' && plan.size_estimate.loc < ctx.limits.lean_below_loc) {
    warnings.push(`预估 ${plan.size_estimate.loc} 行，低于 lean_below_loc=${ctx.limits.lean_below_loc}，建议选 mode: lean（每个阶段一个 task）`);
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
      if (info.manual) errors.push(`${t.id} 的 ac ${ac} 是 manual 条目，不分配给 task（写进 manual_checks）`);
      if (!info.mvp) warnings.push(`${t.id} 的 ac ${ac} 属于非 MVP 需求 ${info.req}`);
      if (t.modifies && owner.get(ac)?.includes(t.modifies)) continue;
      owner.set(ac, [...(owner.get(ac) ?? []), t.id]);
    }
  }
  for (const [ac, info] of acs) {
    if (!info.mvp || info.manual) continue;
    const o = owner.get(ac) ?? [];
    if (!o.length) errors.push(`MVP 验收标准 ${ac} 没有分配给任何 task`);
    if (o.length > 1) errors.push(`验收标准 ${ac} 分配给了多个 task：${o.join('、')}（每条恰好分配一次）`);
  }
  const taskStage = new Map(plan.tasks.map((t) => [t.id, t.stage]));
  for (const s of plan.stages) {
    for (const req of s.exit) {
      for (const [ac, info] of acs) {
        if (info.req !== req || info.manual) continue;
        for (const tid of owner.get(ac) ?? []) {
          if ((stageIdx.get(taskStage.get(tid)!) ?? 0) > stageIdx.get(s.id)!) errors.push(`阶段 ${s.id} 的 exit 含 ${req}，但它的 ${ac} 分配给了更晚阶段的 ${tid}`);
        }
      }
    }
  }

  // 符号：语法、存在、唯一生产方、每个 requires 都有生产方
  const producer = new Map<string, string>();
  if (ctx.mode === 'build' && plan.baseline?.length) errors.push('baseline 只用于 feature 模式（已有项目的现有契约），新项目不能写');
  for (const b of plan.baseline ?? []) {
    const sym = parseSymbol(b);
    if (typeof sym === 'string') { errors.push(`baseline：${sym}`); continue; }
    if (!symbolExists(sym, ctx)) errors.push(`baseline 的 ${b} 在现有契约中找不到`);
    producer.set(sym.key, 'baseline');
  }
  for (const t of plan.tasks) {
    for (const p of t.produces) {
      const sym = parseSymbol(p);
      if (typeof sym === 'string') { errors.push(`${t.id} 的 produces：${sym}`); continue; }
      if (sym.soft) errors.push(`${t.id} 的 produces ${p} 不能带 ~（~ 只用于 requires）`);
      if (!symbolExists(sym, ctx)) errors.push(`${t.id} 产出的 ${sym.key} 在${sym.kind === 'page' ? '规格的 screens.md' : '契约'}中找不到`);
      const prev = producer.get(sym.key);
      if (prev) errors.push(`${sym.key} 有多个生产方：${prev}、${t.id}`);
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
      if (typeof sym === 'string') { errors.push(`${t.id} 的 requires：${sym}`); continue; }
      const from = producer.get(sym.key);
      if (!from) { errors.push(`${t.id} 需要的 ${sym.key} 缺少生产方：没有 task 在 produces 中声明它${ctx.mode === 'feature' ? '，baseline 中也没有' : ''}`); continue; }
      if (from === t.id) { errors.push(`${t.id} 的 requires ${sym.key} 是它自己产出的`); continue; }
      if (from === 'baseline') continue;
      const e = edges.get(from) ?? { hard: false, symbols: [] };
      e.hard ||= !sym.soft;
      e.symbols.push(sym.key);
      edges.set(from, e);
      const fs = stageIdx.get(taskStage.get(from)!);
      const ts = stageIdx.get(t.stage);
      if (fs !== undefined && ts !== undefined && fs > ts) errors.push(`${t.id}（${t.stage}）需要的 ${sym.key} 由更晚阶段的 ${from}（${taskStage.get(from)}）产出`);
    }
    deps.set(t.id, [...edges].map(([task, e]) => ({ task, type: e.hard ? 'hard' : 'soft', reason: e.symbols.join('、') })));
  }

  // 环、互斥、报告
  const graph = plan.tasks.map((t) => ({ id: t.id, stage: t.stage, depends_on: deps.get(t.id) ?? [], writes: t.writes }));
  const cycle = findCycle(graph);
  if (cycle) errors.push(`依赖存在环：${cycle.join(' -> ')}`);
  if (errors.length) return { errors, warnings, report: null, deps };
  const mutex = mutexPairs(graph);
  const dag = dagReport(graph, warnings);
  return {
    errors, warnings: dag.warnings, deps,
    report: { stages: plan.stages.map((s) => ({ id: s.id, goal: s.goal, tasks: plan.tasks.filter((t) => t.stage === s.id).map((t) => t.id) })), mutex, dag },
  };
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
    r.mutex.length ? `互斥（writes 重叠，不能同时运行）：${r.mutex.map(([a, b]) => `${a}↔${b}`).join('、')}` : '没有互斥的 task',
    ...warnings.map((w) => `! ${w}`),
  ].join('\n');
}

/** 第 7.4 节：S0 的 .at 在 impl 合并后才就绪；其他 .at 与 impl 同时就绪（继承 impl 的硬依赖） */
export function deriveAcctest(impl: Pick<TaskInput, 'id' | 'stage' | 'title' | 'depends_on' | 'ac' | 'test_interface' | 'module'>, scopes: string[]): TaskInput {
  return {
    id: `${impl.id}.at`, stage: impl.stage, kind: 'acctest', role: 'test-author', title: `验收测试：${impl.title}`, scopes,
    depends_on: impl.stage === 'S0'
      ? [{ task: impl.id, type: 'hard', reason: 'S0 的验收测试在骨架合并后编写（第 9.5 节单独合并）' }]
      : impl.depends_on.filter((d) => d.type === 'hard').map((d) => ({ ...d })),
    inputs: [], writes: [`tests/acceptance/${impl.id}/**`, `tests/acceptance/_support/${impl.id}/**`], verify: [],
    for_task: impl.id, ac: [...(impl.ac ?? [])], test_interface: [...(impl.test_interface ?? [])],
    ...(impl.module ? { module: impl.module } : {}),
  };
}

/** 计划批准时生成的 task：每个 plan task 一个 impl（worker），以及它的 .at（test-author） */
export function deriveTasks(plan: PlanFile, deps: ReadonlyMap<string, TaskFile['depends_on']>, scopes: { worker: string[]; testAuthor: string[] }, opts: { acctest: boolean; verify?: string[]; selfTest?: boolean }): TaskInput[] {
  // selfTest（test_author: false，偏离 81）：不派生 .at，impl 的 writes 加上自己的验收目录，由 worker 自己写验收测试；
  // lean 计划（偏离 110）所有 task 共用同一个验收目录 tests/acceptance/suite/
  const sharedTests = plan.mode === 'lean';
  const out: TaskInput[] = [];
  for (const t of plan.tasks) {
    const impl: TaskInput = {
      id: t.id, stage: t.stage, kind: 'impl', role: 'worker', title: t.title, scopes: [...scopes.worker],
      depends_on: (deps.get(t.id) ?? []).map((d) => ({ ...d })), inputs: [],
      // verify 非空的任务合并时跑全量 typecheck、lint、test（merge-queue）
      writes: [...new Set([...t.writes, ...(t.stage === 'S0' ? S0_EXTRA_WRITES : []), ...(opts.selfTest ? [selfTestGlob(t.id, sharedTests)] : [])])], verify: [...(opts.verify ?? [])],
      module: t.module, size: t.size, layers: [...t.layers], ac: [...t.ac], produces: [...t.produces], requires: [...t.requires],
      test_interface: [...t.test_interface],
      ...(t.shared?.length ? { shared: [...t.shared] } : {}),
      ...(t.manual_checks?.length ? { manual_checks: [...t.manual_checks] } : {}),
      ...(t.review ? { review: t.review } : {}),
      ...(t.risk ? { risk: t.risk } : {}),
    };
    out.push(impl);
    if (opts.acctest) out.push(deriveAcctest(impl, scopes.testAuthor));
  }
  return out;
}

/** writes 互斥的两个 plan task（报告用；shared 不算） */
export const planConflicts = (a: { writes: string[] }, b: { writes: string[] }) => conflictsWith(a, b);
