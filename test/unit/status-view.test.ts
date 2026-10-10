// 改编自 pi-flow test/unit/status-view.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../../src/core/config.ts';
import { phaseOfStage, renderStatus, taskActivity, notices, snapshotOf, actionsNeeded, statusLine } from '../../src/core/status-view.ts';
import { hashToken } from '../../src/core/state-machine.ts';
import { setupProject } from '../helpers/project.ts';
import { TEST_YAML, REAL_TEMPLATE_YAML } from '../helpers/config.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

test('phase：模板显式配置；缺省按阶段 id 推断；顺序倒退报错', () => {
  const c = parseConfig(REAL_TEMPLATE_YAML);
  assert.equal(phaseOfStage(c, 'build', 'P0'), 'spec');
  assert.equal(phaseOfStage(c, 'build', 'P1'), 'plan');
  assert.equal(phaseOfStage(c, 'feature', 'S0'), 'implementation');
  const noPhase = parseConfig(REAL_TEMPLATE_YAML.replace(/phase: \w+,\s*/g, ''));
  assert.equal(phaseOfStage(noPhase, 'build', 'S0'), 'implementation');
  assert.throws(() => parseConfig(REAL_TEMPLATE_YAML.replace(/(id: P0, name: spec,\s*phase:) spec/g, '$1 implementation')),
    (e: unknown) => e instanceof ConfigError && /phase plan 不能排在 implementation 之后/.test(e.message));
});

test('任务活动用人话表示，重试带上次失败原因', () => {
  const lease = { run_id: 'r', role: 'worker', token_hash: 'a'.repeat(64), acquired_at: 'x', expires_at: 'y' };
  assert.equal(taskActivity(mkTask('T-1', { status: 'in_progress', lease }), null), '实现中');
  assert.equal(taskActivity(mkTask('T-1', { status: 'in_progress', attempts: 1 }), '合并时全量测试失败'), '等待重新派发（第 2 次，上次：合并时全量测试失败）');
  const qaLease = { ...lease, role: 'stage-qa' };
  assert.equal(taskActivity(mkTask('T-1', { status: 'in_progress', lease: qaLease, kind: 'qa', role: 'stage-qa', scopes: ['qa'], writes: [], for_task: 'T-2' }), null), '阶段验收中');
  assert.equal(taskActivity(mkTask('T-1', { status: 'queued_merge' }), null), '合入中');
  assert.equal(taskActivity(mkTask('T-1', { status: 'merging' }), null), '合入中');
});

test('/forge status 精简视图：阶段条、进度、正在进行、需要你处理放在最上面', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { title: '用户服务' }), mkTask('T-002', { deps: [hard('T-001')] }), mkTask('T-003')] });
  try {
    let out = renderStatus(p.store, p.config);
    assert.match(out, /^需要你处理：无/);
    assert.match(out, /\[实施\] → 交付/);
    assert.match(out, /实施阶段：按任务实施并运行全量验证/);
    assert.match(out, /进度：0 \/ 3 个任务完成/);
    assert.doesNotMatch(out, /pending|in_progress|queued_merge|S3/, '不暴露内部状态名');

    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 's' });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'd', patch: {
      lease: { run_id: 'r-1', role: 'worker', token_hash: hashToken('t'), acquired_at: 'x', expires_at: '2999-01-01T00:00:00Z' },
      worktree: '/w', branch: 'b', base_sha: 'c' } });
    out = renderStatus(p.store, p.config);
    assert.match(out, /正在进行：\n- T-001 用户服务（worker）实现中/);

    await p.store.transitionTask(p.flowId, 'T-001', { to: 'blocked', trigger: 'block', actor: 'run:r-1', facts: { reason: '用 PostgreSQL 还是 SQLite？' } });
    out = renderStatus(p.store, p.config);
    assert.match(out, /^需要你处理：\n- T-001「用户服务」阻塞：用 PostgreSQL 还是 SQLite？\n  → \/forge answer T-001/);
    assert.match(out, /阻塞：T-001/);

    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    assert.ok(actionsNeeded(p.store, p.config).some((a) => /全部任务已完成，等你批准合入主分支/.test(a.text) && a.command.startsWith('/forge-approve')));
  } finally { p.cleanup(); }
});

test('主动通知：只在进入新阶段、出现需要处理的事、首次失败重试时出现', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001'), mkTask('T-002')] });
  try {
    const s0 = snapshotOf(p.store, p.config);
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 's' });
    assert.deepEqual(notices(s0, snapshotOf(p.store, p.config)), [], '普通的任务推进不通知');
    const s1 = snapshotOf(p.store, p.config);
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'd', patch: {
      lease: { run_id: 'r-1', role: 'worker', token_hash: hashToken('t'), acquired_at: 'x', expires_at: '2999-01-01T00:00:00Z' },
      worktree: '/w', branch: 'b', base_sha: 'c' } });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'run_failed', actor: 'd', facts: { reason: '崩溃' } });
    const s2 = snapshotOf(p.store, p.config);
    assert.deepEqual(notices(s1, s2, () => '运行中断'), ['pi-forge：T-001 第一次未通过（运行中断），程序已自动重试。']);
    await p.store.transitionTask(p.flowId, 'T-002', { to: 'ready', trigger: 'schedule', actor: 's' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    const n = notices(s2, snapshotOf(p.store, p.config));
    assert.equal(n.length, 1);
    assert.match(n[0]!, /需要你处理：全部任务已完成，等你批准合入主分支/);
    await p.store.transitionStage(p.flowId, { to: 'done', trigger: 'approve', actor: 'human' });
    const s3 = snapshotOf(p.store, p.config);
    await p.store.advanceStage(p.flowId, 'human');
    assert.deepEqual(notices(s3, snapshotOf(p.store, p.config)), ['pi-forge：B-001 已结束。'], '流程结束时提醒一次');
  } finally { p.cleanup(); }
});

test('状态栏一行：流程、高层阶段、进度、进行中的任务、需要处理的事项；没有流程时为 null', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001'), mkTask('T-002', { deps: [hard('T-001')] }), mkTask('T-003', { writes: ['src/server/t-003/**'] })] });
  try {
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher',
      patch: { worktree: '/w', branch: 'b', base_sha: 'abc', lease: { run_id: 'r-1', role: 'worker', token_hash: hashToken('t'), acquired_at: '2026-10-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' } } });
    assert.equal(statusLine(p.store, p.config), 'pi-forge B-001 实施 · 0/3 · 进行中：T-001 实现中');
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'blocked', trigger: 'block', actor: 'run:r-1', facts: { token: 't', reason: '需要决定' } });
    assert.match(statusLine(p.store, p.config)!, /需要你处理 1 项$/);
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.equal(statusLine(p.store, p.config), null);
  } finally { p.cleanup(); }
});
