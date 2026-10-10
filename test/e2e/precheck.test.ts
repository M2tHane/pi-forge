// M1 集成：真实 Git 同步与直通预检；假 agent 不参与这些程序步骤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { passthroughPrecheck } from '../../src/core/dispatcher.ts';
import { MergeQueue } from '../../src/core/merge-queue.ts';
import { hashToken } from '../../src/core/state-machine.ts';
import { createTaskWorktree, snapshot } from '../../src/core/worktree.ts';
import { setupProject, type Project } from '../helpers/project.ts';
import { commitToBranch } from '../helpers/engine.ts';
import { mkTask, soft } from '../helpers/tasks.ts';

async function submitted(p: Project, content: string) {
  const wt = createTaskWorktree(p.dir, p.flowId, 'T-001', p.store.readFlow(p.flowId).integration_branch);
  await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher', patch: {
    worktree: wt.path, branch: wt.branch, base_sha: wt.base_sha,
    lease: { run_id: 'r-1', role: 'worker', token_hash: hashToken('token'), acquired_at: new Date().toISOString(), expires_at: '2099-01-01' },
  } });
  mkdirSync(path.join(wt.path, 'src/server/t-001'), { recursive: true });
  writeFileSync(path.join(wt.path, 'src/server/t-001/a.ts'), content);
  snapshot(wt.path, '任务提交');
  await p.store.appendHandoff(p.flowId, 'T-001', '完成', 'run:r-1');
  await p.store.transitionTask(p.flowId, 'T-001', { to: 'awaiting_inputs', trigger: 'submit', actor: 'run:r-1', facts: { token: 'token', diff_files: ['src/server/t-001/a.ts'] } });
  return wt;
}

test('直通预检：无冲突时同步新输入后进入 queued_merge，全量验证在合并时运行', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const wt = await submitted(p, 'ok');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const upstream = commitToBranch(p.dir, integ, { 'docs/input.md': '新的输入' }, '更新输入');
    await passthroughPrecheck(p.store, p.flowId);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'queued_merge');
    assert.equal(p.store.readTask(p.flowId, 'T-001').base_sha, upstream);
    assert.equal(readFileSync(path.join(wt.path, 'docs/input.md'), 'utf8'), '新的输入');
    assert.deepEqual(p.store.readEvents().filter((e) => e.task === 'T-001' && e.type === 'transition').map((e) => e.to), ['ready', 'in_progress', 'awaiting_inputs', 'checking', 'queued_merge']);
    assert.equal(p.store.readEvents().filter((e) => e.reason === 'evidence').length, 0);
    const result = await new MergeQueue(p.dir, p.store, p.config).processNext(p.flowId);
    assert.equal(result?.kind, 'merged');
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.ok(p.store.readEvents().some((e) => e.reason === 'evidence'));
  } finally { p.cleanup(); }
});

test('直通预检：同步冲突回 in_progress 并保留 worktree 与冲突标记，不增加失败计数', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')], files: { 'src/server/t-001/a.ts': 'base\n' } });
  try {
    const wt = await submitted(p, 'task\n');
    commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, { 'src/server/t-001/a.ts': 'upstream\n' }, '并发更新');
    await passthroughPrecheck(p.store, p.flowId);
    const task = p.store.readTask(p.flowId, 'T-001');
    assert.equal(task.status, 'in_progress');
    assert.equal(task.worktree, wt.path);
    assert.deepEqual(task.conflict_files, ['src/server/t-001/a.ts']);
    assert.equal(task.attempts + (task.precheck_failures ?? 0) + (task.merge_failures ?? 0), 0);
    assert.match(readFileSync(path.join(wt.path, 'src/server/t-001/a.ts'), 'utf8'), /<<<<<<<[\s\S]*>>>>>>>/);
    assert.deepEqual(p.store.readMergeQueue().queue, []);
  } finally { p.cleanup(); }
});

test('直通预检：不会执行命令；合并时全量验证失败能阻止合入，并只计 merge_failures', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    await submitted(p, 'FAIL');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const before = p.git('rev-parse', integ);
    await passthroughPrecheck(p.store, p.flowId);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'queued_merge');
    await new MergeQueue(p.dir, p.store, p.config).processNext(p.flowId);
    const task = p.store.readTask(p.flowId, 'T-001');
    assert.equal(task.status, 'in_progress');
    assert.equal(task.merge_failures, 1);
    assert.equal(task.attempts, 0);
    assert.equal(p.git('rev-parse', integ), before);
    assert.ok(p.store.readEvents().some((e) => e.trigger === 'merge_verify_fail'));
  } finally { p.cleanup(); }
});

test('直通预检：最新验收测试与软依赖未完成时保持 awaiting_inputs', async () => {
  for (const wait of ['acctest', 'soft']) {
    const p = await setupProject({ tasks: [mkTask('T-001', { deps: wait === 'soft' ? [soft('T-002')] : [] }),
      wait === 'soft' ? mkTask('T-002') : mkTask('T-001.at-2', { kind: 'acctest', role: 'test-author', scopes: ['acctest'], for_task: 'T-001', writes: [] })] });
    try {
      await submitted(p, 'ok');
      await passthroughPrecheck(p.store, p.flowId);
      assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'awaiting_inputs');
      assert.deepEqual(p.store.readMergeQueue().queue, []);
    } finally { p.cleanup(); }
  }
});
