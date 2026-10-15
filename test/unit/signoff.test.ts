import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, criticalPath, renderViolations, violationStats, filterSuggestions, parseCoverageMatrix, qaConclusion, qaCounts, renderMetrics, reworkCounts, stageDurations, taskTimings, deliveryReport, stageSignoff, flowMetrics } from '../../src/core/stage/signoff.ts';
import type { FlowEvent, FlowFile, RunFile } from '../../src/core/state/schemas.ts';
import { renderCoverageMarkdown } from '../../src/core/acceptance/coverage.ts';
import { mkTask, hard } from '../helpers/tasks.ts';
import { setupProject } from '../helpers/project.ts';
import { needsHumanReason, renderStatus, actionsNeeded } from '../../src/core/ops/status-view.ts';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const ev = (min: number, over: Partial<FlowEvent>): FlowEvent => ({ seq: ++seq, ts: at(min), flow: 'B-001', actor: 'x', type: 'transition', prev_hash: '', hash: '', ...over }) as FlowEvent;
const stageEv = (min: number, to: string, stage?: string, extra: Partial<FlowEvent> = {}) => ev(min, { to, data: stage ? { entity: 'stage', stage } : { entity: 'stage' }, ...extra });
const taskEv = (min: number, task: string, to: string, trigger = 'x') => ev(min, { task, to, trigger });

const flow = (over: Partial<FlowFile> = {}): FlowFile => ({
  id: 'B-001', mode: 'build', title: 't', stages: ['P0', 'P1', 'S1', 'S2'], stage: 'S2', stage_status: 'awaiting_human',
  integration_branch: 'forge/B-001', base_sha: null, approvals: {}, created_at: at(0), version: 1,
  s_stages: [{ id: 'S1', goal: '登录', exit: ['REQ-001'] }, { id: 'S2', goal: '列表', exit: ['REQ-002'] }], ...over,
}) as FlowFile;

test('agent 时间 = 墙钟 - 等人工的时间', () => {
  const events = [
    stageEv(10, 'awaiting_gate', 'S1'), stageEv(12, 'awaiting_human', 'S1'), stageEv(32, 'active', 'S1'),
    stageEv(40, 'awaiting_human', 'S1'), stageEv(50, 'done', 'S1'), stageEv(50, 'S2'),
  ];
  const d = stageDurations(events, 'B-001', 'S1', at(0), T0 + 60 * 60_000).get('S1')!;
  assert.equal(d.wall_ms, 50 * 60_000);
  assert.equal(d.human_ms, 30 * 60_000);
  const s2 = stageDurations(events, 'B-001', 'S1', at(0), T0 + 60 * 60_000).get('S2')!;
  assert.equal(s2.wall_ms, 10 * 60_000);
});

test('task 时间与关键路径', () => {
  const events = [
    taskEv(0, 'T-001', 'ready'), taskEv(2, 'T-001', 'in_progress'), taskEv(12, 'T-001', 'done'),
    taskEv(0, 'T-002', 'ready'), taskEv(12, 'T-002', 'in_progress'), taskEv(22, 'T-002', 'done'),
    taskEv(2, 'T-003', 'in_progress'), taskEv(7, 'T-003', 'done'),
  ];
  const tm = taskTimings(events, 'B-001');
  assert.equal(tm.get('T-001')!.ready_at, T0);
  const tasks = [mkTask('T-001'), mkTask('T-002', { deps: [hard('T-001')] }), mkTask('T-003')];
  const cp = criticalPath(tasks, tm)!;
  assert.equal(cp.theory_ms, 20 * 60_000);
  assert.equal(cp.actual_ms, 20 * 60_000);
  assert.equal(criticalPath(tasks, new Map()), null);
});

test('返工计数', () => {
  const tasks = [
    mkTask('T-001', { stage: 'S1' }),
    mkTask('T-001.fx-1', { stage: 'S1', kind: 'fix', title: '修复stage-qa的问题（S1.qa）：a.ts' }),
    mkTask('T-002.fx-1', { stage: 'S2', kind: 'fix', title: '修复阶段门禁的问题（g）：b.ts' }),
    mkTask('T-002', { stage: 'S2' }),
  ];
  const events = [
    taskEv(1, 'T-001', 'in_progress', 'precheck_fail'), taskEv(2, 'T-001', 'in_progress', 'precheck_fail'),
    taskEv(3, 'T-001', 'in_progress', 'review_changes'), taskEv(4, 'T-002', 'in_progress', 'merge_verify_fail'),
  ];
  const f = flow();
  assert.deepEqual(reworkCounts(events, tasks, f), { precheck_failures: 2, review_rejects: 1, merge_verify_failures: 1, gate_fixes: 1, qa_fixes: 1 });
  const s2 = reworkCounts(events, tasks, f, 'S2');
  assert.equal(s2.precheck_failures, 0);
  assert.equal(s2.merge_verify_failures, 1);
  assert.equal(s2.qa_fixes, 0);
});

