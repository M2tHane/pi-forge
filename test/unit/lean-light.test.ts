// 偏离 110–112：lean 变轻——共享验收目录、不写单元测试（unit_tests 理由）、契约只写接口清单。纯函数与计划校验的单元测试；
// 端到端（计划批准 → 两个阶段的 impl 写共享目录 → 覆盖率通过）见 test/e2e/lean-light.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContracts } from '../../src/core/plan/contract-check.ts';
import { effectiveSpec } from '../../src/core/spec/spec.ts';
import { checkPlan, deriveTasks, isTestWrite, parsePlan, type PlanContext } from '../../src/core/plan/plan.ts';
import { scanAcCoverage } from '../../src/core/acceptance/acctest.ts';
import { testWritesOf } from '../../src/core/acceptance/stage-fix.ts';
import { gateIssues } from '../../src/core/stage/gates.ts';
import { assemblePrompt } from '../../src/core/engine/prompt-assembler.ts';
import { acceptanceDirOf, SHARED_ACCEPTANCE_GLOB, writesOwnAcceptance } from '../../src/core/state/paths.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import type { PlanFile } from '../../src/core/state/schemas.ts';
import { CONTRACTS, P1_SPEC, PLAN_YAML } from '../helpers/contracts.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { mkTask } from '../helpers/tasks.ts';

const base = (): PlanFile => structuredClone(parsePlan(PLAN_YAML).plan!);
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  catalog: parseContracts(CONTRACTS).catalog, spec: effectiveSpec(P1_SPEC, []), existingTaskIds: ['T-001'], mode: 'build',
  limits: { max_parallel: 4, max_task_files: 12, lean_below_loc: 6000 }, ...over,
});
const lean = (edit: (p: PlanFile) => void = () => {}) => { const p = base(); p.mode = 'lean'; edit(p); return checkPlan(p, ctx()); };
const t = (p: PlanFile, id: string) => p.tasks.find((x) => x.id === id)!;

// —— 1 共享验收目录 ——

test('scanAcCoverage：一个测试名可带多个 AC 编号（连写、逗号分隔、顿号分隔都算）；括号里夹杂别的文字不算', () => {
  const cov = scanAcCoverage([{ path: 'tests/acceptance/suite/a.test.js', content: [
    "test('[REQ-001.AC1][REQ-001.AC2] 创建后列表可见')",
    "test('[REQ-002.AC1, REQ-002.AC2] 权限矩阵')",
    "test('[REQ-003.AC1、REQ-003.AC2] 顿号')",
    "test('[REQ-004.AC1 见规格] 夹杂文字')",
  ].join('\n') }]);
  assert.deepEqual([...cov.keys()].sort(), ['REQ-001.AC1', 'REQ-001.AC2', 'REQ-002.AC1', 'REQ-002.AC2', 'REQ-003.AC1', 'REQ-003.AC2']);
  assert.deepEqual(cov.get('REQ-002.AC2'), ['tests/acceptance/suite/a.test.js']);
});

test('deriveTasks：lean + selfTest 的 impl 都写共享目录 suite，没有按 task 的验收目录；standard 仍是各自的目录', () => {
  const plan = base();
  plan.mode = 'lean';
  const r = checkPlan(plan, ctx());
  assert.deepEqual(r.errors, []);
  const scopes = { worker: ['code'], testAuthor: ['acctest'] };
  const impls = deriveTasks(plan, r.deps, scopes, { acctest: false, selfTest: true });
  assert.deepEqual(impls.map((x) => x.id), ['T-002', 'T-003'], '没有 .at');
  for (const x of impls) {
    assert.ok(x.writes.includes(SHARED_ACCEPTANCE_GLOB), x.writes.join());
    assert.ok(!x.writes.some((w) => /tests\/acceptance\/T-\d+/.test(w)), '没有 tests/acceptance/T-xxx/');
    assert.equal(acceptanceDirOf(x), 'suite');
    assert.ok(writesOwnAcceptance(x));
  }
  // lean 但 test_author 开启：照旧派生 .at，impl 不带共享目录
  const withAt = deriveTasks(plan, r.deps, scopes, { acctest: true });
  assert.deepEqual(withAt.map((x) => x.id), ['T-002', 'T-002.at', 'T-003', 'T-003.at']);
  assert.ok(withAt.every((x) => !x.writes.includes(SHARED_ACCEPTANCE_GLOB)));
  // standard
  const std = base();
  const sr = checkPlan(std, ctx());
  const own = deriveTasks(std, sr.deps, scopes, { acctest: false, selfTest: true });
  assert.ok(own.every((x) => !x.writes.includes(SHARED_ACCEPTANCE_GLOB) && x.writes.includes(`tests/acceptance/${x.id}/**`)));
  assert.equal(acceptanceDirOf(own[1]!), 'T-003');
});

