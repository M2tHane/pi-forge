// M9 计分、回归、判定（第 3.2、3.3 节每个分支与"贴近门槛"）、agent 时间、问句识别、结果表。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentTime, blockedIntervals, flowDoneMs, looksLikeQuestion, nativeAgentMs, parseHidden, parseTestSummary, scoreRun, unionMs,
  BASE_TOTAL, type Summary,
} from '../../scripts/m9/common.ts';
import { a4Triggered, judgeFirstBatch, judgeMechanism, renderResults, type Measure } from '../../scripts/m9/score.ts';
import type { FlowEvent } from '../../src/core/schemas.ts';

// —— hidden.mjs 输出 ——

/** 按真实输出格式拼一份：base 个基础用例（前 failBase 个失败；含"非法 JSON 返回 400"），change 个变更用例 */
function hiddenOutput(opts: { failBase?: string[]; changeOk?: number; withChange?: boolean }): string {
  const labels = Array.from({ length: 40 }, (_, i) => (i === 39 ? '非法 JSON 返回 400' : `基础用例 ${i + 1}`));
  const lines: string[] = ['', '## 账号（40/40）'];
  for (const l of labels) lines.push(opts.failBase?.includes(l) ? `✗ ${l}：500` : `✓ ${l}`);
  if (opts.withChange) {
    lines.push('', '## 变更：归档（6/6）');
    for (let i = 0; i < 6; i++) lines.push((opts.changeOk ?? 6) > i ? `✓ 变更用例 ${i + 1}` : `✗ 变更用例 ${i + 1}：409 缺错误码`);
  }
  lines.push('', `合计：基础 40/40${opts.withChange ? '，变更 6/6' : ''}`);
  return lines.join('\n');
}

test('parseHidden：读出分组、通过与失败原因、合计行', () => {
  const r = parseHidden(hiddenOutput({ failBase: ['基础用例 3'], withChange: true, changeOk: 4 }));
  assert.equal(r.crashed, false);
  assert.equal(r.cases.length, 46);
  const c3 = r.cases.find((c) => c.label === '基础用例 3')!;
  assert.equal(c3.ok, false);
  assert.equal(c3.why, '500');
  assert.equal(r.cases.filter((c) => c.group.startsWith('变更')).length, 6);
  assert.match(r.footer ?? '', /^合计/);
});

test('parseHidden：没有任何用例输出（服务没起来）→ crashed', () => {
  assert.equal(parseHidden('Error: 服务没有启动', 1).crashed, true);
});

test('计分：满分 39，"非法 JSON 返回 400"不计分', () => {
  const s = scoreRun(parseHidden(hiddenOutput({})), null);
  assert.equal(s.base.passed, 39);
  assert.equal(s.base.total, BASE_TOTAL);
  assert.equal(s.base.observed, 39);
  assert.equal(s.total, 39);
  assert.equal(s.change, null);
  assert.equal(s.regression, 0);
});

test('计分：只有"非法 JSON 返回 400"失败，不扣分', () => {
  const s = scoreRun(parseHidden(hiddenOutput({ failBase: ['非法 JSON 返回 400'] })), null);
  assert.equal(s.total, 39);
  assert.deepEqual(s.failed_base, []);
});

test('计分：基础与变更相加', () => {
  const b = parseHidden(hiddenOutput({ failBase: ['基础用例 1', '基础用例 2'] }));
  const c = parseHidden(hiddenOutput({ failBase: ['基础用例 1', '基础用例 2'], withChange: true, changeOk: 5 }));
  const s = scoreRun(b, c);
  assert.equal(s.base.passed, 37);
  assert.equal(s.change?.passed, 5);
  assert.equal(s.total, 42);
  assert.deepEqual(s.failed_change, ['变更用例 6']);
});

test('回归：新建后通过、变更后失败的基础用例数；本来就失败的不算', () => {
  const b = parseHidden(hiddenOutput({ failBase: ['基础用例 1'] }));
  const c = parseHidden(hiddenOutput({ failBase: ['基础用例 1', '基础用例 5', '基础用例 6'], withChange: true }));
  const s = scoreRun(b, c);
  assert.equal(s.regression, 2);
  assert.deepEqual(s.regressed, ['基础用例 5', '基础用例 6']);
});

test('回归：变更那次崩溃（服务起不来）→ 新建通过的全部算回归；没有变更结果 → 回归 0 且标记未跑', () => {
  const b = parseHidden(hiddenOutput({}));
  const crashed = scoreRun(b, parseHidden('Error: 服务没有启动', 1));
  assert.equal(crashed.regression, 39);
  assert.equal(crashed.change?.passed, 0);
  const none = scoreRun(b, null);
  assert.equal(none.regression, 0);
  assert.equal(none.change_ran, false);
});