test('覆盖率矩阵、QA 报告、建议行解析', () => {
  const md = '# S1\n\n| 需求 | AC | 测试文件 |\n|---|---|---|\n| REQ-001 | AC1 | tests/a.test.ts |\n| REQ-001 | AC2 | — |\n| REQ-002 | AC1 | tests/b.test.ts |\n| REQ-002 | AC2 | |\n';
  const c = parseCoverageMatrix(md);
  assert.equal(c.total, 4);
  assert.equal(c.covered, 2);
  assert.deepEqual(c.gaps, ['REQ-001 AC2', 'REQ-002 AC2']);
  const real = renderCoverageMarkdown('S1', '目标', [
    { req: 'REQ-001', ac: 'REQ-001.AC1', text: '甲', owner: 'T-001', files: ['tests/acceptance/T-001/a.test.ts'] },
    { req: 'REQ-001', ac: 'REQ-001.AC2', text: '乙', owner: 'T-001', files: [] },
  ]);
  assert.deepEqual(parseCoverageMatrix(real), { total: 2, covered: 1, gaps: ['REQ-001 REQ-001.AC2'] });
  assert.deepEqual(parseCoverageMatrix(renderCoverageMarkdown('S1', '目标', [])), { total: 0, covered: 0, gaps: [] });
  assert.deepEqual(parseCoverageMatrix('没有表格'), { total: 0, covered: 0, gaps: [] });
  assert.deepEqual(qaCounts({ issues: [{ level: 'must' }, { level: 'suggest' }, { level: 'must' }, null] }), { must: 2, suggest: 1 });
  assert.equal(qaCounts('坏数据'), null);
  assert.equal(qaCounts({}), null);
  const sugg = '# 审查建议\n\n## T-001（T-001.rv）\n\n- [T-001.rv R1] T-001：问题（出处：x；a.ts）→ 期望\n- [T-002.rv R1] T-002：别的\n';
  assert.deepEqual(filterSuggestions(sugg, new Set(['T-001'])), ['- [T-001.rv R1] T-001：问题（出处：x；a.ts）→ 期望']);
});

test('stage-qa 结论：must 总数与人工放行', () => {
  const tasks = [mkTask('S1.qa', { stage: 'S1', kind: 'qa' }), mkTask('S1.qa-2', { stage: 'S1', kind: 'qa' }), mkTask('S2.qa', { stage: 'S2', kind: 'qa' })];
  const reports = { 'S1.qa': { issues: [{ level: 'must' }, { level: 'must' }] }, 'S1.qa-2': { issues: [] }, 'S2.qa': { issues: [{ level: 'must' }] } };
  const events = [stageEv(5, 'awaiting_human', 'S1', { trigger: 'accept', reason: '已核对' })];
  const q = qaConclusion(events, 'B-001', 'S1', tasks, reports);
  assert.equal(q.must, 2);
  assert.equal(q.accepted_note, '已核对');
  assert.equal(qaConclusion(events, 'B-001', 'S2', tasks, reports).accepted_note, null);
});

const run = (task: string, start: number, end: number, cost: number | null): RunFile => ({
  run_id: `r-${task}-${start}`, flow: 'B-001', task, role: 'worker', model: 'm', started_at: at(start), ended_at: at(end),
  tokens: { input: 100, output: 50, cache_read: null, cache_write: null }, outcome: 'submitted', token_hash: 'a'.repeat(64), violations: 0, cost, version: 1,
}) as RunFile;

