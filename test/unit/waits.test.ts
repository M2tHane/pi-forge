// "一个 task 在等谁"：waitsOn / stalls / softDepsDone（纯函数）。
// 前三个用例由 scripts/ablation/faults/liveness.test.ts 的原型移入（对抗性评审 F4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskFile } from '../../src/core/schemas.ts';
import { softDepsDone, stalls, waitsOn } from '../../src/core/waits.ts';
import { hard, mkTask, soft } from '../helpers/tasks.ts';

const acctest = (id: string, forTask: string, over: Parameters<typeof mkTask>[1] = {}) => mkTask(id, { kind: 'acctest', role: 'test-author', for_task: forTask, ...over });

test('偏离 72 的现场：S0 的 impl 在 awaiting_inputs，.at 硬依赖它——不等它，不成环', () => {
  const tasks = [
    mkTask('T-001', { stage: 'S0', status: 'awaiting_inputs' }),
    acctest('T-001.at', 'T-001', { stage: 'S0', deps: [hard('T-001')], status: 'pending' }),
  ];
  assert.deepEqual(waitsOn(tasks[0]!, tasks), []);
  assert.deepEqual(waitsOn(tasks[1]!, tasks), ['T-001']);
  assert.deepEqual(stalls(tasks), []);
});

test('等到已阻塞的软依赖生产方，报停滞（规格第 8.1 节"卡住时必须能被看见"）', () => {
  const tasks = [mkTask('T-001', { status: 'blocked', blocked_by: 'agent', blocked_reason: '要问你' }), mkTask('T-002', { status: 'awaiting_inputs', deps: [soft('T-001')] })];
  const r = stalls(tasks);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.kind, 'blocked');
  assert.deepEqual(r[0]!.tasks, ['T-002']);
  assert.equal(r[0]!.target, 'T-001');
  assert.match(r[0]!.reason, /T-002 在等 T-001，但 T-001 已阻塞：要问你/);
});

test('正常的并行等待不报停滞', () => {
  const tasks = [
    mkTask('T-001', { status: 'in_progress' }),
    acctest('T-001.at', 'T-001', { status: 'in_progress' }),
    mkTask('T-002', { status: 'awaiting_inputs', deps: [soft('T-001')] }),
    mkTask('T-003', { status: 'pending', deps: [hard('T-002')] }),
  ];
  assert.deepEqual(stalls(tasks), []);
});

test('等到已取消的 task 报停滞', () => {
  const tasks = [mkTask('T-001', { status: 'cancelled' }), mkTask('T-002', { status: 'pending', deps: [hard('T-001')] })];
  const r = stalls(tasks);
  assert.deepEqual(r.map((s) => [s.kind, s.tasks, s.target]), [['cancelled', ['T-002'], 'T-001']]);
  assert.match(r[0]!.reason, /T-001 已取消/);
});

test('跨 3 个 task 的环：只报一次，成员排序稳定，原因写出谁等谁', () => {
  const tasks = [
    mkTask('T-001', { status: 'pending', deps: [hard('T-003')] }),
    mkTask('T-002', { status: 'pending', deps: [hard('T-001')] }),
    mkTask('T-003', { status: 'pending', deps: [hard('T-002')] }),
    mkTask('T-004', { status: 'pending', deps: [hard('T-001')] }),
  ];
  const r = stalls(tasks);
  assert.equal(r.length, 1, '环外的 T-004 只是被环挡住，不另报');
  assert.equal(r[0]!.kind, 'cycle');
  assert.deepEqual(r[0]!.tasks, ['T-001', 'T-002', 'T-003']);
  assert.match(r[0]!.reason, /互相等待/);
  assert.match(r[0]!.reason, /T-001 等 T-003/);
  assert.deepEqual(stalls([...tasks].reverse()), r, '输入顺序不影响结果');
});

test('已 done 的依赖不算在等，环里有 done 的 task 就不是环', () => {
  const tasks = [mkTask('T-001', { status: 'done' }), mkTask('T-002', { status: 'pending', deps: [hard('T-001')] })];
  assert.deepEqual(waitsOn(tasks[1]!, tasks), []);
  assert.deepEqual(stalls(tasks), []);
});

