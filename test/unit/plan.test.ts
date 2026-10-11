import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContracts } from '../../src/core/plan/contract-check.ts';
import { effectiveSpec } from '../../src/core/spec/spec.ts';
import { checkPlan, deriveAcctest, deriveTasks, formatPlanReport, parsePlan, parseSymbol, type PlanContext } from '../../src/core/plan/plan.ts';
import type { PlanFile } from '../../src/core/state/schemas.ts';
import { CONTRACTS, P1_SPEC, PLAN_YAML } from '../helpers/contracts.ts';

const base = (): PlanFile => structuredClone(parsePlan(PLAN_YAML).plan!);
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  catalog: parseContracts(CONTRACTS).catalog, spec: effectiveSpec(P1_SPEC, []), existingTaskIds: ['T-001'], mode: 'build',
  limits: { max_parallel: 4, max_task_files: 12, lean_below_loc: 6000 }, ...over,
});
const run = (edit: (p: PlanFile) => void = () => {}, over: Partial<PlanContext> = {}) => {
  const p = base();
  edit(p);
  return checkPlan(p, ctx(over));
};
const t = (p: PlanFile, id: string) => p.tasks.find((x) => x.id === id)!;
const errs = (r: ReturnType<typeof run>) => r.errors.join('\n');

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
  assert.match(errs(run((p) => { t(p, 'T-002').produces.push('widget:x'); })), /T-002 的 produces：符号 widget:x/);
  assert.match(errs(run((p) => { t(p, 'T-002').produces.push('~lib:ui'); })), /produces ~lib:ui 不能带 ~/);
});

test('7.3-1 符号核对：produces 在契约（page 在 screens.md）中找不到；lib: 不要求', () => {
  assert.match(errs(run((p) => { t(p, 'T-003').produces.push('api:DELETE /api/datasources'); })), /T-003 产出的 api:DELETE \/api\/datasources 在契约中找不到/);
  assert.match(errs(run((p) => { t(p, 'T-003').produces.push('table:sessions'); })), /table:sessions 在契约中找不到/);
  assert.match(errs(run((p) => { t(p, 'T-003').produces.push('error:DATASOURCE_GONE'); })), /error:DATASOURCE_GONE 在契约中找不到/);
  assert.match(errs(run((p) => { t(p, 'T-003').produces.push('fn:team#other'); })), /fn:team#other 在契约中找不到/);
  assert.match(errs(run((p) => { t(p, 'T-003').produces.push('page:/settings'); })), /page:\/settings 在规格的 screens\.md中找不到/);
  assert.deepEqual(run((p) => { t(p, 'T-002').produces.push('lib:ui-kit'); }).errors, []);
});

test('7.3-1 每个 requires 都有生产方；baseline 只用于 feature 模式且要在契约中', () => {
  assert.match(errs(run((p) => { t(p, 'T-003').requires.push('lib:charts'); })), /T-003 需要的 lib:charts 缺少生产方/);
  assert.match(errs(run((p) => { t(p, 'T-002').requires.push('table:teams'); })), /T-002 的 requires table:teams 是它自己产出的/);
  assert.match(errs(run((p) => { p.baseline = ['api:GET /api/teams']; })), /baseline 只用于 feature 模式/);
  const feature = run((p) => {
    t(p, 'T-002').produces = t(p, 'T-002').produces.filter((s) => s !== 'api:GET /api/teams');
    p.baseline = ['api:GET /api/teams', 'api:GET /api/nothing'];
  }, { mode: 'feature' });
  assert.match(errs(feature), /baseline 的 api:GET \/api\/nothing 在现有契约中找不到/);
  assert.ok(!/api:GET \/api\/teams 缺少生产方/.test(errs(feature)), 'baseline 中的符号算生产方');
});

test('7.3-2 同一个符号只能有一个生产方', () => {
  assert.match(errs(run((p) => { t(p, 'T-003').produces.push('table:teams'); })), /table:teams 有多个生产方：T-002、T-003/);
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
    p.mode = 'standard';
    t(p, 'T-002').requires.push('~table:datasources');
  });
  assert.match(errs(r), /依赖存在环：T-00\d -> T-00\d -> T-00\d/);
});

test('7.3-6 AC 覆盖：MVP 非 manual AC 恰好分配一次；不存在、manual 的 AC；LATER 只警告', () => {
  assert.match(errs(run((p) => { t(p, 'T-003').ac = ['REQ-001.AC1']; })), /MVP 验收标准 REQ-001\.AC2 没有分配给任何 task/);
  assert.match(errs(run((p) => { t(p, 'T-002').ac.push('REQ-001.AC1'); })), /REQ-001\.AC1 分配给了多个 task：T-002、T-003/);
  assert.match(errs(run((p) => { t(p, 'T-003').ac.push('REQ-001.AC9'); })), /ac REQ-001\.AC9 在规格中不存在/);
  assert.match(errs(run((p) => { t(p, 'T-003').ac.push('REQ-001.AC3'); })), /REQ-001\.AC3 是 manual 条目/);
  const later = run((p) => { t(p, 'T-003').ac.push('REQ-003.AC1'); });
  assert.deepEqual(later.errors, []);
  assert.match(later.warnings.join(), /REQ-003\.AC1 属于非 MVP 需求 REQ-003/);
});

