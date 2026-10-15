// M1：plan.yaml 与任务、流程新增字段的形状校验；语义校验留给 M3。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMAS, TASK_KINDS, TASK_STATUSES, validate, type PlanFile } from '../../src/core/state/schemas.ts';
import { mkTask } from '../helpers/tasks.ts';
import { SCHEMA_VERSION, MIGRATIONS, migrationChain } from '../../src/core/state/migrations.ts';

const plan = (): PlanFile => ({
  stages: [{ id: 'S0', goal: '骨架', exit: ['REQ-001'] }, { id: 'S1', goal: '数据源管理', exit: ['REQ-012'] }],
  tasks: [{
    id: 'T-003', stage: 'S1', module: 'datasource', title: '数据源管理', size: 'M',
    layers: ['backend', 'database', 'frontend'], ac: ['REQ-012.AC1', 'REQ-012.AC2'],
    writes: ['server/src/datasource/**'], shared: ['server/src/routes.ts'],
    produces: ['table:datasources', 'api:POST /api/datasources'], requires: ['table:teams', '~api:GET /api/teams/{id}'],
    manual_checks: ['新增后列表高亮'], risk: 'high',
  }],
});
test('完整的计划通过；可选字段可省略', () => {
  assert.deepEqual(validate('plan', plan()), []);
  const minimal = plan();
  for (const key of ['shared', 'manual_checks', 'risk'] as const) delete minimal.tasks[0]![key];
  assert.deepEqual(validate('plan', minimal), []);
});
test('计划拒绝缺字段、未知字段、错误类型、负整数、空阶段或任务、错误枚举', () => {
  for (const key of ['stages', 'tasks']) {
    const invalid: Record<string, unknown> = structuredClone(plan()); delete invalid[key]; assert.ok(validate('plan', invalid).length, key);
  }
  for (const key of ['id', 'stage', 'title', 'layers', 'ac', 'writes', 'produces', 'requires']) {
    const invalid = plan(); const entry = invalid.tasks[0]! as unknown as Record<string, unknown>; delete entry[key]; assert.ok(validate('plan', invalid).length, key);
  }
  for (const change of [
    { extra: true }, { mode: 'unknown' }, { stages: [] }, { tasks: [] },
    { stages: [{ id: 'S0', goal: '骨架', exit: 'REQ-001' }] },
    { tasks: [{ ...plan().tasks[0], review: 'strong' }] }, { tasks: [{ ...plan().tasks[0], risk: 'critical' }] },
    { tasks: [{ ...plan().tasks[0], acceptance: ['旧字段'] }] },
  ]) assert.ok(validate('plan', { ...plan(), ...change }).length);
});
test('parsePlan：多写的字段忽略，列表字段与 exit 缺省为空，module 与 size 可省略', async () => {
  const { parsePlan } = await import('../../src/core/plan/plan.ts');
  const r = parsePlan(['size_estimate: { loc: 100 }', 'note: 随手写的', 'stages:', '  - { id: S0, goal: 骨架 }', 'tasks:', '  - { id: T-001, stage: S0, title: 骨架, description: 多写的, owner: architect }'].join('\n'));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.plan!.stages[0]!.exit, []);
  assert.deepEqual(r.plan!.tasks[0]!.writes, []);
  assert.equal((r.plan!.tasks[0] as Record<string, unknown>)['description'], undefined);
  assert.ok(parsePlan('stages: []\ntasks: []').errors.length, '空阶段与空任务仍然拒绝');
});
test('M1 只校验形状：重复编号、未知阶段、符号和 AC 暂由后续语义检查处理', () => {
  const p = plan(); p.tasks.push(structuredClone(p.tasks[0]!)); p.tasks[0]!.stage = 'unknown'; p.tasks[0]!.requires = ['任意符号'];
  assert.deepEqual(validate('plan', p), []);
});
test('编号支持主任务与 .rv/.fx 派生任务与阶段 .qa，其他后缀与旧 kind 被拒', () => {
  for (const id of ['T-003', 'T-1000', 'T-003.rv', 'T-003.rv-2', 'T-003.fx-1', 'T-003.fx', 'S1.qa', 'S1.qa-2']) assert.deepEqual(validate('task', mkTask(id)), [], id);
  for (const id of ['T-03', 'T-003.at', 'T-003.at-2', 'T-003.rv-x', 'T-003.rv-2.fx', 'T-003.foo', 'T-003.rv-', 'S1.rv']) assert.ok(validate('task', mkTask(id)).length, id);
  for (const kind of TASK_KINDS) assert.deepEqual(validate('task', mkTask('T-001', { kind })), []);
  for (const status of TASK_STATUSES) assert.deepEqual(validate('task', mkTask('T-001', { status })), []);
  for (const kind of ['analysis', 'review-fix', 'acctest']) assert.ok(validate('task', { ...mkTask('T-001'), kind }).length);
  for (const status of ['accepting', 'disputed']) assert.ok(validate('task', { ...mkTask('T-001'), status }).length);
});
test('任务新增字段与独立计数合法；已删除字段与范围申请字段被拒', () => {
  const t = mkTask('T-003.fx-1', {
    kind: 'fix', module: 'datasource', ac: ['REQ-012.AC1'], layers: ['backend'], produces: ['table:datasources'], requires: ['~table:teams'],
    review: 'skip', risk: 'high', for_task: 'T-003', deviations: ['按既有约定实现'], precheck_failures: 1, review_rounds: 2, merge_failures: 1, blocked_by: null,
  });
  assert.deepEqual(validate('task', t), []);
  for (const blocked_by of ['review_exhausted', 'precheck_exhausted', 'merge_exhausted', 'attempts', 'agent', 'dispatcher', 'user', 'integration_broken']) assert.deepEqual(validate('task', { ...t, blocked_by }), []);
  for (const key of ['attempts', 'precheck_failures', 'review_rounds', 'merge_failures']) assert.ok(validate('task', { ...t, [key]: -1 }).length);
  for (const key of ['acceptance', 'needs_acceptance', 'accepted', 'accept_of', 'accept_kind', 'final_review', 'replan', 'disputes', 'waits_for', 'acctest_round', 'changed_tests']) assert.ok(validate('task', { ...t, [key]: '旧字段' }).length, key);
  // 范围申请机制已删除（格式 3）
  for (const key of ['scope_request', 'scope_grants']) assert.ok(validate('task', { ...t, [key]: [] }).length, key);
});
test('flow 支持动态阶段、needs_human 与新事件，旧流程字段被拒', () => {
  const f = { id: 'B-001', mode: 'build', title: '流程', stages: ['P0', 'P1', 'S0'], stage: 'S0', stage_status: 'needs_human', integration_branch: 'forge/B-001', base_sha: null, approvals: {}, created_at: '2026-01-01', version: 1, s_stages: [{ id: 'S0', goal: '骨架', exit: ['REQ-001'] }] };
  assert.deepEqual(validate('flow', f), []);
  for (const key of ['requirements', 'planning', 'replan_request', 'skip_stages', 'plan_mode']) assert.ok(validate('flow', { ...f, [key]: {} }).length);
  for (const type of ['stages_planned', 'stages_revised', 'stage_reopened']) {
    const e = { seq: 1, ts: '2026-01-01', flow: 'B-001', actor: 'orchestrator', type, prev_hash: '0'.repeat(64), hash: '1'.repeat(64) };
    assert.deepEqual(validate('event', e), []);
  }
});
test('格式版本 3：内置 1 → 2、2 → 3 的迁移，旧流程专用 schema 不再导出', () => {
  assert.equal(SCHEMA_VERSION, 3); assert.deepEqual(MIGRATIONS.map((m) => m.from), [1, 2]);
  assert.deepEqual(migrationChain(3, 3), { steps: [], missing: null });
  assert.equal(migrationChain(1, 3).steps.length, 2);
  assert.deepEqual(migrationChain(3, 4), { steps: [], missing: 3 });
  assert.ok('plan' in SCHEMAS);
  for (const key of ['proposal', 'revision', 'acceptance', 'final-review', 'amend']) assert.equal(key in SCHEMAS, false);
});
