// 跨运行的循环（第六轮 B3、B4）：同样的原因连续失败时立刻升级模型、升级后仍一样就交给用户；模块连同派生任务超出谱系预算时交给用户。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine, ALL_FAKE } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';

const task1 = () => mkTask('T-001', { verify: ['test'] });

async function submit(a: FakeAgent, content: string) {
  assert.ok((await a.call('forge_claim')).ok);
  assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content })).ok);
  await a.call('forge_note', { text: '完成' });
  assert.ok((await a.call('forge_submit', { summary: 'a' })).ok);
}

test('同样的原因连续失败两次：第三次直接用升级模型（不等失败次数）；升级后仍然一样就交给用户', async () => {
  const settings = { version: 1 as const, roles: { ...ALL_FAKE.roles, 'worker': { model: 'fake/small', escalate_model: 'fake/big' } } };
  const p = await setupProject({ yaml: PROJECT_YAML.replace(/after_failures: \d+/, 'after_failures: 5').replace(/max_attempts: \d+/, 'max_attempts: 6'), tasks: [task1()] });
  try {
    const { engine, launcher, errors } = makeEngine(p, async (_role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      throw new Error('同样的运行失败');
    }, settings);
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(launcher.launched.map((s) => s.model), ['fake/small', 'fake/small', 'fake/big']);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.equal(t.attempts, 3);
    assert.match(t.blocked_reason ?? '', /同样的原因连续失败 3 次（换过升级模型，仍然一样）/);
    assert.ok(p.store.listRuns().find((r) => r.model === 'fake/big')?.escalated);
    assert.deepEqual(errors, []);
    // 因调度器的重复失败看守阻塞，--reset 不会清零 attempts；保留 worktree，清除重复原因标记。
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'unblock', actor: 'human', facts: { reset: true } });
    const u = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([u.same_failures, u.failure_sig, u.attempts], [undefined, undefined, 3]);
  } finally { p.cleanup(); }
});

test('兜底模型：同样的原因连续失败，先换升级模型，再换兜底模型，都试过才交出去', async () => {
  const settings = { version: 1 as const, roles: { ...ALL_FAKE.roles, 'worker': { model: 'fake/small', escalate_model: 'fake/big' } }, fallback_model: 'fake/fb' };
  const p = await setupProject({ yaml: PROJECT_YAML.replace(/after_failures: \d+/, 'after_failures: 5').replace(/max_attempts: \d+/, 'max_attempts: 6'), tasks: [task1()] });
  try {
    const { engine, launcher, errors } = makeEngine(p, async (_role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      throw new Error('同样的运行失败');
    }, settings);
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(launcher.launched.map((s) => s.model), ['fake/small', 'fake/small', 'fake/big', 'fake/fb']);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.match(t.blocked_reason ?? '', /连续失败 4 次（换过升级模型、兜底模型，仍然一样）/);
    assert.ok(p.store.listRuns().find((r) => r.model === 'fake/fb')?.fallback);
    assert.deepEqual(errors, []);
  } finally { p.cleanup(); }
});

test('兜底模型：没有可升级的模型时，失败次数到了就用兜底模型代替升级', async () => {
  const settings = { version: 1 as const, roles: { ...ALL_FAKE.roles, 'worker': { model: 'fake/small' } }, fallback_model: 'fake/fb' };
  const p = await setupProject({ yaml: PROJECT_YAML.replace(/after_failures: \d+/, 'after_failures: 1').replace(/max_attempts: \d+/, 'max_attempts: 6'), tasks: [task1()] });
  try {
    let n = 0;
    const { engine, launcher, errors } = makeEngine(p, async (_role, _n, a) => {
      if (n++ === 0) { assert.ok((await a.call('forge_claim')).ok); throw new Error('第一次失败'); }
      await submit(a, 'export const a = 1;\n');
    }, settings);
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(launcher.launched.filter((s) => s.env['PI_FORGE_ROLE'] === 'worker').map((s) => s.model).slice(0, 2), ['fake/small', 'fake/fb']);
    assert.deepEqual(errors, []);
  } finally { p.cleanup(); }
});

