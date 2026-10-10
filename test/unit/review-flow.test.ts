// 第 10 节：逐任务审查接进引擎。fake-subagent 驱动真实的引擎、guard、工具与状态存储（不使用真实模型）。
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, ALL_FAKE, type RoleScript } from '../helpers/engine.ts';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { P0_SPEC } from '../helpers/spec.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { readReviewEvidence, REVIEW_CONFIRM, REVIEW_INPUT, REVIEW_REPORT, SUGGESTIONS_PATH, type ReviewInputFile } from '../../src/core/review-flow.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';

// 全量测试命令改为恒通过：本组用例关心的是审查而不是预检
const YAML = PROJECT_YAML.replace(/test: +"test -f[^\n]*/, 'test:      "true"');
const FILES = Object.fromEntries(Object.entries(P0_SPEC).map(([k, v]) => [`docs/spec/${k}.md`, v]));
const derived = (id: string, over: Parameters<typeof mkTask>[1] = {}) => { const { review: _review, ...t } = mkTask(id, over); return t; };
const SETTINGS: RoleSettingsFile = { version: 1, roles: { ...ALL_FAKE.roles, reviewer: { model: 'fake/model', thinking: 'low', escalate_model: 'fake/strong' } } };

async function implement(a: FakeAgent, id: string, content: string) {
  await a.call('forge_claim');
  assert.ok((await a.call('write', { path: `src/server/${id}/a.ts`, content })).ok);
  await a.call('forge_note', { text: `完成 ${id}` });
  const r = await a.call('forge_submit', { summary: `实现 ${id}` });
  assert.ok(r.ok, r.text);
}

async function drive(p: Project, e: ReturnType<typeof makeEngine>, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    const before = e.launcher.launched.length;
    await e.engine.next(p.flowId);
    await e.engine.idle();
    if (e.launcher.launched.length === before && i > 1) break;
  }
}

const must1 = { level: 'must' as const, basis: 'ac:REQ-001.AC1', files: ['src/server/t-001/a.ts'], location: 'a', problem: '没有返回看板编号', expected: '返回编号' };
const badMust = { level: 'must' as const, basis: '我觉得命名不好', files: ['src/server/t-001/a.ts'], location: '', problem: '命名', expected: '改名' };
const sug = { level: 'suggest' as const, basis: '过长函数', file: 'src/server/t-001/a.ts', location: 'a', problem: '函数过长', expected: '拆分' };

interface Seen { brief: string; cwd: string; tools: string[]; results: Record<string, { ok: boolean; text: string }> }

async function flow(roundTwo: 'resolved' | 'unresolved', maxRounds = 2) {
  const yaml = maxRounds === 2 ? YAML : YAML.replace('max_rounds: 2', `max_rounds: ${maxRounds}`);
  const p = await setupProject({ yaml, files: FILES, tasks: [mkTask('T-001', { review: 'auto', layers: ['backend'] })] });
  const seen: Record<string, Seen> = {};
  const handoffs: string[] = [];
  const script: RoleScript = async (role, nth, a) => {
    if (role === 'worker') {
      if (nth > 1) handoffs.push(p.store.readHandoff(p.flowId, 'T-001'));
      return implement(a, 't-001', `export const a = ${nth};\n`);
    }
    assert.equal(role, 'reviewer');
    const s: Seen = { brief: a.spec.prompt, cwd: a.spec.cwd, tools: a.spec.tools, results: {} };
    seen[a.env.task] = s;
    if (a.env.task === 'T-001.rv') {
      s.results['confirm'] = await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: true }] });
      s.results['noFiles'] = await a.call('forge_review_report', { verdict: 'changes', issues: [{ level: 'suggest', basis: 'x', location: '', problem: 'p', expected: 'e' }] });
      s.results['report'] = await a.call('forge_review_report', { verdict: 'changes', issues: [must1, badMust, sug] });
      return;
    }
    // 第二轮：不能提新问题；编号不全或多出编号会被拒绝
    s.results['report'] = await a.call('forge_review_report', { verdict: 'changes', issues: [must1] });
    s.results['missing'] = await a.call('forge_review_confirm', { items: [] });
    s.results['extra'] = await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: true }, { id: 'R-7', resolved: false }] });
    s.results['newIssues'] = await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: true }], issues: [must1] } as never);
    s.results['confirm'] = await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: roundTwo === 'resolved', note: roundTwo === 'resolved' ? '已修' : '仍然返回空' }] });
  };
  const e = makeEngine(p, script, SETTINGS);
  return { p, e, seen, handoffs };
}

