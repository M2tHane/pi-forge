// 来源：pi-flow scripts/baseline-build.ts @ 31f3f15（经 pi-forge scripts/baseline-build.ts 改编）
// M9 的 N 组：不加载 pi-forge，用原生 pi 在单会话里从零做同一个项目，再在同一会话里提需求变更。
//   node scripts/m9/native.ts --prd <requirement.md> --then-file <change.md> --hidden <hidden.mjs>
//        [--out <目录>] [--model magpie/zcode/GLM-5.3-Flash] [--thinking high] [--max-min 90] [--stuck-min 30]
//        [--ext <扩展>]... [--no-plugins]
// - 需求文件原文作为第一条消息；它停下提问时（问句识别见 common.ts）回"同意你给出的建议（默认方案），按建议继续。"，每个阶段最多 3 次。
// - 计时：从第一条消息发出到最后一轮结束，扣掉脚本代答的间隔；新建与变更分开算。
// - 看门狗：总时长 max-min（默认 90）；会话 stuck-min（默认 30）分钟没有新的 JSON 事件。超时或卡住就停掉进程，用当时的代码计分，时间按上限计。
// - 计分：新建完成后跑 hidden.mjs，变更完成后跑 hidden.mjs --change（同一个目录原地改，没有 main 分支）；输出与 real-build.ts 同格式的 summary.json。
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  looksLikeQuestion, nativeAgentMs, parseTestSummary, runHidden, scoreRun, toMin,
  type HiddenResult, type Interval, type PhaseSummary, type RunStatus, type Summary, type TestSummary,
} from './common.ts';

export const EXPECTED_PI_VERSION = '1.1.0';
export const ANSWER = '同意你给出的建议（默认方案），按建议继续。';
export const MAX_ANSWERS_PER_PHASE = 3;

export interface NativeOptions {
  prd: string; thenFile: string; hidden: string | null; out: string | null;
  model: string; thinking: string; maxMin: number; stuckMin: number; ext: string[]; plugins: boolean;
}

export function parseArgs(argv: string[]): NativeOptions {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (k: string) => { const v = get(k); if (!v) throw new Error(`缺少 ${k}`); return path.resolve(v); };
  return {
    prd: need('--prd'), thenFile: need('--then-file'),
    hidden: get('--hidden') ? path.resolve(get('--hidden')!) : null,
    out: get('--out') ? path.resolve(get('--out')!) : null,
    model: get('--model') ?? 'magpie/zcode/GLM-5.3-Flash', thinking: get('--thinking') ?? 'high',
    maxMin: Number(get('--max-min') ?? 90), stuckMin: Number(get('--stuck-min') ?? 30),
    ext: argv.flatMap((a, i) => (a === '--ext' && argv[i + 1] ? [path.resolve(argv[i + 1]!)] : [])),
    plugins: !argv.includes('--no-plugins'),
  };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const gitTry = (cwd: string, args: string[]): string | null => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };

interface Round { phase: 'build' | 'change'; index: number; startMs: number; endMs: number; killed: string | null }

