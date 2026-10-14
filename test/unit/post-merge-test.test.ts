// 合并后回归测试：二分定位、基线、不稳定测试、已有回归修复时只记录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { commitToBranch } from '../helpers/engine.ts';
import { taskRel } from '../../src/core/state/state-store.ts';
import { POST_MERGE, checkIntegration, firstFailing, implOf, lastGreen, mergeCommits } from '../../src/core/engine/post-merge-test.ts';

test('firstFailing：已知基线通过、最后一个失败时，二分找第一个失败的下标，只测中间的', async () => {
  for (const [n, first] of [[1, 0], [2, 0], [2, 1], [5, 0], [5, 3], [5, 4], [8, 6]] as const) {
    const asked: number[] = [];
    const got = await firstFailing(n, async (i) => { asked.push(i); return i < first; });
    assert.equal(got, first, `n=${n} first=${first}`);
    assert.ok(asked.every((i) => i >= 0 && i < n - 1));
    assert.ok(asked.length <= Math.ceil(Math.log2(n)));
  }
});

test('implOf：修复归原 task，merge-fix 归被它解决冲突的 task', () => {
  const tasks = [
    mkTask('T-001'), mkTask('T-001.fx-1', { kind: 'fix', for_task: 'T-001' }),
    mkTask('T-002.mf', { kind: 'merge-fix', merge_fix_for: 'T-001.fx-1' }), mkTask('T-009', { kind: 'doc' }),
  ];
  assert.equal(implOf('T-001', tasks), 'T-001');
  assert.equal(implOf('T-001.fx-1', tasks), 'T-001');
  assert.equal(implOf('T-002.mf', tasks), 'T-001');
  assert.equal(implOf('T-009', tasks), null);
  assert.equal(implOf('T-404', tasks), null);
});

test('mergeCommits、lastGreen 只看本流程的事件', () => {
  const ev = [
    { flow: 'B-1', type: 'merge', task: 'T-001', data: { to: 'a' } },
    { flow: 'B-2', type: 'merge', task: 'T-009', data: { to: 'z' } },
    { flow: 'B-1', type: 'note', task: null, data: { kind: POST_MERGE, head: 'a', ok: true } },
    { flow: 'B-1', type: 'note', task: null, data: { kind: POST_MERGE, head: 'b', ok: false } },
    { flow: 'B-2', type: 'note', task: null, data: { kind: POST_MERGE, head: 'z', ok: true } },
  ] as const;
  assert.deepEqual([...mergeCommits(ev as never, 'B-1')], [['a', 'T-001']]);
  assert.equal(lastGreen(ev as never, 'B-1'), 'a');
  assert.equal(lastGreen(ev as never, 'B-3'), null);
});

function force(p: Project, rel: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', rel);
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}

/** 三个 task 依次合入集成分支；返回基线与三个合并提交 */
async function merged(): Promise<{ p: Project; base: string; shas: string[] }> {
  const p = await setupProject({ tasks: ['T-001', 'T-002', 'T-003'].map((id) => mkTask(id, { verify: [] })) });
  const integ = p.store.readFlow(p.flowId).integration_branch;
  const base = p.git('rev-parse', integ);
  const shas: string[] = [];
  let prev = base;
  for (const id of ['T-001', 'T-002', 'T-003']) {
    const sha = commitToBranch(p.dir, integ, { [`src/server/${id.toLowerCase()}/a.ts`]: id }, `[${p.flowId}/${id}]`);
    await p.store.recordEvent({ flow: p.flowId, task: id, actor: 'merge-queue', type: 'merge', evidence: sha, data: { integration_branch: integ, from: prev, to: sha } });
    force(p, taskRel(p.flowId, id), { status: 'done' });
    shas.push(sha);
    prev = sha;
  }
  return { p, base, shas };
}

