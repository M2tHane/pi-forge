// M1 集成：动态阶段与程序事实在 StateStore 中落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../../src/core/state/state-store.ts';
import { hashToken } from '../../src/core/state/state-machine.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { mkTask, soft } from '../helpers/tasks.ts';

const lease = (id: string) => ({ run_id: id, role: 'worker', token_hash: hashToken(id), acquired_at: '2026-01-01', expires_at: '2099-01-01' });

test('动态 S 阶段：计划与修订同时保存阶段顺序、plan_mode 和事件；非法输入不落盘', async () => {
  const r = tmpRepo();
  try {
    const store = await StateStore.init(r.dir, { git: false });
    const f = await store.createFlow({ mode: 'build', title: '阶段存储', stages: ['P0', 'P1'], base_sha: null });
    const stages = [{ id: 'S0', goal: '骨架', exit: ['REQ-001'] }, { id: 'S1', goal: '业务', exit: ['REQ-002'] }];
    const planned = await store.setStages(f.id, stages, 'standard');
    assert.deepEqual(planned.stages, ['P0', 'P1', 'S0', 'S1']);
    assert.deepEqual(planned.s_stages, stages);
    assert.equal(planned.plan_mode, 'standard');
    const revised = await store.setStages(f.id, [stages[0]!], 'lean', 'human', true);
    assert.deepEqual(revised.stages, ['P0', 'P1', 'S0']);
    assert.equal(revised.plan_mode, 'lean');
    assert.deepEqual(store.readEvents().filter((e) => e.type.startsWith('stages_')).map((e) => e.type), ['stages_planned', 'stages_revised']);
    const version = store.readState().version;
    await assert.rejects(store.setStages(f.id, [stages[0]!, stages[0]!], 'standard'), /编号重复/);
    assert.equal(store.readState().version, version);
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { r.cleanup(); }
});

test('阶段打回：awaiting_human 与 needs_human 回 active 时各记录一次 stage_reopened；门禁可重跑和人工接受', async () => {
  for (const exhausted of [false, true]) {
    const r = tmpRepo();
    try {
      const store = await StateStore.init(r.dir, { git: false });
      const f = await store.createFlow({ mode: 'build', title: '打回', stages: ['S0'], base_sha: null });
      await store.transitionStage(f.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      if (exhausted) {
        await store.transitionStage(f.id, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'gate', reason: '两轮未通过' });
        await store.transitionStage(f.id, { to: 'awaiting_gate', trigger: 'gate_rerun', actor: 'human' });
        await store.transitionStage(f.id, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'gate', reason: '重跑仍失败' });
      } else await store.transitionStage(f.id, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });
      await store.transitionStage(f.id, { to: 'active', trigger: 'reject', actor: 'human', reason: '补齐边界条件' });
      const reopened = store.readEvents().filter((e) => e.type === 'stage_reopened');
      assert.equal(reopened.length, 1);
      assert.equal(reopened[0]!.from, exhausted ? 'needs_human' : 'awaiting_human');
      assert.equal(reopened[0]!.reason, '补齐边界条件');
      assert.equal(store.readFlow(f.id).stage_status, 'active');
      assert.deepEqual((await store.verifyIntegrity()).errors, []);
    } finally { r.cleanup(); }
  }
});

test('预检 facts：最新 .at 与软依赖未完成时，调用方不能伪造等待条件', async () => {
  const r = tmpRepo();
  try {
    const store = await StateStore.init(r.dir, { git: false });
    const f = await store.createFlow({ mode: 'build', title: '等待事实', stages: ['S3'], base_sha: 'base' });
    await store.addTasks(f.id, [mkTask('T-001', { deps: [soft('T-002')] }), mkTask('T-002'), mkTask('T-001.at-2', { kind: 'acctest', for_task: 'T-001', writes: [] })], 'architect');
    await store.transitionTask(f.id, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    await store.transitionTask(f.id, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher', patch: { lease: lease('r-1'), worktree: '/worktree', branch: 'task', base_sha: 'base' } });
    await store.appendHandoff(f.id, 'T-001', '完成', 'run:r-1');
    await store.transitionTask(f.id, 'T-001', { to: 'awaiting_inputs', trigger: 'submit', actor: 'run:r-1', facts: { token: 'r-1', diff_files: ['src/server/t-001/a.ts'] } });
    await assert.rejects(store.transitionTask(f.id, 'T-001', { to: 'checking', trigger: 'inputs_ready', actor: 'engine', facts: { inputs_synced: true, latest_acctest_done: true, soft_deps_done: true, status_of: new Map([['T-002', 'done']]) } }), /最新验收测试尚未 done.*软依赖生产方尚未 done/s);
    assert.equal(store.readTask(f.id, 'T-001').status, 'awaiting_inputs');
  } finally { r.cleanup(); }
});
