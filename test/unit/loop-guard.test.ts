// 来源：pi-flow test/unit/loop-guard.test.ts @ 31f3f15
// 运行内的打转检测（第六轮 B1、B2）：滑动窗口里的同类调用、同样的检查失败反复出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '../../src/core/state-store.ts';
import { hashToken } from '../../src/core/state-machine.ts';
import { parseConfig } from '../../src/core/config.ts';
import { SAME_FAILURE_LIMIT, SAME_FAILURE_WARN, SubagentRuntime, WINDOW_LIMIT, WINDOW_WARN, normalizedSignature } from '../../src/core/subagent-runtime.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { mkTask } from '../helpers/tasks.ts';

const config = parseConfig(TEST_YAML);
const now = () => new Date('2026-01-01T00:00:00Z');

async function setup() {
  const repo = tmpRepo();
  writeFileSync(path.join(repo.dir, 'README.md'), 'x');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'init');
  const store = await StateStore.init(repo.dir, { now, limits: config.limits });
  const flow = await store.createFlow({ mode: 'build', title: 'loop', stages: ['S3'], base_sha: 'abc' });
  await store.addTasks(flow.id, [mkTask('T-001', { writes: ['src/server/**'] })], 'architect');
  const wt = path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`);
  mkdirSync(path.join(wt, 'src/server'), { recursive: true });
  await store.transitionTask(flow.id, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  await store.transitionTask(flow.id, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher', patch: {
    lease: { run_id: 'r-1', role: 'backend-engineer', token_hash: hashToken('t'), acquired_at: now().toISOString(), expires_at: '2026-01-01T01:00:00Z' },
    worktree: wt, branch: 'flow/B-001/T-001', base_sha: 'abc' } });
  await store.createRun({ run_id: 'r-1', flow: flow.id, task: 'T-001', role: 'backend-engineer', model: null,
    started_at: now().toISOString(), ended_at: null, tokens: { input: null, output: null, cache_read: null, cache_write: null },
    outcome: null, token_hash: hashToken('t'), violations: 0 });
  const rt = new SubagentRuntime({ root: repo.dir, flow: flow.id, task: 'T-001', run: 'r-1', token: 't', role: 'backend-engineer' }, store, config, now);
  const cleanup = () => { repo.cleanup(); rmSync(wt, { recursive: true, force: true }); };
  return { store, flow, rt, wt: realpathSync(wt), cleanup };
}

const bash = (command: string) => ({ toolName: 'bash', input: { command } });

test('归一化签名：只差截断行数、数字参数的命令视为同一类', () => {
  assert.equal(normalizedSignature('bash', { command: 'node debug.js 1 | tail -50' }), normalizedSignature('bash', { command: 'node debug.js 2 | tail -n 80 2>&1' }));
  assert.notEqual(normalizedSignature('bash', { command: 'node debug.js' }), normalizedSignature('bash', { command: 'node other.js' }));
});

test('滑动窗口：两条命令交替执行、期间没有改文件 → 提醒，到上限结束运行并计一次失败', async () => {
  const { store, flow, rt, wt, cleanup } = await setup();
  try {
    let warned = -1;
    let stopped = -1;
    for (let i = 0; i < WINDOW_LIMIT && stopped < 0; i++) {
      for (const c of [`node debug.js ${i}`, 'ls src']) {
        const g = await rt.gate(bash(c), wt);
        if (g.block && !g.terminate && warned < 0) { warned = i; assert.match(g.reason, /期间没有改过文件/); }
        if (g.block && g.terminate) { stopped = i; assert.match(g.reason, /判定为原地打转/); break; }
      }
    }
    assert.equal(warned, WINDOW_WARN - 1);
    assert.equal(stopped, WINDOW_LIMIT - 1);
    const t = store.readTask(flow.id, 'T-001');
    assert.equal(t.attempts, 1);
    assert.equal(t.lease, null, '计一次失败，等引擎重新派发');
    assert.match(t.last_failure ?? '', /原地打转/);
    assert.equal(store.readRun('r-1').outcome, 'failed');
  } finally { cleanup(); }
});

test('滑动窗口：每次运行前都改了文件（改了再测）不算打转', async () => {
  const { rt, wt, cleanup } = await setup();
  try {
    for (let i = 0; i < WINDOW_LIMIT + 3; i++) {
      assert.equal((await rt.gate({ toolName: 'write', input: { path: 'src/server/a.ts', content: `edit ${String.fromCharCode(97 + i)}` } }, wt)).block, false);
      assert.equal((await rt.gate(bash('node src/server/a.ts'), wt)).block, false, `第 ${i} 次`);
    }
  } finally { cleanup(); }
});

test('同样的检查失败反复出现：提醒，到上限结束运行；失败变了或通过就清零', async () => {
  const { store, flow, rt, cleanup } = await setup();
  try {
    const fail = (n: number) => `FAIL tests/a.test.ts (${n} ms)\n  expected 3 received 2`;
    const run = (out: string, err = true) => rt.afterToolResult('bash', { command: 'npx vitest run' }, err, out);
    assert.deepEqual(await rt.afterToolResult('bash', { command: 'cat a' }, true, 'x'), {}, '不是检查类命令不管');
    for (let i = 1; i < SAME_FAILURE_WARN; i++) assert.deepEqual(await run(fail(i)), {});
    assert.match((await run(fail(9))).note ?? '', /同样的失败已经连续出现 3 次/);
    assert.deepEqual(await run('FAIL tests/b.test.ts\n  cannot read property'), {}, '失败变了，重新计数');
    assert.deepEqual(await run('ok', false), {});
    for (let i = 1; i < SAME_FAILURE_LIMIT; i++) await run(fail(i));
    const last = await run(fail(99));
    assert.equal(last.terminate, true);
    assert.match(last.note ?? '', /没有进展[\s\S]*expected 3 received 2/);
    const t = store.readTask(flow.id, 'T-001');
    assert.equal(t.attempts, 1);
    assert.match(t.last_failure ?? '', /同样的检查失败连续出现 5 次/);
  } finally { cleanup(); }
});

test('检查类命令：项目配置的命令与常见运行器', async () => {
  const { rt, cleanup } = await setup();
  try {
    assert.ok(rt.isCheckCommand('pnpm test -- --run'));
    assert.ok(rt.isCheckCommand('cd web && npx tsc --noEmit'));
    assert.ok(rt.isCheckCommand('uv run pytest -x'));
    assert.ok(!rt.isCheckCommand('ls -la'));
  } finally { cleanup(); }
});

test('滑动窗口：来回改成同样的两种内容（改过去又改回来）→ 提醒', async () => {
  const { rt, wt, cleanup } = await setup();
  try {
    let warned = false;
    for (let i = 0; i < WINDOW_WARN * 2 && !warned; i++) {
      const g = await rt.gate({ toolName: 'write', input: { path: 'src/server/a.ts', content: i % 2 ? 'A' : 'B' } }, wt);
      if (g.block) { warned = true; assert.match(g.reason, /来回改同样的内容/); }
    }
    assert.ok(warned);
  } finally { cleanup(); }
});
