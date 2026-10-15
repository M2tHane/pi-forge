import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContracts } from '../../src/core/plan/contract-check.ts';
import { effectiveSpec } from '../../src/core/spec/spec.ts';
import { checkPlan, deriveTasks, formatPlanReport, parsePlan, parseSymbol, type PlanContext } from '../../src/core/plan/plan.ts';
import type { PlanFile } from '../../src/core/state/schemas.ts';
import { CONTRACTS, P1_SPEC, PLAN_YAML } from '../helpers/contracts.ts';

const base = (): PlanFile => structuredClone(parsePlan(PLAN_YAML).plan!);
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  catalog: parseContracts(CONTRACTS).catalog, spec: effectiveSpec(P1_SPEC), existingTaskIds: ['T-001'],
  limits: { max_parallel: 4, max_task_files: 12 }, ...over,
});
const run = (edit: (p: PlanFile) => void = () => {}, over: Partial<PlanContext> = {}) => {
  const p = base();
  edit(p);
  return checkPlan(p, ctx(over));
};
const t = (p: PlanFile, id: string) => p.tasks.find((x) => x.id === id)!;
const errs = (r: ReturnType<typeof run>) => r.errors.join('\n');
/** 只提醒的项：在 warnings 里，且不产生错误 */
const warns = (r: ReturnType<typeof run>) => { assert.deepEqual(r.errors, []); return r.warnings.join('\n'); };

test('合格的计划：零错误，推导出软依赖与硬依赖，报告含阶段与关键路径', () => {
  const r = run();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.deps.get('T-002'), []);
  assert.deepEqual(r.deps.get('T-003'), [{ task: 'T-002', type: 'hard', reason: 'table:teams、api:GET /api/teams、fn:team#currentTeam' }],
    '同一生产方的多个符号合并成一条边；只要有一个不带 ~ 就是硬依赖');
  assert.deepEqual(r.report!.stages.map((s) => [s.id, s.tasks]), [['S0', ['T-002']], ['S1', ['T-003']]]);
  assert.equal(r.report!.dag.critical_path_length, 2);
  assert.match(formatPlanReport(r.report!), /S0（1 个 task）[\s\S]*关键路径 2/);
});

test('全部 requires 带 ~ 时是软依赖', () => {
  const r = run((p) => { t(p, 'T-003').requires = ['~table:teams', '~api:GET /api/teams']; });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.deps.get('T-003'), [{ task: 'T-002', type: 'soft', reason: 'table:teams、api:GET /api/teams' }]);
});

