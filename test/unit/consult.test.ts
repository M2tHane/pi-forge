// 架构师咨询的调度（纯函数）：同一时间只有一个架构师在写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldConsults, latestConsultOf } from '../../src/core/engine/consult.ts';
import type { TaskStatus } from '../../src/core/state/schemas.ts';
import { mkTask } from '../helpers/tasks.ts';

const consult = (id: string, status: TaskStatus, forTask?: string) =>
  mkTask(id, { kind: 'consult', role: 'architect', status, ...(forTask ? { for_task: forTask } : {}) });

test('heldConsults：就绪的咨询只放行编号最小的一个；有 architect 的任务在途时一个都不放', () => {
  assert.deepEqual([...heldConsults([consult('T-012', 'ready'), consult('T-010', 'ready'), mkTask('T-001', { status: 'in_progress' })])], ['T-012']);
  assert.deepEqual([...heldConsults([consult('T-010', 'ready'), consult('T-009', 'queued_merge')])], ['T-010'], '上一个咨询还在合并');
  assert.deepEqual([...heldConsults([consult('T-010', 'ready'), mkTask('T-002', { role: 'architect', status: 'in_review' })])], ['T-010'], 'S0 的架构任务在审查');
  assert.deepEqual([...heldConsults([consult('T-010', 'ready'), consult('T-009', 'blocked'), consult('T-008', 'done')])], [], '阻塞或完成的咨询不占名额');
});

test('latestConsultOf：取提问任务最近一次提问的咨询', () => {
  const tasks = [consult('T-009', 'done', 'T-001'), consult('T-011', 'pending', 'T-001'), consult('T-010', 'done', 'T-002'), consult('T-012', 'done')];
  assert.equal(latestConsultOf(tasks, 'T-001')?.id, 'T-011');
  assert.equal(latestConsultOf(tasks, 'T-003'), undefined);
});
