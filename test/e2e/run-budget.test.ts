// 来源：pi-flow test/e2e/run-budget.test.ts @ 31f3f15
// 每次运行的时间预算：到期提醒收尾，宽限期后结束；超时不计失败，等主会话复核（接着做、从头做、交给用户）；超时次数有上限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { FLOW5_YAML, SETTINGS5 } from '../helpers/flow5.ts';
import { sessionDirOf } from '../../src/core/session-log.ts';
import { runBudgetMinutes } from '../../src/core/run-budget.ts';
import { nextStep } from '../../src/core/context-injector.ts';
import { flowResolveTimeout, flowWait, statusText } from '../../src/tools/orchestrator-tools.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';

const MIN = 60_000;
/** 主会话复核（limits.timeout_review: orchestrator）；默认由程序按进展决定，见最后一条测试 */
const ORCHESTRATOR_YAML = FLOW5_YAML.replace(/^  timeout_review: auto.*$/m, '  timeout_review: orchestrator');
const mod = (id: string, over: Parameters<typeof mkTask>[1] = {}) => mkTask(id, {
  stage: 'S0', role: 'worker', scopes: ['code'], writes: [`src/${id.toLowerCase()}/**`], ac: ['能用'], verify: [], ...over,
});

/** 一直在做事、不提交，直到被结束（被结束后下一次工具调用抛出） */
async function busyUntilKilled(a: FakeAgent): Promise<void> {
  for (;;) {
    await a.call('read', { path: 'README.md' });
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('时间预算：按任务大小与类型计算', () => {
  const cfg = { limits: { run_minutes: 30 } } as never;
  assert.equal(runBudgetMinutes(cfg, { kind: 'impl' }), 30);
  assert.equal(runBudgetMinutes(cfg, { kind: 'impl', size: 'L' }), 60);
  assert.equal(runBudgetMinutes(cfg, { kind: 'impl', size: 'S' }), 15);
  assert.equal(runBudgetMinutes(cfg, { kind: 'review' }), 15, '验收等只读任务减半');
  assert.equal(runBudgetMinutes({ limits: {} } as never, { kind: 'impl' }), 30, '默认 30 分钟');
});

test('超时：到期插话提醒收尾，宽限期后结束；计一次运行失败，等主会话复核，复核前不重新派发；continue 接着原会话再做', async () => {
  let clock = Date.now(); // 假子进程的 forge_* 工具按真实时间检查租约
  const now = () => new Date(clock);
  const p = await setupProject({ yaml: ORCHESTRATOR_YAML, stages: ['S0'], now, tasks: [mod('T-001')] });
  try {
    const { engine, launcher, errors } = makeEngine(p, async (_role, nth, a) => {
      if (nth === 1) {
        await a.call('forge_claim');
        // 模拟 pi 的会话留档，复核后接着这次的对话
        const dir = sessionDirOf(p.dir, a.env.run);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 's.jsonl'), '{"type":"session"}\n');
        await a.call('forge_note', { text: '做到一半：接口写完了，页面还没做' });
        await busyUntilKilled(a);
        return;
      }
      await a.call('forge_claim');
      await a.call('write', { path: 'src/t-001/a.ts', content: 'x' });
      await a.call('forge_note', { text: '完成' });
      await a.call('forge_submit', { summary: '完成' });
    }, SETTINGS5, undefined, { now });
    await engine.next(p.flowId);
    const run1 = p.store.readTask(p.flowId, 'T-001').lease!.run_id;
    assert.equal(Date.parse(p.store.readRun(run1).deadline_at!) - clock, 30 * MIN);

    clock += 29 * MIN;
    assert.deepEqual(await engine.checkDeadlines(), []);
    assert.equal(launcher.steers.length, 0, '没到期不提醒');

    clock += 1 * MIN;
    assert.deepEqual(await engine.checkDeadlines(), []);
    assert.equal(launcher.steers.length, 1);
    assert.match(launcher.steers[0]!.message, /时间预算（30 分钟）已用完/);
    assert.ok(p.store.readRun(run1).warned_at);
    await engine.checkDeadlines();
    assert.equal(launcher.steers.length, 1, '只提醒一次');

    clock += 5 * MIN;
    assert.deepEqual(await engine.checkDeadlines(), [run1], '宽限期后结束');
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'in_progress');
    assert.equal(t.lease, null);
    assert.equal(t.attempts, 1, '超时计入运行失败次数');
    assert.equal(t.timeouts, 1);
    assert.equal(t.timeout_review?.run, run1);
    assert.equal(p.store.readRun(run1).outcome, 'timeout');
    assert.equal(launcher.launched.length, 1, '复核前不重新派发');
    await engine.pump(p.flowId);
    await engine.idle();
    assert.equal(launcher.launched.length, 1, 'pump 也不派发等复核的任务');

    // 主会话：下一步是复核，材料里有 handoff
    const step = nextStep(p.store, 3, 0, p.config);
    assert.equal(step.tool, 'forge_resolve_timeout');
    assert.equal(step.task, 'T-001');
    const st = statusText(p.store, engine, p.flowId);
    assert.match(st, /运行超时，等你复核/);
    assert.match(st, /做到一半：接口写完了/);
    const w = await flowWait(p.store, engine, { timeout_s: 1 }, p.config);
    assert.match(w.text, /运行超时/);

    await assert.rejects(flowResolveTimeout(p.store, engine, { task_id: 'T-001', decision: 'block' }), /block 需要 note/);
    const r = await flowResolveTimeout(p.store, engine, { task_id: 'T-001', decision: 'continue', note: '先把页面做完，别再重写接口' });
    assert.match(r.text, /接着原会话/);
    await engine.idle();
    const spec2 = launcher.launched[1]!;
    assert.ok(spec2.forkFrom?.endsWith('s.jsonl'), '接着上一次的会话');
    assert.match(spec2.prompt, /用完了 30 分钟的时间预算/);
    assert.match(spec2.prompt, /先把页面做完，别再重写接口/);
    const done = p.store.readTask(p.flowId, 'T-001');
    assert.notEqual(done.status, 'in_progress');
    assert.equal(done.timeout_review, undefined, '决定在派发时用掉');
    assert.deepEqual(errors, []);
  } finally { p.cleanup(); }
});

