// 改编自 pi-flow src/core/finish-report.ts @ 31f3f15
// 阶段签收材料、交付汇报与速度/返工/质量/成本度量（规格第 5、11、17 节）。
// pi-flow 的验收与提案概念在这里换成 pi-forge 的对应物：覆盖率矩阵、stage-qa 结论、审查建议、manual_checks。
// 计算部分都是对普通数据（事件、task、run）的纯函数，可以不依赖 git 单元测试；读取 git/磁盘的部分集中在 flowMetrics 与 stageSignoff。
import { existsSync, readFileSync } from 'node:fs';
import type { FlowConfig } from './config.ts';
import { costReport, formatRow, type CostRow } from './cost.ts';
import { git } from './git.ts';
import type { FlowEvent, FlowFile, RunFile, TaskFile } from './schemas.ts';
import { evidenceRel, type StateStore } from './state-store.ts';

const HUMAN_WAIT = new Set(['awaiting_human', 'needs_human']);
const min = (ms: number) => Math.round(ms / 6_000) / 10;
const ratio1 = (n: number) => Math.round(n * 10) / 10;

// —— 纯函数：时间 ——

export interface StageDuration { wall_ms: number; human_ms: number }

/** 各阶段的墙钟时间与等待人工的时间（awaiting_human / needs_human）；agent 时间 = 墙钟 − 等人工 */
export function stageDurations(events: readonly Pick<FlowEvent, 'flow' | 'ts' | 'to' | 'data'>[], flowId: string, firstStage: string, createdAt: string, now: number): Map<string, StageDuration> {
  const acc = new Map<string, StageDuration>();
  let stage = firstStage;
  let status = 'active';
  let since = Date.parse(createdAt);
  const add = (until: number) => {
    if (status === 'done' || status === 'aborted') return;
    const a = acc.get(stage) ?? { wall_ms: 0, human_ms: 0 };
    const d = Math.max(0, until - since);
    a.wall_ms += d;
    if (HUMAN_WAIT.has(status)) a.human_ms += d;
    acc.set(stage, a);
  };
  for (const e of events) {
    if (e.flow !== flowId || e.data?.['entity'] !== 'stage' || !e.to) continue;
    const at = Date.parse(e.ts);
    add(at);
    since = at;
    if (typeof e.data['stage'] === 'string') status = e.to;
    else { stage = e.to; status = 'active'; }
  }
  if (stage !== 'finished' && status !== 'done' && status !== 'aborted') add(now);
  return acc;
}

export interface TaskTiming { ready_at?: number; dispatched_at?: number; done_at?: number }

/** 每个 task 第一次 ready、第一次派发（in_progress）与 done 的时刻 */
export function taskTimings(events: readonly Pick<FlowEvent, 'flow' | 'ts' | 'to' | 'task' | 'data'>[], flowId: string): Map<string, TaskTiming> {
  const out = new Map<string, TaskTiming>();
  for (const e of events) {
    if (e.flow !== flowId || !e.task || !e.to || e.data?.['entity'] === 'stage' || e.data?.['entity'] === 'flow') continue;
    const at = Date.parse(e.ts);
    const t = out.get(e.task) ?? {};
    if (e.to === 'ready' && t.ready_at === undefined) t.ready_at = at;
    if (e.to === 'in_progress' && t.dispatched_at === undefined) t.dispatched_at = at;
    if (e.to === 'done') t.done_at = at;
    out.set(e.task, t);
  }
  return out;
}

/** 关键路径：理论用时 = 依赖链上各 task 耗时（派发到 done）之和的最大值；实际用时 = 最早派发到最晚 done。没有可算的 task 时为 null */
export function criticalPath(tasks: readonly Pick<TaskFile, 'id' | 'depends_on'>[], timings: ReadonlyMap<string, TaskTiming>): { actual_ms: number; theory_ms: number } | null {
  const dur = new Map<string, number>();
  let first = Infinity;
  let last = -Infinity;
  for (const t of tasks) {
    const x = timings.get(t.id);
    if (x?.dispatched_at === undefined || x.done_at === undefined) continue;
    dur.set(t.id, Math.max(0, x.done_at - x.dispatched_at));
    first = Math.min(first, x.dispatched_at);
    last = Math.max(last, x.done_at);
  }
  if (!dur.size) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const longest = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const t = byId.get(id);
    const before = Math.max(0, ...(t?.depends_on ?? []).filter((d) => byId.has(d.task)).map((d) => longest(d.task)));
    visiting.delete(id);
    const v = before + (dur.get(id) ?? 0);
    memo.set(id, v);
    return v;
  };
  const theory = Math.max(...tasks.map((t) => longest(t.id)));
  return { actual_ms: last - first, theory_ms: theory };
}

