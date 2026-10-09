// 来源：pi-flow test/unit/flow-watch.test.ts @ 31f3f15（改名）
// 流程层面的时间与停滞（第六轮 B6）：墙钟不含等用户的时间；流程卡住；停滞看守；时间预算用完暂停派发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeMinutes, stuckTasks } from '../../src/core/forge-watch.ts';
import { budgetState } from '../../src/core/cost-control.ts';
import { actionsNeeded } from '../../src/core/status-view.ts';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask, hard } from '../helpers/tasks.ts';
import type { FlowEvent, FlowFile } from '../../src/core/schemas.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (m: number) => new Date(T0 + m * MIN).toISOString();
const flow = { id: 'B-001', stages: ['D0', 'D2', 'E'], stage: 'E', stage_status: 'active', created_at: at(0) } as FlowFile;
const ev = (m: number, to: string, stage?: string) => ({ flow: 'B-001', ts: at(m), to, data: { entity: 'stage', ...(stage ? { stage } : {}) } }) as unknown as FlowEvent;

test('流程墙钟：需求阶段与等用户审批的时间不计', () => {
  const events = [
    ev(30, 'D2'), // 需求阶段 30 分钟不计
    ev(40, 'awaiting_gate', 'D2'), ev(41, 'awaiting_human', 'D2'), ev(101, 'done', 'D2'), // 等审批 60 分钟不计
    ev(101, 'E'),
  ];
  assert.equal(activeMinutes(flow, events, new Date(T0 + 161 * MIN)), 10 + 1 + 60);
});

test('流程卡住：剩下的任务都 blocked 或只因为依赖 blocked 任务而没开始', () => {
  const blocked = mkTask('T-001', { stage: 'E', status: 'blocked' });
  const waits = mkTask('T-002', { stage: 'E', deps: [hard('T-001')] });
  const waits2 = mkTask('T-003', { stage: 'E', deps: [hard('T-002')] });
  const done = mkTask('T-004', { stage: 'E', status: 'done' });
  assert.deepEqual(stuckTasks(flow, [blocked, waits, waits2, done])?.map((t) => t.id), ['T-001']);
  assert.equal(stuckTasks(flow, [blocked, mkTask('T-005', { stage: 'E', status: 'ready' })]), null, '还有能做的任务');
  assert.equal(stuckTasks(flow, [blocked, mkTask('T-006', { stage: 'E', status: 'in_progress' })]), null);
  assert.equal(stuckTasks({ ...flow, stage_status: 'awaiting_human' }, [blocked]), null);
});

test('停滞看守：实施中长时间没有事件也没有运行中的任务 → 提醒一次；卡住单独报告；时间预算用完暂停派发', async () => {
  let clock = T0;
  const now = () => new Date(clock);
  const yaml = PROJECT_YAML.replace(/(max_attempts: \d+)/, '$1\n  stall_minutes: 20');
  const p = await setupProject({ yaml, now, stages: ['S3'], tasks: [mkTask('T-001', { status: 'pending' })] });
  try {
    const { engine } = makeEngine(p, async () => {}, undefined, undefined, { now });
    let changes = 0;
    engine.onChange(() => { changes++; });
    clock += 19 * MIN;
    assert.deepEqual(engine.checkWatch(), []);
    clock += 2 * MIN;
    const found = engine.checkWatch();
    assert.equal(found.length, 1);
    assert.match(found[0]!, /:stall:/);
    assert.equal(changes, 1);
    assert.deepEqual(engine.checkWatch(), [], '同一次停滞只提醒一次');
    assert.ok(actionsNeeded(p.store, p.config, now()).some((a) => /流程停滞：21 分钟没有任何进展/.test(a.text)));

    // 卡住：唯一的任务被阻塞 → 报"流程卡住"，不再报停滞
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'blocked', trigger: 'block', actor: 'dispatcher', facts: { reason: '要用户决定' } });
    clock += 30 * MIN;
    assert.match(engine.checkWatch().join(), /:stuck:T-001@/);
    const acts = actionsNeeded(p.store, p.config, now()).map((a) => a.text);
    assert.ok(acts.some((t) => /流程卡住：本阶段剩下的任务都被 T-001 挡住/.test(t)));
    assert.ok(!acts.some((t) => /流程停滞/.test(t)));

    // 时间预算：从创建起 51 分钟，设 50 分钟 → 超出，暂停派发
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'unblock', actor: 'human' });
    await p.store.setFlowBudget(p.flowId, { minutes: 50 });
    const b = budgetState(p.store, p.config, p.store.readFlow(p.flowId), now())!;
    assert.equal(Math.round(b.minutes!.used), 51);
    assert.ok(b.exceeded);
    assert.deepEqual(await engine.next(p.flowId), []);
    assert.match(engine.checkWatch().join(), /:budget/);
    assert.ok(actionsNeeded(p.store, p.config, now()).some((a) => /时间 51 \/ 50 分钟（不含等你的时间）[\s\S]*已超出/.test(a.text)));
  } finally { p.cleanup(); }
});
