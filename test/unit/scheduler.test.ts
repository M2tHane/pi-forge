// 来源：pi-flow test/unit/scheduler.test.ts @ 31f3f15
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDispatchable } from '../../src/core/engine/scheduler.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

test('优先关键路径上的任务；同长度按 id', () => {
  const tasks = [
    mkTask('T-001', { status: 'ready' }),
    mkTask('T-002', { status: 'ready' }),
    mkTask('T-003', { deps: [hard('T-002')] }),
    mkTask('T-004', { deps: [hard('T-003')] }),
    mkTask('T-005', { status: 'ready' }),
  ];
  assert.deepEqual(selectDispatchable(tasks, 'S3', 2), ['T-002', 'T-001']);
});

test('不超过并发上限；运行中的任务占用名额', () => {
  const tasks = [mkTask('T-001', { status: 'in_progress' }), mkTask('T-002', { status: 'ready' }), mkTask('T-003', { status: 'ready' })];
  assert.deepEqual(selectDispatchable(tasks, 'S3', 2), ['T-002']);
  assert.deepEqual(selectDispatchable(tasks, 'S3', 1), []);
});

test('writes 重叠只是优先级：先挑不重叠的；名额还有剩时重叠的也派', () => {
  const tasks = [
    mkTask('T-001', { status: 'queued_merge', writes: ['src/server/a/**'] }),
    mkTask('T-002', { status: 'ready', writes: ['src/server/a/x.ts'] }),
    mkTask('T-003', { status: 'ready', writes: ['src/server/b/**'] }),
    mkTask('T-004', { status: 'ready', writes: ['src/server/b/c.ts'] }),
  ];
  // 名额充足：不重叠的 T-003 在前，重叠的 T-002、T-004 随后
  assert.deepEqual(selectDispatchable(tasks, 'S3', 5), ['T-003', 'T-002', 'T-004']);
  // 名额只剩 1（在途 1 个 in_progress + 上限 2）：只派不重叠的
  const busy = [mkTask('T-009', { status: 'in_progress', writes: ['src/other/**'] }), ...tasks];
  assert.deepEqual(selectDispatchable(busy, 'S3', 2), ['T-003']);
  // 名额 2：不重叠的一个 + 重叠的一个
  assert.deepEqual(selectDispatchable(tasks, 'S3', 2), ['T-003', 'T-002']);
});

test('只选当前阶段的 ready 任务', () => {
  assert.deepEqual(selectDispatchable([mkTask('T-001', { status: 'ready', stage: 'S4' })], 'S3', 2), []);
});

test('两个池分别限流：实施池满了审查仍可派发，辅助池满了实施仍可派发', () => {
  const tasks = [
    mkTask('T-001', { status: 'in_progress' }), mkTask('T-002', { status: 'in_progress' }),
    mkTask('T-003', { status: 'ready' }),
    mkTask('T-001.rv', { status: 'ready', kind: 'review', role: 'reviewer', scopes: ['review'], writes: [], for_task: 'T-001' }),
    mkTask('T-002.rv', { status: 'ready', kind: 'review', role: 'reviewer', scopes: ['review'], writes: [], for_task: 'T-002' }),
  ];
  // 实施池 2/2 满：只派审查；辅助池上限 1 只派一个
  assert.deepEqual(selectDispatchable(tasks, 'S3', 2, 1), ['T-001.rv']);
  assert.deepEqual(selectDispatchable(tasks, 'S3', 2, 4), ['T-001.rv', 'T-002.rv']);
  // 实施池有名额、辅助池为 0：只派实施
  assert.deepEqual(selectDispatchable(tasks, 'S3', 3, 0), ['T-003']);
  // 没给辅助池上限时沿用实施池上限，但仍分开计数
  assert.deepEqual(selectDispatchable(tasks, 'S3', 2), ['T-001.rv', 'T-002.rv']);
});
