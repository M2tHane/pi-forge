// M4：真实预检。同步输入、契约检查；假 agent 不参与这些程序步骤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MergeQueue } from '../../src/core/engine/merge-queue.ts';
import { hashToken } from '../../src/core/state/state-machine.ts';
import { createTaskWorktree, snapshot, worktreesRoot } from '../../src/core/workspace/worktree.ts';
import { setupProject, type Project } from '../helpers/project.ts';
import { commitToBranch, makeEngine } from '../helpers/engine.ts';
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
// 预检不再运行命令，impl / fix 一律进入审查；默认审查者（test/helpers/engine.ts）直接通过
const engineOf = (p: Project) => makeEngine(p, async (role) => { if (role !== 'reviewer') throw new Error('预检不派发子进程'); }).engine;
const hasPrecheckEvidence = (p: Project, id = 'T-001') => p.store.readEvents().some((e) => e.task === id && e.reason === 'evidence' && e.actor === 'precheck');

test('预检：同步新输入，不跑命令，进入审查；审查通过后合并（合并只检查冲突标记）', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const wt = await submitted(p, 'ok');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const upstream = commitToBranch(p.dir, integ, { 'docs/input.md': '新的输入' }, '更新输入');
    const e = engineOf(p);
    await e.precheck(p.flowId);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'in_review', 'impl 默认审查');
    assert.equal(p.store.readTask(p.flowId, 'T-001').base_sha, upstream);
    assert.equal(readFileSync(path.join(wt.path, 'docs/input.md'), 'utf8'), '新的输入');
    assert.equal(hasPrecheckEvidence(p), false, '预检没有运行任何命令');
    assert.deepEqual(p.store.readEvents().filter((e) => e.task === 'T-001' && e.type === 'transition').map((e) => e.to), ['ready', 'in_progress', 'awaiting_inputs', 'checking', 'in_review']);
    for (let i = 0; i < 8 && p.store.readTask(p.flowId, 'T-001').status !== 'done'; i++) { await e.next(p.flowId); await e.idle(); }
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.ok(!p.store.readEvents().some((ev) => ev.task === 'T-001' && ev.reason === 'evidence' && /merge-a\d+-(test|typecheck|lint)\.log/.test(JSON.stringify(ev))), '合并没有跑 test、typecheck、lint');
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

test('预检不再运行 test：即使 test 命令会失败也进入审查，没有 precheck evidence，失败交给 reviewer 与阶段门禁', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    await submitted(p, 'FAIL');
    await engineOf(p).precheck(p.flowId);
    const task = p.store.readTask(p.flowId, 'T-001');
    assert.equal(task.status, 'in_review');
    assert.equal(task.precheck_failures ?? 0, 0);
    assert.equal(hasPrecheckEvidence(p), false);
  } finally { p.cleanup(); }
});

test('预检不分配资源、不运行 test：两个任务的预检都不会执行 test 命令', async () => {
  const yaml = PROJECT_YAML.replace(/  test: .*\n/, '  test: "echo $PORT $FORGE_DB_NAME $FORGE_TMP >> ../ports.log"\n');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001'), mkTask('T-002')] });
  try {
    await submitted(p, 'ok', 'T-001');
    await submitted(p, 'ok', 'T-002');
    const e = engineOf(p);
    await e.precheck(p.flowId);
    const log = path.join(worktreesRoot(p.dir), 'ports.log');
    assert.equal(existsSync(log), false, 'test 命令没有被预检运行');
    assert.deepEqual(['T-001', 'T-002'].map((id) => p.store.readTask(p.flowId, id).status), ['in_review', 'in_review']);
  } finally { p.cleanup(); }
});

test('预检：软依赖未完成时保持 awaiting_inputs', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { deps: [soft('T-002')] }), mkTask('T-002')] });
  try {
    await submitted(p, 'ok');
    await engineOf(p).precheck(p.flowId);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'awaiting_inputs');
    assert.deepEqual(p.store.readMergeQueue().queue, []);
  } finally { p.cleanup(); }
});