// —— 纯函数：返工、覆盖率、QA ——

export interface Rework {
  precheck_failures: number;
  review_rejects: number;
  merge_verify_failures: number;
  disputes: number;
  /** .at-n 验收测试返工轮数 */
  acctest_rounds: number;
  gate_fixes: number;
  qa_fixes: number;
}

const FIX_TITLE = { gate: '修复阶段门禁的问题', qa: '修复stage-qa的问题' } as const;
export const isAcctestRound = (t: Pick<TaskFile, 'id' | 'kind'>) => t.kind === 'acctest' && /\.at-\d+$/.test(t.id);

/** 返工次数；stage 给出时只算该阶段的 task（纯函数） */
export function reworkCounts(events: readonly Pick<FlowEvent, 'flow' | 'task' | 'type' | 'trigger'>[], tasks: readonly TaskFile[], flow: Pick<FlowFile, 'id' | 'gate_rounds'>, stage?: string): Rework {
  const scoped = tasks.filter((t) => !stage || t.stage === stage);
  const inScope = new Set(scoped.map((t) => t.id));
  const count = (trigger: string) => events.filter((e) => e.flow === flow.id && e.type === 'transition' && e.trigger === trigger && e.task && inScope.has(e.task)).length;
  const gateTasks = scoped.filter((t) => t.kind === 'fix' && t.title.startsWith(FIX_TITLE.gate)).length;
  const gateRounds = (flow.gate_rounds ?? []).filter((r) => !stage || r.stage === stage).length;
  return {
    precheck_failures: count('precheck_fail'),
    review_rejects: count('review_changes'),
    merge_verify_failures: count('merge_verify_fail'),
    disputes: scoped.reduce((n, t) => n + Object.values(t.disputes ?? {}).reduce((a, b) => a + b, 0), 0),
    acctest_rounds: scoped.filter(isAcctestRound).length,
    gate_fixes: Math.max(gateTasks, gateRounds),
    qa_fixes: scoped.filter((t) => t.kind === 'fix' && t.title.startsWith(FIX_TITLE.qa)).length,
  };
}

export interface Coverage { total: number; covered: number; gaps: string[] }
const EMPTY_CELL = /^(|[-—–]+|无|缺失|缺口|\*\*缺口\*\*|未覆盖|待补|n\/a|❌|✗|x)$/i;

/** 解析 docs/qa/<阶段>.md 的"需求 → AC → 测试文件"表格：第 3 列为空或为占位符的行算缺口（纯函数，宽容） */
export function parseCoverageMatrix(md: string): Coverage {
  let total = 0;
  const gaps: string[] = [];
  for (const line of md.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 3 || cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    if (/^(需求|requirement|req)$/i.test(cells[0]!) && /AC/i.test(cells[1] ?? '')) continue;
    if (!cells[1] || /^[-—–]+$/.test(cells[1])) continue;
    total++;
    // 测试文件在最后一列（coverage.ts 的表格：需求 | AC | 内容 | 负责 task | 测试文件）
    if (EMPTY_CELL.test(cells.at(-1) ?? '')) gaps.push(`${cells[0]} ${cells[1]}`.trim());
  }
  return { total, covered: total - gaps.length, gaps };
}

