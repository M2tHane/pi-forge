// M4：真实预检（第 8.2 节）。同步、合入验收测试、带资源运行命令；假 agent 不参与这些程序步骤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MergeQueue } from '../../src/core/merge-queue.ts';
import { hashToken } from '../../src/core/state-machine.ts';
import { createTaskWorktree, snapshot, worktreesRoot } from '../../src/core/worktree.ts';
import { setupProject, type Project } from '../helpers/project.ts';
import { commitToBranch, makeEngine } from '../helpers/engine.ts';
import { accBranch } from '../../src/core/acctest.ts';
import { PROJECT_YAML } from '../helpers/project.ts';
import { mkTask, soft } from '../helpers/tasks.ts';

async function submitted(p: Project, content: string, id = 'T-001') {
  const wt = createTaskWorktree(p.dir, p.flowId, id, p.store.readFlow(p.flowId).integration_branch);
  await p.store.transitionTask(p.flowId, id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  await p.store.transitionTask(p.flowId, id, { to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher', patch: {
    worktree: wt.path, branch: wt.branch, base_sha: wt.base_sha,
    lease: { run_id: `r-${id}`, role: 'worker', token_hash: hashToken('token'), acquired_at: new Date().toISOString(), expires_at: '2099-01-01' },
  } });
  const file = `src/server/${id.toLowerCase()}/a.ts`;
  mkdirSync(path.join(wt.path, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(wt.path, file), content);
  snapshot(wt.path, '任务提交');
  await p.store.appendHandoff(p.flowId, id, '完成', `run:r-${id}`);
  await p.store.transitionTask(p.flowId, id, { to: 'awaiting_inputs', trigger: 'submit', actor: `run:r-${id}`, facts: { token: 'token', diff_files: [file] } });
  return wt;
}
const engineOf = (p: Project) => makeEngine(p, async () => { throw new Error('预检不派发子进程'); }).engine;

test('预检：同步新输入，带资源跑命令并存 evidence，通过后进入 queued_merge；合并时再跑全量', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const wt = await submitted(p, 'ok');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const upstream = commitToBranch(p.dir, integ, { 'docs/input.md': '新的输入' }, '更新输入');
    await engineOf(p).precheck(p.flowId);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'queued_merge');
    assert.equal(p.store.readTask(p.flowId, 'T-001').base_sha, upstream);
    assert.equal(readFileSync(path.join(wt.path, 'docs/input.md'), 'utf8'), '新的输入');
    assert.deepEqual(p.store.readEvents().filter((e) => e.task === 'T-001' && e.type === 'transition').map((e) => e.to), ['ready', 'in_progress', 'awaiting_inputs', 'checking', 'queued_merge']);
    assert.ok(p.store.readEvents().some((e) => e.reason === 'evidence' && e.actor === 'precheck'));
    const result = await new MergeQueue(p.dir, p.store, p.config).processNext(p.flowId);
    assert.equal(result?.kind, 'merged');
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.ok(p.store.readEvents().some((e) => e.reason === 'evidence'));
  } finally { p.cleanup(); }
});

test('预检：同步冲突回 in_progress 并保留 worktree 与冲突标记，不增加失败计数', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')], files: { 'src/server/t-001/a.ts': 'base\n' } });
  try {
    const wt = await submitted(p, 'task\n');
    commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, { 'src/server/t-001/a.ts': 'upstream\n' }, '并发更新');
    await engineOf(p).precheck(p.flowId);
    const task = p.store.readTask(p.flowId, 'T-001');
    assert.equal(task.status, 'in_progress');
    assert.equal(task.worktree, wt.path);
    assert.deepEqual(task.conflict_files, ['src/server/t-001/a.ts']);
    assert.equal(task.attempts + (task.precheck_failures ?? 0) + (task.merge_failures ?? 0), 0);
    assert.match(readFileSync(path.join(wt.path, 'src/server/t-001/a.ts'), 'utf8'), /<<<<<<<[\s\S]*>>>>>>>/);
    assert.deepEqual(p.store.readMergeQueue().queue, []);
  } finally { p.cleanup(); }
});