test('7.3-6 exit：每条 MVP 需求恰好在一个阶段 exit；exit 需求的 AC 不能分配给更晚阶段；exit 引用要存在', () => {
  assert.match(errs(run((p) => { p.stages[1]!.exit = []; })), /MVP 需求 REQ-001 没有出现在任何阶段的 exit 中/);
  assert.match(errs(run((p) => { p.stages[0]!.exit.push('REQ-001'); })), /需求 REQ-001 出现在多个阶段的 exit 中：S0、S1/);
  assert.match(errs(run((p) => { p.stages[0]!.exit.push('REQ-009'); })), /exit 引用了不存在的需求 REQ-009/);
  const late = run((p) => { p.stages[0]!.exit = ['REQ-002', 'REQ-001']; p.stages[1]!.exit = []; });
  assert.match(errs(late), /阶段 S0 的 exit 含 REQ-001，但它的 REQ-001\.AC1 分配给了更晚阶段的 T-003/);
});

test('S0 只能有 1 个 task；lean 每个阶段 1 个 task；阶段编号连续；空阶段报错', () => {
  const two = run((p) => { p.tasks.push({ ...structuredClone(t(p, 'T-003')), id: 'T-004', stage: 'S0', ac: [], produces: [], requires: [], writes: ['x/**'] }); });
  assert.match(errs(two), /S0 只能有 1 个 task，现在有 2 个/);
  const lean = run((p) => { p.mode = 'lean'; p.tasks.push({ ...structuredClone(t(p, 'T-003')), id: 'T-004', ac: [], produces: [], requires: [], writes: ['y/**'] }); });
  assert.match(errs(lean), /精简模式（lean）每个阶段只能有 1 个 task，阶段 S1 有 2 个/);
  assert.match(errs(run((p) => { p.stages[1]!.id = 'S2'; t(p, 'T-003').stage = 'S2'; })), /按顺序写成 S0、S1、S2……，第 2 个阶段是 S2/);
  assert.match(errs(run((p) => { p.stages.push({ id: 'S2', goal: '空', exit: [] }); })), /阶段 S2 没有 task/);
  assert.match(errs(run((p) => { t(p, 'T-003').stage = 'S5'; })), /T-003 的阶段 S5 不在 stages 中/);
});

test('task 编号：格式、重复、与流程已有 task 冲突时给出下一个可用编号', () => {
  assert.match(errs(run((p) => { t(p, 'T-003').id = 'T-003.at'; })), /T-003\.at 必须写成 T-数字/);
  assert.match(errs(run((p) => { p.tasks[1]!.id = 'T-002'; })), /task 编号 T-002 重复/);
  assert.match(errs(run(() => {}, { existingTaskIds: ['T-001', 'T-002'] })), /T-002 已被流程里的 task 使用，请从 T-003 起编号/);
});

test('writes：不能为空，不能覆盖验收测试、规格、契约与受保护路径；超过 max_task_files 只警告', () => {
  assert.match(errs(run((p) => { t(p, 'T-003').writes = ['tests/acceptance/T-003/**']; })), /与 tests\/acceptance\/\*\* 重叠/);
  assert.match(errs(run((p) => { t(p, 'T-003').writes = ['docs/**']; })), /与 docs\/spec\/\*\* 重叠/);
  assert.match(errs(run((p) => { t(p, 'T-003').writes = ['docs/contracts/paths/datasource.yaml']; })), /与 docs\/contracts\/\*\* 重叠/);
  assert.match(errs(run((p) => { t(p, 'T-003').writes = []; })), /T-003 的 writes 不能为空/);
  const many = run((p) => { t(p, 'T-003').writes = Array.from({ length: 13 }, (_, i) => `src/m${i}/**`); });
  assert.deepEqual(many.errors, []);
  assert.match(many.warnings.join(), /writes 有 13 项，超过 max_task_files=12/);
});

test('提醒：小项目建议 lean；阶段 task 过多；产出的接口不在自己模块的契约文件', () => {
  assert.match(run(() => {}, { limits: { max_parallel: 4, max_task_files: 12, lean_below_loc: 10000 } }).warnings.join(), /低于 lean_below_loc=10000，建议选 mode: lean/);
  assert.match(run(() => {}, { limits: { max_parallel: 0, max_task_files: 12, lean_below_loc: 6000 } }).warnings.join(), /阶段 S0 有 1 个 task，超过 max_parallel × 3 = 0/);
  const r = run((p) => { t(p, 'T-003').module = 'storage'; });
  assert.match(r.warnings.join(), /T-003（module storage）产出的 api:POST \/api\/datasources 定义在模块 datasource 的契约文件里/);
});

test('互斥对：writes 重叠的 task 写进报告', () => {
  const r = run((p) => { t(p, 'T-003').writes.push('server/src/team/shared.ts'); });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.report!.mutex, [['T-002', 'T-003']]);
});