export async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const piVersion = execFileSync('pi', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!piVersion.includes(EXPECTED_PI_VERSION)) throw new Error(`Pi 版本必须是 ${EXPECTED_PI_VERSION}（当前 ${piVersion}）`);
  const prdText = readFileSync(o.prd, 'utf8').trim();
  const thenText = readFileSync(o.thenFile, 'utf8').trim();
  // 插件：沿用原生对照组的做法，--no-extensions 之后用 -e 显式加载
  const agentDir = process.env['PI_CODING_AGENT_DIR'] ?? path.join(homedir(), '.pi/agent');
  const pluginRoot = path.join(agentDir, 'npm/node_modules');
  const plugins = o.plugins ? ['@bacnh85/pi-serena', '@vndv/pi-codegraph', 'pi-subagents'].map((p) => path.join(pluginRoot, p)) : [];
  for (const e of plugins) if (!existsSync(e)) throw new Error(`缺少插件：${e}`);

  let out = o.out;
  if (!out) {
    const base = path.join(homedir(), 'pi-forge-runs', 'm9');
    mkdirSync(base, { recursive: true });
    out = path.join(base, `N-${String(readdirSync(base).filter((d) => d.startsWith('N-')).length + 1).padStart(2, '0')}-${stamp()}`);
  }
  const project = path.join(out, 'project');
  const sessionDir = path.join(out, 'session');
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const rawDir = path.join(out, 'stdout');
  mkdirSync(rawDir, { recursive: true });
  const runId = path.basename(out);
  const startedAt = new Date();
  const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  const sh = (cmd: string, a: string[]) => execFileSync(cmd, a, { cwd: project, encoding: 'utf8' }).trim();
  sh('git', ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(project, 'package.json'), '{ "name": "m9-project", "version": "0.0.0", "private": true }\n');
  sh('git', ['add', '.']);
  sh('git', ['-c', 'user.name=m9', '-c', 'user.email=m9@local', 'commit', '-q', '-m', '空项目']);
  log(`输出目录：${out}\nPi ${piVersion}；模型 ${o.model}（${o.thinking}）；插件：${plugins.map((p) => path.basename(p)).join('、') || '无'}`);

  const qa: { ts: string; phase: string; question_tail: string; answer: string }[] = [];
  const rounds: Round[] = [];
  let current: ChildProcess | null = null;
  let failure: { kind: string; reason: string; status: RunStatus } | null = null as { kind: string; reason: string; status: RunStatus } | null;
  let scoringMs = 0;
  const runStart = Date.now();
  const state = { interrupted: false };
  const killGroup = (c: ChildProcess | null, sig: NodeJS.Signals) => { if (!c?.pid) return; try { process.kill(-c.pid, sig); } catch { try { c.kill(sig); } catch { /* 已退出 */ } } };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { state.interrupted = true; killGroup(current, 'SIGTERM'); setTimeout(() => process.exit(130), 10_000).unref(); });
  }

  /** 跑一轮 pi（JSON 模式，-c 接着上一轮的会话）；返回最后一条 assistant 文本。看门狗在这里 */
  function round(prompt: string, cont: boolean, phase: 'build' | 'change', index: number): Promise<string> {
    const args = ['--mode', 'json', '-p', '--session-dir', sessionDir, ...(cont ? ['-c'] : []), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      ...plugins.flatMap((e) => ['-e', e]), ...o.ext.flatMap((e) => ['-e', e]), '--model', o.model, '--thinking', o.thinking, '--', prompt];
    return new Promise((resolve) => {
      const r: Round = { phase, index, startMs: Date.now(), endMs: 0, killed: null };
      const c = spawn('pi', args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' } });
      current = c;
      const decoder = new StringDecoder('utf8');
      let buf = '';
      let last = '';
      let lastEventAt = Date.now();
      const raw = path.join(rawDir, `${phase}-${index}.jsonl`); // 不能放进 --session-dir：-c 会把里面最新的 .jsonl 当成会话接着写
      writeFileSync(raw, '');
      c.stdout!.on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk);
        appendFileSync(raw, text);
        buf += text;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          lastEventAt = Date.now();
          try {
            const ev = JSON.parse(line) as { type?: string; toolName?: string; message?: { role?: string; content?: { type: string; text?: string }[] } };
            if (ev.type === 'tool_execution_start') log(`  ${ev.toolName}`);
            if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
              const t = (ev.message.content ?? []).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('').trim();
              if (t) last = t;
            }
          } catch { /* 非 JSON 行 */ }
        }
      });
      c.stderr!.setEncoding('utf8').on('data', (d: string) => process.stderr.write(d));
      const timer = setInterval(() => {
        const elapsed = Date.now() - runStart - scoringMs;
        if (elapsed > o.maxMin * 60_000) r.killed = 'timeout';
        else if (Date.now() - lastEventAt > o.stuckMin * 60_000) r.killed = 'stuck';
        if (r.killed || state.interrupted) {
          killGroup(c, 'SIGTERM');
          setTimeout(() => killGroup(c, 'SIGKILL'), 5000).unref();
        }
      }, 5000);
      c.on('close', (code) => {
        clearInterval(timer);
        current = null;
        r.endMs = Date.now();
        rounds.push(r);
        if (r.killed) failure ??= { kind: r.killed, reason: r.killed === 'timeout' ? `超过硬上限 ${o.maxMin} 分钟` : `会话 ${o.stuckMin} 分钟没有新的 JSON 事件`, status: 'flow_failed' };
        else if (state.interrupted) failure ??= { kind: 'interrupted', reason: '收到中断信号', status: 'stopped_early' };
        else if (code !== 0) failure ??= { kind: 'pi_exit', reason: `pi 退出码 ${code}；需人工判断是否基础设施问题`, status: 'infra_failed' };
        resolve(last);
      });
    });
  }

  /** 一个阶段：发消息，停下提问就代答，最多 3 次 */
  async function phase(name: 'build' | 'change', text: string, cont: boolean): Promise<void> {
    let last = await round(text, cont, name, 0);
    for (let i = 1; i <= MAX_ANSWERS_PER_PHASE && !failure && looksLikeQuestion(last); i++) {
      log(`它在提问，代答：${ANSWER}`);
      qa.push({ ts: new Date().toISOString(), phase: name, question_tail: last.slice(-300), answer: ANSWER });
      appendFileSync(path.join(out!, 'qa.jsonl'), `${JSON.stringify(qa.at(-1))}\n`);
      last = await round(ANSWER, true, name, i);
    }
  }

  const phases: { name: 'build' | 'change'; hidden: HiddenResult | null; tests: TestSummary | null; scoredOn: string | null }[] = [];
  const scorePhase = async (name: 'build' | 'change'): Promise<void> => {
    const t0 = Date.now();
    const rec = { name, hidden: null as HiddenResult | null, tests: null as TestSummary | null, scoredOn: gitTry(project, ['rev-parse', 'HEAD']) };
    if (o.hidden) {
      log(`跑隐藏测试（${name}）…`);
      rec.hidden = await runHidden(o.hidden, project, name === 'change');
      writeFileSync(path.join(out!, `hidden-${name}.json`), `${JSON.stringify({ phase: name, head: rec.scoredOn, uncommitted_files: (gitTry(project, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length, result: rec.hidden }, null, 2)}\n`);
    }
    const t = spawnSync('npm', ['test', '--silent'], { cwd: project, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    rec.tests = parseTestSummary(`${t.stdout ?? ''}${t.stderr ?? ''}`, t.status);
    phases.push(rec);
    scoringMs += Date.now() - t0;
  };

  const t0 = Date.now();
  await phase('build', prdText, false);
  const buildRounds = rounds.filter((r) => r.phase === 'build');
  const buildEnd = buildRounds.at(-1)?.endMs ?? Date.now();
  await scorePhase('build');
  let changeStart = 0;
  let changeEnd = 0;
  if (!failure && !state.interrupted) {
    log(`第一版完成（${toMin(buildEnd - t0)} 分钟），提出需求变更`);
    changeStart = Date.now();
    await phase('change', thenText, true);
    changeEnd = rounds.filter((r) => r.phase === 'change').at(-1)?.endMs ?? Date.now();
    await scorePhase('change');
  }

  // 摘要
  const gaps = (name: 'build' | 'change'): Interval[] => {
    const rs = rounds.filter((r) => r.phase === name);
    return rs.slice(1).map((r, i) => [rs[i]!.endMs, r.startMs] as const);
  };
  const phaseSummaries: PhaseSummary[] = [];
  const mk = (name: 'build' | 'change', s: number, e: number): void => {
    const g = gaps(name);
    const gapMs = g.reduce((a, [x, y]) => a + (y - x), 0);
    const agent = nativeAgentMs(s, e, g);
    phaseSummaries.push({ name, flow: null, delivered: !failure, wall_min: toMin(e - s), human_wait_min: 0, blocked_wait_min: 0, p0_wait_min: toMin(gapMs), agent_min: toMin(agent), metrics_agent_min: null, metrics_diff_over_2min: false });
  };
  mk('build', t0, buildEnd);
  if (changeStart) mk('change', changeStart, changeEnd);
  const agentMin = Math.round(phaseSummaries.reduce((a, p) => a + p.agent_min, 0) * 100) / 100;
  const fail = failure as { kind: string; reason: string; status: RunStatus } | null;
  const status: RunStatus = fail ? fail.status : 'delivered';
  const usage = sessionUsage(sessionDir);
  const bHidden = phases.find((p) => p.name === 'build')?.hidden ?? null;
  const cHidden = phases.find((p) => p.name === 'change')?.hidden ?? null;
  const answersBuild = qa.filter((q) => q.phase === 'build').length;
  const answersChange = qa.filter((q) => q.phase === 'change').length;
  const summary: Summary = {
    schema: 1, arm: 'N', run_id: runId, started_at: startedAt.toISOString(), ended_at: new Date().toISOString(),
    pi_version: piVersion, pi_forge_sha: null, pi_forge_dirty: null,
    models: { main: o.model }, thinking: { main: o.thinking },
    status, failure: fail ? { kind: fail.kind, reason: fail.reason } : null,
    agent_min: agentMin,
    // 方案 6.1：卡住或超过上限时，时间按上限计入
    time_charged_min: status === 'flow_failed' ? o.maxMin : agentMin,
    phases: phaseSummaries,
    hidden: { build: bHidden, change: cHidden },
    score: scoreRun(bHidden, cHidden),
    project_tests: { after_build: phases.find((p) => p.name === 'build')?.tests ?? null, after_change: phases.find((p) => p.name === 'change')?.tests ?? null },
    // N 组的"P0 问题数"按轮计（第 4 节）：所有代答的轮数；新建与变更阶段的分别写在备注里
    interventions: { p0_questions: qa.length, p0_text_turns: qa.length, p0_text_numbered: 0, gates: 0, extra: {}, extra_total: 0 },
    usage,
    notes: [`代答 ${qa.length} 次（新建 ${answersBuild}，变更 ${answersChange}）`, ...(o.hidden ? [] : ['没有给 --hidden，未计分'])],
  };
  writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(`完成：${status}；基础 ${summary.score.base.passed}/${summary.score.base.total}，变更 ${summary.score.change ? `${summary.score.change.passed}/${summary.score.change.total}` : '—'}，回归 ${summary.score.regression}，agent 时间 ${agentMin} 分钟`);
  return status === 'delivered' ? 0 : 1;
}

/** 会话目录下所有会话文件（主会话与子会话）的 token 与金额合计 */
function sessionUsage(dir: string): Record<string, number | null> {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); });
}