/** stage-qa 报告中的 must / suggest 数；格式不对时返回 null（纯函数，宽容） */
export function qaCounts(report: unknown): { must: number; suggest: number } | null {
  const issues = (report as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return null;
  const level = (i: unknown) => (i as { level?: unknown } | null)?.level;
  return { must: issues.filter((i) => level(i) === 'must').length, suggest: issues.filter((i) => level(i) === 'suggest').length };
}

export interface QaConclusion { qa_tasks: number; must: number; suggest: number; reports: number; accepted_note: string | null }

/** 本阶段 stage-qa 的结论：must 总数，以及是否由人在 needs_human 时用 /forge accept 放行（纯函数） */
export function qaConclusion(events: readonly Pick<FlowEvent, 'flow' | 'type' | 'trigger' | 'reason' | 'to' | 'data'>[], flowId: string, stage: string, tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'stage'>[], reports: Readonly<Record<string, unknown>>): QaConclusion {
  const qa = tasks.filter((t) => t.kind === 'qa' && t.stage === stage);
  let must = 0, suggest = 0, n = 0;
  for (const t of qa) {
    const c = qaCounts(reports[t.id]);
    if (!c) continue;
    n++; must += c.must; suggest += c.suggest;
  }
  const acc = [...events].reverse().find((e) => e.flow === flowId && e.trigger === 'accept' && e.data?.['entity'] === 'stage' && e.data['stage'] === stage);
  return { qa_tasks: qa.length, must, suggest, reports: n, accepted_note: acc ? (acc.reason ?? '') || '（无说明）' : null };
}

/** 从 docs/review/suggestions.md 取出属于给定 task 集合的建议行（纯函数）；行格式见 review.ts suggestionLine */
export function filterSuggestions(md: string, taskIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const line of md.split('\n')) {
    const m = /^- \[[^\]]*\] ([^：\s]+)：/.exec(line);
    if (m && taskIds.has(m[1]!)) out.push(line);
  }
  return out;
}

// —— 纯函数：成本 ——

export interface RunSum { runs: number; tokens: number | null; cost: number | null; duration_ms: number }
export function sumRuns(runs: readonly Pick<RunFile, 'tokens' | 'cost' | 'started_at' | 'ended_at'>[], now: number): RunSum {
  let tokens: number | null = null, cost: number | null = null, dur = 0;
  for (const r of runs) {
    for (const v of [r.tokens.input, r.tokens.output]) if (v !== null) tokens = (tokens ?? 0) + v;
    if (typeof r.cost === 'number') cost = (cost ?? 0) + r.cost;
    dur += Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : now) - Date.parse(r.started_at));
  }
  return { runs: runs.length, tokens, cost, duration_ms: dur };
}

// —— 度量 ——

export interface StageSpeed {
  stage: string;
  wall_min: number;
  human_min: number;
  agent_min: number;
  tasks_done: number;
  tasks_cancelled: number;
  critical_actual_min: number | null;
  critical_theory_min: number | null;
  /** 实际/理论；理论为 0 或算不出时为 null */
  critical_ratio: number | null;
}
export interface TaskSpeed { task: string; stage: string; run_min: number | null; queue_min: number | null }

export interface WorkspaceStats { count: number; total_ms: number; cache_hits: number; skipped: number; failed: number }

/** 工作区准备的汇总（纯函数）：数据来自 prepareWorkspaceRecorded 记的 note 事件 */
export function workspaceStats(events: readonly Pick<FlowEvent, 'flow' | 'type' | 'data'>[], flowId: string): WorkspaceStats {
  const mine = events.filter((e) => e.flow === flowId && e.type === 'note' && e.data?.['kind'] === 'workspace_prepare');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    count: mine.length,
    total_ms: mine.reduce((n, e) => n + num(e.data?.['ms']), 0),
    cache_hits: mine.filter((e) => e.data?.['cached'] === true).length,
    skipped: mine.filter((e) => e.data?.['skipped'] === true).length,
    failed: mine.filter((e) => e.data?.['ok'] === false).length,
  };
}

export interface Metrics {
  flow: string;
  stages: StageSpeed[];
  tasks: TaskSpeed[];
  queue_avg_min: number | null;
  /** 工作区准备（install → codegen）的次数、总耗时与缓存命中次数 */
  workspace: WorkspaceStats;
  rework: Rework;
  rework_by_stage: Record<string, Rework>;
  quality: {
    /** 有矩阵的阶段合计；没有任何矩阵时为 null */
    ac_coverage_pct: number | null;
    acceptance_tests: number;
    qa_must: number;
    fix_after_delivery: number;
  };
  cost: RunSum;
  cost_by_stage: Record<string, RunSum>;
  cost_row: CostRow | null;
}