test('派生 task：impl 归 worker，S0 多两个验收目录；.at 归 test-author，S0 的 .at 硬依赖 impl，其他 .at 继承 impl 的硬依赖', () => {
  const plan = base();
  const r = checkPlan(plan, ctx());
  const tasks = deriveTasks(plan, r.deps, { worker: ['code'], testAuthor: ['acctest'] }, { acctest: true });
  assert.deepEqual(tasks.map((x) => [x.id, x.kind, x.role, x.stage]), [
    ['T-002', 'impl', 'worker', 'S0'], ['T-002.at', 'acctest', 'test-author', 'S0'],
    ['T-003', 'impl', 'worker', 'S1'], ['T-003.at', 'acctest', 'test-author', 'S1'],
  ]);
  const s0 = tasks[0]!;
  assert.deepEqual(s0.writes, ['server/src/team/**', 'web/src/pages/team/**', 'package.json', 'tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**']);
  assert.deepEqual(tasks[1]!.depends_on, [{ task: 'T-002', type: 'hard', reason: 'S0 的验收测试在骨架合并后编写（第 9.5 节单独合并）' }]);
  assert.deepEqual(tasks[1]!.writes, ['tests/acceptance/T-002/**', 'tests/acceptance/_support/T-002/**']);
  assert.equal(tasks[1]!.for_task, 'T-002');
  assert.deepEqual(tasks[3]!.depends_on, tasks[2]!.depends_on.filter((d) => d.type === 'hard'));
  assert.deepEqual(tasks[2]!.ac, ['REQ-001.AC1', 'REQ-001.AC2']);
  assert.deepEqual(tasks[2]!.manual_checks, ['新增后列表第一行出现新项']);
  assert.deepEqual(tasks[2]!.shared, ['server/src/routes.ts']);
  const softOnly = deriveAcctest({ id: 'T-009', stage: 'S2', title: 'x', depends_on: [{ task: 'T-003', type: 'soft' }], ac: [], test_interface: [] }, ['acctest']);
  assert.deepEqual(softOnly.depends_on, [], '软依赖不影响 .at 就绪');
  assert.deepEqual(deriveTasks(plan, r.deps, { worker: ['code'], testAuthor: ['acctest'] }, { acctest: false }).map((x) => x.id), ['T-002', 'T-003']);
  const withVerify = deriveTasks(plan, r.deps, { worker: ['code'], testAuthor: ['acctest'] }, { acctest: true, verify: ['typecheck', 'test'] });
  assert.deepEqual(withVerify.map((x) => [x.id, x.verify]), [['T-002', ['typecheck', 'test']], ['T-002.at', []], ['T-003', ['typecheck', 'test']], ['T-003.at', []]], 'impl 合并时跑全量，.at 不跑');
});

test('plan.yaml：YAML 语法错误与形状错误', () => {
  assert.match(parsePlan('stages: [').errors.join(), /不是合法的 YAML/);
  assert.match(parsePlan('mode: standard\n').errors.join(), /docs\/plan\/plan\.yaml：/);
  assert.equal(parsePlan(PLAN_YAML).errors.length, 0);
});

test('test_author: false（偏离 81）：不派生 .at，impl 的 writes 加上自己的验收目录；默认行为不变', () => {
  const plan = base();
  const r = checkPlan(plan, ctx());
  const scopes = { worker: ['code'], testAuthor: ['acctest'] };
  const self = deriveTasks(plan, r.deps, scopes, { acctest: false, selfTest: true });
  assert.deepEqual(self.map((x) => x.id), ['T-002', 'T-003']);
  assert.deepEqual(self[0]!.writes, ['server/src/team/**', 'web/src/pages/team/**', 'package.json', 'tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**', 'tests/acceptance/T-002/**'], 'S0 的额外 writes 不变');
  assert.equal(self[1]!.writes.at(-1), 'tests/acceptance/T-003/**');
  assert.ok(!self[1]!.writes.some((w) => w.includes('T-002')), '只加自己的目录');
  const normal = deriveTasks(plan, r.deps, scopes, { acctest: true });
  assert.ok(normal.filter((x) => x.kind === 'impl').every((x) => !x.writes.includes(`tests/acceptance/${x.id}/**`)), '默认不给 impl 验收目录');
  assert.deepEqual(normal.map((x) => x.id), ['T-002', 'T-002.at', 'T-003', 'T-003.at']);
});

test('S0 的 writes 写出 _support/ 与 S0-smoke/ 也接受，派生时去重；别的阶段仍拒绝（偏离 83）', () => {
  const extra = ['tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**'];
  const r = run((p) => { t(p, 'T-002').writes.push(...extra); });
  assert.deepEqual(r.errors, []);
  const p = base();
  t(p, 'T-002').writes.push(...extra);
  const impl = deriveTasks(p, r.deps, { worker: [], testAuthor: [] }, { acctest: false }).find((x) => x.id === 'T-002')!;
  assert.equal(impl.writes.filter((w) => w === 'tests/acceptance/_support/**').length, 1);
  assert.match(errs(run((p2) => { t(p2, 'T-003').writes.push('tests/acceptance/_support/**'); })), /与 tests\/acceptance\/\*\* 重叠/);
});
