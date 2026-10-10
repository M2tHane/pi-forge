import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIssuesByOwner, lastWorkerTask, ownerOf } from '../../src/core/stage-fix.ts';

import type { TaskFile } from '../../src/core/schemas.ts';
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
