import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDispatchable } from '../../src/core/engine/scheduler.ts';
import { flowLimits, poolOf } from '../../src/core/state/state-machine.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

const L = (max_parallel: number, more: { max_parallel_aux?: number; max_parallel_backend?: number } = {}) => ({ max_parallel, ...more });
const be = (id: string, over = {}) => mkTask(id, { role: 'backend', ...over });
const fe = (id: string, over = {}) => mkTask(id, { role: 'frontend', ...over });
const rv = (id: string, over = {}) => mkTask(id, { kind: 'review', role: 'reviewer', scopes: ['review'], writes: [], ...over });

test('优先关键路径上的任务；同长度按 id', () => {
  const tasks = [
    mkTask('T-001', { status: 'ready' }),
    mkTask('T-002', { status: 'ready' }),
    mkTask('T-003', { deps: [hard('T-002')] }),
    mkTask('T-004', { deps: [hard('T-003')] }),
    mkTask('T-005', { status: 'ready' }),
  ];
  assert.deepEqual(selectDispatchable(tasks, 'S3', L(2)), ['T-002', 'T-001']);
});

test('不超过并发上限；运行中的任务占用名额', () => {
  const tasks = [mkTask('T-001', { status: 'in_progress' }), mkTask('T-002', { status: 'ready' }), mkTask('T-003', { status: 'ready' })];
  assert.deepEqual(selectDispatchable(tasks, 'S3', L(2)), ['T-002']);
  assert.deepEqual(selectDispatchable(tasks, 'S3', L(1)), []);
});

test('不按 writes 排优先级：writes 重叠的照常按关键路径与 id 派发', () => {
  const tasks = [
    be('T-001', { status: 'ready', writes: ['src/server/a/**'] }),
    be('T-002', { status: 'ready', writes: ['src/server/a/x.ts'] }),
  ];
  assert.deepEqual(selectDispatchable(tasks, 'S3', L(1, { max_parallel_backend: 2 })), ['T-001', 'T-002']);
});

test('只选当前阶段的 ready 任务', () => {
  assert.deepEqual(selectDispatchable([mkTask('T-001', { status: 'ready', stage: 'S4' })], 'S3', L(2)), []);
});

test('三个池分别计数：backend 用 max_parallel_backend，frontend 固定 1 个，审查另计', () => {
  const tasks = [
    be('T-001', { status: 'ready' }), be('T-002', { status: 'ready' }), be('T-003', { status: 'ready' }),
    fe('T-004', { status: 'ready' }), fe('T-005', { status: 'ready' }),
    rv('T-009.rv', { status: 'ready', for_task: 'T-009' }),
  ];
  assert.deepEqual(selectDispatchable(tasks, 'S3', L(1, { max_parallel_backend: 2, max_parallel_aux: 1 })), ['T-001', 'T-002', 'T-004', 'T-009.rv']);
  // 前端已有一个在运行：前端不再派；后端满了也不影响前端与审查
  const busy = [...tasks.map((t) => (t.id === 'T-004' ? { ...t, status: 'in_progress' as const } : t)), be('T-008', { status: 'in_progress' }), be('T-007', { status: 'in_progress' })];
  assert.deepEqual(selectDispatchable(busy, 'S3', L(1, { max_parallel_backend: 2 })), ['T-009.rv']);
});

test('backend 不写上限时同 max_parallel；架构、轻流程的 worker 与 merge-fix（按角色）用对应的池', () => {
  const tasks = [be('T-001', { status: 'ready' }), be('T-002', { status: 'ready' }), mkTask('T-003', { status: 'ready', role: 'architect' })];
  assert.deepEqual(selectDispatchable(tasks, 'S3', L(1)), ['T-001', 'T-003']);
  assert.equal(poolOf({ kind: 'merge-fix', role: 'frontend' }), 'frontend');
  assert.equal(poolOf({ kind: 'qa', role: 'stage-qa' }), 'aux');
  assert.equal(poolOf({ kind: 'impl', role: 'worker' }), 'impl');
});

test('docs/plan.md 的 max_parallel_backend 覆盖 workflow.yaml', () => {
  const tasks = ['T-001', 'T-002', 'T-003'].map((id) => be(id, { status: 'ready' }));
  const limits = L(1, { max_parallel_backend: 1 });
  assert.deepEqual(selectDispatchable(tasks, 'S3', flowLimits(limits, {})), ['T-001']);
  assert.deepEqual(selectDispatchable(tasks, 'S3', flowLimits(limits, { max_parallel_backend: 3 })), ['T-001', 'T-002', 'T-003']);
});
