// 小改动（change）模式：纯函数（交接说明、状态文案、日志标题）、"更新架构图与契约"任务的提交校验、startChange 与 fixStep 的推进（不跑 agent）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { evidenceRel, isFinished, taskRel } from '../../src/core/state/state-store.ts';
import { QA_REPORT } from '../../src/core/stage/stage-qa.ts';
import { hashToken, isDocsUpdateTask, planTransition, type Facts } from '../../src/core/state/state-machine.ts';
import { isLightFlow } from '../../src/core/state/schemas.ts';
import { CHANGE_PHASE_LABEL, FIX_PHASE_LABEL, buildFixQaBrief, fixHelpHint, fixPhase, fixStatusLine, fixStep, readFixLog, renderFixLog, acceptFix } from '../../src/modes/fix.ts';
import { DOCS_UPDATE_TITLE, buildChangeHandoff, buildDocsUpdateHandoff, renderChangeBrief, startChange } from '../../src/modes/change.ts';
import { runFlowChange, type CommandEnv } from '../../src/commands/forge.ts';
import { flowChange, statusText } from '../../src/tools/orchestrator-tools.ts';
import { renderStatus, statusLine } from '../../src/core/ops/status-view.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { ChangePlanInput } from '../../src/core/plan/change-plan.ts';

const YAML = PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true');
const PLAN: ChangePlanInput = {
  title: '看板支持导出 CSV', description: '在看板页加一个导出按钮，导出当前列表。',
  tasks: [
    { title: '导出接口', writes: ['src/export/**'], ac: ['GET /api/export 返回 CSV'] },
    { title: '页面按钮', writes: ['src/ui/**'], ac: ['点击按钮下载文件', '空列表导出表头'], depends_on: [{ task: 'T-001', type: 'hard' }] },
  ],
};

