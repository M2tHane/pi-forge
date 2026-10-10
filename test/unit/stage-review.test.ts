// 第 7.6 节：精简模式的阶段审查（S1.rv、S1.rv-2）与跨阶段 fork 的决定。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, commitToBranch, type RoleScript } from '../helpers/engine.ts';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { P0_SPEC } from '../helpers/spec.ts';
import { REVIEW_CONFIRM, REVIEW_INPUT, REVIEW_REPORT, resolveReviews, readReviewEvidence } from '../../src/core/review-flow.ts';
import { createStageReview, nextStageReviewId, resolveStageReview, stageReviewRoundOf, stageReviewRounds, stageReviewsOf } from '../../src/core/stage-review.ts';
import { leanForkFrom } from '../../src/core/stage-fix.ts';
import { worktreesRoot } from '../../src/core/worktree.ts';
import { taskRel } from '../../src/core/state-store.ts';
import type { TaskFile } from '../../src/core/schemas.ts';

const FILES = Object.fromEntries(Object.entries(P0_SPEC).map(([k, v]) => [`docs/spec/${k}.md`, v]));
const must1 = { level: 'must' as const, basis: 'ac:REQ-001.AC1', files: ['src/server/t-001/a.ts'], location: 'a', problem: '没有返回看板编号', expected: '返回编号' };
const sug = { level: 'suggest' as const, basis: '过长函数', file: 'src/server/t-001/a.ts', location: 'a', problem: '函数过长', expected: '拆分' };

