// 来源：pi-flow test/e2e/loops.test.ts @ 31f3f15
// 跨运行的循环（第六轮 B3、B4）：同样的原因连续失败时立刻升级模型、升级后仍一样就交给用户；模块连同派生任务超出谱系预算时交给用户。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine, ALL_FAKE } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { lineageRoot, lineageTasks } from '../../src/core/lineage.ts';

const task1 = () => mkTask('T-001', { verify: ['test'] });

async function submit(a: FakeAgent, content: string) {
  assert.ok((await a.call('forge_claim')).ok);
  assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content })).ok);
  await a.call('forge_note', { text: '完成' });
  assert.ok((await a.call('forge_submit', { summary: 'a' })).ok);
}

test('同样的原因连续失败两次：第三次直接用升级模型（不等失败次数）；升级后仍然一样就交给用户', async () => {
  const settings = { version: 1 as const, roles: { ...ALL_FAKE.roles, 'backend-engineer': { model: 'fake/small', escalate_model: 'fake/big' } } };
  const p = await setupProject({ yaml: PROJECT_YAML.replace(/after_failures: \d+/, 'after_failures: 5').replace(/max_attempts: \d+/, 'max_attempts: 6'), tasks: [task1()] });
  try {
    const { engine, launcher, errors } = makeEngine(p, async (_role, _n, a) => submit(a, 'FAIL'), settings);
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(launcher.launched.map((s) => s.model), ['fake/small', 'fake/small', 'fake/big']);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.equal(t.attempts, 3);
    assert.match(t.blocked_reason ?? '', /同样的原因连续失败 3 次（升级模型后仍然一样）/);
    assert.ok(p.store.listRuns().find((r) => r.model === 'fake/big')?.escalated);
    assert.deepEqual(errors, []);
    // 用户解除阻塞后计数清零
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'unblock', actor: 'human' });
    const u = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([u.same_failures, u.failure_sig, u.attempts], [undefined, undefined, 0]);
  } finally { p.cleanup(); }
});

test('模块谱系预算：失败原因各不相同、失败次数也没用完，但模块累计运行次数超过 limits.module_runs 时交给用户；解除阻塞后重新计算', async () => {
  const yaml = PROJECT_YAML.replace(/max_attempts: \d+/, 'max_attempts: 10').replace(/(max_attempts: 10)/, '$1\n  module_runs: 3');
  const p = await setupProject({ yaml, tasks: [task1()] });
  try {
    assert.equal(p.config.limits.module_runs, 3);
    const { engine, launcher } = makeEngine(p, async (_role, nth, a) => {
      if (nth % 2 === 0) { await a.call('forge_claim'); throw new Error(`崩溃 ${'abcdef'[nth]}`); }
      await submit(a, 'FAIL');
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(launcher.launched.length, 3);
    assert.equal(t.status, 'blocked');
    assert.ok(t.attempts < 10);
    assert.match(t.blocked_reason ?? '', /模块 T-001「任务 T-001」连同派生任务（T-001）已运行 3 次[\s\S]*超过上限（3 次[\s\S]*最近的失败/);
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'unblock', actor: 'human' });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(launcher.launched.length, 6, '解除阻塞后又给了一轮');
  } finally { p.cleanup(); }
});

test('谱系：merge-fix、验收、修复任务都追溯到模块本身', () => {
  const tasks = [
    mkTask('T-001'),
    mkTask('T-002', { kind: 'merge-fix', merge_fix_for: 'T-001' }),
    mkTask('T-003', { kind: 'analysis', accept_of: 'T-001' }),
    mkTask('T-004', { kind: 'review-fix', fork_from_task: 'T-001' }),
    mkTask('T-005', { kind: 'merge-fix', merge_fix_for: 'T-004' }),
    mkTask('T-006'),
  ];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  assert.equal(lineageRoot(byId.get('T-005')!, byId).id, 'T-001');
  assert.deepEqual(lineageTasks(byId.get('T-001')!, tasks).map((t) => t.id), ['T-001', 'T-002', 'T-003', 'T-004', 'T-005']);
  assert.deepEqual(lineageTasks(byId.get('T-006')!, tasks).map((t) => t.id), ['T-006']);
});