function force(p: Project, flow: string, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(flow, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}
function evidence(p: Project, flow: string, id: string, name: string, body: unknown) {
  const dir = path.join(p.dir, '.forge', evidenceRel(flow, id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), JSON.stringify(body));
}

async function changeProject(yaml = YAML) {
  const p = await setupProject({ yaml });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  const calls: string[] = [];
  const pumped: string[] = [];
  const config = parseConfig(yaml);
  const r = await startChange({ root: p.dir, store: p.store, config, pump: async (f) => { pumped.push(f); } }, PLAN, { yes: false });
  assert.equal(r.kind, 'started');
  const flow = (r as Extract<typeof r, { kind: 'started' }>).flow;
  const ctx = {
    root: p.dir, store: p.store, config, now: () => new Date('2026-03-04T05:06:07Z'),
    dispatch: async (_f: string, t: string) => { calls.push(t); },
    promote: async () => {},
  };
  return { p, flow, ctx, calls, pumped };
}

// —— 纯函数 ——

test('isLightFlow：只有 build 不是轻流程', () => {
  assert.deepEqual((['build', 'fix', 'change'] as const).map((mode) => isLightFlow({ mode })), [false, true, true]);
});

test('buildChangeHandoff：变更说明、本 task 的 AC、要求（先读架构与契约、写测试、共享代码只追加、超范围 forge_block）', () => {
  const t = buildChangeHandoff('在看板页加导出', { id: 'T-002', title: '页面按钮', ac: ['点击按钮下载文件'], writes: ['src/ui/**', 'tests/acceptance/T-002/**'] });
  for (const s of ['在看板页加导出', 'T-002 页面按钮', '- 点击按钮下载文件', '- src/ui/**', 'docs/arch/overview.md', 'rules/', 'docs/contracts/', 'tests/acceptance/T-002/', '只追加', 'forge_block']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('- tests/acceptance/T-002/**'), '自己的验收目录不算计划范围');
  assert.match(buildChangeHandoff('', { id: 'T-001', title: '标题', ac: [], writes: [] }), /标题/);
});

test('renderChangeBrief：标题、说明、任务清单与依赖', () => {
  const md = renderChangeBrief(PLAN, [
    { id: 'T-001', title: '导出接口', ac: ['GET /api/export 返回 CSV'], depends_on: [] },
    { id: 'T-002', title: '页面按钮', ac: ['点击按钮下载文件'], depends_on: [{ task: 'T-001', type: 'hard' }] },
  ]);
  for (const s of ['# 看板支持导出 CSV', '导出按钮', '### T-001 导出接口', '### T-002 页面按钮', '依赖：T-001（硬）', '- 点击按钮下载文件']) assert.ok(md.includes(s), s);
});

test('buildDocsUpdateHandoff：改动统计、范围、改到与代码一致（契约可修改）、不需要改时直接提交', () => {
  const t = buildDocsUpdateHandoff('加导出', { from: 'a'.repeat(40), to: 'b'.repeat(40) }, ' src/a.ts | 3 ++-');
  for (const s of ['加导出', 'aaaaaaaa..bbbbbbbb', 'src/a.ts | 3', 'docs/arch/overview.md', 'docs/contracts/', '可以修改', '直接 forge_submit']) assert.ok(t.includes(s), s);
  assert.match(buildDocsUpdateHandoff('x', { from: 'a', to: 'b' }, ''), /没有改动/);
});

test('fixPhase / fixStatusLine：change 模式的文案；fix 模式不变', () => {
  const flow = (s: string, mode?: string) => ({ stage: 'X1', stages: ['X1'], stage_status: s, ...(mode ? { mode } : {}) }) as never;
  const t = (id: string, kind: string, status: string) => ({ id, kind, status, stage: 'X1' }) as never;
  const impls = [t('T-001', 'impl', 'done'), t('T-002', 'impl', 'done')];
  assert.equal(fixPhase(flow('active', 'change'), [t('T-001', 'impl', 'in_progress'), t('T-002', 'impl', 'pending')]), 'fixing');
  assert.equal(fixPhase(flow('active', 'change'), [t('T-001', 'impl', 'queued_merge'), t('T-002', 'impl', 'pending')]), 'merging');
  assert.equal(fixPhase(flow('active', 'change'), impls), 'docs', '实现都完成、文档任务还没建');
  assert.equal(fixPhase(flow('active', 'change'), [...impls, t('T-003', 'doc', 'in_progress')]), 'docs');
  assert.equal(fixPhase(flow('active', 'change'), [...impls, t('T-003', 'doc', 'in_review')]), 'merging');
  assert.equal(fixPhase(flow('active', 'change'), [...impls, t('T-003', 'doc', 'done')]), 'confirming');
  assert.equal(fixPhase(flow('active', 'change'), [...impls, t('T-003', 'doc', 'done'), t('T-001.fx-1', 'fix', 'in_progress')]), 'fixing');
  assert.equal(fixPhase(flow('active', 'change'), [...impls, t('T-003', 'doc', 'blocked')]), 'needs_human');
  // fix 模式没有 docs 步骤
  assert.equal(fixPhase(flow('active', 'fix'), impls), 'confirming');
  assert.match(fixStatusLine(flow('active', 'change'), [t('T-001', 'impl', 'in_progress')] as never), /^变更步骤：实施中/);
  assert.match(fixStatusLine(flow('active', 'change'), [...impls, t('T-003', 'doc', 'in_progress')] as never), /变更步骤：更新架构图与契约/);
  assert.match(fixStatusLine(flow('active', 'change'), [...impls, t('T-003', 'doc', 'done'), t('X1.qa', 'qa', 'in_progress')] as never), /变更步骤：变更确认（第 1 轮）/);
  assert.match(fixStatusLine(flow('active', 'fix'), [t('T-001', 'impl', 'in_progress')] as never), /^修复步骤：修复中/);
  assert.match(fixStatusLine(flow('active'), [t('T-001', 'impl', 'in_progress')] as never), /^修复步骤：修复中/);
  assert.equal(CHANGE_PHASE_LABEL.confirming, '变更确认');
  assert.equal(FIX_PHASE_LABEL.confirming, '复现确认');
  assert.match(fixHelpHint('C-001', 'change'), /^小改动 C-001/);
  assert.match(fixHelpHint('X-001'), /^修复 X-001/);
});

test('renderFixLog：change 模式的标题与“变更内容”一节；fix 模式不变', () => {
  const base = {
    flow: { id: 'C-001', title: '看板导出' }, date: '2026-03-04', mainBranch: 'main', problem: '加导出按钮', commits: [{ sha: 'abcdef1234567890', subject: '[C-001/T-001] 导出接口' }],
    files: ['src/export/a.ts', 'tests/acceptance/T-001/a.test.ts'], qa: { rounds: 1, conclusion: 'confirmed' as const, must: 0 },
    rework: { merge_fail: 0, run_failed: 0, fix_tasks: 0 }, cost: ['合计：3 次运行'],
  };
  const md = renderFixLog({ ...base, mode: 'change' });
  for (const s of ['# 变更 C-001：看板导出', '## 变更内容', '加导出按钮', '已确认变更', '## 变更确认（stage-qa）']) assert.ok(md.includes(s), s);
  assert.ok(!md.includes('## 问题'));
  const fix = renderFixLog({ ...base, flow: { id: 'X-001', title: 't' } });
  for (const s of ['# 修复 X-001：t', '## 问题', '已确认修复']) assert.ok(fix.includes(s), s);
});

test('buildFixQaBrief：change 模式的“变更确认”', () => {
  const b = { qaId: 'X1.qa', round: 1, problem: '## 任务清单\n### T-001 导出', range: { from: 'a'.repeat(40), to: 'b'.repeat(40) }, stat: ' a.ts | 2 +-', serves: [], priorMust: [] };
  const t = buildFixQaBrief({ ...b, mode: 'change' });
  for (const s of ['# 变更确认：X1.qa', '### T-001 导出', '验收标准是否达成', '全量测试', 'docs/arch/overview.md', 'forge_qa_report']) assert.ok(t.includes(s), s);
  assert.match(buildFixQaBrief({ ...b }), /# 修复确认/);
});

// —— 提交校验（状态机） ——

const NOW = new Date('2026-01-01T00:00:00Z');
const TOKEN = 'tok-doc';
const lease = { run_id: 'r-1', role: 'architect', token_hash: hashToken(TOKEN), acquired_at: NOW.toISOString(), expires_at: '2026-01-01T00:30:00Z' };
const facts = (over: Partial<Facts> = {}): Facts => ({
  now: NOW, limits: { max_attempts: 3, max_parallel: 2 }, actor: 'run:r-1', token: TOKEN, diff_files: ['docs/arch/overview.md'], ...over,
});
const docTask = () => mkTask('T-003', { kind: 'doc', stage: 'X1', role: 'architect', scopes: ['plan'], writes: ['docs/arch/**', 'docs/contracts/**'], verify: [], status: 'in_progress', lease, worktree: '/wt', branch: 'b', base_sha: 'abc' });
const submit = (f: Partial<Facts>) => planTransition(docTask(), 'queued_merge', 'submit', facts({ review_required: false, ...f }));

test('“更新架构图与契约”：改什么文档都能提交；没有改动时 report 直接完成', () => {
  assert.equal(isDocsUpdateTask(docTask()), true);
  assert.equal(isDocsUpdateTask(mkTask('T-004', { kind: 'doc', stage: 'S1' })), false);
  assert.ok(submit({}).ok, '改了 docs/arch');
  assert.equal(submit({ diff_files: [] }).ok, false, '没有改动走 report，不走 submit');
  const done = planTransition(docTask(), 'done', 'report', facts({ diff_files: [], structured_report: true }));
  assert.ok(done.ok, done.ok ? '' : done.errors.join());
  if (done.ok) assert.deepEqual([done.task.status, done.task.worktree, done.task.lease], ['done', null, null]);
  assert.equal(planTransition(docTask(), 'done', 'report', facts({ diff_files: ['docs/arch/overview.md'], structured_report: true })).ok, false, '有改动不能直接完成');
});

// —— startChange / 入口 ——

test('startChange：建 C-001（不占活动指针）、brief、全部 impl 与 handoff，然后 pump', async () => {
  const { p, flow, pumped } = await changeProject();
  try {
    assert.equal(flow.id, 'C-002', 'B-001 已占用编号 1，流程编号全局递增');
    assert.deepEqual([flow.mode, flow.stage, flow.title, flow.integration_branch], ['change', 'X1', '看板支持导出 CSV', 'main']);
    assert.equal(p.store.readState().active_flow, null);
    assert.deepEqual(pumped, ['C-002']);
    const tasks = p.store.listTasks(flow.id);
    assert.deepEqual(tasks.map((t) => [t.id, t.kind, t.role, t.stage, t.status]), [['T-001', 'impl', 'worker', 'X1', 'pending'], ['T-002', 'impl', 'worker', 'X1', 'pending']]);
    assert.deepEqual(tasks[1]!.depends_on.map((d) => [d.task, d.type]), [['T-001', 'hard']]);
    assert.ok(tasks[0]!.writes.includes('tests/acceptance/T-001/**'));
    assert.deepEqual(tasks[0]!.verify, ['test'], 'typecheck、lint 是给 agent 参考的命令');
    assert.match(p.store.readHandoff(flow.id, 'T-002'), /点击按钮下载文件/);
    assert.match(p.store.readFlowBrief(flow.id), /### T-001 导出接口/);
    assert.match(statusText(p.store, null, flow.id), /变更步骤：实施中/);
    assert.match(renderStatus(p.store, p.config), /（小改动）/);
    assert.match(statusLine(p.store, p.config)!, /C-002 小改动·实施中/);
  } finally { p.cleanup(); }
});

test('startChange：计划不通过报中文错误且不建流程；与未结束的 fix / change 互斥；build 流程运行中拒绝，等待审批时需确认', async () => {
  const p = await setupProject({ yaml: YAML });
  try {
    const config = parseConfig(YAML);
    const d = { root: p.dir, store: p.store, config };
    await assert.rejects(startChange(d, PLAN, { yes: false }), /不能同时小改动/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });
    const bad = { ...PLAN, tasks: [{ title: 'x', writes: ['docs/contracts/**'], ac: ['a'] }] };
    await assert.rejects(startChange(d, bad, { yes: true }), /迷你计划未通过检查[\s\S]*docs\/contracts/);
    assert.equal(p.store.openLightFlow(), null);
    const needs = await startChange(d, PLAN, { yes: false });
    assert.equal(needs.kind, 'needs_confirm');
    assert.equal((await startChange(d, PLAN, { yes: false, confirm: () => false })).kind, 'cancelled');
    assert.equal(p.store.openLightFlow(), null);
    const ok = await startChange(d, PLAN, { yes: false, confirm: () => true });
    assert.equal(ok.kind, 'started');
    assert.equal(p.store.readState().active_flow, p.flowId, '小改动不占用活动流程指针');
    await assert.rejects(startChange(d, PLAN, { yes: true }), /已有进行中的小改动 C-002/);
    await assert.rejects(p.store.createLightFlow('fix', 'x', 'main', p.git('rev-parse', 'HEAD')), /已有进行中的小改动/);
  } finally { p.cleanup(); }
});

function envOf(p: Project, opts: { ui?: CommandEnv['ui'] } = {}) {
  const pumped: string[] = [];
  const env = {
    root: p.dir, packageRoot: p.dir, ui: opts.ui ?? null, waitForIdle: false,
    engine: () => ({ store: p.store, config: p.config, engine: { pump: async (f: string) => { pumped.push(f); }, idle: async () => {} } }),
    store: () => p.store, roleSettings: () => ({}), availableModels: () => [], activateOrchestrator: () => {},
  } as unknown as CommandEnv;
  return { env, pumped };
}

test('/forge-change：help、缺 --from、非法 YAML、计划错误；成功时建流程并 pump', async () => {
  const p = await setupProject({ yaml: YAML });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.match(await runFlowChangeText(p, 'help'), /--from <yaml 文件>/);
    await assert.rejects(runFlowChange('', envOf(p).env).then((s) => { throw new Error(s); }), /--from/);
    await assert.rejects(runFlowChange('--from none.yaml', envOf(p).env), /找不到文件/);
    writeFileSync(path.join(p.dir, 'bad.yaml'), 'title: [');
    await assert.rejects(runFlowChange('--from bad.yaml', envOf(p).env), /不是合法的 YAML/);
    writeFileSync(path.join(p.dir, 'wrong.yaml'), 'title: 缺任务\ntasks: []\n');
    await assert.rejects(runFlowChange('--from wrong.yaml', envOf(p).env), /至少需要 1 个 task/);
    assert.equal(p.store.openLightFlow(), null);
    writeFileSync(path.join(p.dir, 'plan.yaml'), 'title: 看板导出\ndescription: 加按钮\ntasks:\n  - title: 导出接口\n    writes: [src/export/**]\n    ac: [返回 CSV]\n');
    const go = envOf(p);
    const out = await runFlowChange('--from plan.yaml', go.env);
    assert.match(out, /已创建小改动 C-\d+「看板导出」，共 1 个 task：T-001/);
    assert.deepEqual(go.pumped, ['C-002']);
    assert.equal(p.store.openLightFlow()!.mode, 'change');
  } finally { p.cleanup(); }
});
const runFlowChangeText = (p: Project, args: string) => runFlowChange(args, envOf(p).env);

test('forge_change 工具：flowChange 建流程并 pump；错误转为工具错误', async () => {
  const p = await setupProject({ yaml: YAML });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    await assert.rejects(flowChange(p.dir, p.store, p.config, { title: 'x', tasks: [] }), /至少需要 1 个 task/);
    const pumped: string[] = [];
    const r = await flowChange(p.dir, p.store, p.config, PLAN as never, { pump: async (f: string) => { pumped.push(f); } } as never);
    assert.match(r.text, /C-002/);
    assert.deepEqual(r.details, { flow: 'C-002', tasks: ['T-001', 'T-002'] });
    assert.deepEqual(pumped, ['C-002']);
  } finally { p.cleanup(); }
});

