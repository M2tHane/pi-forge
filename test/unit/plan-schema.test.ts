// M1：plan.yaml 与任务、流程新增字段的形状校验；语义校验留给 M3。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMAS, TASK_KINDS, TASK_STATUSES, validate, type PlanFile } from '../../src/core/state/schemas.ts';
import { mkTask } from '../helpers/tasks.ts';
import { SCHEMA_VERSION, MIGRATIONS, migrationChain } from '../../src/core/state/migrations.ts';

const plan = (): PlanFile => ({
  size_estimate: { loc: 18000, modules: 9 }, mode: 'standard',
  stages: [{ id: 'S0', goal: '骨架', exit: ['REQ-001'] }, { id: 'S1', goal: '数据源管理', exit: ['REQ-012'] }],
  baseline: ['api:GET /api/users/me'],
  tasks: [{
    id: 'T-003', stage: 'S1', module: 'datasource', title: '数据源管理', size: 'M',
    layers: ['backend', 'database', 'frontend'], ac: ['REQ-012.AC1', 'REQ-012.AC2'],
    writes: ['server/src/datasource/**'], shared: ['server/src/routes.ts'],
    produces: ['table:datasources', 'api:POST /api/datasources'], requires: ['table:teams', '~api:GET /api/teams/{id}'],
    test_interface: ['HTTP /api/datasources*', 'page /datasources'], manual_checks: ['新增后列表高亮'], review: 'strong', risk: 'high',
  }],
});
test('规格第 7.1 节计划通过；可选字段可省略；standard 与 lean 均合法', () => {
  assert.deepEqual(validate('plan', plan()), []);
  const minimal = plan(); delete minimal.baseline;
  for (const key of ['shared', 'manual_checks', 'review', 'risk'] as const) delete minimal.tasks[0]![key];
  minimal.mode = 'lean';
  assert.deepEqual(validate('plan', minimal), []);
  for (const review of ['skip', 'auto', 'strong'] as const) assert.deepEqual(validate('plan', { ...minimal, tasks: [{ ...minimal.tasks[0], review }] }), []);
});
test('计划拒绝缺字段、未知字段、错误类型、负整数、空阶段或任务、错误枚举', () => {
  for (const key of ['size_estimate', 'mode', 'stages', 'tasks']) {
    const invalid: Record<string, unknown> = structuredClone(plan()); delete invalid[key]; assert.ok(validate('plan', invalid).length, key);
  }
  for (const key of ['id', 'stage', 'module', 'title', 'size', 'layers', 'ac', 'writes', 'produces', 'requires', 'test_interface']) {
    const invalid = plan(); const entry = invalid.tasks[0]! as unknown as Record<string, unknown>; delete entry[key]; assert.ok(validate('plan', invalid).length, key);
  }
  for (const change of [
    { extra: true }, { mode: 'unknown' }, { stages: [] }, { tasks: [] },
    { size_estimate: { loc: -1, modules: 1 } }, { size_estimate: { loc: 1.5, modules: 1 } },
    { stages: [{ id: 'S0', goal: '骨架', exit: 'REQ-001' }] },
    { tasks: [{ ...plan().tasks[0], review: true }] }, { tasks: [{ ...plan().tasks[0], risk: 'critical' }] },
    { tasks: [{ ...plan().tasks[0], acceptance: ['旧字段'] }] },
  ]) assert.ok(validate('plan', { ...plan(), ...change }).length);
});
test('M1 只校验形状：重复编号、未知阶段、符号和 AC 暂由后续语义检查处理', () => {
  const p = plan(); p.tasks.push(structuredClone(p.tasks[0]!)); p.tasks[0]!.stage = 'unknown'; p.tasks[0]!.requires = ['任意符号'];
  assert.deepEqual(validate('plan', p), []);
});
test('编号支持主任务与 .at/.rv/.fx 派生任务，其他后缀与旧 kind 被拒', () => {
  for (const id of ['T-003', 'T-1000', 'T-003.at', 'T-003.at-2', 'T-003.rv', 'T-003.rv-2', 'T-003.fx-1', 'T-003.fx']) assert.deepEqual(validate('task', mkTask(id)), [], id);
  for (const id of ['T-03', 'T-003.at-x', 'T-003.at-2.rv', 'T-003.foo', 'T-003.at-']) assert.ok(validate('task', mkTask(id)).length, id);
  for (const kind of TASK_KINDS) assert.deepEqual(validate('task', mkTask('T-001', { kind })), []);
  for (const status of TASK_STATUSES) assert.deepEqual(validate('task', mkTask('T-001', { status })), []);
  for (const kind of ['analysis', 'review-fix']) assert.ok(validate('task', { ...mkTask('T-001'), kind }).length);
  assert.ok(validate('task', { ...mkTask('T-001'), status: 'accepting' }).length);
});
test('任务新增字段与独立计数合法；已删除字段与 main 范围授权被拒', () => {
  const t = mkTask('T-003.fx-1', {
    kind: 'fix', module: 'datasource', ac: ['REQ-012.AC1'], layers: ['backend'], produces: ['table:datasources'], requires: ['~table:teams'], test_interface: ['HTTP /api/datasources*'],
    review: 'skip', risk: 'high', for_task: 'T-003', deviations: ['按既有约定实现'], precheck_failures: 1, review_rounds: 2, merge_failures: 1, disputes: { '测试 a': 2 }, blocked_by: null,
  });
  assert.deepEqual(validate('task', t), []);
  for (const blocked_by of ['dispute', 'review_exhausted', 'precheck_exhausted', 'merge_exhausted', 'attempts', 'agent', 'dispatcher', 'user', 'integration_broken']) assert.deepEqual(validate('task', { ...t, blocked_by }), []);
  for (const key of ['attempts', 'precheck_failures', 'review_rounds', 'merge_failures']) assert.ok(validate('task', { ...t, [key]: -1 }).length);
  assert.ok(validate('task', { ...t, disputes: { a: -1 } }).length);
  for (const key of ['acceptance', 'needs_acceptance', 'accepted', 'accept_of', 'accept_kind', 'final_review', 'replan']) assert.ok(validate('task', { ...t, [key]: '旧字段' }).length, key);
  const grant = { paths: ['src/a.ts'], reason: '扩大范围', by: 'orchestrator', at: '2026-01-01' };
  assert.deepEqual(validate('task', { ...t, scope_grants: [grant] }), []);
  assert.ok(validate('task', { ...t, scope_grants: [{ ...grant, by: 'main' }] }).length);
});
test('flow 支持动态阶段、needs_human 与新事件，旧流程字段被拒', () => {
  const f = { id: 'B-001', mode: 'build', title: '流程', stages: ['P0', 'P1', 'S0'], stage: 'S0', stage_status: 'needs_human', integration_branch: 'forge/B-001', base_sha: null, approvals: {}, created_at: '2026-01-01', version: 1, s_stages: [{ id: 'S0', goal: '骨架', exit: ['REQ-001'] }], plan_mode: 'standard' };
  assert.deepEqual(validate('flow', f), []);
  for (const key of ['requirements', 'planning', 'replan_request', 'skip_stages']) assert.ok(validate('flow', { ...f, [key]: {} }).length);
  for (const type of ['stages_planned', 'stages_revised', 'stage_reopened']) {
    const e = { seq: 1, ts: '2026-01-01', flow: 'B-001', actor: 'orchestrator', type, prev_hash: '0'.repeat(64), hash: '1'.repeat(64) };
    assert.deepEqual(validate('event', e), []);
  }
});
test('格式从 1 开始，无内置迁移，旧流程专用 schema 不再导出', () => {
  assert.equal(SCHEMA_VERSION, 1); assert.deepEqual(MIGRATIONS, []);
  assert.deepEqual(migrationChain(1, 1), { steps: [], missing: null });
  assert.deepEqual(migrationChain(1, 2), { steps: [], missing: 1 });
  assert.ok('plan' in SCHEMAS);
  for (const key of ['proposal', 'revision', 'acceptance', 'final-review']) assert.equal(key in SCHEMAS, false);
});
