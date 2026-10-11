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

test('不与在途任务互斥，也不在同一批里选互斥的任务', () => {
  const tasks = [
    mkTask('T-001', { status: 'queued_merge', writes: ['src/server/a/**'] }),
    mkTask('T-002', { status: 'ready', writes: ['src/server/a/x.ts'] }),
    mkTask('T-003', { status: 'ready', writes: ['src/server/b/**'] }),
    mkTask('T-004', { status: 'ready', writes: ['src/server/b/c.ts'] }),
  ];
  assert.deepEqual(selectDispatchable(tasks, 'S3', 5), ['T-003']);
});

test('只选当前阶段的 ready 任务', () => {
  assert.deepEqual(selectDispatchable([mkTask('T-001', { status: 'ready', stage: 'S4' })], 'S3', 2), []);
});

test('同一 impl 谱系里的验收测试 task 不与实现 task 互斥（.fx 争议后等 .at-n，偏离 87）；别的谱系仍互斥', () => {
  const fx = mkTask('T-002.fx-1', { status: 'disputed', stage: 'S0', kind: 'fix', for_task: 'T-002', writes: ['src/**', 'tests/acceptance/_support/**'] });
  const at = mkTask('T-002.at-2', { status: 'ready', stage: 'S0', kind: 'acctest', for_task: 'T-002', writes: ['tests/acceptance/T-002/**', 'tests/acceptance/_support/T-002/**'] });
  assert.deepEqual(selectDispatchable([fx, at], 'S0', 4), ['T-002.at-2']);
  const other = mkTask('T-003.at', { status: 'ready', stage: 'S0', kind: 'acctest', for_task: 'T-003', writes: ['tests/acceptance/_support/T-002/**'] });
  assert.deepEqual(selectDispatchable([fx, other], 'S0', 4), []);
});