export interface MetricsInput {
  flow: FlowFile;
  events: readonly FlowEvent[];
  tasks: readonly TaskFile[];
  runs: readonly RunFile[];
  /** 每个 qa task 的 qa-report.json 内容（读不到的不放） */
  qaReports: Readonly<Record<string, unknown>>;
  /** 阶段 → 覆盖率（没有矩阵时不放或为 null） */
  coverage: Readonly<Record<string, Coverage | null>>;
  /** 其他 fix 流程的创建时间 */
  fixFlowCreated: readonly string[];
  now: number;
  costRow?: CostRow | null;
}

export const sStageIds = (flow: FlowFile): string[] => flow.s_stages?.map((s) => s.id) ?? flow.stages.filter((s) => !['P0', 'P1', 'ADOPT'].includes(s));

/** 纯函数：从普通数据算出 §17 的全部度量 */
export function computeMetrics(i: MetricsInput): Metrics {
  const { flow, tasks, now } = i;
  const stages = sStageIds(flow);
  const dur = stageDurations(i.events, flow.id, flow.stages[0]!, flow.created_at, now);
  const timings = taskTimings(i.events, flow.id);
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const taskSpeed: TaskSpeed[] = live.map((t) => {
    const x = timings.get(t.id);
    return {
      task: t.id, stage: t.stage,
      run_min: x?.dispatched_at !== undefined && x.done_at !== undefined ? min(Math.max(0, x.done_at - x.dispatched_at)) : null,
      queue_min: x?.ready_at !== undefined && x.dispatched_at !== undefined ? min(Math.max(0, x.dispatched_at - x.ready_at)) : null,
    };
  });
  const queues = taskSpeed.flatMap((t) => (t.queue_min === null ? [] : [t.queue_min]));
  const stageSpeed: StageSpeed[] = stages.map((s) => {
    const d = dur.get(s) ?? { wall_ms: 0, human_ms: 0 };
    const cp = criticalPath(live.filter((t) => t.stage === s), timings);
    return {
      stage: s, wall_min: min(d.wall_ms), human_min: min(d.human_ms), agent_min: min(Math.max(0, d.wall_ms - d.human_ms)),
      tasks_done: tasks.filter((t) => t.stage === s && t.status === 'done').length,
      tasks_cancelled: tasks.filter((t) => t.stage === s && t.status === 'cancelled').length,
      critical_actual_min: cp ? min(cp.actual_ms) : null,
      critical_theory_min: cp ? min(cp.theory_ms) : null,
      critical_ratio: cp && cp.theory_ms > 0 ? ratio1(cp.actual_ms / cp.theory_ms) : null,
    };
  });
  const cov = Object.values(i.coverage).filter((c): c is Coverage => !!c && c.total > 0);
  const covTotal = cov.reduce((n, c) => n + c.total, 0);
  const lastStage = stages.at(-1);
  const deliveredAt = lastStage ? flow.approvals[lastStage]?.at : undefined;
  const stageOfTask = new Map(tasks.map((t) => [t.id, t.stage]));
  const costBy: Record<string, RunSum> = {};
  for (const s of stages) costBy[s] = sumRuns(i.runs.filter((r) => r.task && stageOfTask.get(r.task) === s), now);
  return {
    flow: flow.id,
    stages: stageSpeed,
    tasks: taskSpeed,
    workspace: workspaceStats(i.events, flow.id),
    queue_avg_min: queues.length ? ratio1(queues.reduce((a, b) => a + b, 0) / queues.length) : null,
    rework: reworkCounts(i.events, tasks, flow),
    rework_by_stage: Object.fromEntries(stages.map((s) => [s, reworkCounts(i.events, tasks, flow, s)])),
    quality: {
      ac_coverage_pct: covTotal ? Math.round((cov.reduce((n, c) => n + c.covered, 0) / covTotal) * 100) : null,
      acceptance_tests: live.filter((t) => t.kind === 'acctest' && t.status === 'done').length,
      qa_must: stages.reduce((n, s) => n + qaConclusion(i.events, flow.id, s, tasks, i.qaReports).must, 0),
      fix_after_delivery: deliveredAt ? i.fixFlowCreated.filter((c) => Date.parse(c) >= Date.parse(deliveredAt)).length : 0,
    },
    cost: sumRuns(i.runs, now),
    cost_by_stage: costBy,
    cost_row: i.costRow ?? null,
  };
}