test('预检失败：test 不通过时回 in_progress，只计 precheck_failures，失败摘要写进 handoff，不进合并队列', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    await submitted(p, 'FAIL');
    await engineOf(p).precheck(p.flowId);
    const task = p.store.readTask(p.flowId, 'T-001');
    assert.equal(task.status, 'in_progress');
    assert.equal(task.precheck_failures, 1);
    assert.equal(task.attempts, 0);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /预检未通过：test 退出码 1/);
    assert.deepEqual(p.store.readMergeQueue().queue, []);
  } finally { p.cleanup(); }
});

test('预检合入最新验收测试并运行 acceptance -- <task>；返工再提交时这些文件不算 worker 的改动', async () => {
  // 收到 "-- T-001"，且验收测试已合入工作区时通过
  const yaml = PROJECT_YAML.replace('acceptance: "true"', 'acceptance: "sh tests/run-acc.sh"');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001')], files: { 'tests/run-acc.sh': '[ "$2" = T-001 ] && test -f tests/acceptance/T-001/a.test.sh\n' } });
  try {
    p.git('branch', accBranch(p.flowId, 'T-001'), p.store.readFlow(p.flowId).integration_branch);
    commitToBranch(p.dir, accBranch(p.flowId, 'T-001'), { 'tests/acceptance/T-001/a.test.sh': 'ok\n' }, '验收测试');
    const wt = await submitted(p, 'ok');
    await engineOf(p).precheck(p.flowId);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'queued_merge');
    assert.equal(readFileSync(path.join(wt.path, 'tests/acceptance/T-001/a.test.sh'), 'utf8'), 'ok\n');
    const { withoutMergedAcceptance } = await import('../../src/core/precheck.ts');
    assert.deepEqual(withoutMergedAcceptance(p.dir, p.flowId, p.store.readTask(p.flowId, 'T-001'), ['src/server/t-001/a.ts', 'tests/acceptance/T-001/a.test.sh']), ['src/server/t-001/a.ts']);
    writeFileSync(path.join(wt.path, 'tests/acceptance/T-001/a.test.sh'), '改了\n');
    snapshot(wt.path, '改测试');
    assert.deepEqual(withoutMergedAcceptance(p.dir, p.flowId, p.store.readTask(p.flowId, 'T-001'), ['tests/acceptance/T-001/a.test.sh']), ['tests/acceptance/T-001/a.test.sh'], '改过的测试仍算越界');
  } finally { p.cleanup(); }
});

test('两个并行预检拿到不同的端口段、数据库名和临时目录', async () => {
  const yaml = PROJECT_YAML.replace(/  test: .*\n/, '  test: "echo $PORT $FORGE_DB_NAME $FORGE_TMP >> ../ports.log && sleep 0.3"\n');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001'), mkTask('T-002')] });
  try {
    await submitted(p, 'ok', 'T-001');
    await submitted(p, 'ok', 'T-002');
    const e = engineOf(p);
    await e.pump(p.flowId);
    await e.idle();
    const lines = readFileSync(path.join(worktreesRoot(p.dir), 'ports.log'), 'utf8').trim().split('\n').map((l) => l.split(' '))
      .filter((l) => l[1]!.startsWith('forge_pc_')); // 两个任务合入后阶段门禁也会跑 test
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.notEqual(lines[0]![0], lines[1]![0]);
    assert.notEqual(lines[0]![1], lines[1]![1]);
    assert.notEqual(lines[0]![2], lines[1]![2]);
    assert.deepEqual(['T-001', 'T-002'].map((id) => p.store.readTask(p.flowId, id).status).every((s) => s === 'queued_merge' || s === 'merging' || s === 'done'), true);
  } finally { p.cleanup(); }
});

test('预检：最新验收测试与软依赖未完成时保持 awaiting_inputs', async () => {
  for (const wait of ['acctest', 'soft']) {
    const p = await setupProject({ tasks: [mkTask('T-001', { deps: wait === 'soft' ? [soft('T-002')] : [] }),
      wait === 'soft' ? mkTask('T-002') : mkTask('T-001.at-2', { kind: 'acctest', role: 'test-author', scopes: ['acctest'], for_task: 'T-001', writes: [] })] });
    try {
      await submitted(p, 'ok');
      await engineOf(p).precheck(p.flowId);
      assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'awaiting_inputs');
      assert.deepEqual(p.store.readMergeQueue().queue, []);
    } finally { p.cleanup(); }
  }
});
