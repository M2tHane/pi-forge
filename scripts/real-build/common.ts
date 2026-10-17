// real-build.ts 用的纯函数与小工具：hidden.mjs 输出解析与计分、项目自带测试、会话文件的用量统计、返工与冲突计数、summary.json 的类型。
// 统计口径与 stock run-04 相同：调用、命中率、费用按会话文件逐次调用统计，按角色 + 条目 id + 时间去重
// （返工时接着原会话的 run 会把之前的会话条目复制一份，不去重会重复计数，run-02 的 worker 工具调用 1910 对去重后 1144）。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// —— 隐藏测试 ——

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

/** 解析 hidden.mjs 的输出：`## 组名（a/b）` 后跟若干 `✓ 标题` / `✗ 标题：原因`，末行 `合计：x/y` */
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
      // 失败行是 "标题：原因"，按第一个全角冒号拆
      const idx = ok ? -1 : rest.indexOf('：');
      cases.push({ group, label: idx >= 0 ? rest.slice(0, idx) : rest, ok, why: idx >= 0 ? rest.slice(idx + 1) : '' });
      continue;
    }
    if (line.startsWith('合计：')) footer = line;
  }
  return { cases, exitCode, crashed: cases.length === 0, footer, tail: output.slice(-1500) };
}

export interface HiddenScore { passed: number; total: number; groups: Record<string, { passed: number; total: number }>; failed: string[] }

/** 按组计分；失败用例写成"组名：标题" */
export function scoreHidden(r: HiddenResult): HiddenScore {
  const groups: HiddenScore['groups'] = {};
  for (const c of r.cases) {
    const g = (groups[c.group] ??= { passed: 0, total: 0 });
    g.total++;
    if (c.ok) g.passed++;
  }
  return { passed: r.cases.filter((c) => c.ok).length, total: r.cases.length, groups, failed: r.cases.filter((c) => !c.ok).map((c) => `${c.group}：${c.label}`) };
}

/** 跑 hidden.mjs；服务由 hidden.mjs 自己起停 */
export function runHidden(hidden: string, projectDir: string, timeoutMs = 15 * 60_000): Promise<HiddenResult> {
  return new Promise((resolve) => {
    const c = spawn('node', [hidden, projectDir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = '';
    c.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    c.stderr.setEncoding('utf8').on('data', (d: string) => { out += d; });
    const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('error', (e) => { clearTimeout(timer); resolve(parseHidden(`${out}\n${String(e)}`, null)); });
    c.on('close', (code) => { clearTimeout(timer); resolve(parseHidden(out, code)); });
  });
}

export const toMin = (ms: number): number => Math.round((ms / 60_000) * 10) / 10;

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

/**
 * 在独立进程组里跑项目自带测试，超时结束整个进程组（模型写的测试起了服务不退出时，
 * spawnSync 超时只结束 npm，孙进程占着输出管道，计分会一直卡住）。
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

// —— 会话文件的用量（按角色） ——

export interface SessionEntry {
  id?: string;
  timestamp?: string;
  message?: { role?: string; usage?: Record<string, unknown>; content?: unknown };
}

export interface RoleUsage {
  /** 模型调用次数（带 usage 的 assistant 消息） */
  calls: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  cost: number;
  /** 命中率 = 命中 /（输入 + 命中），百分比 */
  hit_pct: number | null;
  tool_calls: number;
  /** bash 里调用浏览器（playwright）的次数 */
  browser_cmds: number;
}

/** 目录下全部 .jsonl 会话文件的条目（递归）；目录不存在时为空 */
export function readSessionEntries(dir: string | null | undefined): SessionEntry[] {
  if (!dir || !existsSync(dir)) return [];
  const out: SessionEntry[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) for (const line of readFileSync(p, 'utf8').split('\n')) { if (line.trim()) try { out.push(JSON.parse(line) as SessionEntry); } catch { /* 写到一半的行 */ } }
    }
  };
  walk(dir);
  return out;
}

const num = (v: unknown): number => Number(v ?? 0) || 0;
const BROWSER = /pw\.js|playwright/;