test('计分：新建没交付（hidden 为 null 或崩溃）→ 0/39', () => {
  assert.equal(scoreRun(null, null).total, 0);
  assert.equal(scoreRun(parseHidden('boom', 1), null).base.passed, 0);
});

// —— 第 3.2 节 ——

const m = (arm: string, score: number, regression: number, minutes: number): Measure => ({ arm, score, regression, minutes });

test('3.2：质量达标且时间达标 → M9 ① 通过', () => {
  const v = judgeFirstBatch(m('N', 40, 0, 30), m('A0', 42, 0, 80));
  assert.equal(v.verdict, 'pass');
  assert.match(v.next_step, /Homebox/);
});

test('3.2：质量达标、时间超标（> 3 倍）→ 太慢，跑第二批', () => {
  const v = judgeFirstBatch(m('N', 40, 0, 30), m('A0', 42, 0, 100));
  assert.equal(v.verdict, 'too_slow');
  assert.match(v.next_step, /A2、A3/);
});

test('3.2：A0 分数低于 N → 不通过（无论时间）', () => {
  assert.equal(judgeFirstBatch(m('N', 40, 0, 30), m('A0', 39, 0, 50)).verdict, 'quality_fail');
  assert.equal(judgeFirstBatch(m('N', 40, 0, 30), m('A0', 39, 0, 500)).verdict, 'quality_fail');
});

test('3.2：A0 有回归 → 不通过，即使分数更高', () => {
  const v = judgeFirstBatch(m('N', 40, 0, 30), m('A0', 45, 1, 50));
  assert.equal(v.verdict, 'quality_fail');
  assert.equal(v.quality_ok, false);
});

test('3.2：A0 恰好等于 3 倍算达标；分数相等算达标', () => {
  const v = judgeFirstBatch(m('N', 40, 0, 30), m('A0', 40, 0, 90));
  assert.equal(v.verdict, 'pass');
});

test('3.2 贴近门槛：差距在 1 个用例以内', () => {
  assert.ok(judgeFirstBatch(m('N', 40, 0, 30), m('A0', 39, 0, 50)).near.some((x) => x.includes('隐藏测试')));
  assert.ok(judgeFirstBatch(m('N', 40, 0, 30), m('A0', 41, 0, 50)).near.some((x) => x.includes('隐藏测试')));
  assert.deepEqual(judgeFirstBatch(m('N', 40, 0, 30), m('A0', 45, 0, 50)).near, []);
});

test('3.2 贴近门槛：时间在 3 倍门槛的 ±10% 以内', () => {
  assert.ok(judgeFirstBatch(m('N', 30, 0, 30), m('A0', 40, 0, 95)).near.some((x) => x.includes('时间')));
  assert.ok(judgeFirstBatch(m('N', 30, 0, 30), m('A0', 40, 0, 82)).near.some((x) => x.includes('时间')));
  assert.deepEqual(judgeFirstBatch(m('N', 30, 0, 30), m('A0', 40, 0, 60)).near, []);
  assert.deepEqual(judgeFirstBatch(m('N', 30, 0, 30), m('A0', 40, 0, 120)).near, []);
});

test('3.2：基础设施失败 → 作废，不判定', () => {
  const v = judgeFirstBatch(m('N', 40, 0, 30), { ...m('A0', 0, 0, 10), voided: true });
  assert.equal(v.verdict, 'void');
});

// —— 第 3.3 节 ——

test('3.3：三条同时满足 → 去掉这个机制', () => {
  const v = judgeMechanism(m('A0', 42, 0, 100), m('A1', 42, 0, 80));
  assert.equal(v.decision, 'drop');
  assert.ok(v.c1_score && v.c2_regression && v.c3_time);
  assert.equal(v.time_share, 0.2);
});

test('3.3：隐藏测试下降 1 个或以上 → 保留，并记录单位时间收益', () => {
  const v = judgeMechanism(m('A0', 42, 0, 100), m('A1', 41, 0, 50));
  assert.equal(v.decision, 'keep');
  assert.equal(v.c1_score, false);
  assert.equal(v.benefit_per_min, 1 / 50);
});

test('3.3：回归增加 → 保留', () => {
  const v = judgeMechanism(m('A0', 42, 0, 100), m('A1', 42, 1, 50));
  assert.equal(v.decision, 'keep');
  assert.equal(v.c2_regression, false);
});

test('3.3：占 agent 时间不到 10% → 保留', () => {
  const v = judgeMechanism(m('A0', 42, 0, 100), m('A1', 42, 0, 95));
  assert.equal(v.decision, 'keep');
  assert.equal(v.c3_time, false);
});

