// M9 判定与结果表（docs/M9-PLAN.md 第 3.2、3.3 节）。纯函数导出供单元测试；命令行：
//   node scripts/m9/score.ts table <summary.json>...        汇总成结果表 markdown 并给出判定
//   node scripts/m9/score.ts hidden <hidden输出文本文件> [<变更那次的输出>]   解析隐藏测试输出并计分
// 判定只用 summary.json；每组 1 次，"平均"就是这一次的值。
import { readFileSync } from 'node:fs';
import { parseHidden, scoreRun, type Summary } from './common.ts';

/** 参与判定的数字（从 summary 提取） */
export interface Measure {
  arm: string;
  /** 隐藏测试合计（基础 + 变更，不含"非法 JSON 返回 400"） */
  score: number;
  regression: number;
  /** 判定用的 agent 时间（分钟）：流程失败按上限计 */
  minutes: number;
  /** 基础出现的 observed 数异常（不等于 39）时的提醒 */
  voided?: boolean;
}

export function measureOf(s: Summary): Measure {
  return { arm: s.arm, score: s.score.total, regression: s.score.regression, minutes: s.time_charged_min, voided: s.status === 'infra_failed' };
}

/** 第 3.2 节：A0 与 N 比较 */
export const TIME_FACTOR = 3;
export const NEAR_CASES = 1;
export const NEAR_RATIO = 0.1;

export type Verdict3_2 = 'pass' | 'too_slow' | 'quality_fail' | 'void';

export interface Verdict32 {
  verdict: Verdict3_2;
  quality_ok: boolean;
  time_ok: boolean;
  score_diff: number;
  time_ratio: number;
  /** 贴近门槛的原因（空 = 不贴近） */
  near: string[];
  next_step: string;
  text: string;
}

export function judgeFirstBatch(n: Measure, a0: Measure): Verdict32 {
  if (n.voided || a0.voided) {
    return { verdict: 'void', quality_ok: false, time_ok: false, score_diff: 0, time_ratio: 0, near: [], next_step: '基础设施失败：作废，按第 6.2 节重跑', text: '本次运行作废（基础设施失败），不判定' };
  }
  const scoreDiff = a0.score - n.score;
  const qualityOk = scoreDiff >= 0 && a0.regression === 0;
  const limit = TIME_FACTOR * n.minutes;
  const timeRatio = n.minutes > 0 ? a0.minutes / n.minutes : Infinity;
  const timeOk = a0.minutes <= limit;
  const near: string[] = [];
  if (Math.abs(scoreDiff) <= NEAR_CASES) near.push(`隐藏测试差 ${scoreDiff} 个（落在 ${NEAR_CASES} 个以内）`);
  if (limit > 0 && Math.abs(a0.minutes - limit) / limit <= NEAR_RATIO) near.push(`时间 ${a0.minutes.toFixed(1)} 分钟，门槛 ${limit.toFixed(1)} 分钟（±${NEAR_RATIO * 100}% 以内）`);
  let verdict: Verdict3_2;
  let next: string;
  if (!qualityOk) { verdict = 'quality_fail'; next = '停下来分析原因并汇报，不跑第二批'; }
  else if (timeOk) { verdict = 'pass'; next = '不跑第二批，进入 ②（Homebox）的方案'; }
  else { verdict = 'too_slow'; next = '质量够但太慢：跑第二批 A2、A3，看能删掉什么'; }
  const label = { pass: 'M9 ① 通过', too_slow: '质量够但太慢', quality_fail: '不通过', void: '作废' }[verdict];
  const why = [
    `质量${qualityOk ? '达标' : '不达标'}：A0 ${a0.score} 分 vs N ${n.score} 分（差 ${scoreDiff >= 0 ? '+' : ''}${scoreDiff}），A0 回归 ${a0.regression}`,
    `时间${timeOk ? '达标' : '超标'}：A0 ${a0.minutes.toFixed(1)} 分钟 / N ${n.minutes.toFixed(1)} 分钟 = ${Number.isFinite(timeRatio) ? timeRatio.toFixed(2) : '∞'} 倍（门槛 ${TIME_FACTOR} 倍）`,
  ].join('；');
  return { verdict, quality_ok: qualityOk, time_ok: timeOk, score_diff: scoreDiff, time_ratio: timeRatio, near, next_step: next, text: `${label}。${why}` };
}

