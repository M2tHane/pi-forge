// M9 脚本共用的纯函数与小工具（docs/M9-PLAN.md 第 3、5 节）：
// hidden.mjs 输出解析与计分、回归、agent 时间、问句识别、项目自带测试的结果解析、summary.json 的类型。
// real-build.ts 与 native.ts 都写同一种 summary.json，score.ts 汇总它。
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { stageDurations } from '../../src/core/stage/signoff.ts';
import type { FlowEvent, FlowFile } from '../../src/core/state/schemas.ts';

// —— 隐藏测试 ——

/** "非法 JSON 返回 400"超出需求，不计分；基础满分 39，变更 6 */
export const UNSCORED_LABELS: readonly string[] = ['非法 JSON 返回 400'];
export const BASE_TOTAL = 39;
export const CHANGE_TOTAL = 6;

export interface HiddenCase { group: string; label: string; ok: boolean; why: string }
export interface HiddenResult {
  cases: HiddenCase[];
  exitCode: number | null;
  /** 没解析出任何用例：服务没起来或脚本崩溃，按全部失败计 */
  crashed: boolean;
  footer: string | null;
  /** 原始输出的末尾（排查用） */
  tail: string;
}

/** 解析 hidden.mjs 的输出：`## 组名（a/b）` 后跟若干 `✓ 标题` / `✗ 标题：原因`，末行 `合计：基础 a/b，变更 c/d` */
export function parseHidden(output: string, exitCode: number | null = 0): HiddenResult {
  const cases: HiddenCase[] = [];
  let group = '';
  let footer: string | null = null;
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const g = /^##\s+(.+?)（\d+\/\d+）\s*$/.exec(line);
    if (g) { group = g[1]!; continue; }
    const c = /^([✓✗])\s+(.*)$/.exec(line);
    if (c) {
      const ok = c[1] === '✓';
      const rest = c[2]!;
      // 失败行是 "标题：原因"；标题里本身可能有冒号（"变更：归档"只出现在组名里，用例标题里的冒号少见），按第一个全角冒号拆
      const idx = ok ? -1 : rest.indexOf('：');
      cases.push({ group, label: idx >= 0 ? rest.slice(0, idx) : rest, ok, why: idx >= 0 ? rest.slice(idx + 1) : '' });
      continue;
    }
    if (line.startsWith('合计：')) footer = line;
  }
  return { cases, exitCode, crashed: cases.length === 0, footer, tail: output.slice(-1500) };
}

const isChangeCase = (c: HiddenCase) => c.group.startsWith('变更');
const scored = (c: HiddenCase) => !UNSCORED_LABELS.includes(c.label);

export interface RunScore {
  base: { passed: number; total: number; observed: number };
  change: { passed: number; total: number; observed: number } | null;
  /** 基础 + 变更 */
  total: number;
  /** 变更后变成失败的基础用例标题 */
  regressed: string[];
  regression: number;
  /** 变更阶段是否有结果可比（false：没交付变更，回归记 0） */
  change_ran: boolean;
  failed_base: string[];
  failed_change: string[];
}

/**
 * 计分。build：新建交付后在 main 上跑的结果；change：变更交付后跑 `--change` 的结果（没跑为 null）。
 * 基础分取新建那次；变更分取变更那次的"变更"组；回归 = 新建后通过、变更后（--change 那次的基础用例）失败的个数。
 * 变更那次崩溃（服务没起来）时，新建通过的用例全部算回归。
 */
export function scoreRun(build: HiddenResult | null, change: HiddenResult | null): RunScore {
  const baseCases = (build?.cases ?? []).filter((c) => !isChangeCase(c) && scored(c));
  const basePassed = baseCases.filter((c) => c.ok);
  const changeRunBase = (change?.cases ?? []).filter((c) => !isChangeCase(c) && scored(c));
  const changeCases = (change?.cases ?? []).filter((c) => isChangeCase(c) && scored(c));
  const regressed = change
    ? basePassed.filter((p) => !changeRunBase.some((c) => c.label === p.label && c.ok)).map((c) => c.label)
    : [];
  const baseScore = basePassed.length;
  const changeScore = changeCases.filter((c) => c.ok).length;
  return {
    base: { passed: baseScore, total: BASE_TOTAL, observed: baseCases.length },
    change: change ? { passed: changeScore, total: CHANGE_TOTAL, observed: changeCases.length } : null,
    total: baseScore + changeScore,
    regressed,
    regression: regressed.length,
    change_ran: !!change,
    failed_base: baseCases.filter((c) => !c.ok).map((c) => c.label),
    failed_change: changeCases.filter((c) => !c.ok).map((c) => c.label),
  };
}

