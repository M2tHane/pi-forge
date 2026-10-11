// 改编自 pi-flow test/e2e/single-task.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
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
    assert.equal(launcher.launched.length, 1, '提交后直接合并，不派审查');
    const [impl] = launcher.launched;
    assert.equal(impl!.thinking, 'low');
    assert.ok(impl!.tools.includes('forge_submit') && impl!.tools.includes('notes') && !impl!.tools.includes('forge_accept'));
    assert.equal(impl!.extensions.at(-1), '/dev/null/subagent.ts');
    assert.ok(!impl!.prompt.includes(impl!.env['PI_FORGE_RUN_TOKEN']!));
    assert.match(impl!.cwd, /\.worktrees\/B-001-T-001$/);

    const runs = p.store.listRuns();
    assert.deepEqual(runs.map((r) => [r.role, r.outcome]), [['worker', 'submitted']]);
    for (const r of runs) {
      assert.ok(r.ended_at && r.tokens.input! > 0 && r.tokens.output! > 0 && r.model === 'fake/model');
      assert.equal(r.token_hash.length, 64);
    }
    const ev = readdirSync(path.join(p.dir, '.forge/flows', p.flowId, 'evidence/T-001'));
    // 预检在任务 worktree 跑 typecheck、lint、test（没有验收测试目录，不跑 acceptance）；
    // 合并时集成分支没动，代码树与预检相同：typecheck、lint、test 沿用预检的结果并留沿用记录，只跑全量 acceptance（偏离 76）
    assert.deepEqual(ev.sort(), ['merge-a0-acceptance.log', 'merge-a0-reused.txt',
      'precheck-a0-diff.txt', 'precheck-a0-lint.log', 'precheck-a0-test.log', 'precheck-a0-typecheck.log']);
    const reused = readFileSync(path.join(p.dir, '.forge/flows', p.flowId, 'evidence/T-001/merge-a0-reused.txt'), 'utf8');
    for (const c of ['typecheck', 'lint', 'test']) assert.match(reused, new RegExp(`- ${c}：沿用 \\S*/T-001/precheck-a0-${c}\\.log`));
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

test('diff 越界被拒（改了已跟踪的文件）；还原后再提交通过', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    let rejected = '';
    const { engine } = makeEngine(p, async (role, _n, a) => {
      await a.call('forge_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' });
      // write 工具越界会被 guard 拦下；绕过工具层的改动（例如程序运行改写了已跟踪的文件）靠提交时的 diff 检查兜底。
      // 未被跟踪的新文件会在提交前被清理（见下一个测试），已跟踪文件的改动不会被清理
      assert.equal((await a.call('write', { path: 'README.md', content: 'x' })).ok, false);
      writeFileSync(path.join(a.spec.cwd, 'README.md'), 'changed by a test run');
      await a.call('forge_note', { text: 'n' });
      const r = await a.call('forge_submit', { summary: 'x' });
      assert.equal(r.ok, false);
      rejected = r.text;
      assert.ok((await a.call('bash', { command: 'git checkout HEAD~1 -- README.md' })).ok);
      const r2 = await a.call('forge_submit', { summary: 'x' });
      assert.ok(r2.ok, r2.text);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.match(rejected, /越出任务 writes：README\.md/);
    assert.match(rejected, /git checkout/);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
  } finally { p.cleanup(); }
});

test('提交前清理可写范围外、未被跟踪的文件（测试运行留下的数据）；writes 内的文件照常提交', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    let submitText = '';
    const { engine } = makeEngine(p, async (role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content: 'export const a = 1;' })).ok);
      // 模拟测试或程序运行时在工作区写下的数据文件（不经过工具，guard 看不到）
      mkdirSync(path.join(a.spec.cwd, 'data'), { recursive: true });
      writeFileSync(path.join(a.spec.cwd, 'data/ledger.json'), '{}');
      await a.call('forge_note', { text: '完成' });
      const r = await a.call('forge_submit', { summary: '实现 a' });
      assert.ok(r.ok, r.text);
      submitText = r.text;
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(submitText, /已清理可写范围外、未被跟踪的文件 1 个：data\/ledger\.json/);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /程序清理了[\s\S]*data\/ledger\.json/);
    assert.throws(() => p.git('show', `flow/${p.flowId}/integration:data/ledger.json`));
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
    assert.match(t.blocked_reason ?? '', /同样的原因连续失败 2 次（没有可升级的模型）[\s\S]*模型连接失败[\s\S]*\/forge unblock T-001/);
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

test('违规达到上限：结束 run 并计一次失败、重新派发；同样的违规再来一次就交给用户', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async (_role, _n, a) => {
      for (let i = 0; i < 7; i++) await a.call('bash', { command: 'echo x > .forge/state.json' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.match(t.blocked_reason ?? '', /同样的原因连续失败 2 次[\s\S]*被拦下的操作达到 5 次/);
    assert.deepEqual(p.store.listRuns().map((r) => r.outcome), ['killed', 'killed']);
    assert.equal(p.store.readEvents().filter((e) => e.type === 'violation').length, 10, '每次运行上限 5');
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