test('审查 → 打回 → 确认通过：第二轮只能确认；出处不合格的 must 降级；suggest 记入集成分支；通过后合并', async () => {
  const { p, e, seen, handoffs } = await flow('resolved');
  try {
    await drive(p, e);
    assert.deepEqual(e.errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.blocked_reason ?? ''}${t.last_failure ?? ''}`);
    assert.equal(t.review_rounds, 1);
    const triggers = p.store.readEvents().filter((ev) => ev.task === 'T-001' && ev.type === 'transition').map((ev) => ev.trigger);
    assert.ok(triggers.indexOf('precheck_pass') < triggers.indexOf('review_changes') && triggers.indexOf('review_changes') < triggers.lastIndexOf('precheck_pass') && triggers.includes('review_pass'), triggers.join());

    // .rv：reviewer 角色、只读、指向原 task 的 worktree，带上原 task 的 layers 与 AC
    const rv1 = p.store.readTask(p.flowId, 'T-001.rv');
    assert.deepEqual([rv1.kind, rv1.role, rv1.for_task, rv1.writes, rv1.layers, rv1.ac, rv1.status], ['review', 'reviewer', 'T-001', [], ['backend'], ['REQ-001.AC1'], 'done']);
    assert.match(seen['T-001.rv']!.cwd, /\.worktrees\/B-001-T-001$/, '不为审查新建 worktree');
    assert.ok(seen['T-001.rv']!.tools.includes('forge_review_report') && !seen['T-001.rv']!.tools.includes('write'));

    // 第一轮的输入：AC 原文、术语表、diff（不含验收测试）、backend 规则（系统提示）
    const brief = seen['T-001.rv']!.brief;
    assert.match(brief, /REQ-001\.AC1：Given 已登录 When 创建看板 Then 返回看板编号/);
    assert.match(brief, /看板（Board）/);
    assert.match(brief, /diff --git a\/src\/server\/t-001\/a\.ts/);
    assert.ok(!brief.includes('diff --git a/tests/acceptance'));
    assert.match(readFileSync(e.launcher.launched.find((s) => s.env['PI_FORGE_TASK'] === 'T-001.rv')!.appendSystemPromptFiles[0]!, 'utf8'), /handler 内不写业务逻辑/, 'rules/backend.md 进系统提示');

    // 第一轮的工具结果：确认工具此时不可用；must 降级的说明
    assert.match(seen['T-001.rv']!.results['confirm']!.text, /第一轮审查/);
    assert.match(seen['T-001.rv']!.results['noFiles']!.text, /没有写 files/);
    assert.match(seen['T-001.rv']!.results['report']!.text, /需要修改（must 1 条：R-1）.*已降为 suggest：R-2/);
    const report = readReviewEvidence<{ issues: { id: string; level: string }[]; downgraded: { id: string }[] }>(p.store, p.flowId, 'T-001.rv', REVIEW_REPORT)!;
    assert.deepEqual(report.issues.map((i) => [i.id, i.level]), [['R-1', 'must'], ['R-2', 'suggest'], ['R-3', 'suggest']]);

    // 打回：must 清单进了 worker 的 handoff，worker 接着改
    assert.match(handoffs[0]!, /审查意见（第 1 轮）[\s\S]*R-1[\s\S]*没有返回看板编号/);
    assert.equal(e.launcher.launched.filter((s) => s.env['PI_FORGE_TASK'] === 'T-001' && s.env['PI_FORGE_ROLE'] === 'worker').length, 2);

    // 第二轮：.rv-2 只拿 must 清单与增量 diff
    const rv2 = seen['T-001.rv-2']!;
    assert.match(rv2.brief, /确认轮/);
    assert.match(rv2.brief, /R-1　出处：ac:REQ-001\.AC1/);
    assert.ok(!rv2.brief.includes('R-2'), `不带 suggest：${rv2.brief}`);
    assert.ok(!rv2.brief.includes('术语表'), `不带完整输入：${rv2.brief}`);
    assert.match(rv2.brief, /export const a = 2/, '增量 diff');
    assert.match(rv2.results['report']!.text, /确认轮/);
    assert.match(rv2.results['missing']!.text, /还没有回答这些编号：R-1/);
    assert.match(rv2.results['extra']!.text, /不在上一轮的清单里.*R-7/);
    assert.equal(rv2.results['newIssues']!.ok, false, '参数里没有新增问题的字段');
    assert.match(rv2.results['newIssues']!.text, /参数不合法/);
    assert.equal(rv2.results['confirm']!.ok, true);
    assert.deepEqual(readReviewEvidence<{ unresolved: string[] }>(p.store, p.flowId, 'T-001.rv-2', REVIEW_CONFIRM)!.unresolved, []);
    assert.equal(readReviewEvidence<ReviewInputFile>(p.store, p.flowId, 'T-001.rv-2', REVIEW_INPUT)!.prior_must[0]!.id, 'R-1');

    // suggest（含被降级的）追加到集成分支，带审查 task 与 R 编号，只追加一次
    const sugg = p.git('show', `${p.store.readFlow(p.flowId).integration_branch}:${SUGGESTIONS_PATH}`);
    assert.match(sugg, /\[T-001\.rv R-2\] T-001：命名/);
    assert.match(sugg, /\[T-001\.rv R-3\] T-001：函数过长/);
    assert.ok(!sugg.includes('R-1]'));
    assert.equal(sugg.match(/R-3\]/g)!.length, 1);
    assert.equal(p.git('show', `${p.store.readFlow(p.flowId).integration_branch}:src/server/t-001/a.ts`), 'export const a = 2;');
  } finally { p.cleanup(); }
});

test('确认轮仍有未解决的 must 且轮数用完 → 阻塞（review_exhausted），可以 /forge accept；review.max_rounds 生效', async () => {
  const { p, e, handoffs } = await flow('unresolved');
  try {
    await drive(p, e);
    assert.deepEqual(e.errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([t.status, t.blocked_by, t.review_rounds], ['blocked', 'review_exhausted', 2]);
    assert.match(t.blocked_reason ?? '', /次数达到上限 2.*R-1/);
    assert.equal(p.store.readTask(p.flowId, 'T-001.rv-2').status, 'done');
    assert.equal(e.launcher.launched.filter((s) => s.env['PI_FORGE_TASK'] === 'T-001.rv-3').length, 0);
    assert.equal(handoffs.length, 1);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /审查轮数已用完[\s\S]*仍然返回空/);
    // 用户放行：代码已通过预检，只是审查意见没谈拢
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'queued_merge', trigger: 'accept', actor: 'human' });
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'queued_merge');
  } finally { p.cleanup(); }
});

test('max_rounds=3：第二轮没解决还会再确认一轮（.rv-3），只回答没解决的编号', async () => {
  const { p, e, seen } = await flow('unresolved', 3);
  try {
    await drive(p, e);
    assert.deepEqual(e.errors, []);
    assert.ok(seen['T-001.rv-3'], '派了第三轮');
    assert.match(seen['T-001.rv-3']!.brief, /R-1　出处/);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([t.status, t.blocked_by, t.review_rounds], ['blocked', 'review_exhausted', 3]);
  } finally { p.cleanup(); }
});

test('没有 must（只有 suggest 或出处不合格的 must）按 pass 处理，直接合并', async () => {
  const p = await setupProject({ yaml: YAML, files: FILES, tasks: [mkTask('T-001', { review: 'auto' })] });
  const e = makeEngine(p, async (role, _nth, a) => {
    if (role === 'worker') return implement(a, 't-001', 'export const a = 1;\n');
    const r = await a.call('forge_review_report', { verdict: 'changes', issues: [badMust, sug] });
    assert.match(r.text, /降级后没有 must，按 pass 处理/);
  }, SETTINGS);
  try {
    await drive(p, e);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.equal(p.store.readTask(p.flowId, 'T-001').review_rounds, 0);
    assert.equal(e.launcher.launched.filter((s) => s.env['PI_FORGE_ROLE'] === 'reviewer').length, 1);
  } finally { p.cleanup(); }
});

test('推导：S 且没有追加契约不审查；risk=high 是 strong，审查者用升级模型；其余用普通模型', async () => {
  const p = await setupProject({
    yaml: YAML, files: FILES,
    tasks: [derived('T-001', { size: 'S' }), derived('T-002', { size: 'M', risk: 'high' }), derived('T-003', { size: 'M' })],
  });
  const e = makeEngine(p, async (role, _nth, a) => {
    if (role === 'worker') return implement(a, a.env.task.toLowerCase(), 'export const a = 1;\n');
    await a.call('forge_review_report', { verdict: 'pass', issues: [] });
  }, SETTINGS);
  try {
    await drive(p, e);
    assert.deepEqual(e.errors, []);
    for (const id of ['T-001', 'T-002', 'T-003']) assert.equal(p.store.readTask(p.flowId, id).status, 'done', id);
    const reviewers = e.launcher.launched.filter((s) => s.env['PI_FORGE_ROLE'] === 'reviewer');
    assert.deepEqual(reviewers.map((s) => [s.env['PI_FORGE_TASK'], s.model]).sort(), [['T-002.rv', 'fake/strong'], ['T-003.rv', 'fake/model']]);
    assert.equal(p.store.readTask(p.flowId, 'T-002.rv').review, 'strong');
    assert.equal(p.store.listTasks(p.flowId).some((t) => t.id === 'T-001.rv'), false);
    assert.ok(e.launcher.launched.filter((s) => s.env['PI_FORGE_ROLE'] === 'worker').every((s) => s.model === 'fake/model'));
  } finally { p.cleanup(); }
});

test('精简模式不做逐任务审查（strong 的也不做），由阶段审查负责（偏离 84）', async () => {
  const p = await setupProject({ yaml: YAML, files: FILES, stages: ['S1'], tasks: [derived('T-002', { stage: 'S1', size: 'M', risk: 'high' })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'lean');
  const e = makeEngine(p, async (role, _nth, a) => {
    if (role === 'worker') return implement(a, 't-002', 'export const a = 1;\n');
    await a.call('forge_review_report', { verdict: 'pass', issues: [] });
  }, SETTINGS);
  try {
    await drive(p, e);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
    assert.equal(p.store.listTasks(p.flowId).some((t) => t.id === 'T-002.rv'), false);
  } finally { p.cleanup(); }
});

test('审查者调用 forge_block：原 task 一并阻塞，等用户处理', async () => {
  const p = await setupProject({ yaml: YAML, files: FILES, tasks: [mkTask('T-001', { review: 'auto' })] });
  const e = makeEngine(p, async (role, _nth, a) => {
    if (role === 'worker') return implement(a, 't-001', 'export const a = 1;\n');
    await a.call('forge_block', { reason: 'REQ-001.AC1 无法用合理的代码满足' });
  }, SETTINGS);
  try {
    await drive(p, e);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.match(t.blocked_reason ?? '', /T-001\.rv 无法继续：REQ-001\.AC1 无法用合理的代码满足/);
  } finally { p.cleanup(); }
});
