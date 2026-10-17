// 任务、流程字段的形状校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMAS, TASK_KINDS, TASK_STATUSES, validate } from '../../src/core/state/schemas.ts';
import { mkTask } from '../helpers/tasks.ts';
import { SCHEMA_VERSION, MIGRATIONS, migrationChain } from '../../src/core/state/migrations.ts';

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
    review: 'skip', risk: 'high', for_task: 'T-003', deviations: ['按既有约定实现'], review_rounds: 2, merge_failures: 1, blocked_by: null,
  });
  assert.deepEqual(validate('task', t), []);
  for (const blocked_by of ['review_exhausted', 'merge_exhausted', 'attempts', 'agent', 'dispatcher', 'user', 'integration_broken']) assert.deepEqual(validate('task', { ...t, blocked_by }), []);
  for (const key of ['attempts', 'review_rounds', 'merge_failures']) assert.ok(validate('task', { ...t, [key]: -1 }).length);
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
test('格式版本 4：内置 1 → 2、2 → 3、3 → 4 的迁移，旧流程专用 schema 不再导出', () => {
  assert.equal(SCHEMA_VERSION, 4); assert.deepEqual(MIGRATIONS.map((m) => m.from), [1, 2, 3]);
  assert.deepEqual(migrationChain(4, 4), { steps: [], missing: null });
  assert.equal(migrationChain(1, 4).steps.length, 3);
  assert.deepEqual(migrationChain(4, 5), { steps: [], missing: 4 });
  for (const key of ['plan', 'plan-proposal', 'change', 'proposal', 'revision', 'acceptance', 'final-review', 'amend']) assert.equal(key in SCHEMAS, false, key);
});