/** 各角色的调用、token、费用、工具调用；同一角色里条目 id 与时间相同的只算一次 */
export function roleUsage(sources: readonly { role: string; entries: readonly SessionEntry[] }[]): Record<string, RoleUsage> {
  const seen = new Set<string>();
  const out: Record<string, RoleUsage> = {};
  for (const { role, entries } of sources) {
    for (const e of entries) {
      const m = e.message;
      if (m?.role !== 'assistant') continue;
      if (e.id !== undefined) {
        const key = `${role}\0${e.id}\0${e.timestamp ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const a = (out[role] ??= { calls: 0, input: 0, cache_read: 0, cache_write: 0, output: 0, cost: 0, hit_pct: null, tool_calls: 0, browser_cmds: 0 });
      const u = m.usage;
      if (u) {
        a.calls++;
        a.input += num(u['input']);
        a.cache_read += num(u['cacheRead']);
        a.cache_write += num(u['cacheWrite']);
        a.output += num(u['output']);
        a.cost += num((u['cost'] as { total?: number } | undefined)?.total);
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content as { type?: string; name?: string; arguments?: { command?: unknown } }[]) {
          if (c?.type !== 'toolCall') continue;
          a.tool_calls++;
          if (c.name === 'bash' && BROWSER.test(String(c.arguments?.command ?? ''))) a.browser_cmds++;
        }
      }
    }
  }
  for (const a of Object.values(out)) {
    a.cost = Math.round(a.cost * 10_000) / 10_000;
    a.hit_pct = a.input + a.cache_read > 0 ? Math.round((1000 * a.cache_read) / (a.input + a.cache_read)) / 10 : null;
  }
  return out;
}

// —— 返工、冲突、审查轮数 ——

export interface RunLite { role: string; task: string | null; started_at: string }
export interface TaskLite { id: string; kind: string }
export interface EventLite { flow?: string | null; type: string; trigger?: string | null; task?: string | null; data?: Record<string, unknown> | null }

/** 写代码的角色：返工 run 数只算它们（run-04 只有 worker；新流程是 backend、frontend，worker 留给轻流程） */
export const CODER_ROLES: readonly string[] = ['backend', 'frontend', 'worker'];

export interface RoleRuns {
  /** 有 run 的任务数（不含修复任务） */
  tasks: number;
  /** 每个任务的第一个 run */
  first_runs: number;
  /** 同一任务第一个 run 之后的 run：审查打回、合并或同步冲突、失败重试、主会话决定重做 */
  rework_runs: number;
  /** 修复任务（门禁、stage-qa、合并后回归建的 .fx 任务）的 run */
  fix_runs: number;
}

export interface ReworkStats {
  by_role: Record<string, RoleRuns>;
  /** 写代码角色的返工 run 合计（run-04 口径：首次 run 之外的返工与冲突 run） */
  rework_runs: number;
  /** 冲突退回的次数：merge_conflict（合并时）、同步集成分支时（提交前或 forge_sync）留给 agent 解决的冲突 */
  conflicts: { merge: number; sync: number };
  /** 审查任务数（每个 .rv 任务算一轮） */
  review_rounds: number;
  /** 审查轮数最多的任务 */
  review_rounds_max: { task: string; rounds: number } | null;
}

const isFix = (t: TaskLite | undefined, id: string) => t?.kind === 'fix' || t?.kind === 'merge-fix' || /\.fx/.test(id);
/** 不算返工的任务种类：审查、阶段验收、架构师咨询 */
const NOT_WORK = new Set(['review', 'qa', 'consult']);

export function reworkStats(runs: readonly RunLite[], tasks: readonly TaskLite[], events: readonly EventLite[], flowId: string): ReworkStats {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const by: Record<string, RoleRuns> = {};
  const started = new Set<string>();
  for (const r of [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    if (!r.task) continue;
    const t = byId.get(r.task);
    if (!t || NOT_WORK.has(t.kind)) continue;
    if (r.role !== 'architect' && !CODER_ROLES.includes(r.role)) continue;
    const s = (by[r.role] ??= { tasks: 0, first_runs: 0, rework_runs: 0, fix_runs: 0 });
    if (isFix(t, r.task)) { s.fix_runs++; continue; }
    const key = `${r.role}\0${r.task}`;
    if (started.has(key)) s.rework_runs++;
    else { started.add(key); s.tasks++; s.first_runs++; }
  }
  const trig = (name: string) => events.filter((e) => e.flow === flowId && e.type === 'transition' && e.trigger === name).length;
  const reviews = tasks.filter((t) => t.kind === 'review');
  const perTask = new Map<string, number>();
  for (const t of reviews) { const orig = t.id.replace(/\.rv(?:-\d+)?$/, ''); perTask.set(orig, (perTask.get(orig) ?? 0) + 1); }
  let max: ReworkStats['review_rounds_max'] = null;
  for (const [task, rounds] of perTask) if (!max || rounds > max.rounds) max = { task, rounds };
  return {
    by_role: by,
    rework_runs: CODER_ROLES.reduce((n, r) => n + (by[r]?.rework_runs ?? 0), 0),
    conflicts: { merge: trig('merge_conflict'), sync: events.filter((e) => e.flow === flowId && (e.trigger === 'sync_conflict' || e.data?.['kind'] === 'sync_conflict')).length },
    review_rounds: reviews.length,
    review_rounds_max: max,
  };
}

// —— summary.json ——

export type RunStatus = 'delivered' | 'flow_failed' | 'infra_failed' | 'stopped_early';

export interface StageTime {
  stage: string;
  /** 墙钟时间（含等用户的时间） */
  wall_min: number;
  /** 等用户（awaiting_human、needs_human）的时间：脚本扮演用户，只有轮询的几秒 */
  human_min: number;
}

export interface Summary {
  schema: 2;
  run_id: string;
  started_at: string;
  ended_at: string;
  pi_version: string;
  pi_forge_sha: string | null;
  pi_forge_dirty: boolean | null;
  suite: string;
  models: Record<string, string>;
  thinking: Record<string, string>;
  max_parallel_backend: number | null;
  status: RunStatus;
  failure: { kind: string; reason: string } | null;
  flow: string | null;
  /** /forge-build 发出到交付（或结束）的墙钟时间 */
  wall_min: number;
  stages: StageTime[];
  hidden: HiddenScore | null;
  project_tests: TestSummary | null;
  interventions: { gates: number; extra: Record<string, number>; extra_total: number };
  usage: { by_role: Record<string, RoleUsage>; cost: number };
  rework: ReworkStats | null;
  notes: string[];
}
