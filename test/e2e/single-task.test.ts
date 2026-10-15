// M3 验收：单任务闭环（fake-subagent 驱动真实的引擎、guard、工具、verify、状态存储）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DispatchError } from '../../src/core/engine/dispatcher.ts';
import type { RoleSettingsFile } from '../../src/core/state/schemas.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { makeEngine } from '../helpers/engine.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';

const allFake: RoleSettingsFile = { version: 1, roles: Object.fromEntries(
  ['worker'].map((r) => [r, { model: 'fake/model', thinking: 'low' as const }])) };

const task1 = () => mkTask('T-001', { verify: ['typecheck', 'test'] });

async function implGood(a: FakeAgent, content = 'export const a = 1;') {
  assert.ok((await a.call('forge_claim')).ok);
  assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content })).ok);
  assert.ok((await a.call('forge_note', { text: '完成 a.ts；下一步无' })).ok);
  const r = await a.call('forge_submit', { summary: '实现 a' });
  assert.ok(r.ok, r.text);
}


test('一个任务从 ready 走到 queued_merge 并自动合入；run 记录写入指标', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine, launcher, errors } = makeEngine(p, async (_role, _n, a) => implGood(a));
    const d = await engine.next(p.flowId);
    assert.equal(d.length, 1);
    assert.equal(d[0]!.model, 'fake/model');
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', t.last_failure ?? '');
    assert.ok(p.store.readEvents().some((e) => e.task === 'T-001' && e.trigger === 'submit' && e.from === 'in_progress' && e.to === 'awaiting_inputs'));
    assert.deepEqual(p.store.readMergeQueue().queue, []);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), 'export const a = 1;');

    // 子进程规格：模型、思考级别、工具白名单、guard 扩展最后、token 只在环境变量中
    assert.equal(launcher.launched.length, 2, 'impl 一律审查：worker 之后派一个 reviewer');
    const [impl] = launcher.launched;
    assert.equal(impl!.thinking, 'low');
    assert.ok(impl!.tools.includes('forge_submit') && impl!.tools.includes('notes') && !impl!.tools.includes('forge_accept'));
    assert.equal(impl!.extensions.at(-1), '/dev/null/subagent.ts');
    assert.ok(!impl!.prompt.includes(impl!.env['PI_FORGE_RUN_TOKEN']!));
    assert.match(impl!.cwd, /\.worktrees\/B-001-T-001$/);

    const runs = p.store.listRuns();
    assert.deepEqual(runs.map((r) => [r.role, r.outcome]), [['worker', 'submitted'], ['reviewer', 'submitted']]);
    for (const r of runs) {
      assert.ok(r.ended_at && r.tokens.input! > 0 && r.tokens.output! > 0 && r.model === 'fake/model');
      assert.equal(r.token_hash.length, 64);
    }
    // 预检与 build 流程的合并都不跑命令，所以 T-001 没有任何命令的 evidence
    assert.ok(!existsSync(path.join(p.dir, '.forge/flows', p.flowId, 'evidence/T-001')), '没有预检与合并的命令 evidence');
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /提交说明：实现 a/);
    // 主工作区没有被实施角色改动
    assert.ok(!existsSync(path.join(p.dir, 'src/server/t-001/a.ts')));
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('无 token 或错 token 的提交被拒；实施角色没有验收工具', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async (role, _n, a) => {
      await a.call('forge_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' });
      await a.call('forge_note', { text: 'n' });
      const forged = await a.callAs({ token: 'forged' }, 'forge_submit', { summary: 'x' });
      assert.equal(forged.ok, false);
      assert.match(forged.text, /token 无效/);
      const none = await a.callAs({ token: '' }, 'forge_submit', { summary: 'x' });
      assert.equal(none.ok, false);
      const otherRun = await a.callAs({ run: 'r-fake' }, 'forge_submit', { summary: 'x' });
      assert.equal(otherRun.ok, false);
      // 实施角色没有 forge_accept
      assert.match((await a.call('forge_accept', { items: [] })).text, /无权使用|未启用/);
      assert.ok((await a.call('forge_submit', { summary: 'x' })).ok);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
  } finally { p.cleanup(); }
});

test('writes 之外的文件（含别的 task 的验收测试、任何测试代码）可以直接改并合入；只有规格与受保护路径被拦下', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async (role, _n, a) => {
      await a.call('forge_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' });
      assert.ok((await a.call('write', { path: 'README.md', content: 'changed outside writes' })).ok);
      for (const f of ['tests/acceptance/T-009/a.test.ts', 'tests/unit/a.test.ts']) assert.ok((await a.call('write', { path: f, content: 'x' })).ok, f);
      for (const f of ['docs/spec/requirements.md', 'rules/global.md', 'workflow.yaml']) {
        const r = await a.call('write', { path: f, content: 'x' });
        assert.equal(r.ok, false, f);
      }
      await a.call('forge_note', { text: 'n' });
      const r = await a.call('forge_submit', { summary: 'x' });
      assert.ok(r.ok, r.text);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.equal(p.git('show', `flow/${p.flowId}/integration:README.md`).trim(), 'changed outside writes');
  } finally { p.cleanup(); }
});