// —— 读取（git、磁盘、store） ——

function readJson(store: StateStore, flowId: string, task: string, name: string): unknown {
  const abs = store.abs(`${evidenceRel(flowId, task)}/${name}`);
  if (!existsSync(abs)) return undefined;
  try { return JSON.parse(readFileSync(abs, 'utf8')); } catch { return undefined; }
}
function readQaReports(store: StateStore, flowId: string, tasks: readonly TaskFile[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of tasks.filter((x) => x.kind === 'qa')) { const r = readJson(store, flowId, t.id, 'qa-report.json'); if (r !== undefined) out[t.id] = r; }
  return out;
}
/** 读集成分支上的文件；分支或文件不存在时返回 null */
function showOnBranch(root: string, branch: string, rel: string): string | null {
  try { return git(root, ['show', `refs/heads/${branch}:${rel}`], { allowFail: true }); } catch { return null; }
}
const qaDoc = (root: string, flow: FlowFile, stage: string) => showOnBranch(root, flow.integration_branch, `docs/qa/${stage}.md`);

/** §17 度量：速度、返工、质量、成本。不给 root 时读不到覆盖率矩阵，质量里的覆盖率为 null */
export function flowMetrics(store: StateStore, flowId: string, now = new Date(), root?: string): Metrics {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const coverage: Record<string, Coverage | null> = {};
  if (root) for (const s of sStageIds(flow)) { const md = qaDoc(root, flow, s); coverage[s] = md ? parseCoverageMatrix(md) : null; }
  const fixFlowCreated = store.listFlows().filter((f) => f !== flowId).flatMap((f) => { try { const x = store.readFlow(f); return x.mode === 'fix' ? [x.created_at] : []; } catch { return []; } });
  return computeMetrics({
    flow, tasks, events: store.readEvents(), runs: store.listRuns().filter((r) => r.flow === flowId),
    qaReports: readQaReports(store, flowId, tasks), coverage, fixFlowCreated, now: now.getTime(),
    costRow: costReport(store, { flow: flowId }).total,
  });
}

