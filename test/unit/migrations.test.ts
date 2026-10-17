import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore, taskRel } from '../../src/core/state/state-store.ts';
import { legacyFlows, resume } from '../../src/core/ops/resume.ts';
import { doctor } from '../../src/core/ops/doctor.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { TEST_YAML } from '../helpers/config.ts';
import type { Migration } from '../../src/core/state/migrations.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { mkTask } from '../helpers/tasks.ts';

const now = () => new Date('2026-01-01T00:00:00Z');
const mark: Migration = { from: 1, description: '任务标题加星号', task: (t) => ({ ...t, title: `${String(t['title'])}*` }), flow: (f) => ({ ...f, title: `${String(f['title'])}!` }) };

/** 旧流程走过 D0 进入 D1 */
async function passStage(store: StateStore, flow: string) {
  await store.transitionStage(flow, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  await store.transitionStage(flow, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });
  await store.transitionStage(flow, { to: 'done', trigger: 'approve', actor: 'human' });
  await store.advanceStage(flow, 'human');
}

async function oldStore() {
  const repo = tmpRepo();
  const store = await StateStore.init(repo.dir, { now, git: false, schemaVersion: 1 });
  const flow = await store.createFlow({ mode: 'build', title: '旧流程', stages: ['E'], base_sha: null });
  await store.addTasks(flow.id, [mkTask('T-001', { stage: 'E' }), mkTask('T-002', { stage: 'E' })], 'architect');
  return { ...repo, flow: flow.id };
}

test('迁移：显式 migrate 按版本链改写流程与任务，记事件，完整性校验通过；已是最新时不做事', async () => {
  const { dir, flow, cleanup } = await oldStore();
  try {
    const v2 = new StateStore(dir, { now, git: false, schemaVersion: 2, migrations: [mark] });
    const done = await v2.migrate();
    assert.equal(done.length, 1);
    assert.match(done[0]!, /格式 1 → 2：任务标题加星号/);
    assert.equal(v2.readState().schema_version, 2);
    assert.equal(v2.readFlow(flow).title, '旧流程!');
    assert.deepEqual(v2.listTasks(flow).map((t) => t.title), ['任务 T-001*', '任务 T-002*']);
    assert.ok((await v2.verifyIntegrity()).ok);
    assert.deepEqual(await v2.migrate(), []);
  } finally { cleanup(); }
});

test('迁移：任何写入前自动迁移；更新版本写入的拒绝；缺少某一步时给出明确提示', async () => {
  const { dir, flow, cleanup } = await oldStore();
  try {
    const v3 = new StateStore(dir, { now, git: false, schemaVersion: 3, migrations: [mark] });
    await assert.rejects(v3.migrate(), /格式 2 无法迁移到 3/);
    const v2 = new StateStore(dir, { now, git: false, schemaVersion: 2, migrations: [mark] });
    await v2.transitionTask(flow, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    assert.equal(v2.readTask(flow, 'T-002').title, '任务 T-002*');
    assert.equal(v2.readTask(flow, 'T-001').status, 'ready');
    const v1 = new StateStore(dir, { now, git: false, schemaVersion: 1 });
    await assert.rejects(v1.migrate(), /更新版本的 pi-forge/);
    await assert.rejects(v1.transitionTask(flow, 'T-002', { to: 'ready', trigger: 'schedule', actor: 'scheduler' }), /更新版本的 pi-forge/);
  } finally { cleanup(); }
});

test('迁移 2 → 3：去掉 task 的 scope_request 与 scope_grants，其余字段不变', async () => {
  const repo = tmpRepo();
  try {
    const old = await StateStore.init(repo.dir, { now, git: false, schemaVersion: 2 });
    const flow = await old.createFlow({ mode: 'build', title: '流程', stages: ['E'], base_sha: null });
    await old.addTasks(flow.id, [mkTask('T-001', { stage: 'E', title: '保留' })], 'architect');
    const file = path.join(repo.dir, '.forge', taskRel(flow.id, 'T-001'));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw['scope_request'] = { paths: ['src/a.ts'], reason: '旧申请', conflicts: ['x'], run: 'r1', at: '2026-01-01T00:00:00.000Z' };
    raw['scope_grants'] = [{ paths: ['src/b.ts'], reason: '旧批准', by: 'program', at: '2026-01-01T00:00:00.000Z' }];
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const latest = new StateStore(repo.dir, { now, git: false });
    const done = await latest.migrate();
    assert.equal(done.length, 1);
    assert.match(done[0]!, /格式 2 → 4：/);
    const t = latest.readTask(flow.id, 'T-001') as Record<string, unknown>;
    assert.equal(t['title'], '保留');
    assert.equal('scope_request' in t, false);
    assert.equal('scope_grants' in t, false);
    assert.equal(latest.readState().schema_version, 4);
    assert.deepEqual(await latest.migrate(), []);
  } finally { repo.cleanup(); }
});

test('旧流程（格式 3）不迁移：/forge-resume 提示中止后重建；/forge abort 能执行，删掉的状态转为阻塞并写明原因', async () => {
  const repo = tmpRepo();
  try {
    const old = await StateStore.init(repo.dir, { now, git: false, schemaVersion: 3 });
    const flow = await old.createFlow({ mode: 'build', title: '旧流程', stages: ['S1'], base_sha: null });
    await old.addTasks(flow.id, [mkTask('T-001', { stage: 'S1' }), mkTask('T-002', { stage: 'S1' })], 'architect');
    const file = path.join(repo.dir, '.forge', taskRel(flow.id, 'T-002'));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    Object.assign(raw, { status: 'awaiting_inputs', precheck_failures: 1, depends_on: [{ task: 'T-001', type: 'soft' }] });
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const store = new StateStore(repo.dir, { now, git: false });
    assert.deepEqual(legacyFlows(store), [flow.id]);
    const r = await resume({ root: repo.dir, store, config: parseConfig(TEST_YAML) });
    assert.equal(r.ok, false);
    assert.match(r.brief, /这是旧流程，请 \/forge abort 后用新流程重建/);
    assert.equal(store.readState().schema_version, 3, 'resume 不迁移');
    assert.ok((await doctor(repo.dir, store)).errors.some((e) => e.includes(`${flow.id}：这是旧流程，请 /forge abort 后用新流程重建`)));
    await store.transitionStage(flow.id, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const t = store.readTask(flow.id, 'T-002') as Record<string, unknown>;
    assert.deepEqual([t['status'], t['blocked_reason'], 'precheck_failures' in t, t['depends_on']], ['blocked', '这是旧流程，请 /forge abort 后用新流程重建', false, []]);
    assert.equal(store.readState().schema_version, 4);
    assert.deepEqual(legacyFlows(store), []);
  } finally { repo.cleanup(); }
});