/** 第 3.3 节：去掉某个机制后的那一组 x 与 A0 比较 */
export interface Verdict33 {
  /** drop：从精简模式默认流程里去掉这个机制；keep：保留 */
  decision: 'drop' | 'keep' | 'void';
  score_drop: number;
  regression_delta: number;
  time_share: number;
  c1_score: boolean;
  c2_regression: boolean;
  c3_time: boolean;
  /** 保留时记录单位时间收益：每多花 1 分钟 agent 时间换来的隐藏测试个数（A0 − x 的分差 ÷ 时间差）；没有时间差为 null */
  benefit_per_min: number | null;
  near: string[];
  text: string;
}

export const DROP_SCORE_LIMIT = 1;
export const DROP_TIME_SHARE = 0.1;

export function judgeMechanism(a0: Measure, x: Measure): Verdict33 {
  if (a0.voided || x.voided) {
    return { decision: 'void', score_drop: 0, regression_delta: 0, time_share: 0, c1_score: false, c2_regression: false, c3_time: false, benefit_per_min: null, near: [], text: '作废（基础设施失败）' };
  }
  const drop = a0.score - x.score;
  const regDelta = x.regression - a0.regression;
  const share = a0.minutes > 0 ? (a0.minutes - x.minutes) / a0.minutes : 0;
  const c1 = drop < DROP_SCORE_LIMIT;
  const c2 = regDelta <= 0;
  const c3 = share >= DROP_TIME_SHARE;
  const decision = c1 && c2 && c3 ? 'drop' : 'keep';
  const timeDiff = a0.minutes - x.minutes;
  const benefit = decision === 'keep' && timeDiff > 0 ? drop / timeDiff : null;
  const near: string[] = [];
  if (Math.abs(drop - DROP_SCORE_LIMIT) <= NEAR_CASES) near.push(`隐藏测试下降 ${drop} 个（门槛 ${DROP_SCORE_LIMIT} 个，差距在 ${NEAR_CASES} 个以内）`);
  if (Math.abs(share - DROP_TIME_SHARE) <= DROP_TIME_SHARE * NEAR_RATIO) near.push(`占 agent 时间 ${(share * 100).toFixed(1)}%（门槛 ${DROP_TIME_SHARE * 100}%，±10% 以内）`);
  const text = [
    `${c1 ? '✓' : '✗'} 隐藏测试下降 ${drop} 个（需 < ${DROP_SCORE_LIMIT}）`,
    `${c2 ? '✓' : '✗'} 回归变化 ${regDelta >= 0 ? '+' : ''}${regDelta}（需不增加）`,
    `${c3 ? '✓' : '✗'} 占 agent 时间 ${(share * 100).toFixed(1)}%（需 ≥ ${DROP_TIME_SHARE * 100}%）`,
    decision === 'drop' ? '→ 去掉这个机制（标准模式保留开关）' : `→ 保留${benefit !== null ? `，单位时间收益 ${benefit.toFixed(3)} 个用例/分钟` : ''}`,
  ].join('；');
  return { decision, score_drop: drop, regression_delta: regDelta, time_share: share, c1_score: c1, c2_regression: c2, c3_time: c3, benefit_per_min: benefit, near, text };
}

/** A4 触发条件：A2、A3 各自都满足第 3.3 节的第一、二条 */
export function a4Triggered(a0: Measure, a2: Measure, a3: Measure): boolean {
  const ok = (x: Measure) => a0.score - x.score < DROP_SCORE_LIMIT && x.regression <= a0.regression;
  return ok(a2) && ok(a3);
}

// —— 结果表 ——

const f1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function row(s: Summary): string {
  const phases = Object.fromEntries(s.phases.map((p) => [p.name, p]));
  const b = phases['build'];
  const c = phases['change'];
  const ex = s.interventions.extra;
  const cell = (k: string) => String(ex[k] ?? 0);
  const t = (p: typeof b) => (p ? f1(p.agent_min) : '—');
  const status = s.status === 'delivered' ? '交付' : s.status === 'flow_failed' ? `流程失败：${s.failure?.kind ?? ''}` : s.status === 'infra_failed' ? `基础设施失败：${s.failure?.kind ?? ''}` : `提前停止：${s.failure?.kind ?? ''}`;
  return [
    s.arm, status,
    `${s.score.base.passed}/${s.score.base.total}`,
    s.score.change ? `${s.score.change.passed}/${s.score.change.total}` : '—',
    String(s.score.total), String(s.score.regression),
    `${t(b)} + ${t(c)} = ${f1(s.agent_min)}${s.time_charged_min !== s.agent_min ? `（按上限计 ${f1(s.time_charged_min)}）` : ''}`,
    String(s.interventions.extra_total), cell('plan_not_lean'), cell('dispute'), cell('blocked_question'), cell('blocked_reset'), cell('needs_human'), cell('late_question'),
    String(s.interventions.gates),
    `${s.interventions.p0_questions}（文字 ${s.interventions.p0_text_turns} 轮，编号 ${s.interventions.p0_text_numbered} 题）`,
    s.project_tests.after_change ? String(s.project_tests.after_change.failed ?? '?') : '—',
  ].join(' | ');
}