test('超时：restart 不接旧会话、提示换思路；超时次数超过 max_continuations 转 blocked', async () => {
  let clock = Date.now(); // 假子进程的 forge_* 工具按真实时间检查租约
  const now = () => new Date(clock);
  const yaml = ORCHESTRATOR_YAML.replace(/^  max_continuations: 2.*$/m, '  max_continuations: 1');
  const p = await setupProject({ yaml, stages: ['S0'], now, tasks: [mod('T-001', { size: 'S' })] });
  try {
    const { engine, launcher } = makeEngine(p, async (_role, nth, a) => {
      await a.call('forge_claim');
      if (nth === 1) {
        const dir = sessionDirOf(p.dir, a.env.run);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 's.jsonl'), '{"type":"session"}\n');
      }
      await a.call('forge_note', { text: `第 ${nth} 次` });
      // 每次读不同的位置，不触发重复调用检测
      for (let i = 0; ; i++) { await a.call('read', { path: 'README.md', offset: i }); await new Promise((r) => setTimeout(r, 5)); }
    }, SETTINGS5, undefined, { now });
    const timeOut = async () => {
      clock += 15 * MIN; // S 号：15 分钟
      await engine.checkDeadlines();
      clock += 5 * MIN;
      await engine.checkDeadlines();
      await engine.idle();
    };
    await engine.next(p.flowId);
    await timeOut();
    await flowResolveTimeout(p.store, engine, { task_id: 'T-001', decision: 'restart', note: '换成增量实现' });
    await new Promise((r) => setTimeout(r, 20));
    const spec2 = launcher.launched[1]!;
    assert.equal(spec2.forkFrom, undefined, 'restart 不接旧会话');
    assert.match(spec2.prompt, /换个思路从头做/);
    assert.match(spec2.prompt, /换成增量实现/);

    await timeOut();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked', '第 2 次超时超过上限 1');
    assert.match(t.blocked_reason!, /运行已超时 2 次/);
    assert.equal(t.timeout_review, undefined);
  } finally { p.cleanup(); }
});

