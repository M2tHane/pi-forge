import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStageFixTasks, groupIssuesByOwner, lastWorkerTask, ownerOf, testWritesOf } from '../../src/core/acceptance/stage-fix.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { taskRel } from '../../src/core/state/state-store.ts';
import type { Project } from '../helpers/project.ts';

function force(p: Project, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(p.flowId, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}

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

test('ownerOf：实际改过的文件（changed）也算归属；没有 architect 时找不到负责者的归兜底的 impl', () => {
  const changed = new Map([['T-002', ['src/server/main.ts']]]);
  assert.equal(ownerOf('src/server/main.ts', TASKS, changed)?.id, 'T-002');
  assert.equal(ownerOf('src/server/main.ts', TASKS), undefined);
  // 唯一归属：找不到负责者的文件也跟着这条问题交给它
  const one = groupIssuesByOwner([{ files: ['src/server/main.ts', 'src/c/y.ts'], text: '崩溃' }], TASKS, { changed, fallback: 'T-010' });
  assert.deepEqual([...one.groups.keys()], ['T-002']);
  assert.deepEqual([...one.groups.get('T-002')!.files], ['src/server/main.ts', 'src/c/y.ts']);
  const r = groupIssuesByOwner([{ files: ['src/c/y.ts'], text: '崩溃' }], TASKS, { changed, fallback: 'T-010' });
  assert.deepEqual([...r.groups.keys()], ['T-010']);
  assert.deepEqual(r.unowned, []);
  // 兜底必须是已 done 的 impl，否则仍算找不到
  assert.deepEqual(groupIssuesByOwner([{ files: ['src/c/y.ts'], text: 'x' }], TASKS, { fallback: 'T-001.fx-1' }).unowned, ['src/c/y.ts']);
});

// 批次流程：S0 的 architect、两个 domain、前端基础与两个页面
const BATCH = [
  { ...t('T-001', 'impl', 'done', []), role: 'architect' },
  t('T-002', 'impl', 'done', ['src/server/user/**']),
  t('T-003', 'impl', 'done', ['src/server/catalog/**']),
  t('T-004', 'impl', 'done', []),
  { ...t('T-005', 'impl', 'done', []), page: 'login' },
  { ...t('T-006', 'impl', 'done', []), page: 'purchase-orders' },
];

test('ownerOf：先看实际改过的，再看 writes（plan 的 paths），最后页面文件归页面任务', () => {
  const changed = new Map([['T-004', ['src/web/pages/login/index.tsx', 'src/server/user/shared.ts']]]);
  // 实际改过的优先于 paths 与页面
  assert.equal(ownerOf('src/web/pages/login/index.tsx', BATCH, changed)?.id, 'T-004');
  assert.equal(ownerOf('src/server/user/shared.ts', BATCH, changed)?.id, 'T-004');
  assert.equal(ownerOf('src/server/user/service.ts', BATCH, changed)?.id, 'T-002');
  // 页面 id 是路径的一段或文件名（大小写、- 与 _ 不计）
  assert.equal(ownerOf('src/web/pages/login/form.tsx', BATCH)?.id, 'T-005');
  assert.equal(ownerOf('src/web/PurchaseOrders.tsx', BATCH)?.id, 'T-006');
  assert.equal(ownerOf('src/web/purchase_orders/list.vue', BATCH)?.id, 'T-006');
  assert.equal(ownerOf('src/web/loginx.tsx', BATCH), undefined);
});

test('groupIssuesByOwner：一条问题只交给一个 task；唯一归属归它，涉及多个或找不到的整条交给 architect', () => {
  const { groups, unowned } = groupIssuesByOwner([
    { files: ['src/server/user/a.ts', 'src/server/user/b.ts', 'README.md'], text: '只涉及 user' },
    { files: ['src/web/pages/login/index.tsx'], text: '登录页' },
    { files: ['src/server/user/a.ts', 'src/server/catalog/c.ts'], text: '跨 domain' },
    { files: ['README.md'], text: '找不到归属' },
    { files: [], text: '没写文件' },
  ], BATCH, { architect: 'T-001', fallback: 'T-006' });
  assert.deepEqual([...groups.keys()].sort(), ['T-001', 'T-002', 'T-005']);
  assert.deepEqual([...groups.get('T-002')!.files], ['src/server/user/a.ts', 'src/server/user/b.ts', 'README.md']);
  assert.deepEqual(groups.get('T-002')!.texts, ['只涉及 user']);
  assert.deepEqual(groups.get('T-005')!.texts, ['登录页']);
  assert.deepEqual(groups.get('T-001')!.texts, ['跨 domain', '找不到归属', '没写文件']);
  assert.deepEqual([...groups.get('T-001')!.files], ['src/server/user/a.ts', 'src/server/catalog/c.ts', 'README.md']);
  assert.deepEqual(unowned, []);
});

test('createStageFixTasks：多个归属的问题建一个 architect 的修复任务，接着 architect 的会话', async () => {
  const p = await setupProject({ tasks: [
    mkTask('T-001', { role: 'architect', writes: [] }),
    mkTask('T-002', { role: 'backend', writes: ['src/server/user/**'] }), mkTask('T-003', { role: 'backend', writes: ['src/server/catalog/**'] }),
  ] });
  try {
    for (const id of ['T-001', 'T-002', 'T-003']) force(p, id, { status: 'done' });
    const r = await createStageFixTasks(p.store, p.flowId, 'qa', [
      { files: ['src/server/user/a.ts', 'src/server/catalog/b.ts'], text: '下单后库存没扣' },
      { files: ['src/server/user/a.ts'], text: '登录失败' },
    ], 'S1.qa 第 1 轮');
    assert.deepEqual(r.tasks.sort(), ['T-001.fx-1', 'T-002.fx-1']);
    const a = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.equal(a.role, 'architect');
    assert.equal(a.for_task, 'T-001');
    assert.equal(a.fork_from_task, 'T-001');
    assert.match(p.store.readHandoff(p.flowId, 'T-001.fx-1'), /交给你（架构师）修[\s\S]*下单后库存没扣/);
    assert.equal(p.store.readTask(p.flowId, 'T-002.fx-1').role, 'backend');
  } finally { p.cleanup(); }
});

test('lastWorkerTask：最近一个已 done 的 .fx-n，否则 impl 本身', () => {
  assert.equal(lastWorkerTask('T-001', TASKS), 'T-001.fx-1');
  assert.equal(lastWorkerTask('T-002', TASKS), 'T-002');
});

test('groupIssuesByOwner：没有 architect 时跨 task 的问题按文件拆开，找不到负责者的单列', () => {
  const { groups, unowned } = groupIssuesByOwner([
    { files: ['src/a/x.ts', 'src/b/y.ts'], text: '问题一' },
    { files: ['src/a/z.ts'], text: '问题二' },
    { files: ['docs/x.md'], text: '问题三' },
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
    const r = await createStageFixTasks(p.store, p.flowId, 'qa', [
      { files: ['src/a/x.ts'], text: '问题 A', owner: 'T-001' }, { files: ['src/b/y.ts'], text: '问题 B', owner: 'T-002' },
    ], 'S1.qa 第 1 轮', 'engine', { task: 'S1.qa', round: 1 });
    assert.deepEqual(r.tasks, ['T-001.fx-1', 'T-002.fx-1']);
    const a = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual(a.writes, ['src/a/x.ts', 'tests/unit/a/**', 'tests/acceptance/T-001/**']);
    assert.deepEqual(a.source_round, { task: 'S1.qa', round: 1 });
    assert.deepEqual(p.store.readTask(p.flowId, 'T-002.fx-1').writes, ['src/b/y.ts']);
  } finally { p.cleanup(); }
});