test('disputed 等它的争议 .at-n；争议轮 done 后不再等；别人提的 .at-n 不算', () => {
  const impl = mkTask('T-001', { status: 'disputed' });
  const at = (status: TaskFile['status'], from: string) => acctest('T-001.at-2', 'T-001', { status, acctest_round: { kind: 'dispute', from_task: from } as TaskFile['acctest_round'] });
  assert.deepEqual(waitsOn(impl, [impl, at('in_progress', 'T-001')]), ['T-001.at-2']);
  assert.deepEqual(waitsOn(impl, [impl, at('done', 'T-001')]), []);
  assert.deepEqual(waitsOn(impl, [impl, at('in_progress', 'T-009')]), [], '不是这个 task 提的争议');
  const decide = acctest('T-001.at-2', 'T-001', { status: 'pending', acctest_round: { kind: 'decide' } as TaskFile['acctest_round'] });
  assert.deepEqual(waitsOn(impl, [impl, decide]), ['T-001.at-2']);
});

test('disputed 的 .at-n 已阻塞：报停滞，建议解除的是 .at-n', () => {
  const impl = mkTask('T-001', { status: 'disputed' });
  const at = acctest('T-001.at-2', 'T-001', { status: 'blocked', blocked_reason: '测试写不出来', acctest_round: { kind: 'dispute', from_task: 'T-001' } as TaskFile['acctest_round'] });
  const r = stalls([impl, at]);
  assert.deepEqual(r.map((s) => [s.kind, s.tasks, s.target]), [['blocked', ['T-001'], 'T-001.at-2']]);
});

test('waits_for：等别的 task 的 .at-n 修好；done 后不再等', () => {
  const a = mkTask('T-001', { status: 'awaiting_inputs', waits_for: ['T-002.at-2', 'T-003.at-2'] });
  const tasks = [a, acctest('T-002.at-2', 'T-002', { status: 'in_progress' }), acctest('T-003.at-2', 'T-003', { status: 'done' })];
  assert.deepEqual(waitsOn(a, tasks), ['T-002.at-2']);
  tasks[1] = acctest('T-002.at-2', 'T-002', { status: 'blocked', blocked_reason: 'x' });
  assert.deepEqual(stalls(tasks).map((s) => [s.kind, s.target]), [['blocked', 'T-002.at-2']]);
});

test('awaiting_inputs 等最新一轮 .at-n（未 done 时），不重复列出', () => {
  const a = mkTask('T-001', { status: 'awaiting_inputs', waits_for: ['T-001.at-2'] });
  const tasks = [a, acctest('T-001.at', 'T-001', { status: 'done' }), acctest('T-001.at-2', 'T-001', { status: 'in_progress' })];
  assert.deepEqual(waitsOn(a, tasks), ['T-001.at-2']);
});

test('其余状态（in_progress、checking、in_review、queued_merge、merging）不等别人', () => {
  for (const status of ['in_progress', 'checking', 'in_review', 'queued_merge', 'merging'] as const) {
    const t = mkTask('T-002', { status, deps: [hard('T-001'), soft('T-001')] });
    assert.deepEqual(waitsOn(t, [mkTask('T-001', { status: 'in_progress' }), t]), [], status);
  }
});

test('softDepsDone：只看软依赖；硬依赖和缺失的生产方', () => {
  const t = mkTask('T-003', { deps: [hard('T-001'), soft('T-002')] });
  assert.equal(softDepsDone(t, [mkTask('T-001', { status: 'in_progress' }), mkTask('T-002', { status: 'done' })]), true);
  assert.equal(softDepsDone(t, [mkTask('T-002', { status: 'in_review' })]), false);
  assert.equal(softDepsDone(t, []), false, '生产方不存在 = 未 done');
  assert.equal(softDepsDone(mkTask('T-004', { deps: [hard('T-001')] }), []), true, '没有软依赖');
});