// —— fixStep（change 模式） ——

test('fixStep(change)：预建 impl 不再建 T-001；全部 done 后建一次 doc 任务；doc done 后建 X1.qa；pass 后 done 并写日志', async () => {
  const { p, flow, ctx, calls } = await changeProject();
  try {
    const base = p.git('rev-parse', 'HEAD');
    // 预建的 impl 不重复建 T-001；pending 的 impl 不触发 doc
    await fixStep(ctx, flow.id);
    assert.deepEqual(p.store.listTasks(flow.id).map((t) => t.id), ['T-001', 'T-002']);
    assert.deepEqual(calls, []);
    force(p, flow.id, 'T-001', { status: 'done', base_sha: base });
    await fixStep(ctx, flow.id);
    assert.equal(p.store.listTasks(flow.id).length, 2, 'T-002 未完成时不建 doc 任务');

    // 全部 impl 合入：主分支多两个提交，并留下 merge 事件
    mkdirSync(path.join(p.dir, 'src/export'), { recursive: true });
    writeFileSync(path.join(p.dir, 'src/export/a.ts'), 'export const csv = () => "";\n');
    p.git('add', '-A'); p.git('commit', '-q', '-m', `[${flow.id}/T-001] 导出接口`);
    const sha1 = p.git('rev-parse', 'HEAD');
    writeFileSync(path.join(p.dir, 'src/export/b.ts'), 'export const btn = 1;\n');
    p.git('add', '-A'); p.git('commit', '-q', '-m', `[${flow.id}/T-002] 页面按钮`);
    const sha2 = p.git('rev-parse', 'HEAD');
    await p.store.recordEvent({ flow: flow.id, task: 'T-001', actor: 'merge-queue', type: 'merge', evidence: sha1, data: { integration_branch: 'main', from: base, to: sha1 } });
    await p.store.recordEvent({ flow: flow.id, task: 'T-002', actor: 'merge-queue', type: 'merge', evidence: sha2, data: { integration_branch: 'main', from: sha1, to: sha2 } });
    force(p, flow.id, 'T-002', { status: 'done', base_sha: sha1 });

    await fixStep(ctx, flow.id);
    const doc = p.store.readTask(flow.id, 'T-003');
    assert.deepEqual([doc.kind, doc.role, doc.stage, doc.title, doc.scopes, doc.depends_on, doc.verify], ['doc', 'architect', 'X1', DOCS_UPDATE_TITLE, ['plan'], [], []]);
    assert.deepEqual(doc.writes, ['docs/arch/**', 'docs/contracts/**']);
    const handoff = p.store.readHandoff(flow.id, 'T-003');
    assert.match(handoff, /src\/export\/a\.ts/);
    assert.match(handoff, /看板支持导出 CSV/);
    assert.match(handoff, /不需要改时，不改任何文件直接 forge_submit/);
    assert.equal(fixPhase(p.store.readFlow(flow.id), p.store.listTasks(flow.id)), 'docs');
    // 重入幂等
    await fixStep(ctx, flow.id);
    assert.equal(p.store.listTasks(flow.id).filter((t) => t.kind === 'doc').length, 1);
    assert.equal(p.store.listTasks(flow.id).filter((t) => t.kind === 'qa').length, 0, 'doc 任务没完成时不建 qa');

    // doc 任务合入 → X1.qa（变更确认）
    force(p, flow.id, 'T-003', { status: 'done', base_sha: sha2 });
    await fixStep(ctx, flow.id);
    const qa = p.store.readTask(flow.id, 'X1.qa');
    assert.deepEqual([qa.kind, qa.role, qa.status], ['qa', 'stage-qa', 'ready']);
    assert.match(qa.title, /^变更确认：/);
    assert.match(p.store.readHandoff(flow.id, 'X1.qa'), /# 变更确认：X1\.qa[\s\S]*### T-002 页面按钮[\s\S]*docs\/arch\/overview\.md/);
    assert.ok((calls as string[]).includes('X1.qa'));
    assert.equal(fixPhase(p.store.readFlow(flow.id), p.store.listTasks(flow.id)), 'confirming');

    // qa 通过 → done、写日志
    evidence(p, flow.id, 'X1.qa', QA_REPORT, { round: 1, requested: 'pass', verdict: 'pass', issues: [], downgraded: [], head: sha2 });
    force(p, flow.id, 'X1.qa', { status: 'done' });
    await fixStep(ctx, flow.id);
    const done = p.store.readFlow(flow.id);
    assert.ok(isFinished(done));
    assert.equal(p.store.openLightFlow(), null);
    const log = readFixLog(p.store, flow.id)!;
    for (const s of ['# 变更 C-002：看板支持导出 CSV', '## 变更内容', '导出接口', sha1.slice(0, 8), sha2.slice(0, 8), '- src/export/a.ts', '- src/export/b.ts', '已确认变更', '2026-03-04']) assert.ok(log.includes(s), s);
    assert.deepEqual(p.store.listFixLogs(), ['2026-03-04-001.md']);
    assert.match(statusText(p.store, null, flow.id), /变更日志：/);
    await fixStep(ctx, flow.id);
    assert.equal(p.store.listFixLogs().length, 1, '重入不重复写日志');
  } finally { p.cleanup(); }
});

test('fixStep(change)：任务阻塞时不建 doc 且显示需要你处理；解除后继续到变更确认；非 needs_human 时 acceptFix 拒绝', async () => {
  const { p, flow, ctx } = await changeProject();
  try {
    force(p, flow.id, 'T-001', { status: 'done' });
    force(p, flow.id, 'T-002', { status: 'blocked', blocked_reason: '需要改契约', blocked_by: 'agent' });
    await fixStep(ctx, flow.id);
    assert.equal(p.store.listTasks(flow.id).length, 2);
    assert.equal(fixPhase(p.store.readFlow(flow.id), p.store.listTasks(flow.id)), 'needs_human');
    assert.match(renderStatus(p.store, p.config), /小改动/);
    await assert.rejects(acceptFix(ctx, flow.id, 'x'), /小改动 C-002 当前不是"需要你处理"/);
    force(p, flow.id, 'T-002', { status: 'done' });
    await fixStep(ctx, flow.id);
    force(p, flow.id, 'T-003', { status: 'done' });
    await fixStep(ctx, flow.id);
    assert.equal(p.store.readTask(flow.id, 'X1.qa').kind, 'qa');
  } finally { p.cleanup(); }
});

test('fixStep(change)：qa 通过前 needs_human 时 /forge accept 放行并写变更日志', async () => {
  const { p, flow, ctx } = await changeProject();
  try {
    for (const id of ['T-001', 'T-002']) force(p, flow.id, id, { status: 'done' });
    await fixStep(ctx, flow.id);
    force(p, flow.id, 'T-003', { status: 'done' });
    await fixStep(ctx, flow.id);
    await p.store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(flow.id, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'gate', reason: '复现确认：轮数用尽' });
    assert.match(renderStatus(p.store, p.config), /小改动需要你处理/);
    const msg = await acceptFix(ctx, flow.id, '手工验证过了');
    assert.match(msg, /已放行小改动 C-002/);
    assert.match(readFixLog(p.store, flow.id)!, /# 变更 C-002/);
  } finally { p.cleanup(); }
});
