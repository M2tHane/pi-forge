// stage-qa。编号与轮次（纯函数）、任务说明、临时 worktree、forge_qa_*、resolveQa 的各种结论、forge_service 的 cwd 规则。
// fake-subagent 驱动真实的引擎与工具（不使用真实模型）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, commitToBranch, type RoleScript } from '../helpers/engine.ts';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { mkTask } from '../helpers/tasks.ts';
import { PRD_FILES, PRD_MD } from '../helpers/prd.ts';
import { parsePrd } from '../../src/core/spec/prd.ts';
import { SUGGESTIONS_PATH, readReviewEvidence } from '../../src/core/stage/review-flow.ts';
import {
  QA_CONFIRM, QA_INPUT, QA_REPORT, buildQaBrief, createQaTask, exitReqsOf, nextQaId, qaRoundOf, qaRounds, qaTasksOf, resolveQa,
} from '../../src/core/stage/stage-qa.ts';
import { cleanupStageWorktrees, createStageTempWorktree, isStageLevelTask, removeStageTempWorktree, stageBaseOf } from '../../src/core/workspace/stage-worktree.ts';
import { serviceCwd } from '../../src/tools/subagent-tools.ts';
import { worktreesRoot } from '../../src/core/workspace/worktree.ts';
import { evidenceRel, taskRel } from '../../src/core/state/state-store.ts';

const YAML = PROJECT_YAML.replace('acceptance: "true"', 'acceptance: "true"\n  serve:     "true"');
const FILES = PRD_FILES;
const must1 = { level: 'must' as const, basis: 'ac:REQ-001.AC1', files: ['src/server/t-001/a.ts'], location: 'a', problem: '没有返回看板编号', expected: '返回编号' };
const namingSug = { level: 'suggest' as const, basis: '我觉得不好', files: ['src/server/t-001/a.ts'], location: '', problem: '命名', expected: '改名' };
const sug = { level: 'suggest' as const, basis: '过长函数', file: 'src/server/t-001/a.ts', location: 'a', problem: '函数过长', expected: '拆分' };

