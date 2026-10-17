// 提交：forge_submit 先把集成分支同步进任务分支，有冲突时不提交、交回原 agent；之后需要审查的进 in_review，不需要的直接排队合并。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject, type Project } from '../helpers/project.ts';
import { commitToBranch, makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';

const transitions = (p: Project, id: string) => p.store.readEvents().filter((e) => e.task === id && e.type === 'transition').map((e) => e.to);

test('提交时同步集成分支：别的任务已合入的改动进入任务分支，直接进入审查，审查通过后合并', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const upstream = commitToBranch(p.dir, integ, { 'docs/input.md': '新的输入' }, '别的任务合入');
    let wt = '';
    const { engine, errors } = makeEngine(p, async (role, _n, a) => {
      if (role !== 'worker') return;
      await a.call('forge_claim');
      wt = p.store.readTask(p.flowId, 'T-001').worktree!;
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok' });
      await a.call('forge_note', { text: '完成' });
      const r = await a.call('forge_submit', { summary: '完成' });
      assert.ok(r.ok, r.text);
      assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'in_review');
      assert.equal(readFileSync(path.join(wt, 'docs/input.md'), 'utf8'), '新的输入');
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    for (let i = 0; i < 6 && p.store.readTask(p.flowId, 'T-001').status !== 'done'; i++) { await engine.next(p.flowId); await engine.idle(); }
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.deepEqual(transitions(p, 'T-001'), ['ready', 'in_progress', 'in_review', 'queued_merge', 'merging', 'done']);
    p.git('merge-base', '--is-ancestor', upstream, integ);
  } finally { p.cleanup(); }
});

test('提交时同步有冲突：不提交，冲突标记留在文件里交回原 agent；解决后再提交进入审查，不计失败', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')], files: { 'src/server/t-001/a.ts': 'base\n' } });
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const { engine, errors } = makeEngine(p, async (role, _n, a) => {
      if (role !== 'worker') return;
      await a.call('forge_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'task\n' });
      commitToBranch(p.dir, integ, { 'src/server/t-001/a.ts': 'upstream\n' }, '并发更新');
      await a.call('forge_note', { text: '完成' });
      const bad = await a.call('forge_submit', { summary: '完成' });
      assert.ok(!bad.ok);
      assert.match(bad.text, /有冲突：src\/server\/t-001\/a\.ts/);
      const t = p.store.readTask(p.flowId, 'T-001');
      assert.equal(t.status, 'in_progress');
      assert.match(readFileSync(path.join(t.worktree!, 'src/server/t-001/a.ts'), 'utf8'), /<<<<<<<[\s\S]*>>>>>>>/);
      // 还有冲突标记时再提交仍被退回
      assert.ok(!(await a.call('forge_submit', { summary: '完成' })).ok);
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'task + upstream\n' });
      const r = await a.call('forge_submit', { summary: '解决冲突' });
      assert.ok(r.ok, r.text);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.attempts + (t.merge_failures ?? 0), 0);
    assert.ok(['in_review', 'queued_merge', 'merging', 'done'].includes(t.status), t.status);
  } finally { p.cleanup(); }
});

test('不需要审查的任务（"接入真实接口"，review: skip）提交后直接排队合并', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { review: 'skip' })] });
  try {
    const { engine, errors } = makeEngine(p, async (role, _n, a) => {
      if (role !== 'worker') return;
      await a.call('forge_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok' });
      await a.call('forge_note', { text: '完成' });
      assert.ok((await a.call('forge_submit', { summary: '完成' })).ok);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.equal(transitions(p, 'T-001')[2], 'queued_merge');
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'review'));
  } finally { p.cleanup(); }
});