test('符号语法：前缀、api 的方法与路径、fn 与 page 的格式', () => {
  assert.deepEqual(parseSymbol('~api:post /api/x'), { kind: 'api', key: 'api:POST /api/x', soft: true });
  assert.deepEqual(parseSymbol('fn:team#currentTeam'), { kind: 'fn', key: 'fn:team#currentTeam', soft: false });
  assert.match(String(parseSymbol('endpoint:/x')), /必须以 api:/);
  assert.match(String(parseSymbol('api:FETCH /x')), /api:<METHOD> <path>/);
  assert.match(String(parseSymbol('api:GET x')), /api:<METHOD> <path>/);
  assert.match(String(parseSymbol('fn:currentTeam')), /fn:<module>#<name>/);
  assert.match(String(parseSymbol('page:teams')), /page:<route>/);
  assert.match(warns(run((p) => { t(p, 'T-002').produces.push('widget:x'); })), /T-002 的 produces：符号 widget:x/);
});

test('7.3-1 符号核对（只提醒）：别的 task 需要的产出在契约（page 在 screens.md）中找不到时提醒；没人需要的不要求进契约；lib: 不要求', () => {
  const used = (sym: string) => run((p) => { t(p, 'T-002').produces.push(sym); t(p, 'T-003').requires.push(sym); });
  assert.match(warns(used('api:DELETE /api/teams')), /T-002 产出的 api:DELETE \/api\/teams 在契约中找不到/);
  assert.match(warns(used('table:sessions')), /table:sessions 在契约中找不到/);
  assert.match(warns(used('error:TEAM_GONE')), /error:TEAM_GONE 在契约中找不到/);
  assert.match(warns(used('fn:team#other')), /fn:team#other 在契约中找不到/);
  assert.match(warns(used('page:/settings')), /page:\/settings 在规格的 screens\.md中找不到/);
  assert.doesNotMatch(warns(run((p) => { t(p, 'T-003').produces.push('api:DELETE /api/datasources'); })), /在契约中找不到/, '只有自己用的接口不必写进契约');
  assert.deepEqual(run((p) => { t(p, 'T-002').produces.push('lib:ui-kit'); }).errors, []);
});

test('强审查：批准报告列出用强模型审查的 task 与原因；多数 task 标 risk: high 时提醒', () => {
  const r = run((p) => { t(p, 'T-003').risk = 'high'; t(p, 'T-002').layers.push('auth'); }, { limits: { max_parallel: 4, max_task_files: 12, critical_fanout: 1 } });
  assert.deepEqual(r.report!.strong, [{ task: 'T-002', why: '底座，被 1 个 task 硬依赖；auth 层' }, { task: 'T-003', why: 'risk: high' }]);
  assert.match(formatPlanReport(r.report!), /强审查（审查用升级模型）2 个：T-002（底座，被 1 个 task 硬依赖；auth 层）、T-003（risk: high）/);
  assert.match(formatPlanReport(run().report!), /强审查：无/);
  const many = run((p) => {
    for (const id of ['T-004', 'T-005']) p.tasks.push({ ...structuredClone(t(p, 'T-003')), id, module: id, writes: [`x/${id}/**`], produces: [], ac: [], risk: 'high' });
  });
  assert.match(warns(many), /2 \/ 3 个 task 标了 risk: high（T-004、T-005）[\s\S]*普通增删改查的删除不算/);
  assert.doesNotMatch(warns(run((p) => { t(p, 'T-003').risk = 'high'; })), /标了 risk: high/, '只有一个 high 不提醒');
});

test('7.3-1 requires 没有生产方只提醒；需要自己产出的符号不加依赖', () => {
  assert.match(warns(run((p) => { t(p, 'T-003').requires.push('lib:charts'); })), /T-003 需要的 lib:charts 没有 task 在 produces 中声明/);
  assert.deepEqual(run((p) => { t(p, 'T-002').requires.push('table:teams'); }).errors, []);
});

test('7.3-2 同一个符号有多个生产方时提醒', () => {
  assert.match(warns(run((p) => { t(p, 'T-003').produces.push('table:teams'); })), /table:teams 有多个生产方：T-002、T-003/);
});

test('7.3-3 生产方所在阶段不能晚于消费方', () => {
  const r = run((p) => {
    t(p, 'T-002').requires.push('~table:datasources');
  });
  assert.match(errs(r), /T-002（S0）需要的 table:datasources 由更晚阶段的 T-003（S1）产出/);
});

test('7.3-5 环检测', () => {
  const r = run((p) => {
    p.stages[0]!.exit = ['REQ-002', 'REQ-001'];
    p.stages.pop();
    p.tasks[1]!.stage = 'S0';
    t(p, 'T-002').requires.push('~table:datasources');
  });
  assert.match(errs(r), /依赖存在环：T-00\d -> T-00\d -> T-00\d/);
});

test('7.3-6 AC 覆盖：没分配、重复分配、manual、LATER 只提醒；不存在的 AC 报错', () => {
  assert.match(warns(run((p) => { t(p, 'T-003').ac = ['REQ-001.AC1']; })), /MVP 验收标准 REQ-001\.AC2 没有分配给任何 task/);
  assert.match(warns(run((p) => { t(p, 'T-002').ac.push('REQ-001.AC1'); })), /REQ-001\.AC1 分配给了多个 task：T-002、T-003/);
  assert.match(errs(run((p) => { t(p, 'T-003').ac.push('REQ-001.AC9'); })), /ac REQ-001\.AC9 在规格中不存在/);
  assert.match(warns(run((p) => { t(p, 'T-003').ac.push('REQ-001.AC3'); })), /REQ-001\.AC3 是 manual 条目/);
  const later = run((p) => { t(p, 'T-003').ac.push('REQ-003.AC1'); });
  assert.deepEqual(later.errors, []);
  assert.match(later.warnings.join(), /REQ-003\.AC1 属于非 MVP 需求 REQ-003/);
});

test('7.3-6 exit：需求不在 exit、在多个 exit、AC 分配给更晚阶段只提醒；exit 引用要存在', () => {
  assert.match(warns(run((p) => { p.stages[1]!.exit = []; })), /MVP 需求 REQ-001 没有出现在任何阶段的 exit 中/);
  assert.match(warns(run((p) => { p.stages[0]!.exit.push('REQ-001'); })), /需求 REQ-001 出现在多个阶段的 exit 中：S0、S1/);
  assert.match(errs(run((p) => { p.stages[0]!.exit.push('REQ-009'); })), /exit 引用了不存在的需求 REQ-009/);
  const late = run((p) => { p.stages[0]!.exit = ['REQ-002', 'REQ-001']; p.stages[1]!.exit = []; });
  assert.match(warns(late), /阶段 S0 的 exit 含 REQ-001，但它的 REQ-001\.AC1 分配给了更晚阶段的 T-003/);
});

test('S0 只能有 1 个 task；阶段编号连续；空阶段报错', () => {
  const two = run((p) => { p.tasks.push({ ...structuredClone(t(p, 'T-003')), id: 'T-004', stage: 'S0', ac: [], produces: [], requires: [], writes: ['x/**'] }); });
  assert.match(errs(two), /S0 只能有 1 个 task，现在有 2 个/);
  assert.match(errs(run((p) => { p.stages[1]!.id = 'S2'; t(p, 'T-003').stage = 'S2'; })), /按顺序写成 S0、S1、S2……，第 2 个阶段是 S2/);
  assert.match(errs(run((p) => { p.stages.push({ id: 'S2', goal: '空', exit: [] }); })), /阶段 S2 没有 task/);
  assert.match(errs(run((p) => { t(p, 'T-003').stage = 'S5'; })), /T-003 的阶段 S5 不在 stages 中/);
});

test('task 编号：格式、重复、与流程已有 task 冲突时给出下一个可用编号', () => {
  assert.match(errs(run((p) => { t(p, 'T-003').id = 'T-003.at'; })), /T-003\.at 必须写成 T-数字/);
  assert.match(errs(run((p) => { p.tasks[1]!.id = 'T-002'; })), /task 编号 T-002 重复/);
  assert.match(errs(run(() => {}, { existingTaskIds: ['T-001', 'T-002'] })), /T-002 已被流程里的 task 使用，请从 T-003 起编号/);
});

test('writes 只是调度优先级：可以为空、可以含验收测试目录与文档；超过 max_task_files 只警告', () => {
  for (const writes of [[], ['tests/acceptance/T-003/**'], ['docs/**'], ['docs/contracts/paths/datasource.yaml']]) assert.deepEqual(run((p) => { t(p, 'T-003').writes = writes; }).errors, [], writes.join());
  const many = run((p) => { t(p, 'T-003').writes = Array.from({ length: 13 }, (_, i) => `src/m${i}/**`); });
  assert.deepEqual(many.errors, []);
  assert.match(many.warnings.join(), /writes 有 13 项，超过 max_task_files=12/);
});

test('提醒：阶段 task 过多；产出的接口不在自己模块的契约文件', () => {
  assert.match(run(() => {}, { limits: { max_parallel: 0, max_task_files: 12 } }).warnings.join(), /阶段 S0 有 1 个 task，超过 max_parallel × 3 = 0/);
  const r = run((p) => { t(p, 'T-003').module = 'storage'; });
  assert.match(r.warnings.join(), /T-003（module storage）产出的 api:POST \/api\/datasources 定义在模块 datasource 的契约文件里/);
});

test('互斥对：writes 重叠的 task 写进报告', () => {
  const r = run((p) => { t(p, 'T-003').writes.push('server/src/team/shared.ts'); });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.report!.mutex, [['T-002', 'T-003']]);
});

test('派生 task：S0 归 architect、其余 impl 归 worker，writes 加上自己的验收目录，S0 多两个验收目录与 rules/**；verify 来自配置', () => {
  const plan = base();
  const r = checkPlan(plan, ctx());
  const tasks = deriveTasks(plan, r.deps, { worker: ['code'] });
  assert.deepEqual(tasks.map((x) => [x.id, x.kind, x.role, x.stage]), [['T-002', 'impl', 'architect', 'S0'], ['T-003', 'impl', 'worker', 'S1']]);
  const s0 = tasks[0]!;
  assert.deepEqual(s0.writes, ['server/src/team/**', 'web/src/pages/team/**', 'package.json', 'tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**', 'rules/**', 'tests/acceptance/T-002/**']);
  assert.deepEqual(s0.scopes, ['code'], 'S0 用 worker 的 scopes');
  assert.ok(!tasks[1]!.writes.includes('rules/**'), 'S1 起不能写 rules/');
  assert.equal(tasks[1]!.writes.at(-1), 'tests/acceptance/T-003/**');
  assert.ok(!tasks[1]!.writes.some((w) => w.includes('T-002')), '只加自己的目录');
  assert.deepEqual(tasks[1]!.depends_on, r.deps.get('T-003'));
  assert.deepEqual(tasks[1]!.ac, ['REQ-001.AC1', 'REQ-001.AC2']);
  assert.deepEqual(tasks[1]!.manual_checks, ['新增后列表第一行出现新项']);
  assert.deepEqual(tasks[1]!.shared, ['server/src/routes.ts']);
  const withVerify = deriveTasks(plan, r.deps, { worker: ['code'] }, { verify: ['typecheck', 'test'] });
  assert.deepEqual(withVerify.map((x) => [x.id, x.verify]), [['T-002', ['typecheck', 'test']], ['T-003', ['typecheck', 'test']]]);
});
test('plan.yaml：YAML 语法错误与形状错误', () => {
  assert.match(parsePlan('stages: [').errors.join(), /不是合法的 YAML/);
  assert.match(parsePlan('stages: []\n').errors.join(), /docs\/plan\/plan\.yaml：/);
  assert.equal(parsePlan(PLAN_YAML).errors.length, 0);
});

test('S0 的 writes 写出 _support/ 与 S0-smoke/ 也接受，派生时去重', () => {
  const extra = ['tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**', 'rules/**'];
  const r = run((p) => { t(p, 'T-002').writes.push(...extra); });
  assert.deepEqual(r.errors, []);
  const p = base();
  t(p, 'T-002').writes.push(...extra);
  const impl = deriveTasks(p, r.deps, { worker: [] }).find((x) => x.id === 'T-002')!;
  assert.equal(impl.writes.filter((w) => w === 'tests/acceptance/_support/**').length, 1);
  assert.equal(impl.writes.filter((w) => w === 'rules/**').length, 1);
});