test('提交前清理落在不能改的位置（docs/spec）、未被跟踪的文件；writes 外的新文件（含测试）照常提交', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    let submitText = '';
    const { engine } = makeEngine(p, async (role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content: 'export const a = 1;' })).ok);
      // 不经过工具（guard 看不到）写下的文件：规格目录里的被清理；测试代码与普通文件保留
      for (const d of ['tests/unit', 'src/shared', 'docs/spec']) mkdirSync(path.join(a.spec.cwd, d), { recursive: true });
      writeFileSync(path.join(a.spec.cwd, 'docs/spec/leftover.md'), '');
      writeFileSync(path.join(a.spec.cwd, 'tests/unit/leftover.test.ts'), '');
      writeFileSync(path.join(a.spec.cwd, 'src/shared/util.ts'), 'export const u = 1;');
      await a.call('forge_note', { text: '完成' });
      const r = await a.call('forge_submit', { summary: '实现 a' });
      assert.ok(r.ok, r.text);
      submitText = r.text;
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(submitText, /已清理可写范围外、未被跟踪的文件 1 个：docs\/spec\/leftover\.md/);
    assert.throws(() => p.git('show', `flow/${p.flowId}/integration:docs/spec/leftover.md`));
    assert.equal(p.git('show', `flow/${p.flowId}/integration:tests/unit/leftover.test.ts`), '');
    assert.match(p.git('show', `flow/${p.flowId}/integration:src/shared/util.ts`), /u = 1/);
  } finally { p.cleanup(); }
});

test('失败达上限转 blocked，不再派发；同样的原因连续失败两次且没有可升级的模型时提前交给用户（第六轮 B3）', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    // 三次不同原因的运行失败：只增加 attempts，按配置的上限阻塞。
    const { engine, launcher } = makeEngine(p, async (_role, nth, a) => {
      await a.call('forge_claim');
      throw new Error(['配置损坏', '模型连接失败', '依赖缺失'][nth - 1]);
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.equal(t.attempts, 3);
    assert.match(t.blocked_reason ?? '', /失败次数达到上限 3/);
    assert.equal(launcher.launched.filter((s) => s.env['PI_FORGE_ROLE'] === 'worker').length, 3);
  } finally { p.cleanup(); }
  const q = await setupProject({ tasks: [task1()] });
  try {
    const { engine, launcher, errors } = makeEngine(q, async (_role, _n, a) => {
      await a.call('forge_claim');
      throw new Error('模型连接失败');
    });
    await engine.next(q.flowId);
    await engine.idle();
    const t = q.store.readTask(q.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.equal(t.attempts, 2);
    assert.match(t.blocked_reason ?? '', /同样的原因连续失败 2 次（没有可升级的模型，也没有设置兜底模型）[\s\S]*模型连接失败[\s\S]*\/forge unblock T-001/);
    assert.equal(launcher.launched.length, 2);
    assert.deepEqual(errors, [], '交给用户不算程序出错');
  } finally { q.cleanup(); }
});

test('子进程未提交就退出：计一次失败并重新派发', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async (_role, nth, a) => {
      if (nth === 1) { await a.call('forge_claim'); throw new Error('模型连接失败'); }
      await implGood(a);
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done');
    assert.equal(t.attempts, 1);
    const failed = p.store.listRuns().find((r) => r.outcome === 'failed');
    assert.ok(failed);
    assert.ok(p.store.readEvents().some((e) => e.trigger === 'run_failed' && /模型连接失败/.test(e.reason ?? '')));
  } finally { p.cleanup(); }
});

test('被拦下的操作只记账：同一次运行里违规 7 次也不结束，之后照常提交', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async (_role, _n, a) => {
      await a.call('forge_claim');
      for (let i = 0; i < 7; i++) assert.equal((await a.call('bash', { command: `echo ${i} > .forge/state.json` })).ok, false);
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok\n' });
      assert.ok((await a.call('forge_submit', { summary: '完成' })).ok);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readEvents().filter((e) => e.type === 'violation').length, 7);
    assert.deepEqual(p.store.listRuns().filter((r) => r.task === 'T-001').map((r) => r.outcome), ['submitted']);
    assert.notEqual(p.store.readTask(p.flowId, 'T-001').status, 'blocked');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('角色未设置模型时拒绝派发并提示 /forge-config', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async () => {}, { version: 1, roles: {} });
    await engine.promote(p.flowId);
    await assert.rejects(engine.dispatch(p.flowId, 'T-001'), (e: unknown) => e instanceof DispatchError && /forge-config/.test((e as Error).message));
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'ready');
  } finally { p.cleanup(); }
});