test('computeMetrics 汇总并渲染', () => {
  const f = flow({ approvals: { S2: { by: 'human', at: at(100) } } });
  const tasks = [mkTask('T-001', { stage: 'S1', status: 'done' }), mkTask('T-002', { stage: 'S2', status: 'done' }), mkTask('T-009', { stage: 'S2', status: 'cancelled' })];
  const events = [
    stageEv(0, 'S1'), stageEv(10, 'awaiting_human', 'S1'), stageEv(30, 'done', 'S1'), stageEv(30, 'S2'),
    taskEv(31, 'T-002', 'ready'), taskEv(33, 'T-002', 'in_progress'), taskEv(43, 'T-002', 'done'),
  ];
  const m = computeMetrics({
    flow: f, events, tasks, runs: [run('T-001', 0, 5, 0.5), run('T-002', 33, 43, null)],
    qaReports: {}, coverage: { S1: { total: 4, covered: 3, gaps: ['x'] }, S2: { total: 4, covered: 4, gaps: [] }, },
    fixFlowCreated: [at(90), at(110), at(120)], now: T0 + 200 * 60_000,
  });
  const s1 = m.stages.find((s) => s.stage === 'S1')!;
  assert.equal(s1.human_min, 20);
  assert.equal(s1.agent_min, 10);
  assert.equal(m.stages.find((s) => s.stage === 'S2')!.tasks_cancelled, 1);
  assert.equal(m.queue_avg_min, 2);
  assert.equal(m.quality.ac_coverage_pct, 88);
  assert.equal(m.quality.fix_after_delivery, 2);
  assert.equal(m.cost.runs, 2);
  assert.equal(m.cost.tokens, 300);
  assert.equal(m.cost.cost, 0.5);
  const text = renderMetrics(m);
  for (const k of ['## 速度', '## 返工', '## 质量', '## 成本', '## 被拦下的操作', 'AC 覆盖率 88%', '交付后的 /forge-fix 2 次']) assert.match(text, new RegExp(k.replace(/[/]/g, '\\/')));
});

test('violationStats：按角色与规则汇总，同一 run 同一规则 3 次以上列为反复撞墙', () => {
  const v = (run: string, rule: string, n: number, detail: string) => ({ ...taskEv(n, 'T-001', 'in_progress'), type: 'violation' as const, reason: `拒绝 ${rule}`, data: { run, role: 'worker', tool: 'bash', rule, count: 1, detail } });
  const events = [v('r1', 'bash', 1, 'rm -rf $X'), v('r1', 'bash', 2, 'rm -rf *'), v('r1', 'bash', 3, 'rm -rf dist/*'), v('r1', 'protected', 4, '.forge/x'), v('r2', 'bash', 5, 'cd ..')];
  const s = violationStats(events, 'B-001');
  assert.equal(s.total, 5);
  assert.deepEqual(s.by_role_rule, [{ role: 'worker', rule: 'bash', count: 4 }, { role: 'worker', rule: 'protected', count: 1 }]);
  assert.deepEqual(s.repeated.map((r) => [r.run, r.rule, r.count, r.last]), [['r1', 'bash', 3, 'rm -rf dist/*']]);
  const text = renderViolations(s).join('\n');
  assert.match(text, /共 5 次：worker\/bash 4、worker\/protected 1/);
  assert.match(text, /反复撞同一条规则：T-001 run r1 worker\/bash 3 次，最后一次：rm -rf dist\/\*/);
  assert.deepEqual(renderViolations(violationStats([], 'B-001')), ['- 无']);
});

test('签收材料与交付汇报包含关键章节；needs_human 展示原因与三个选项', async () => {
  const p = await setupProject({ stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', status: 'done', manual_checks: ['打开首页看布局'], produces: ['api:GET /api/x'] })] });
  try {
    await p.store.setStages(p.flowId, [{ id: 'S1', goal: '登录闭环', exit: ['REQ-001'] }], 'standard');
    const text = stageSignoff(p.dir, p.store, p.config, p.flowId, 'S1');
    for (const k of ['本阶段目标与 exit', '登录闭环', '演示方式', '需要你手动检查', '- [ ] T-001：打开首页看布局', '覆盖率矩阵', '新增建议', 'stage-qa 结论', '耗时与成本', '/forge-approve', '/forge-reject']) assert.ok(text.includes(k), k);
    const d = deliveryReport(p.dir, p.store, p.config, p.flowId);
    for (const k of ['交付汇报', '--no-ff', '各阶段概况', '## 返工', '最后一个阶段 S1 的签收材料']) assert.ok(d.includes(k), k);
    assert.ok(flowMetrics(p.store, p.flowId, new Date(), p.dir).stages.length === 1);

    // 状态视图：needs_human
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'engine', reason: '全量测试连续失败' });
    assert.equal(needsHumanReason(p.store, p.store.readFlow(p.flowId)), '全量测试连续失败');
    const st = renderStatus(p.store, p.config);
    assert.match(st, /全量测试连续失败/);
    for (const k of ['/forge accept S1 --note', '/forge gate', '/forge-reject']) assert.ok(st.includes(k), k);
    assert.ok(stageSignoff(p.dir, p.store, p.config, p.flowId, 'S1').includes('/forge accept S1 --note'));

    // awaiting_human 的 S 阶段指向 /forge report
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'accept', actor: 'human', reason: '好' });
    assert.match(renderStatus(p.store, p.config), /\/forge report/);
    assert.ok(actionsNeeded(p.store, p.config).some((a) => a.command.includes('/forge report')));
  } finally { p.cleanup(); }
});
