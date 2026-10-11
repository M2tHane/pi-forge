import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStageFixTasks, groupIssuesByOwner, lastWorkerTask, ownerOf, testWritesOf } from '../../src/core/acceptance/stage-fix.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';

import type { TaskFile } from '../../src/core/state/schemas.ts';
type T = Pick<TaskFile, 'id' | 'kind' | 'status' | 'writes' | 'for_task'>;
const t = (id: string, kind: string, status: string, writes: string[], for_task?: string) => ({ id, kind, status, writes, ...(for_task ? { for_task } : {}) }) as T;
const TASKS = [
  t('T-001', 'impl', 'done', ['src/a/**', 'src/shared.ts']),
  t('T-002', 'impl', 'done', ['src/b/**']),
  t('T-010', 'impl', 'done', ['src/shared.ts']),
  t('T-003', 'impl', 'in_progress', ['src/c/**']),
  t('T-001.fx-1', 'fix', 'done', ['src/a/x.ts'], 'T-001'),
  t('T-001.fx-2', 'fix', 'cancelled', ['src/a/x.ts'], 'T-001'),
];

test('ownerOf：取 writes 覆盖、已 done 的 impl 中编号最大的；未 done 与 fix 不算', () => {
  assert.equal(ownerOf('src/shared.ts', TASKS)?.id, 'T-010');
  assert.equal(ownerOf('src/a/x.ts', TASKS)?.id, 'T-001');
  assert.equal(ownerOf('src/c/y.ts', TASKS), undefined);
});

test('lastWorkerTask：最近一个已 done 的 .fx-n，否则 impl 本身', () => {
  assert.equal(lastWorkerTask('T-001', TASKS), 'T-001.fx-1');
  assert.equal(lastWorkerTask('T-002', TASKS), 'T-002');
});

test('groupIssuesByOwner：按 task 分组，跨 task 的问题拆开，找不到负责者的单列', () => {
  const { groups, unowned } = groupIssuesByOwner([
    { files: ['src/a/x.ts', 'src/b/y.ts'], text: '问题一' },
    { files: ['src/a/z.ts', 'docs/x.md'], text: '问题二' },
  ], TASKS);
  assert.deepEqual([...groups.keys()].sort(), ['T-001', 'T-002']);
  assert.deepEqual([...groups.get('T-001')!.files], ['src/a/x.ts', 'src/a/z.ts']);
  assert.deepEqual(groups.get('T-001')!.texts, ['问题一', '问题二']);
  assert.deepEqual(groups.get('T-002')!.texts, ['问题一']);
  assert.deepEqual(unowned, ['docs/x.md']);
});

test('groupIssuesByOwner：指定 owner 的问题跳过 ownerOf，可写范围用 writes；owner 不是 impl 时归入 unowned', () => {
  const { groups, unowned } = groupIssuesByOwner([
    { files: [], text: '验收测试失败', owner: 'T-003', writes: ['src/c/**'] },
    { files: ['tests/x.ts'], text: '别的', owner: 'T-999' },
    { files: ['src/a/x.ts'], text: '普通' },
  ], [...TASKS, t('T-003', 'impl', 'done', ['src/c/**'])]);
  assert.deepEqual([...groups.keys()].sort(), ['T-001', 'T-003']);
  assert.deepEqual([...groups.get('T-003')!.files], ['src/c/**']);
  assert.deepEqual(unowned, ['tests/x.ts']);
});

test('testWritesOf：带上非验收测试的 glob；tests/acceptance/** 不带，只保留 impl 自己的验收目录（test_author: false）', () => {
  assert.deepEqual(testWritesOf({ id: 'T-001', writes: ['src/a/**', 'tests/unit/a/**', 'tests/e2e/**', 'tests/contract/**', 'tests/acceptance/T-001/x/**', 'tests/acceptance/**', 'docs/x.md'] }),
    ['tests/unit/a/**', 'tests/e2e/**', 'tests/contract/**']);
  assert.deepEqual(testWritesOf({ id: 'T-001', writes: ['src/a/**', 'tests/acceptance/T-001/**', 'tests/acceptance/T-002/**'] }), ['tests/acceptance/T-001/**']);
  assert.deepEqual(testWritesOf({ id: 'T-001', writes: ['src/a/**'] }), []);
});

test('createStageFixTasks：fix 的 writes = 问题文件 + 原 impl 的非验收测试 glob；原 task 没有测试 glob 时不加；记录 source_round', async () => {
  const p = await setupProject({ tasks: [
    mkTask('T-001', { writes: ['src/a/**', 'tests/unit/a/**', 'tests/acceptance/T-001/**'] }), mkTask('T-002', { writes: ['src/b/**'] }),
  ] });
  try {
    const r = await createStageFixTasks(p.store, p.flowId, 'review', [
      { files: ['src/a/x.ts'], text: '问题 A', owner: 'T-001' }, { files: ['src/b/y.ts'], text: '问题 B', owner: 'T-002' },
    ], 'S1.rv 第 1 轮', 'engine', { task: 'S1.rv', round: 1 });
    assert.deepEqual(r.tasks, ['T-001.fx-1', 'T-002.fx-1']);
    const a = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual(a.writes, ['src/a/x.ts', 'tests/unit/a/**', 'tests/acceptance/T-001/**']);
    assert.deepEqual(a.source_round, { task: 'S1.rv', round: 1 });
    assert.deepEqual(p.store.readTask(p.flowId, 'T-002.fx-1').writes, ['src/b/y.ts']);
  } finally { p.cleanup(); }
});