test('变红：先确认基线，再在合并之间二分，给第一个变红的合并建修复任务（附失败输出）；同一提交不重复测', async () => {
  const { p, base, shas } = await merged();
  try {
    const bad = new Set([shas[1], shas[2]]);
    const asked: string[] = [];
    const suite = async (sha: string) => { asked.push(sha); return bad.has(sha) ? { ok: false, failed: { command: 'test', output: 'FAIL boards.test.js\nexpected 2 got 3' } } : { ok: true }; };
    const fix = await checkIntegration({ root: p.dir, store: p.store, config: p.config }, p.flowId, suite);
    assert.deepEqual(fix, ['T-002.fx-1']);
    // head、重跑 head、基线，再二分中间的两个合并
    assert.deepEqual(asked, [shas[2], shas[2], base, shas[0], shas[1]]);
    const t = p.store.readTask(p.flowId, 'T-002.fx-1');
    assert.deepEqual([t.kind, t.for_task, t.stage], ['fix', 'T-002', 'S3']);
    assert.ok(t.writes.includes('src/server/t-002/a.ts'));
    assert.match(p.store.readHandoff(p.flowId, 'T-002.fx-1'), /T-002 合入[\s\S]*之前的提交[\s\S]*expected 2 got 3/);
    const ev = p.store.readEvents().filter((e) => e.data?.['kind'] === POST_MERGE);
    assert.deepEqual(ev.map((e) => [e.data!['head'], e.data!['ok']]), [[base, true], [shas[2], false]]);
    assert.equal(ev.at(-1)!.data!['culprit'], 'T-002');
    // 同一提交不再测；修复没合入前，新的红只记录
    assert.deepEqual(await checkIntegration({ root: p.dir, store: p.store, config: p.config }, p.flowId, suite), []);
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const next = commitToBranch(p.dir, integ, { 'src/server/t-003/b.ts': 'x' }, 'more');
    bad.add(next);
    assert.deepEqual(await checkIntegration({ root: p.dir, store: p.store, config: p.config }, p.flowId, suite), []);
    assert.match(p.store.readEvents().at(-1)!.reason ?? '', /等回归修复 T-002\.fx-1 合入/);
  } finally { p.cleanup(); }
});

test('同一个 task 因回归修过 2 次仍被定位到：不再建修复，交给阶段检查', async () => {
  const { p, shas } = await merged();
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const green = new Set<string>();
    const suite = async (sha: string) => (green.has(sha) ? { ok: true } : { ok: false, failed: { command: 'test', output: 'x' } });
    // 基线（第一次合并之前）通过，三次合并后都是红的：每轮都定位到 T-001
    const base = p.git('rev-parse', `${shas[0]}~1`);
    green.add(base);
    const deps = { root: p.dir, store: p.store, config: p.config };
    for (let round = 1; round <= 3; round++) {
      const fix = await checkIntegration(deps, p.flowId, suite);
      if (round <= 2) {
        assert.deepEqual(fix, [`T-001.fx-${round}`]);
        force(p, taskRel(p.flowId, `T-001.fx-${round}`), { status: 'done' });
        commitToBranch(p.dir, integ, { [`src/server/t-001/fix${round}.ts`]: 'x' }, `fix ${round}`);
      } else {
        assert.deepEqual(fix, []);
        assert.match(p.store.readEvents().at(-1)!.reason ?? '', /已因回归修过 2 次/);
      }
    }
  } finally { p.cleanup(); }
});

test('重跑通过记为不稳定、不建修复；阶段不在进行中只记录', async () => {
  const { p, shas } = await merged();
  try {
    let n = 0;
    const flaky = async () => (n++ === 0 ? { ok: false, failed: { command: 'test', output: 'timeout' } } : { ok: true });
    assert.deepEqual(await checkIntegration({ root: p.dir, store: p.store, config: p.config }, p.flowId, flaky), []);
    const e = p.store.readEvents().at(-1)!;
    assert.deepEqual([e.data!['head'], e.data!['ok'], e.data!['flaky']], [shas[2], true, 'test']);

    const integ = p.store.readFlow(p.flowId).integration_branch;
    commitToBranch(p.dir, integ, { 'src/server/t-003/c.ts': 'x' }, 'more');
    force(p, `flows/${p.flowId}/flow.json`, { stage_status: 'awaiting_gate' });
    const red = async () => ({ ok: false, failed: { command: 'test', output: 'x' } });
    assert.deepEqual(await checkIntegration({ root: p.dir, store: p.store, config: p.config }, p.flowId, red), []);
    assert.match(p.store.readEvents().at(-1)!.reason ?? '', /阶段不在进行中/);
    assert.equal(p.store.listTasks(p.flowId).filter((t) => t.kind === 'fix').length, 0);
  } finally { p.cleanup(); }
});