const fmtTokens = (n: number | null) => (n === null ? '—' : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtCost = (c: number | null) => (c === null ? '—' : `$${c.toFixed(2)}`);
const fmtMin = (m: number | null) => (m === null ? '—' : `${m} 分钟`);

export function renderRework(r: Rework): string {
  return `预检失败 ${r.precheck_failures}，审查打回 ${r.review_rejects}，合并验证失败 ${r.merge_verify_failures}，争议 ${r.disputes}，验收测试返工（.at-n）${r.acctest_rounds}，门禁修复 ${r.gate_fixes}，stage-qa 修复 ${r.qa_fixes}`;
}

export function renderMetrics(m: Metrics): string {
  const q = m.quality;
  const longest = m.tasks.filter((t) => t.run_min !== null).sort((a, b) => b.run_min! - a.run_min!).slice(0, 3).map((t) => `${t.task} ${t.run_min} 分钟`).join('、') || '—';
  return [
    `# ${m.flow} 度量`,
    '## 速度（agent 时间 = 墙钟时间 − 等你处理的时间）',
    ...(m.stages.length ? m.stages.map((s) => `- ${s.stage}：agent ${s.agent_min} 分钟 / 墙钟 ${s.wall_min} 分钟（等你 ${s.human_min}）；完成 ${s.tasks_done} 个任务${s.tasks_cancelled ? `，取消 ${s.tasks_cancelled}` : ''}；关键路径 实际 ${fmtMin(s.critical_actual_min)} / 理论 ${fmtMin(s.critical_theory_min)}${s.critical_ratio === null ? '' : `（${s.critical_ratio} 倍）`}`) : ['（还没有实施阶段）']),
    `- 任务排队等待（就绪到派发）平均 ${fmtMin(m.queue_avg_min)}；任务从派发到完成最长：${longest}`,
    `- 工作区准备 ${m.workspace.count} 次（跳过 ${m.workspace.skipped}，失败 ${m.workspace.failed}），总耗时 ${(m.workspace.total_ms / 1000).toFixed(1)} 秒，缓存命中 ${m.workspace.cache_hits} 次`,
    '## 返工',
    `- ${renderRework(m.rework)}`,
    '## 质量',
    `- AC 覆盖率 ${q.ac_coverage_pct === null ? '—' : `${q.ac_coverage_pct}%`}；验收测试 ${q.acceptance_tests} 个；stage-qa 的 must ${q.qa_must} 条；交付后的 /forge-fix ${q.fix_after_delivery} 次`,
    '## 成本',
    `- 合计：${m.cost.runs} 次运行，token ${fmtTokens(m.cost.tokens)}，金额 ${fmtCost(m.cost.cost)}，运行时间 ${min(m.cost.duration_ms)} 分钟`,
    ...(m.cost_row ? [`- ${formatRow(m.cost_row)}`] : []),
  ].join('\n');
}

// —— 签收材料 ——

const STATUS_ZH: Record<string, string> = { active: '进行中', awaiting_gate: '阶段检查中', needs_human: '需要你处理', awaiting_human: '等你签收', done: '已通过', aborted: '已中止' };

function stageBody(root: string, store: StateStore, config: FlowConfig, flow: FlowFile, stage: string, now: Date): string[] {
  const tasks = store.listTasks(flow.id);
  const mine = tasks.filter((t) => t.stage === stage);
  const live = mine.filter((t) => t.status !== 'cancelled');
  const def = flow.s_stages?.find((s) => s.id === stage);
  const m = flowMetrics(store, flow.id, now, root);
  const sp = m.stages.find((s) => s.stage === stage);
  const qa = qaConclusion(store.readEvents(), flow.id, stage, tasks, readQaReports(store, flow.id, tasks));
  const matrix = qaDoc(root, flow, stage);
  const sugg = showOnBranch(root, flow.integration_branch, 'docs/review/suggestions.md');
  const suggLines = sugg ? filterSuggestions(sugg, new Set(mine.map((t) => t.id))) : [];
  const serve = Object.entries(config.commands).filter(([k]) => /^serve(_[a-z0-9_]+)?$/.test(k));
  const ifaces = [...new Set(live.filter((t) => t.status === 'done').flatMap((t) => t.test_interface ?? []))].slice(0, 15);
  const checks = live.flatMap((t) => (t.manual_checks ?? []).map((c) => `- [ ] ${t.id}：${c}`));
  const c = m.cost_by_stage[stage] ?? sumRuns([], now.getTime());
  const cov = matrix ? parseCoverageMatrix(matrix) : null;
  return [
    '## 本阶段目标与 exit',
    `目标：${def?.goal ?? '（计划里没有记录）'}`,
    ...(def?.exit?.length ? ['exit：', ...def.exit.map((x) => `- ${x}`)] : []),
    `任务：${live.filter((t) => t.status === 'done').length} / ${live.length} 个完成${mine.length - live.length ? `，取消 ${mine.length - live.length}` : ''}`,
    '',
    '## 演示方式',
    ...(serve.length ? ['在集成分支上启动服务：', ...serve.map(([k, v]) => `- ${k}：\`${v}\``)] : ['workflow.yaml 没有配置 serve 命令；按下面的接口与测试自行验证。']),
    ...(ifaces.length ? ['本阶段对外的接口：', ...ifaces.map((x) => `- ${x}`)] : []),
    `集成分支：${flow.integration_branch}`,
    '',
    '## 需要你手动检查',
    ...(checks.length ? checks : ['（本阶段没有需要手动检查的项）']),
    '',
    '## 覆盖率矩阵（需求 → AC → 测试文件）',
    ...(matrix ? [cov && cov.total ? `覆盖 ${cov.covered} / ${cov.total}${cov.gaps.length ? `，缺口：${cov.gaps.join('、')}` : ''}` : '', matrix.trim()].filter(Boolean) : [`（没有找到 docs/qa/${stage}.md）`]),
    '',
    '## 新增建议（不阻塞合并，可挑选）',
    ...(suggLines.length ? suggLines : ['（无）']),
    '',
    '## stage-qa 结论',
    qa.qa_tasks === 0 ? '本阶段没有 stage-qa 记录。' : `must ${qa.must} 条，suggest ${qa.suggest} 条${qa.reports < qa.qa_tasks ? `（${qa.qa_tasks - qa.reports} 次验收没有可读的报告）` : ''}。`,
    qa.accepted_note !== null ? `人工放行：你用 /forge accept ${stage} --note 放行过本阶段（说明：${qa.accepted_note}）。` : '没有使用人工放行。',
    `返工：${renderRework(m.rework_by_stage[stage] ?? m.rework)}`,
    '',
    '## 耗时与成本',
    sp ? `- agent 时间 ${sp.agent_min} 分钟，墙钟 ${sp.wall_min} 分钟（其中等你处理 ${sp.human_min} 分钟）` : '- （无耗时数据）',
    ...(sp && sp.critical_ratio !== null ? [`- 关键路径：实际 ${fmtMin(sp.critical_actual_min)}，理论 ${fmtMin(sp.critical_theory_min)}（${sp.critical_ratio} 倍）`] : []),
    `- ${c.runs} 次运行，token ${fmtTokens(c.tokens)}，金额 ${fmtCost(c.cost)}，运行时间 ${min(c.duration_ms)} 分钟`,
  ];
}

function commandsFooter(flow: FlowFile, stage: string, last: boolean, main: string): string[] {
  return [
    '',
    '## 你可以做的',
    last ? `- /forge-approve：批准交付，程序把 ${flow.integration_branch} 以 --no-ff 合入 ${main}` : '- /forge-approve：批准本阶段，进入下一阶段',
    '- /forge-reject "<意见>"：打回，阶段回到 active，意见整理成规格修订',
    ...(flow.stage === stage && flow.stage_status === 'needs_human' ? [`- /forge accept ${stage} --note "<说明>"：门禁修复轮数用尽时，人工放行进入签收（也可以 /forge gate 重跑门禁）`] : []),
  ];
}

/** S 阶段的人工签收材料（Markdown，中文）。第 11 节第 5 步 */
export function stageSignoff(root: string, store: StateStore, config: FlowConfig, flowId: string, stage: string, now = new Date()): string {
  const flow = store.readFlow(flowId);
  const last = stage === sStageIds(flow).at(-1);
  const state = flow.stage === stage ? `，状态：${STATUS_ZH[flow.stage_status] ?? flow.stage_status}` : '';
  return [`# 阶段 ${stage} 签收材料（${flowId}${state}）`, '',
    ...stageBody(root, store, config, flow, stage, now), ...commandsFooter(flow, stage, last, config.raw.main_branch)].join('\n');
}

/** 交付汇报：整个流程的汇总（每个阶段的任务、取消、修复）+ §17 度量 + 最后一个 S 阶段的签收材料；批准即 --no-ff 合入主分支 */
export function deliveryReport(root: string, store: StateStore, config: FlowConfig, flowId: string, now = new Date()): string {
  const flow = store.readFlow(flowId);
  const stages = sStageIds(flow);
  const last = stages.at(-1);
  if (!last) throw new Error('流程还没有实施阶段，没有可交付的内容。');
  const tasks = store.listTasks(flowId);
  const m = flowMetrics(store, flowId, now, root);
  const main = config.raw.main_branch;
  const goals = new Map((flow.s_stages ?? []).map((s) => [s.id, s.goal]));
  return [
    `# 交付汇报（${flowId}「${flow.title}」）`,
    '',
    `批准最后一个阶段 ${last} 的签收时，程序会把 ${flow.integration_branch} 以 --no-ff 合入 ${main}，流程随之结束。`,
    '',
    '## 各阶段概况',
    ...stages.map((s) => {
      const mine = tasks.filter((t) => t.stage === s);
      const sp = m.stages.find((x) => x.stage === s);
      return `- ${s}${goals.get(s) ? `「${goals.get(s)}」` : ''}：完成 ${mine.filter((t) => t.status === 'done').length} 个任务，取消 ${mine.filter((t) => t.status === 'cancelled').length}，修复 ${mine.filter((t) => t.kind === 'fix').length} 个；agent ${sp?.agent_min ?? 0} 分钟 / 墙钟 ${sp?.wall_min ?? 0} 分钟`;
    }),
    '',
    renderMetrics(m),
    '',
    `# 最后一个阶段 ${last} 的签收材料`,
    '',
    ...stageBody(root, store, config, flow, last, now),
    ...commandsFooter(flow, last, true, main),
  ].join('\n');
}