function force(p: Project, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(p.flowId, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}

async function project(yaml = PROJECT_YAML) {
  const p = await setupProject({ yaml, files: FILES, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', layers: ['backend'], deviations: ['用了内存存储'] }), mkTask('T-009', { stage: 'S1', writes: ['src/other/**'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'lean');
  force(p, 'T-001', { status: 'done', base_sha: p.git('rev-parse', 'HEAD') });
  force(p, 'T-009', { status: 'blocked', blocked_reason: '测试占位', blocked_by: 'user' });
  commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, {
    'src/server/t-001/a.ts': 'export const a = 1;\n', 'tests/acceptance/T-001/a.test.ts': 'test("验收")\n',
  }, '阶段实现');
  return p;
}
const headOf = (p: Project) => p.git('rev-parse', p.store.readFlow(p.flowId).integration_branch);

test('阶段审查编号与轮次：S1.rv、S1.rv-2；不含逐任务的 T-001.rv', () => {
  assert.deepEqual(['S1.rv', 'S1.rv-3', 'T-001.rv', 'S1.qa'].map(stageReviewRoundOf), [1, 3, 0, 0]);
  const r = (id: string, status = 'done', for_task?: string) => ({ id, kind: 'review' as const, status: status as 'done', ...(for_task ? { for_task } : {}) });
  const tasks = [r('S1.rv-2'), r('S1.rv'), r('T-001.rv', 'done', 'T-001'), r('S1.rv-3', 'cancelled'), r('S2.rv')];
  assert.deepEqual(stageReviewsOf(tasks, 'S1').map((t) => t.id), ['S1.rv', 'S1.rv-2']);
  assert.equal(stageReviewRounds(tasks, 'S1'), 2);
  assert.equal(nextStageReviewId(tasks, 'S1'), 'S1.rv-4');
  assert.equal(nextStageReviewId([], 'S1'), 'S1.rv');
});

test('leanForkFrom：lean 的 impl 接上一阶段 impl 的最后一次 worker 会话；其余情况为 null', () => {
  const t = (id: string, kind: string, status: string, stage: string, for_task?: string) => ({ id, kind, status, stage, ...(for_task ? { for_task } : {}) }) as Pick<TaskFile, 'id' | 'kind' | 'status' | 'stage' | 'for_task'>;
  const tasks = [t('T-001', 'impl', 'done', 'S1'), t('T-001.fx-1', 'fix', 'done', 'S1', 'T-001'), t('T-002', 'impl', 'ready', 'S2'), t('T-003', 'doc', 'done', 'P1')];
  const stages = ['P0', 'P1', 'S1', 'S2'];
  const next = { kind: 'impl' as const, stage: 'S2' };
  assert.equal(leanForkFrom('lean', next, stages, tasks), 'T-001.fx-1', '接最近一个 done 的 fx');
  assert.equal(leanForkFrom('lean', next, stages, [t('T-001', 'impl', 'done', 'S1')]), 'T-001');
  assert.equal(leanForkFrom('standard', next, stages, tasks), null);
  assert.equal(leanForkFrom(undefined, next, stages, tasks), null);
  assert.equal(leanForkFrom('lean', { ...next, fork_from_task: 'T-001' }, stages, tasks), null, '已有 fork_from_task 不覆盖');
  assert.equal(leanForkFrom('lean', { kind: 'fix', stage: 'S2' }, stages, tasks), null);
  assert.equal(leanForkFrom('lean', { kind: 'impl', stage: 'S1' }, stages, tasks), null, '上一阶段 P1 没有 impl');
  assert.equal(leanForkFrom('lean', { kind: 'impl', stage: 'P0' }, stages, tasks), null);
  assert.equal(leanForkFrom('lean', next, stages, [t('T-001', 'impl', 'in_progress', 'S1')]), null, '上一阶段 impl 未完成');
});

test('createStageReview：整个阶段的 diff（去掉验收测试）、AC、偏离；没有 for_task', async () => {
  const p = await project();
  try {
    const rv = await createStageReview(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    assert.deepEqual([rv.id, rv.kind, rv.role, rv.for_task, rv.writes, rv.stage], ['S1.rv', 'review', 'reviewer', undefined, [], 'S1']);
    const brief = p.store.readHandoff(p.flowId, 'S1.rv');
    assert.match(brief, /diff --git a\/src\/server\/t-001\/a\.ts/);
    assert.ok(!brief.includes('tests/acceptance/T-001/a.test.ts'), '不含验收测试');
    assert.match(brief, /REQ-001\.AC1：Given 已登录/);
    assert.match(brief, /T-001：用了内存存储/);
    assert.match(brief, /阶段整体审查（可以创建看板）/);
    assert.equal(readReviewEvidence<{ round: number; prior_must: unknown[] }>(p.store, p.flowId, 'S1.rv', REVIEW_INPUT)!.round, 1);
  } finally { p.cleanup(); }
});

interface Seen { cwd: string; results: Record<string, { ok: boolean; text: string }> }
async function runRv(p: Project, id: string, body: (a: Parameters<RoleScript>[2], s: Seen) => Promise<void>): Promise<Seen> {
  const seen: Seen = { cwd: '', results: {} };
  const e = makeEngine(p, async (role, _n, a) => {
    assert.equal(role, 'reviewer');
    seen.cwd = a.spec.cwd;
    await body(a, seen);
  });
  if (p.store.readTask(p.flowId, id).status === 'pending') await p.store.transitionTask(p.flowId, id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  await e.engine.dispatch(p.flowId, id);
  await e.engine.idle();
  assert.deepEqual(e.errors, []);
  return seen;
}

test('阶段审查全流程：临时 worktree → 打回生成 fix → 确认轮只确认 → 通过', async () => {
  const p = await project();
  try {
    assert.deepEqual(await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'none' });
    await createStageReview(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    assert.deepEqual(await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'running' });
    const s1 = await runRv(p, 'S1.rv', async (a, s) => {
      s.results['confirm'] = await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: true }] });
      s.results['report'] = await a.call('forge_review_report', { verdict: 'changes', issues: [must1, sug] });
    });
    assert.match(s1.cwd, /\.worktrees\/B-001-S1\.rv$/);
    assert.notEqual(path.resolve(s1.cwd), path.resolve(p.dir));
    assert.match(s1.results['confirm']!.text, /第一轮审查/);
    assert.match(s1.results['report']!.text, /需要修改（must 1 条：R-1）/);
    assert.ok(readReviewEvidence(p.store, p.flowId, 'S1.rv', REVIEW_REPORT));

    // 逐任务的 resolveReviews 不碰阶段级 .rv
    assert.deepEqual(await resolveReviews(p.dir, p.store, p.config, p.flowId), []);

    const r1 = await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1');
    assert.deepEqual([r1.kind, 'tasks' in r1 ? r1.tasks : null], ['fix', ['T-001.fx-1']]);
    assert.equal(existsSync(path.join(worktreesRoot(p.dir), `${p.flowId}-S1.rv`)), false, '结论处理后删除临时 worktree');
    assert.deepEqual(await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1'), r1, '幂等');
    assert.equal(p.store.readTask(p.flowId, 'T-001.fx-1').fork_from_task, 'T-001', 'fork 原 worker');
    assert.equal(p.store.listTasks(p.flowId).filter((t) => t.kind === 'fix').length, 1);

    force(p, 'T-001.fx-1', { status: 'done' });
    assert.deepEqual(await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'fix-done', tasks: ['T-001.fx-1'], round: 1 });
    const rv2 = await createStageReview(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    assert.equal(rv2.id, 'S1.rv-2');
    assert.match(p.store.readHandoff(p.flowId, 'S1.rv-2'), /确认轮[\s\S]*R-1　出处：ac:REQ-001\.AC1/);
    const s2 = await runRv(p, 'S1.rv-2', async (a, s) => {
      s.results['report'] = await a.call('forge_review_report', { verdict: 'pass', issues: [] });
      s.results['confirm'] = await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: true }] });
    });
    assert.match(s2.results['report']!.text, /确认轮/);
    assert.deepEqual(readReviewEvidence<{ unresolved: string[] }>(p.store, p.flowId, 'S1.rv-2', REVIEW_CONFIRM)!.unresolved, []);
    assert.deepEqual(await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'pass' });
  } finally { p.cleanup(); }
});

test('阶段审查：确认轮仍有 must 且轮数用尽 → exhausted；找不到负责 task 的问题 → exhausted', async () => {
  const p = await project();
  try {
    await createStageReview(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    await runRv(p, 'S1.rv', async (a) => { await a.call('forge_review_report', { verdict: 'changes', issues: [must1] }); });
    assert.equal((await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1')).kind, 'fix');
    force(p, 'T-001.fx-1', { status: 'done' });
    await createStageReview(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    await runRv(p, 'S1.rv-2', async (a) => { await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: false, note: '还是空' }] }); });
    const r = await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1');
    assert.equal(r.kind, 'exhausted');
    assert.match('reason' in r ? r.reason : '', /R-1/);
  } finally { p.cleanup(); }
});

test('阶段审查：must 涉及的文件没有负责 task → exhausted（无法生成 fix）', async () => {
  const p = await project();
  try {
    await createStageReview(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    await runRv(p, 'S1.rv', async (a) => { await a.call('forge_review_report', { verdict: 'changes', issues: [{ ...must1, files: ['docs/unowned.md'] }] }); });
    const r = await resolveStageReview(p.dir, p.store, p.config, p.flowId, 'S1');
    assert.equal(r.kind, 'exhausted');
    assert.match('reason' in r ? r.reason : '', /docs\/unowned\.md/);
    assert.equal(p.store.listTasks(p.flowId).filter((t) => t.kind === 'fix').length, 0);
  } finally { p.cleanup(); }
});