/** 跑 hidden.mjs；`change` 为 true 时加 --change。服务由 hidden.mjs 自己起停 */
export function runHidden(hidden: string, projectDir: string, change: boolean, timeoutMs = 15 * 60_000): Promise<HiddenResult> {
  return new Promise((resolve) => {
    const c = spawn('node', [hidden, projectDir, ...(change ? ['--change'] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = '';
    c.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    c.stderr.setEncoding('utf8').on('data', (d: string) => { out += d; });
    const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('error', (e) => { clearTimeout(timer); resolve(parseHidden(`${out}\n${String(e)}`, null)); });
    c.on('close', (code) => { clearTimeout(timer); resolve(parseHidden(out, code)); });
  });
}

// —— agent 时间（第 5.1 节） ——

export type Interval = readonly [number, number];

/** 区间并集的总长度（毫秒），先裁剪到 [lo, hi] */
export function unionMs(intervals: readonly Interval[], lo = -Infinity, hi = Infinity): number {
  const xs = intervals.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const x of xs) {
    if (!cur) cur = [...x];
    else if (x[0] <= cur[1]) cur[1] = Math.max(cur[1], x[1]);
    else { total += cur[1] - cur[0]; cur = [...x]; }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

type EventLike = Pick<FlowEvent, 'flow' | 'ts' | 'task' | 'from' | 'to' | 'data'>;

/** 事件日志里 task 处于 blocked 的区间（每个 task 可有多段；到 endMs 还没解除的算到 endMs） */
export function blockedIntervals(events: readonly EventLike[], flowId: string, endMs: number): Interval[] {
  const open = new Map<string, number>();
  const out: [number, number][] = [];
  for (const e of events) {
    if (e.flow !== flowId || !e.task || !e.to || e.data?.['entity'] === 'stage' || e.data?.['entity'] === 'flow') continue;
    const at = Date.parse(e.ts);
    if (e.to === 'blocked') { if (!open.has(e.task)) open.set(e.task, at); }
    else if (open.has(e.task)) { out.push([open.get(e.task)!, at]); open.delete(e.task); }
  }
  for (const start of open.values()) out.push([start, endMs]);
  return out;
}

/** 流程到达 done 的时刻（最后一个转入 done 的阶段事件）；没有为 null */
/** 流程交付的时刻：最后一个阶段转为 done（P0、P1 等前面阶段的 done 不算） */
export function flowDoneMs(events: readonly EventLike[], flowId: string, lastStage: string): number | null {
  let at: number | null = null;
  for (const e of events) if (e.flow === flowId && e.data?.['entity'] === 'stage' && e.data['stage'] === lastStage && e.to === 'done') at = Date.parse(e.ts);
  return at;
}

export interface AgentTime {
  wall_ms: number;
  /** 流程处于 awaiting_human / needs_human 的时长（与 /forge-status --metrics 同口径） */
  human_ms: number;
  /** task 处于 blocked 等人回答的时长（事件日志） */
  blocked_ms: number;
  /** P0 里主会话等待回答的时长（脚本记录） */
  p0_ms: number;
  /** wall − human − blocked − p0 */
  agent_ms: number;
  /** /forge-status --metrics 的口径：各阶段 wall − human（不扣 blocked 与 P0 等待），用来核对 */
  metrics_agent_ms: number;
}

/**
 * 一次 /forge-build 的 agent 时间。startMs 是发出命令的时刻；endMs 取流程到达 done 的时刻（没有就用 fallbackEndMs）。
 * 轮询状态的几秒落在 awaiting_human / blocked 区间里，已一并扣除。
 */
export function agentTime(events: readonly FlowEvent[], flow: Pick<FlowFile, 'id' | 'stages' | 'created_at'>, startMs: number, fallbackEndMs: number, p0Intervals: readonly Interval[]): AgentTime {
  const endMs = flowDoneMs(events, flow.id, flow.stages.at(-1)!) ?? fallbackEndMs;
  const wall = Math.max(0, endMs - startMs);
  const dur = stageDurations(events, flow.id, flow.stages[0]!, flow.created_at, endMs);
  let human = 0;
  let metricsAgent = 0;
  for (const d of dur.values()) { human += d.human_ms; metricsAgent += Math.max(0, d.wall_ms - d.human_ms); }
  const blocked = unionMs(blockedIntervals(events, flow.id, endMs), startMs, endMs);
  const p0 = unionMs(p0Intervals, startMs, endMs);
  return { wall_ms: wall, human_ms: human, blocked_ms: blocked, p0_ms: p0, agent_ms: Math.max(0, wall - human - blocked - p0), metrics_agent_ms: metricsAgent };
}

/** N 组：墙钟减去脚本代答的间隔（一轮结束到下一轮发出之间的时间） */
export function nativeAgentMs(startMs: number, endMs: number, answerGaps: readonly Interval[]): number {
  return Math.max(0, endMs - startMs - unionMs(answerGaps, startMs, endMs));
}

export const toMin = (ms: number): number => Math.round((ms / 60_000) * 100) / 100;

// —— 问句识别（N 组；第 4 节"原生 Pi 停下提问"） ——

/** 最后一条消息以问句结尾，或含"请确认""是否需要"等 */
export function looksLikeQuestion(text: string): boolean {
  const tail = text.slice(-300);
  return /[？?]\s*$|请确认|是否需要|要不要|你希望|请告诉我|需要我|please confirm|would you like|do you want/i.test(tail);
}

// —— 项目自带测试 ——

export interface TestSummary { exit_code: number | null; passed: number | null; failed: number | null; tail: string }

/** 从测试输出里读通过/失败数：node:test（`# pass N` / `# fail N`）、vitest/jest（`Tests  1 failed | 5 passed`、`Tests: 1 failed, 5 passed`） */
export function parseTestSummary(output: string, exitCode: number | null): TestSummary {
  const pick = (re: RegExp) => { const m = re.exec(output); return m ? Number(m[1]) : null; };
  let passed = pick(/^# pass (\d+)/m);
  let failed = pick(/^# fail (\d+)/m);
  if (passed === null && failed === null) {
    passed = pick(/(\d+) passed/);
    failed = pick(/(\d+) failed/);
    if (passed !== null || failed !== null) failed = failed ?? 0;
  }
  return { exit_code: exitCode, passed, failed, tail: output.slice(-800) };
}

// —— summary.json ——

export type RunStatus = 'delivered' | 'flow_failed' | 'infra_failed' | 'stopped_early';

export interface PhaseSummary {
  /** 阶段名：build / change */
  name: 'build' | 'change';
  flow: string | null;
  delivered: boolean;
  wall_min: number;
  human_wait_min: number;
  blocked_wait_min: number;
  p0_wait_min: number;
  agent_min: number;
  /** /forge-status --metrics 口径的 agent 时间，用来核对 */
  metrics_agent_min: number | null;
  /** 两种算法差超过 2 分钟 */
  metrics_diff_over_2min: boolean;
}

export interface Summary {
  schema: 1;
  arm: 'N' | 'A0' | 'A1';
  run_id: string;
  started_at: string;
  ended_at: string;
  pi_version: string;
  pi_forge_sha: string | null;
  pi_forge_dirty: boolean | null;
  models: Record<string, string>;
  thinking: Record<string, string>;
  status: RunStatus;
  failure: { kind: string; reason: string } | null;
  /** 总 agent 时间（新建 + 变更，分钟）。流程失败按上限计：time_charged_min */
  agent_min: number;
  time_charged_min: number;
  phases: PhaseSummary[];
  hidden: { build: HiddenResult | null; change: HiddenResult | null };
  score: RunScore;
  project_tests: { after_build: TestSummary | null; after_change: TestSummary | null };
  interventions: {
    p0_questions: number;
    p0_text_turns: number;
    p0_text_numbered: number;
    gates: number;
    extra: Record<string, number>;
    extra_total: number;
  };
  usage: Record<string, number | null>;
  notes: string[];
}

/** 会话目录下全部会话文件的 token 用量（主会话与子会话） */
export function sessionUsage(dir: string): Record<string, number | null> {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); } };
  walk(dir);
  const sum = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, turns: 0 };
  for (const f of files) {
    if (!statSync(f).isFile()) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o: { message?: { role?: string; usage?: Record<string, unknown> } };
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (m?.role !== 'assistant' || !m.usage) continue;
      sum.turns++;
      sum.input += Number(m.usage['input'] ?? 0) || 0;
      sum.output += Number(m.usage['output'] ?? 0) || 0;
      sum.cache_read += Number(m.usage['cacheRead'] ?? 0) || 0;
      sum.cache_write += Number(m.usage['cacheWrite'] ?? 0) || 0;
      sum.cost += Number((m.usage['cost'] as { total?: number } | undefined)?.total ?? 0) || 0;
    }
  }
  return { session_files: files.length, ...sum };
}

/**
 * 在独立进程组里跑项目自带测试，超时结束整个进程组（M9 冒烟：模型写的测试起了服务不退出，
 * spawnSync 超时只结束 npm，孙进程占着输出管道，计分一直卡住）。
 */
export function runProjectTests(cwd: string, timeoutMs = 5 * 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn('npm', ['test', '--silent'], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out: out.slice(-200_000) }); };
    c.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d; });
    c.stderr!.setEncoding('utf8').on('data', (d: string) => { out += d; });
    const timer = setTimeout(() => {
      out += `\n[超过 ${Math.round(timeoutMs / 1000)} 秒，结束测试进程组]`;
      try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* 已退出 */ }
      finish(null);
    }, timeoutMs);
    c.on('exit', (code) => { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* 进程组已空 */ } finish(code); });
  });
}