test('testWritesOf：fix 继承 impl 的共享验收目录', () => {
  assert.deepEqual(testWritesOf({ id: 'T-001', writes: ['src/a/**', SHARED_ACCEPTANCE_GLOB, 'tests/acceptance/**'] }), [SHARED_ACCEPTANCE_GLOB]);
});

test('gateIssues：全量命令的失败日志出现 tests/acceptance/suite/ 时，归最后一个写共享目录的 impl', () => {
  const tasks = [mkTask('T-001', { writes: ['src/a/**', SHARED_ACCEPTANCE_GLOB] }), mkTask('T-002', { writes: ['src/b/**', SHARED_ACCEPTANCE_GLOB] })];
  const issues = gateIssues({ command: 'acceptance', output: 'FAIL tests/acceptance/suite/flow.test.js\n' }, tasks, new Set());
  assert.deepEqual(issues.map((i) => i.owner), ['T-002']);
  assert.deepEqual(issues[0]!.writes, ['src/b/**', SHARED_ACCEPTANCE_GLOB]);
});

const agent = { name: 'worker', tier: 'strong', thinking: null, description: '', prompt: 'ROLE' };
test('任务说明：共享目录时『验收测试（由你编写）』写明 suite、_helpers.js、多编号、不写单元测试和 acceptance -- suite；按 task 目录的说明不变', () => {
  const config = parseConfig(TEST_YAML);
  const shared = mkTask('T-002', { ac: ['REQ-001.AC1'], writes: ['src/**', SHARED_ACCEPTANCE_GLOB] });
  const p = assemblePrompt({ agent, rules: [], task: shared, flowId: 'B-001', handoff: '', mode: 'impl', commands: config.commands });
  assert.match(p.user, /## 验收测试（由你编写）[\s\S]*tests\/acceptance\/suite\/[\s\S]*_helpers\.js[\s\S]*多个编号[\s\S]*不要写单元测试[\s\S]*acceptance -- suite[\s\S]*- \[REQ-001\.AC1\]/);
  assert.ok(!p.user.includes('tests/acceptance/T-002'));
  const own = mkTask('T-002', { ac: ['REQ-001.AC1'], writes: ['src/**', 'tests/acceptance/T-002/**'] });
  const q = assemblePrompt({ agent, rules: [], task: own, flowId: 'B-001', handoff: '', mode: 'impl', commands: config.commands });
  assert.match(q.user, /tests\/acceptance\/T-002\/[\s\S]*acceptance -- T-002/);
  assert.ok(!q.user.includes('_helpers.js'));
});

// —— 2 lean 不写单元测试 ——

test('isTestWrite：测试目录、测试文件名算；src/**/*.js、tests 以外的普通路径不算', () => {
  for (const w of ['tests/unit/**', 'tests/e2e/**', 'test/**', 'src/__tests__/**', 'src/foo.test.js', 'lib/foo_test.go', 'src/test-utils.js', 'e2e/**', 'tests']) assert.ok(isTestWrite(w), w);
  for (const w of ['src/**/*.js', 'src/server/**', 'web/src/pages/**', 'src/latest.js', 'src/contest/**', 'package.json']) assert.ok(!isTestWrite(w), w);
});

test('lean 计划：writes 含 tests/unit 等测试路径且没写 unit_tests 理由 → 计划检查报错（中文、点名 task 与路径）', () => {
  assert.deepEqual(lean().errors, []);
  const r = lean((p) => { t(p, 'T-003').writes.push('tests/unit/datasource/**', 'src/a.test.js'); });
  assert.equal(r.errors.length, 2, r.errors.join('\n'));
  assert.match(r.errors[0]!, /T-003 的 writes tests\/unit\/datasource\/\*\* 是测试路径：精简模式（lean）不写单元测试[\s\S]*tests\/acceptance\/suite\/[\s\S]*unit_tests: "<是哪类复杂逻辑>"/);
  assert.match(r.errors[1]!, /src\/a\.test\.js/);
});

test('lean 计划：写了 unit_tests 理由的 task 可以列单元测试路径；空理由不算；standard 不受限制', () => {
  assert.deepEqual(lean((p) => { const x = t(p, 'T-003'); x.writes.push('tests/unit/datasource/**'); x.unit_tests = '权限矩阵：四种角色对增删改查的组合'; }).errors, []);
  assert.match(lean((p) => { const x = t(p, 'T-003'); x.writes.push('tests/unit/**'); x.unit_tests = '  '; }).errors.join(), /是测试路径/);
  assert.match(lean((p) => { t(p, 'T-003').writes.push('tests/unit/**'); t(p, 'T-002').unit_tests = '别的 task 的理由不算'; }).errors.join(), /T-003 的 writes/);
  const std = base();
  t(std, 'T-003').writes.push('tests/unit/datasource/**');
  assert.deepEqual(checkPlan(std, ctx()).errors, []);
});

test('plan schema：unit_tests 是可选字符串，非空', () => {
  const ok = PLAN_YAML.replace('    shared: [server/src/routes.ts]', '    shared: [server/src/routes.ts]\n    unit_tests: 并发写入的幂等逻辑');
  assert.deepEqual(parsePlan(ok).errors, []);
  assert.equal(parsePlan(ok).plan!.tasks[1]!.unit_tests, '并发写入的幂等逻辑');
  assert.match(parsePlan(PLAN_YAML.replace('    shared: [server/src/routes.ts]', '    shared: [server/src/routes.ts]\n    unit_tests: ""')).errors.join(), /unit_tests/);
});

// —— 3 lean 契约只写接口清单 ——

test('契约检查不要求 schema：lean 写法（无 components、无请求/响应体 schema，只有 summary 与状态码）通过，接口进符号目录；缺 responses 仍报错', () => {
  const files = {
    'openapi.yaml': "openapi: 3.1.0\ninfo: { title: 看板, version: 1.0.0 }\npaths:\n  /api/boards:\n    $ref: './paths/board.yaml#/~1api~1boards'\n",
    'paths/board.yaml': "/api/boards:\n  post:\n    operationId: createBoard\n    summary: 创建看板，名称 1 到 50 字\n    x-req: [REQ-001]\n    responses: { '201': { description: 已创建 }, '400': { description: BOARD_NAME_INVALID } }\n  get:\n    operationId: listBoards\n    summary: 看板列表\n    responses: { '200': { description: 列表 } }\n",
    'errors/board.yaml': 'BOARD_NAME_INVALID: { http: 400, message: 名称不合法 }\n',
    'data-model.yaml': 'tables:\n  boards:\n    columns:\n      id: { type: uuid, pk: true }\n      name: { type: string, max: 50 }\n',
  };
  const r = parseContracts(files);
  assert.deepEqual(r.errors, []);
  assert.deepEqual([...r.catalog.apis.keys()].sort(), ['GET /api/boards', 'POST /api/boards']);
  assert.ok(r.catalog.errors.has('BOARD_NAME_INVALID') && r.catalog.tables.has('boards'));
  const bad = parseContracts({ ...files, 'paths/board.yaml': '/api/boards:\n  get:\n    summary: x\n' });
  assert.match(bad.errors.map((e) => e.message).join(), /必须写 responses/);
});