test('超时：主会话判断需要用户决定时 block', async () => {
  let clock = Date.now(); // 假子进程的 forge_* 工具按真实时间检查租约
  const now = () => new Date(clock);
  const p = await setupProject({ yaml: ORCHESTRATOR_YAML, stages: ['S0'], now, tasks: [mod('T-001')] });
  try {
    const { engine } = makeEngine(p, async (_role, _nth, a) => {
      await a.call('forge_claim');
      await busyUntilKilled(a);
    }, SETTINGS5, undefined, { now });
    await engine.next(p.flowId);
    clock += 35 * MIN; // 预算加宽限期都过了：直接结束
    await engine.checkDeadlines();
    await engine.idle();
    await flowResolveTimeout(p.store, engine, { task_id: 'T-001', decision: 'block', note: '需要用户决定桌面端怎么定位 pi' });
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.match(t.blocked_reason!, /需要用户决定桌面端怎么定位 pi/);
    await assert.rejects(flowResolveTimeout(p.store, engine, { task_id: 'T-001', decision: 'continue' }), /没有等待复核的超时/);
  } finally { p.cleanup(); }
});

test('宽限期内已经提交的运行不算超时', async () => {
  let clock = Date.now(); // 假子进程的 forge_* 工具按真实时间检查租约
  const now = () => new Date(clock);
  const p = await setupProject({ yaml: ORCHESTRATOR_YAML, stages: ['S0'], now, tasks: [mod('T-001')] });
  try {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const { engine } = makeEngine(p, async (_role, _nth, a) => {
      await a.call('forge_claim');
      await a.call('write', { path: 'src/t-001/a.ts', content: 'x' });
      await a.call('forge_note', { text: '完成' });
      await a.call('forge_submit', { summary: '完成' });
      await hold; // 提交后还没退出
    }, SETTINGS5, undefined, { now });
    await engine.next(p.flowId);
    const run = p.store.readTask(p.flowId, 'T-001').lease!.run_id;
    while (p.store.readRun(run).outcome !== 'submitted') await new Promise((r) => setTimeout(r, 10));
    clock += 40 * MIN;
    await engine.checkDeadlines();
    assert.deepEqual(await engine.checkDeadlines(), []);
    assert.equal(p.store.readRun(run).outcome, 'submitted');
    release();
    await engine.idle();
  } finally { p.cleanup(); }
});

test('超时：默认由程序按进展复核——有改动接着原会话做；没有进展从头做一次；从头做后仍没有进展交给用户', async () => {
  let clock = Date.now();
  const now = () => new Date(clock);
  const p = await setupProject({ yaml: FLOW5_YAML.replace(/max_attempts: \d+/, 'max_attempts: 5').replace(/^  max_continuations: 2.*$/m, '  max_continuations: 5'), stages: ['S0'], now, tasks: [mod('T-001')] });
  try {
    assert.equal(p.config.limits.timeout_review, 'auto');
    const { engine, launcher, errors } = makeEngine(p, async (_role, nth, a) => {
      await a.call('forge_claim');
      if (nth === 1) await a.call('write', { path: 'src/t-001/a.ts', content: 'export const a = 1;\n' });
      await a.call('forge_note', { text: `第 ${nth} 次` });
      // 每次读不同的位置，不触发重复调用检测
      for (let i = 0; ; i++) { await a.call('read', { path: 'README.md', offset: i }); await new Promise((r) => setTimeout(r, 5)); }
    }, SETTINGS5, undefined, { now });
    // 超时后不等 idle（接着派发的运行会一直忙下去）：等到重新派发或转 blocked
    const timeOut = async () => {
      const n = launcher.launched.length;
      clock += 30 * MIN;
      await engine.checkDeadlines(); // 提醒收尾
      clock += 5 * MIN;
      await engine.checkDeadlines(); // 宽限期后结束
      for (let i = 0; i < 500 && launcher.launched.length === n && p.store.readTask(p.flowId, 'T-001').status !== 'blocked'; i++) await new Promise((r) => setTimeout(r, 10));
    };
    await engine.next(p.flowId);
    await timeOut();
    // 第一次：有改动 → continue，不等主会话
    assert.equal(launcher.launched.length, 2);
    assert.match(launcher.launched[1]!.prompt, /程序复核：有进展（本地提交 0 个、改动 1 行）/);
    assert.notEqual(nextStep(p.store, 3, 0, p.config).tool, 'forge_resolve_timeout');
    await timeOut();
    // 第二次：和上次比没有变化 → restart
    assert.equal(launcher.launched.length, 3);
    assert.match(launcher.launched[2]!.prompt, /程序复核：没有进展[\s\S]*从头做/);
    await timeOut();
    // 从头做后仍没有进展 → 交给用户
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.match(t.blocked_reason ?? '', /运行超时：从头换思路做了一次仍没有进展/);
    assert.equal(launcher.launched.length, 3);
    assert.deepEqual(errors, []);
  } finally { p.cleanup(); }
});