test('3.3：占时间恰好 10% 算满足；A1 更慢时没有单位时间收益可记', () => {
  assert.equal(judgeMechanism(m('A0', 42, 0, 100), m('A1', 42, 0, 90)).decision, 'drop');
  const slower = judgeMechanism(m('A0', 42, 0, 100), m('A1', 40, 0, 120));
  assert.equal(slower.decision, 'keep');
  assert.equal(slower.benefit_per_min, null);
});

test('3.3：分数上升也算"下降不到 1 个"', () => {
  assert.equal(judgeMechanism(m('A0', 40, 0, 100), m('A1', 44, 0, 70)).decision, 'drop');
});

test('3.3 贴近门槛：下降 0、1、2 个，或占时间 9.5%–10.5%', () => {
  assert.ok(judgeMechanism(m('A0', 42, 0, 100), m('A1', 41, 0, 50)).near.some((x) => x.includes('隐藏测试')));
  assert.ok(judgeMechanism(m('A0', 42, 0, 100), m('A1', 42, 0, 89.8)).near.some((x) => x.includes('占 agent 时间')));
  assert.deepEqual(judgeMechanism(m('A0', 50, 0, 100), m('A1', 40, 0, 50)).near, []);
});

test('A4 触发：A2、A3 各自都满足第 3.3 节的第一、二条（时间不论）', () => {
  const a0 = m('A0', 42, 0, 100);
  assert.equal(a4Triggered(a0, m('A2', 42, 0, 99), m('A3', 43, 0, 100)), true);
  assert.equal(a4Triggered(a0, m('A2', 41, 0, 50), m('A3', 42, 0, 50)), false);
  assert.equal(a4Triggered(a0, m('A2', 42, 0, 50), m('A3', 42, 1, 50)), false);
});

// —— agent 时间 ——

const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + min * 60_000).toISOString();
const ms = (min: number) => Date.parse(T(min));
function ev(seq: number, minute: number, o: Partial<FlowEvent>): FlowEvent {
  return { seq, ts: T(minute), flow: 'B-001', actor: 'engine', type: 'transition', prev_hash: '0'.repeat(64), hash: '0'.repeat(64), ...o } as FlowEvent;
}
const stageEv = (seq: number, minute: number, to: string, isStatus: boolean, stage = 'P0') => ev(seq, minute, { to, data: { entity: 'stage', ...(isStatus ? { stage } : {}) } });
const taskEv = (seq: number, minute: number, task: string, from: string, to: string) => ev(seq, minute, { task, from, to, data: { entity: 'task' } });

test('unionMs：重叠区间合并、裁剪到窗口', () => {
  assert.equal(unionMs([[0, 10], [5, 20], [30, 40]]), 30);
  assert.equal(unionMs([[0, 100]], 10, 20), 10);
  assert.equal(unionMs([]), 0);
});

test('blockedIntervals：多段、未解除的算到结束时刻', () => {
  const events = [taskEv(1, 10, 'T-001', 'in_progress', 'blocked'), taskEv(2, 14, 'T-001', 'blocked', 'in_progress'), taskEv(3, 20, 'T-001', 'in_progress', 'blocked'), taskEv(4, 12, 'T-002', 'in_progress', 'blocked')];
  const iv = blockedIntervals(events, 'B-001', ms(30));
  // T-001：10→14 与 20→30；T-002：12→30。并集 10→30 共 20 分钟
  assert.equal(unionMs(iv) / 60_000, 20);
});

test('agentTime：墙钟 − 等人工 − blocked − P0 等待；与 --metrics 口径（只扣等人工）分别给出', () => {
  // P0 活动 0–10（其中 P0 提问等待 2 分钟），P0 等批准 10–15，P1 活动 15–40（其中 task blocked 20–26），P1 等批准 40–45，S1 活动 45–60，S1 等签收 60–65 → done
  const events = [
    stageEv(1, 10, 'awaiting_human', true, 'P0'),
    stageEv(2, 15, 'P1', false), // 进入 P1，active
    ev(3, 15, { to: 'active', data: { entity: 'stage', stage: 'P1' } }),
    taskEv(4, 20, 'T-001', 'in_progress', 'blocked'),
    taskEv(5, 26, 'T-001', 'blocked', 'in_progress'),
    stageEv(6, 40, 'awaiting_human', true, 'P1'),
    stageEv(7, 45, 'S1', false),
    stageEv(8, 60, 'awaiting_human', true, 'S1'),
    stageEv(9, 65, 'done', true, 'S1'),
  ];
  const flow = { id: 'B-001', stages: ['P0', 'P1', 'S1'], created_at: T(0) };
  const t = agentTime(events, flow, ms(0), ms(100), [[ms(3), ms(5)]]);
  assert.equal(flowDoneMs(events, 'B-001'), ms(65));
  assert.equal(t.wall_ms / 60_000, 65);
  assert.equal(t.human_ms / 60_000, 5 + 5 + 5);
  assert.equal(t.blocked_ms / 60_000, 6);
  assert.equal(t.p0_ms / 60_000, 2);
  assert.equal(t.agent_ms / 60_000, 65 - 15 - 6 - 2);
  assert.equal(t.metrics_agent_ms / 60_000, 65 - 15);
});