const HEADER = [
  '组 | 状态 | 基础/39 | 变更/6 | 合计 | 回归 | agent 时间（分钟，新建 + 变更） | 额外介入 | 计划非精简 | 争议 | 阻塞提问 | 阻塞重置 | needs_human | 其他提问 | 必经闸门 | P0 问题数 | 自带测试失败数（变更后）',
  '---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---',
];

/** 多个 summary.json → 结果表 markdown（含第 3.2、3.3 节的判定）。同一组有多个时都列出，判定取每组最后一个 */
export function renderResults(summaries: readonly Summary[]): string {
  const lines: string[] = ['# M9 结果（第一批：看板，单次、方向性）', '', '## 结果表', '', ...HEADER.map((l) => `| ${l} |`), ...summaries.map((s) => `| ${row(s)} |`), ''];
  const last = (arm: string) => [...summaries].reverse().find((s) => s.arm === arm);
  const n = last('N'), a0 = last('A0'), a1 = last('A1');
  lines.push('## 判定', '');
  if (n && a0) {
    const v = judgeFirstBatch(measureOf(n), measureOf(a0));
    lines.push(`### 第 3.2 节（A0 对 N）`, '', v.text, '', `下一步：${v.next_step}`, '');
    if (v.near.length) lines.push(`**贴近门槛**（由用户决定是否补跑）：${v.near.join('；')}`, '');
  } else lines.push('第 3.2 节：缺少 N 或 A0 的结果，暂不判定。', '');
  if (a0 && a1) {
    const v = judgeMechanism(measureOf(a0), measureOf(a1));
    lines.push('### 第 3.3 节（test-author：A0 对 A1）', '', v.text, '');
    if (v.near.length) lines.push(`**贴近门槛**：${v.near.join('；')}`, '');
  }
  const notes = summaries.flatMap((s) => s.notes.map((x) => `- ${s.arm}（${s.run_id}）：${x}`));
  const diffs = summaries.flatMap((s) => s.phases.filter((p) => p.metrics_diff_over_2min).map((p) => `- ${s.arm} ${p.name}：脚本 ${f1(p.agent_min)} 分钟，--metrics 口径 ${p.metrics_agent_min === null ? '—' : f1(p.metrics_agent_min)} 分钟，差超过 2 分钟，需在报告里说明原因`));
  if (diffs.length) lines.push('## agent 时间核对', '', ...diffs, '');
  if (notes.length) lines.push('## 备注', '', ...notes, '');
  lines.push('## 运行信息', '', ...summaries.map((s) => `- ${s.arm} ${s.run_id}：Pi ${s.pi_version}，pi-forge ${s.pi_forge_sha?.slice(0, 8) ?? '—'}${s.pi_forge_dirty ? '（有未提交改动）' : ''}，模型 ${Object.entries(s.models).map(([k, v]) => `${k}=${v}`).join('、')}`), '');
  return lines.join('\n');
}

// —— 命令行 ——

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (cmd === 'table') {
    if (!rest.length) throw new Error('用法：score.ts table <summary.json>...');
    const summaries = rest.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Summary);
    process.stdout.write(`${renderResults(summaries)}\n`);
  } else if (cmd === 'hidden') {
    const [build, change] = rest;
    if (!build) throw new Error('用法：score.ts hidden <基础输出> [<变更输出>]');
    const score = scoreRun(parseHidden(readFileSync(build, 'utf8')), change ? parseHidden(readFileSync(change, 'utf8')) : null);
    process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
  } else {
    throw new Error('用法：score.ts table <summary.json>... | score.ts hidden <基础输出> [<变更输出>]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; }
}