/** 测试专用：直接改任务文件（让已完成的 impl 不必走完整流水线） */
function force(p: Project, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(p.flowId, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}

async function project() {
  const p = await setupProject({ yaml: YAML, files: FILES, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', layers: ['backend'] }), mkTask('T-009', { stage: 'S1', writes: ['src/other/**'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  const base = p.git('rev-parse', 'HEAD');
  force(p, 'T-001', { status: 'done', base_sha: base });
  // 阶段里留一个未完成的任务：引擎不会自动推进阶段（真实流程由编排器让阶段停在 awaiting_gate）
  force(p, 'T-009', { status: 'blocked', blocked_reason: '测试占位', blocked_by: 'user' });
  commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, {
    'src/server/t-001/a.ts': 'export const a = 1;\n', 'docs/qa/S1.md': '# S1 覆盖率\n| REQ-001.AC1 | tests/acceptance/T-001/a.test.ts |\n',
  }, '阶段实现');
  return p;
}
const headOf = (p: Project) => p.git('rev-parse', p.store.readFlow(p.flowId).integration_branch);

test('编号与轮次：S1.qa、S1.qa-2…（取消的轮次也占编号）；qaRounds 不计取消的', () => {
  assert.deepEqual(['S1.qa', 'S1.qa-2', 'S1.qa-10', 'T-001.rv', 'S1.rv'].map(qaRoundOf), [1, 2, 10, 0, 0]);
  const q = (id: string, status = 'done') => ({ id, kind: 'qa' as const, status: status as 'done' });
  assert.equal(nextQaId([], 'S1'), 'S1.qa');
  assert.equal(nextQaId([q('S1.qa')], 'S1'), 'S1.qa-2');
  assert.equal(nextQaId([q('S1.qa'), q('S1.qa-2', 'cancelled')], 'S1'), 'S1.qa-3');
  assert.equal(nextQaId([q('S1.qa'), q('S2.qa')], 'S2'), 'S2.qa-2', '阶段互不影响');
  const tasks = [q('S1.qa-2'), q('S1.qa'), q('S1.qa-3', 'cancelled'), q('S2.qa')];
  assert.deepEqual(qaTasksOf(tasks, 'S1').map((t) => t.id), ['S1.qa', 'S1.qa-2']);
  assert.equal(qaRounds(tasks, 'S1'), 2);
});

test('isStageLevelTask：只有 qa；逐任务审查不是', () => {
  assert.equal(isStageLevelTask({ id: 'S1.qa', kind: 'qa' }), true);
  assert.equal(isStageLevelTask({ id: 'S1.qa-2', kind: 'qa' }), true);
  assert.equal(isStageLevelTask({ id: 'T-001.rv', kind: 'review', for_task: 'T-001' }), false);
  assert.equal(isStageLevelTask({ id: 'T-001', kind: 'impl' }), false);
});

test('exitReqsOf 与 buildQaBrief：第一轮给目标、AC 原文、矩阵、统计、服务；确认轮只给 must 清单', () => {
  const exit = exitReqsOf(parsePrd(PRD_MD), ['REQ-001', 'REQ-404']);
  assert.equal(exit[0]!.acs[0]!.id, 'REQ-001.AC1');
  assert.deepEqual(exit[1], { req: 'REQ-404', title: '（PRD 里找不到）', acs: [] });
  const base = { stage: 'S1', goal: '可以创建看板', qaId: 'S1.qa', round: 1, exit, matrix: '| REQ-001.AC1 | a.test.ts |', range: { from: 'a'.repeat(40), to: 'b'.repeat(40) }, stat: ' a.ts | 1 +', serves: ['serve'], priorMust: [] };
  const first = buildQaBrief(base);
  assert.match(first, /可以创建看板/);
  assert.match(first, /REQ-001\.AC1：Given 已登录 When 创建看板 Then 返回看板编号/);
  assert.match(first, /a\.test\.ts/);
  assert.match(first, /a\.ts \| 1 \+/);
  assert.match(first, /forge_service 启动/);
  assert.match(first, /forge_qa_report/);
  assert.match(first, /每条 must[^\n]*复现步骤[^\n]*控制台报错[^\n]*怀疑的归属/);
  assert.match(buildQaBrief({ ...base, serves: [], matrix: null }), /没有 serve 或 serve_\* 命令[\s\S]*还没有这个阶段的覆盖率矩阵|还没有这个阶段的覆盖率矩阵[\s\S]*没有 serve/);
  const confirm = buildQaBrief({ ...base, round: 2, qaId: 'S1.qa-2', priorMust: [{ id: 'R-1', level: 'must', basis: 'ac:REQ-001.AC1', files: ['a.ts'], location: 'a', problem: '问题甲', expected: '改' }] });
  assert.match(confirm, /forge_qa_confirm/);
  assert.match(confirm, /R-1　出处：ac:REQ-001\.AC1/);
  assert.ok(!confirm.includes('覆盖率矩阵') && !confirm.includes('exit 中的需求'), confirm);
});

test('临时 worktree：detached、在 worktreesRoot 下、不动集成分支；重复创建复用；删除后不留分支变动', () => {
  const r = tmpRepo();
  try {
    r.git('commit', '-q', '--allow-empty', '-m', 'c1');
    r.git('branch', 'integ');
    const head = r.git('rev-parse', 'integ');
    const wt = createStageTempWorktree(r.dir, 'B-001', 'S1.qa', 'integ');
    assert.equal(wt.branch, 'integ');
    assert.equal(wt.base_sha, head);
    assert.ok(wt.path.startsWith(worktreesRoot(r.dir)) && existsSync(path.join(wt.path, '.git')));
    assert.equal(path.resolve(wt.path) === path.resolve(r.dir), false);
    assert.equal(r.git('-C', wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
    assert.equal(createStageTempWorktree(r.dir, 'B-001', 'S1.qa', 'integ').path, wt.path);
    assert.equal(removeStageTempWorktree(r.dir, 'B-001', 'S1.qa'), true);
    assert.equal(existsSync(wt.path), false);
    assert.equal(removeStageTempWorktree(r.dir, 'B-001', 'S1.qa'), false);
    assert.equal(r.git('rev-parse', 'integ'), head);
    assert.ok(r.git('branch', '--list', 'integ').includes('integ'), '集成分支还在');
  } finally { r.cleanup(); }
});

test('stageBaseOf：阶段内 impl/fix/doc 中最早的 base_sha；没有时为 null', () => {
  const r = tmpRepo();
  try {
    r.git('commit', '-q', '--allow-empty', '-m', 'c1');
    const a = r.git('rev-parse', 'HEAD');
    r.git('commit', '-q', '--allow-empty', '-m', 'c2');
    const b = r.git('rev-parse', 'HEAD');
    const t = (stage: string, kind: string, base_sha: string | null) => ({ stage, kind, base_sha }) as never;
    assert.equal(stageBaseOf(r.dir, [t('S1', 'impl', b), t('S1', 'fix', a), t('S2', 'impl', a), t('S1', 'review', a)], 'S1'), a);
    assert.equal(stageBaseOf(r.dir, [t('S1', 'impl', b), t('S1', 'acctest', a)], 'S1'), b, 'acctest 不算');
    assert.equal(stageBaseOf(r.dir, [t('S1', 'impl', null)], 'S1'), null);
  } finally { r.cleanup(); }
});

test('forge_service 的 cwd：只能是任务自己的 worktree，没有时拒绝，绝不是项目根目录', () => {
  assert.equal(serviceCwd({ id: 'T-001', worktree: '/tmp/x.worktrees/B-001-T-001' }, '/tmp/x'), '/tmp/x.worktrees/B-001-T-001');
  assert.throws(() => serviceCwd({ id: 'S1.qa', worktree: null }, '/tmp/x'), /没有 worktree[\s\S]*不会在主工作区/);
  assert.throws(() => serviceCwd({ id: 'S1.qa', worktree: '/tmp/x/' }, '/tmp/x'), /主工作区/);
});

test('createQaTask：阶段 qa 任务、说明与输入记录；上一轮没有 must 时仍是出清单的一轮', async () => {
  const p = await project();
  try {
    const qa = await createQaTask(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    assert.deepEqual([qa.id, qa.kind, qa.role, qa.scopes, qa.writes, qa.verify, qa.stage], ['S1.qa', 'qa', 'stage-qa', ['qa'], [], [], 'S1']);
    const brief = p.store.readHandoff(p.flowId, 'S1.qa');
    assert.match(brief, /可以创建看板/);
    assert.match(brief, /REQ-001\.AC1：Given 已登录/);
    assert.match(brief, /S1 覆盖率/);
    assert.match(brief, /src\/server\/t-001\/a\.ts/, '阶段改动统计');
    assert.match(brief, /forge_service 启动/);
    const input = readReviewEvidence<{ round: number; prior_must: unknown[]; base: string; head: string }>(p.store, p.flowId, 'S1.qa', QA_INPUT)!;
    assert.deepEqual([input.round, input.prior_must, input.base === p.store.readTask(p.flowId, 'T-001').base_sha, input.head], [1, [], true, headOf(p)]);
  } finally { p.cleanup(); }
});

interface Seen { cwd: string; brief: string; tools: string[]; results: Record<string, { ok: boolean; text: string }> }

async function runQa(p: Project, id: string, round: (a: Parameters<RoleScript>[2], s: Seen) => Promise<void>): Promise<Seen> {
  const seen: Seen = { cwd: '', brief: '', tools: [], results: {} };
  const e = makeEngine(p, async (role, _n, a) => {
    assert.equal(role, 'stage-qa');
    Object.assign(seen, { cwd: a.spec.cwd, brief: a.spec.prompt, tools: a.spec.tools });
    await round(a, seen);
  });
  // engine.promote 只在阶段 active 时提升；stage-qa 在 awaiting_gate 时运行，由编排器直接提升（state_store 的 stage_active 事实允许 qa）
  if (p.store.readTask(p.flowId, id).status === 'pending') await p.store.transitionTask(p.flowId, id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  await e.engine.dispatch(p.flowId, id);
  await e.engine.idle();
  assert.deepEqual(e.errors, []);
  return seen;
}

test('stage-qa 全流程：临时 worktree、第一轮出清单、fix task、确认轮只确认、轮数用尽 / 通过', async () => {
  const p = await project();
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    await createQaTask(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    assert.deepEqual(await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'running' });

    // 第一轮
    const s1 = await runQa(p, 'S1.qa', async (a, s) => {
      assert.ok(existsSync(a.spec.cwd));
      s.results['confirm'] = await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: true }] });
      s.results['reviewTool'] = await a.call('forge_review_report', { verdict: 'pass', issues: [] });
      s.results['report'] = await a.call('forge_qa_report', { verdict: 'changes', issues: [must1, namingSug, sug] });
    });
    assert.match(s1.cwd, /\.worktrees\/B-001-S1\.qa$/);
    assert.notEqual(path.resolve(s1.cwd), path.resolve(p.dir));
    assert.ok(s1.tools.includes('forge_qa_report') && s1.tools.includes('forge_service') && !s1.tools.includes('write'));
    assert.match(s1.brief, /阶段验收：S1/);
    assert.match(s1.results['confirm']!.text, /第一轮阶段验收/);
    assert.equal(s1.results['reviewTool']!.ok, false, '审查工具不能提交 qa');
    assert.match(s1.results['report']!.text, /需要修改（must 1 条：R-1）/);
    assert.equal(p.store.readTask(p.flowId, 'S1.qa').status, 'done');
    const report = readReviewEvidence<{ issues: { id: string; level: string }[] }>(p.store, p.flowId, 'S1.qa', QA_REPORT)!;
    assert.deepEqual(report.issues.map((i) => [i.id, i.level]), [['R-1', 'must'], ['R-2', 'suggest'], ['R-3', 'suggest']]);
    const wtPath = path.join(worktreesRoot(p.dir), `${p.flowId}-S1.qa`);
    assert.ok(existsSync(wtPath), '结论还没处理，worktree 暂时保留');

    // 处理结论：生成按 task 分组的 fix，suggest 记入集成分支，临时 worktree 删除；重复调用幂等
    const r1 = await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1');
    assert.equal(r1.kind, 'fix');
    assert.deepEqual('tasks' in r1 ? r1.tasks : [], ['T-001.fx-1']);
    assert.equal(existsSync(wtPath), false);
    const fx = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual([fx.kind, fx.for_task, fx.writes], ['fix', 'T-001', ['src/server/t-001/a.ts']]);
    assert.match(p.store.readHandoff(p.flowId, 'T-001.fx-1'), /没有返回看板编号/);
    assert.deepEqual(await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1'), r1);
    assert.equal(p.store.listTasks(p.flowId).filter((t) => t.kind === 'fix').length, 1);
    const sugg = p.git('show', `${integ}:${SUGGESTIONS_PATH}`);
    assert.match(sugg, /\[S1\.qa R-2\] S1：命名/);
    assert.equal(sugg.match(/R-3\]/g)!.length, 1);

    // fix 做完 → fix-done；第二轮是确认轮，带上一轮 must，不能提新问题
    force(p, 'T-001.fx-1', { status: 'done' });
    assert.deepEqual(await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'fix-done', tasks: ['T-001.fx-1'], round: 1 });
    const qa2 = await createQaTask(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    assert.equal(qa2.id, 'S1.qa-2');
    assert.match(p.store.readHandoff(p.flowId, 'S1.qa-2'), /R-1　出处：ac:REQ-001\.AC1/);
    assert.equal(readReviewEvidence<{ prior_must: { id: string }[] }>(p.store, p.flowId, 'S1.qa-2', QA_INPUT)!.prior_must[0]!.id, 'R-1');
    const s2 = await runQa(p, 'S1.qa-2', async (a, s) => {
      s.results['report'] = await a.call('forge_qa_report', { verdict: 'pass', issues: [] });
      s.results['extra'] = await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: true }, { id: 'R-9', resolved: true }] });
      s.results['newIssues'] = await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: false }], issues: [must1] } as never);
      s.results['confirm'] = await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: false, note: '仍然返回空' }] });
    });
    assert.match(s2.results['report']!.text, /确认轮/);
    assert.match(s2.results['extra']!.text, /不在上一轮的清单里.*R-9/);
    assert.equal(s2.results['newIssues']!.ok, false);
    assert.equal(s2.results['confirm']!.ok, true);
    assert.deepEqual(readReviewEvidence<{ unresolved: string[] }>(p.store, p.flowId, 'S1.qa-2', QA_CONFIRM)!.unresolved, ['R-1']);

    // qa.max_rounds 默认 2：用尽，不再生成 fix
    const r2 = await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1');
    assert.equal(r2.kind, 'exhausted');
    assert.match('reason' in r2 ? r2.reason : '', /R-1/);
    assert.equal(p.store.listTasks(p.flowId).filter((t) => t.kind === 'fix').length, 1);
    assert.equal(existsSync(path.join(worktreesRoot(p.dir), `${p.flowId}-S1.qa-2`)), false);
    assert.ok(existsSync(path.join(p.dir, '.forge', evidenceRel(p.flowId, 'S1.qa-2'), QA_CONFIRM)));
  } finally { p.cleanup(); }
});

test('stage-qa：确认全部解决 → pass；没有 qa → none', async () => {
  const p = await project();
  try {
    assert.deepEqual(await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'none' });
    await createQaTask(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    await runQa(p, 'S1.qa', async (a) => { await a.call('forge_qa_report', { verdict: 'changes', issues: [must1] }); });
    assert.equal((await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1')).kind, 'fix');
    force(p, 'T-001.fx-1', { status: 'done' });
    await createQaTask(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    await runQa(p, 'S1.qa-2', async (a) => { await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: true }] }); });
    assert.deepEqual(await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'pass' });
  } finally { p.cleanup(); }
});

test('stage-qa：第一轮就通过 → pass；cleanupStageWorktrees 清理已结束任务的 worktree', async () => {
  const p = await project();
  try {
    await createQaTask(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    await runQa(p, 'S1.qa', async (a) => { await a.call('forge_qa_report', { verdict: 'pass', issues: [] }); });
    const wtPath = path.join(worktreesRoot(p.dir), `${p.flowId}-S1.qa`);
    assert.ok(existsSync(wtPath));
    assert.deepEqual(cleanupStageWorktrees(p.dir, p.store, p.flowId), ['S1.qa']);
    assert.equal(existsSync(wtPath), false);
    assert.deepEqual(await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1'), { kind: 'pass' });
  } finally { p.cleanup(); }
});

test('stage-qa：forge_block → blocked（带原因）', async () => {
  const p = await project();
  try {
    await createQaTask(p.dir, p.store, p.config, p.flowId, 'S1', headOf(p));
    await runQa(p, 'S1.qa', async (a) => { await a.call('forge_block', { reason: '服务起不来' }); });
    const r = await resolveQa(p.dir, p.store, p.config, p.flowId, 'S1');
    assert.equal(r.kind, 'blocked');
    assert.match('reason' in r ? r.reason : '', /服务起不来/);
  } finally { p.cleanup(); }
});