test('nativeAgentMs：墙钟减去代答间隔', () => {
  assert.equal(nativeAgentMs(0, 100_000, [[10_000, 12_000], [50_000, 51_000]]), 97_000);
  assert.equal(nativeAgentMs(0, 5, []), 5);
});

// —— 问句识别 ——

test('looksLikeQuestion：问号结尾、"请确认""是否需要"等', () => {
  assert.equal(looksLikeQuestion('已完成。需要我继续添加测试吗？'), true);
  assert.equal(looksLikeQuestion('Done. Would you like me to continue'), true);
  assert.equal(looksLikeQuestion('请确认以上方案后我再动手'), true);
  assert.equal(looksLikeQuestion('是否需要增加分页'), true);
  assert.equal(looksLikeQuestion('全部完成，测试通过。'), false);
  assert.equal(looksLikeQuestion('前面问过 好吗？但后面写了很多很多结论'.padEnd(500, '。')), false);
});

// —— 项目自带测试 ——

test('parseTestSummary：node:test 与 vitest/jest 的输出', () => {
  assert.deepEqual(parseTestSummary('# tests 10\n# pass 8\n# fail 2\n', 1), { exit_code: 1, passed: 8, failed: 2, tail: '# tests 10\n# pass 8\n# fail 2\n' });
  assert.equal(parseTestSummary('Tests  1 failed | 5 passed (6)', 1).failed, 1);
  assert.equal(parseTestSummary('Tests: 5 passed, 5 total', 0).failed, 0);
  assert.equal(parseTestSummary('no output', 2).failed, null);
});

// —— 结果表 ——

function summary(arm: 'N' | 'A0' | 'A1', o: { base: number; change: number; regression: number; min: number; extra?: Record<string, number> }): Summary {
  return {
    schema: 1, arm, run_id: `${arm}-01`, started_at: '', ended_at: '', pi_version: '1.1.0', pi_forge_sha: 'abcdef123456', pi_forge_dirty: false,
    models: { planner: 'p' }, thinking: {}, status: 'delivered', failure: null, agent_min: o.min, time_charged_min: o.min,
    phases: [{ name: 'build', flow: 'B-001', delivered: true, wall_min: o.min, human_wait_min: 0, blocked_wait_min: 0, p0_wait_min: 0, agent_min: o.min - 5, metrics_agent_min: 20, metrics_diff_over_2min: true }, { name: 'change', flow: 'F-002', delivered: true, wall_min: 5, human_wait_min: 0, blocked_wait_min: 0, p0_wait_min: 0, agent_min: 5, metrics_agent_min: 5, metrics_diff_over_2min: false }],
    hidden: { build: null, change: null },
    score: { base: { passed: o.base, total: 39, observed: 39 }, change: { passed: o.change, total: 6, observed: 6 }, total: o.base + o.change, regressed: [], regression: o.regression, change_ran: true, failed_base: [], failed_change: [] },
    project_tests: { after_build: null, after_change: { exit_code: 1, passed: 3, failed: 2, tail: '' } },
    interventions: { p0_questions: 4, p0_text_turns: 1, p0_text_numbered: 3, gates: 6, extra: o.extra ?? {}, extra_total: Object.values(o.extra ?? {}).reduce((a, b) => a + b, 0) },
    usage: {}, notes: ['单次'],
  };
}

test('renderResults：结果表列出每组、判定、贴近门槛与 agent 时间核对', () => {
  const md = renderResults([summary('N', { base: 36, change: 6, regression: 0, min: 30 }), summary('A0', { base: 37, change: 6, regression: 0, min: 80, extra: { blocked_question: 2 } }), summary('A1', { base: 37, change: 6, regression: 0, min: 60 })]);
  assert.match(md, /\| N \|/);
  assert.match(md, /\| A0 \|/);
  assert.match(md, /M9 ① 通过/);
  assert.match(md, /贴近门槛/);
  assert.match(md, /去掉这个机制/);
  assert.match(md, /差超过 2 分钟/);
  assert.match(md, /阻塞提问/);
});

test('renderResults：只有 N 时不判定', () => {
  assert.match(renderResults([summary('N', { base: 36, change: 6, regression: 0, min: 30 })]), /缺少 N 或 A0/);
});
