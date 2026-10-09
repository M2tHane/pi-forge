// 来源：pi-flow test/unit/migrations.test.ts @ 31f3f15
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../../src/core/state-store.ts';
import type { Migration } from '../../src/core/migrations.ts';
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

test('迁移 1 → 2（第六轮）：删除原型阶段；停在原型阶段的流程转到规划由主 agent 进行；designer、architect 未结束的任务取消；未结束的修订任务转为修订请求', async () => {
  const repo = tmpRepo();
  try {
    const old = await StateStore.init(repo.dir, { now, git: false, schemaVersion: 1 });
    const a = await old.createFlow({ mode: 'build', title: '停在原型', stages: ['D0', 'D1', 'D2', 'E'], base_sha: null });
    await passStage(old, a.id);
    await old.addTasks(a.id, [mkTask('T-001', { stage: 'D1', role: 'designer', kind: 'doc' })], 'engine');
    await old.transitionStage(a.id, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const b = await old.createFlow({ mode: 'feature', title: '实施中', stages: ['D0', 'D1', 'D2', 'E'], base_sha: null });
    await old.addTasks(b.id, [
      mkTask('T-001', { stage: 'E', role: 'implementer' }),
      mkTask('T-002', { stage: 'E', role: 'architect', kind: 'analysis', writes: [], replan: '加导出' }),
    ], 'architect');
    const store = new StateStore(repo.dir, { now, git: false });
    const done = await store.migrate();
    assert.match(done[0]!, /格式 1 → 2/);
    const fa = store.readFlow(a.id);
    assert.deepEqual(fa.stages, ['D0', 'D2', 'E']);
    const fb = store.readFlow(b.id);
    assert.deepEqual(fb.stages, ['D0', 'D2', 'E']);
    assert.equal(store.readTask(a.id, 'T-001').status, 'cancelled');
    assert.equal(store.readTask(b.id, 'T-001').status, 'pending', '实现任务不动');
    assert.equal(store.readTask(b.id, 'T-002').status, 'cancelled');
    assert.equal(fb.replan_request?.reason, '加导出');
    assert.ok((await store.verifyIntegrity()).ok);
  } finally { repo.cleanup(); }
});

test('迁移 1 → 2：停在原型阶段进行中的流程进入规划', async () => {
  const repo = tmpRepo();
  try {
    const old = await StateStore.init(repo.dir, { now, git: false, schemaVersion: 1 });
    const f = await old.createFlow({ mode: 'build', title: 'x', stages: ['D0', 'D1', 'D2', 'E'], base_sha: null });
    await passStage(old, f.id);
    assert.equal(old.readFlow(f.id).stage, 'D1');
    const store = new StateStore(repo.dir, { now, git: false });
    await store.migrate();
    const m = store.readFlow(f.id);
    assert.deepEqual([m.stage, m.stage_status, m.planning?.submitted], ['D2', 'active', false]);
    assert.match(m.planning?.feedback ?? '', /原型阶段已删除/);
  } finally { repo.cleanup(); }
});
