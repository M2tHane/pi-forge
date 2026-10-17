// RPC 模式的 M9 实验驱动。
// 用法：
//   node scripts/real-build.ts --arm A0|A1 --prd <requirement.md> [--change <change.md>] [--hidden <hidden.mjs>]
//        [--out <目录>] [--max-min 240] [--stuck-min 30] [--planner-model ..] [--planner-thinking medium] [--max-parallel N]
//        [--coder-model ..] [--coder-thinking high] [--main-model ..] [--ext <扩展>]... [--poll-sec 5] [--stop-after-gates N]
// 做的事（M9 实验方案，原 docs/M9-PLAN.md，已删除，见 git 历史）：
//   建空仓库 → /forge init → 写实验配置（按角色设模型与思考级别、关闭升级、A1 关闭 test-author）→ 用 `pi --mode rpc` 拉起主会话
//   → /forge-build --prd → 把 extension_ui_request 与 .forge/ 状态交给 simulator.ts 的规则表 → 交付后 /forge-build --feature --prd
//   → 看门狗（卡住、上限）→ 在 main 上跑隐藏测试 → 留档（interventions.jsonl、rpc.jsonl、hidden-*.json、metrics-*.txt、summary.json）。
// 脚本只读 .forge/，不改状态；所有改状态的动作都是发给主会话的命令。
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { loadConfig } from '../src/core/state/config.ts';
import { stageDelegated } from '../src/core/engine/decisions.ts';
import { activePauses } from '../src/core/engine/model-pause.ts';
import { renderDetail } from '../src/core/ops/status-detail.ts';
import { flowMetrics, renderMetrics } from '../src/core/stage/signoff.ts';
import { sessionsRoot } from '../src/core/engine/session-log.ts';
import { StateStore } from '../src/core/state/state-store.ts';
import { packageRoots, pluginExtensionsFor } from '../src/pi-adapter/plugins.ts';
import {
  agentTime, parseTestSummary, runHidden, runProjectTests, scoreRun, sessionUsage, toMin,
  type HiddenResult, type PhaseSummary, type RunStatus, type Summary, type TestSummary,
} from './real-build/common.ts';
import { RpcProcess, type RpcRecord } from './real-build/rpc.ts';
import { apply, decide, extraTotal, initialState, type Action, type Snapshot, type SimState, type UiRequest } from './real-build/user.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION = path.join(ROOT, 'src/pi-adapter/extension.ts');
export const EXPECTED_PI_VERSION = '1.1.0';

// —— 参数 ——

export interface Options {
  arm: 'A0' | 'A1';
  prd: string;
  /** 交付后再跑的变更需求；不给就只跑新建 */
  change: string | null;
  hidden: string | null;
  out: string | null;
  maxMin: number;
  stuckMin: number;
  plannerModel: string;
  plannerThinking: string;
  coderModel: string;
  coderThinking: string;
  mainModel: string;
  ext: string[];
  pollSec: number;
  stopAfterGates: number | null;
  /** 只做冒烟：在 --out 里已交付的项目上只跑变更阶段（不计入结果）；有未完成的 feature 流程时接着它 */
  changeOnly: boolean;
  /** limits.max_parallel（同时运行的 impl task 数）；不给就用模板的值 */
  maxParallel: number | null;
}

export function parseArgs(argv: string[]): Options {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const all = (k: string): string[] => argv.flatMap((a, i) => (a === k && argv[i + 1] ? [argv[i + 1]!] : []));
  const arm = get('--arm');
  if (arm !== 'A0' && arm !== 'A1') throw new Error('--arm 必须是 A0 或 A1');
  const need = (k: string) => { const v = get(k); if (!v) throw new Error(`缺少 ${k}`); return path.resolve(v); };
  const plannerModel = get('--planner-model') ?? 'magpie/codex/gpt-6.1-sol';
  if (argv.includes('--change-only') && !get('--change')) throw new Error('--change-only 需要 --change');
  return {
    arm, prd: need('--prd'), change: get('--change') ? path.resolve(get('--change')!) : null,
    hidden: get('--hidden') ? path.resolve(get('--hidden')!) : null,
    out: get('--out') ? path.resolve(get('--out')!) : null,
    maxMin: Number(get('--max-min') ?? 240), stuckMin: Number(get('--stuck-min') ?? 30),
    plannerModel, plannerThinking: get('--planner-thinking') ?? 'medium',
    coderModel: get('--coder-model') ?? 'magpie/zcode/GLM-5.3-Flash', coderThinking: get('--coder-thinking') ?? 'high',
    mainModel: get('--main-model') ?? plannerModel,
    ext: all('--ext').map((e) => path.resolve(e)),
    pollSec: Number(get('--poll-sec') ?? 5),
    stopAfterGates: get('--stop-after-gates') ? Number(get('--stop-after-gates')) : null,
    changeOnly: argv.includes('--change-only'),
    maxParallel: get('--max-parallel') ? Number(get('--max-parallel')) : null,
  };
}

// —— 实验配置 ——

export const PLANNER_ROLES = ['orchestrator', 'architect', 'reviewer', 'stage-qa'] as const;
export const CODER_ROLES = ['worker', 'test-author'] as const;

/**
 * 在 workflow.yaml 上写实验配置：按角色设模型与思考级别（新增 planner / coder 两个档位，角色的 model 指向档位，
 * thinking 写在角色上——这是 workflow.yaml 本来支持的方式，不动 ~/.pi/agent/pi-forge.json），escalation.enabled=false，A1 关闭 test-author。
 * 用 yaml 的 Document 改，保留模板里的注释与行内写法。
 */
export function applyExperimentConfig(yamlText: string, o: Pick<Options, 'arm' | 'plannerModel' | 'plannerThinking' | 'coderModel' | 'coderThinking'> & { maxParallel?: number | null }): string {
  const doc = parseDocument(yamlText);
  doc.setIn(['models', 'planner'], o.plannerModel);
  doc.setIn(['models', 'coder'], o.coderModel);
  // 旧档位也指向实验用的模型，避免留下占位符
  doc.setIn(['models', 'strong'], o.plannerModel);
  doc.setIn(['models', 'medium'], o.plannerModel);
  doc.setIn(['models', 'cheap'], o.coderModel);
  for (const r of PLANNER_ROLES) { doc.setIn(['roles', r, 'model'], 'planner'); doc.setIn(['roles', r, 'thinking'], o.plannerThinking); }
  for (const r of CODER_ROLES) { if (!doc.hasIn(['roles', r])) continue; /* 模板不再定义 test-author */ doc.setIn(['roles', r, 'model'], 'coder'); doc.setIn(['roles', r, 'thinking'], o.coderThinking); }
  doc.setIn(['escalation', 'enabled'], false);
  if (o.arm === 'A1') doc.setIn(['implementation_gate', 'test_author'], false);
  if (o.maxParallel) doc.setIn(['limits', 'max_parallel'], o.maxParallel);
  return String(doc);
}

// —— 快照（只读 .forge/） ——

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const gitTry = (cwd: string, args: string[]): string | null => { try { return git(cwd, args); } catch { return null; } };

/** 把 .forge/ 整理成 simulator 的快照（只读）。flowId 是本阶段对应的流程 */
export function readSnapshot(store: StateStore, flowId: string | null, extra: { nowMs: number; ui?: UiRequest | null }): Snapshot {
  const base: Snapshot = { nowMs: extra.nowMs, ui: extra.ui ?? null, flow: null, tasks: [] };
  if (!flowId) return base;
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  return {
    ...base,
    flow: { id: flow.id, stage: flow.stage, stageStatus: flow.stage_status, version: flow.version, delegated: stageDelegated(store, flow) },
    tasks: tasks.map((t) => ({
      id: t.id, status: t.status, blockedBy: t.blocked_by ?? null, blockedReason: t.blocked_reason, version: t.version, blockedOwner: t.blocked_owner ?? null,
    })),
  };
}

function newestMtime(dir: string, depth = 4): number {
  let newest = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { if (depth > 0) newest = Math.max(newest, newestMtime(p, depth - 1)); }
      else newest = Math.max(newest, statSync(p).mtimeMs);
    } catch { /* 文件刚被删除 */ }
  }
  return newest;
}

// —— 运行 ——

interface Phase { name: 'build' | 'change'; command: string; flowId: string | null; startMs: number; endMs: number | null; delivered: boolean; metricsText: string | null; hidden: HiddenResult | null; tests: TestSummary | null; hiddenMeta: Record<string, unknown> }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function defaultOut(arm: string): string {
  const base = path.join(homedir(), 'pi-forge-runs', 'm9');
  mkdirSync(base, { recursive: true });
  const n = readdirSync(base).filter((d) => d.startsWith(`${arm}-`)).length + 1;
  return path.join(base, `${arm}-${String(n).padStart(2, '0')}-${stamp()}`);
}

function runShell(cwd: string, cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): { code: number | null; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const piVersion = execFileSync('pi', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!piVersion.includes(EXPECTED_PI_VERSION)) throw new Error(`Pi 版本必须是 ${EXPECTED_PI_VERSION}（当前 ${piVersion}）；方案第 2 节要求开跑前断言。`);
  for (const f of [o.prd, ...(o.change ? [o.change] : [])]) if (!existsSync(f)) throw new Error(`找不到文件 ${f}`);
  if (o.hidden && !existsSync(o.hidden)) throw new Error(`找不到 hidden.mjs：${o.hidden}`);
  const sha = gitTry(ROOT, ['rev-parse', 'HEAD']);
  const dirty = gitTry(ROOT, ['status', '--porcelain', '--', 'src', 'agents', 'rules', 'skills', 'templates', 'scripts']);
  const out = o.out ?? defaultOut(o.arm);
  const project = path.join(out, 'project');
  const mainSessions = path.join(out, 'main-session');
  mkdirSync(project, { recursive: true });
  mkdirSync(mainSessions, { recursive: true });
  const runId = path.basename(out);
  const startedAt = new Date();
  const runStart = Date.now();
  let scoringMs = 0;
  const log = (s: string) => console.log(`[${Math.round((Date.now() - runStart) / 1000)}s] ${s}`);
  log(`输出目录：${out}\nPi ${piVersion}；pi-forge ${sha?.slice(0, 8) ?? '?'}${dirty ? '（有未提交改动）' : ''}\n组 ${o.arm}；规划模型 ${o.plannerModel}（${o.plannerThinking}）；写代码模型 ${o.coderModel}（${o.coderThinking}）`);

  // 1. 空仓库 + /forge init + 实验配置
  const env: NodeJS.ProcessEnv = { ...process.env, PI_SKIP_VERSION_CHECK: '1' };
  const id = ['-c', 'user.name=m9', '-c', 'user.email=m9@local'];
  const piBase = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp'];
  const wf = path.join(project, 'workflow.yaml');
  if (o.changeOnly) {
    if (!existsSync(wf)) throw new Error(`--change-only 需要 ${project} 里已有项目`);
  } else {
    git(project, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(project, 'package.json'), '{ "name": "m9-project", "version": "0.0.0", "private": true }\n');
    git(project, ['add', '.']);
    git(project, [...id, 'commit', '-q', '-m', '空项目']);
    const init = runShell(project, 'pi', ['-p', ...piBase, '-e', EXTENSION, ...o.ext.flatMap((e) => ['-e', e]), '--model', o.mainModel, '/forge init'], 5 * 60_000, env);
    writeFileSync(path.join(out, 'init.log'), init.out);
    if (init.code !== 0 || !existsSync(wf)) throw new Error(`/forge init 失败（退出码 ${init.code}）：${init.out.slice(-500)}`);
    writeFileSync(wf, applyExperimentConfig(readFileSync(wf, 'utf8'), o));
    git(project, ['add', 'workflow.yaml']);
    git(project, [...id, 'commit', '-q', '-m', 'M9 实验配置：角色模型与思考级别、关闭升级']);
  }
  const config = loadConfig(wf); // 校验：模板之外的键写错会在这里报
  const agentDir = process.env['PI_CODING_AGENT_DIR'] ?? path.join(homedir(), '.pi', 'agent');
  const plugins = pluginExtensionsFor(config, 'orchestrator', packageRoots(project, agentDir));
  const notes: string[] = [];
  // --ext 显式给出的插件包（例如装在实验目录里、不写全局配置的 ask_user）不算缺失
  plugins.missing = plugins.missing.filter((pkg) => !o.ext.some((e) => e.endsWith(`/node_modules/${pkg}`)));
  if (plugins.missing.length) {
    const msg = `主会话缺少插件 ${plugins.missing.join('、')}：主会话的提问会退回文字（pi install npm:${plugins.missing[0]}）`;
    notes.push(msg);
    log(`警告：${msg}`);
  }

  // 2. 状态与留档
  const store = new StateStore(project);
  const interventionsFile = path.join(out, 'interventions.jsonl');
  writeFileSync(interventionsFile, '');
  let sim: SimState = initialState();
  type Fail = { kind: string; reason: string; status: RunStatus };
  const st: { failure: Fail | null } = { failure: null };
  const fail = (kind: string, reason: string, status: RunStatus = 'flow_failed') => { if (!st.failure) { st.failure = { kind, reason, status }; log(`失败：${kind}：${reason}`); } };
  const live = { running: false, turnEnded: false, turnEndedAt: 0, lastText: '', lastNotify: '', inFlight: false, lastDetail: '', lastToolError: '', sameToolErrors: 0 };
  // 方案修订 1：主会话同一工具连续报同一个错误达到这个次数，算卡住（RPC 一直有输出，30 分钟无活动的规则发现不了）
  const SAME_TOOL_ERROR_LIMIT = 10;
  let phase: Phase | null = null;
  let stopping = false;
  const phases: Phase[] = [];
  const intervene = (a: Exclude<Action, { kind: 'stuck' }>, result: Record<string, unknown> = {}) => {
    const snap = phase?.flowId ? safe(() => readSnapshot(store, phase!.flowId, { nowMs: Date.now() })) : null;
    appendFileSync(interventionsFile, `${JSON.stringify({
      ts: new Date().toISOString(), elapsed_s: Math.round((Date.now() - runStart) / 1000), phase: phase?.name ?? null,
      category: a.category, counts: a.counts, key: a.key, kind: a.kind,
      ...(a.kind === 'prompt' ? { command: a.message } : { ui_id: a.id, answer: a.summary }),
      note: a.note,
      state: snap ? { flow: snap.flow && { id: snap.flow.id, stage: snap.flow.stage, status: snap.flow.stageStatus }, blocked: snap.tasks.filter((t) => t.status === 'blocked').map((t) => t.id) } : null,
      ...result,
    })}\n`);
  };
  function safe<T>(fn: () => T): T | null { try { return fn(); } catch { return null; } }

  // 3. RPC 主会话
  const rpcArgs = ['--mode', 'rpc', '--session-dir', mainSessions, ...piBase, '-e', EXTENSION, ...plugins.paths.flatMap((e) => ['-e', e]), ...o.ext.flatMap((e) => ['-e', e]),
    '--model', o.mainModel, '--thinking', o.plannerThinking];
  const onRecord = (r: RpcRecord) => {
    switch (r.type) {
      case 'agent_start': live.running = true; live.turnEnded = false; break;
      case 'agent_settled': live.running = false; live.turnEnded = true; live.turnEndedAt = Date.now(); break;
      case 'message_end': {
        const m = r['message'] as { role?: string; content?: { type: string; text?: string }[] } | undefined;
        if (m?.role === 'assistant') { const t = (m.content ?? []).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('').trim(); if (t) live.lastText = t; }
        break;
      }
      case 'tool_execution_end': {
        const res = r['result'] as { content?: { type: string; text?: string }[] } | undefined;
        const text = `${String(r['toolName'] ?? '')}：${(res?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 300)}`;
        if (r['isError'] === true) {
          live.sameToolErrors = text === live.lastToolError ? live.sameToolErrors + 1 : 1;
          live.lastToolError = text;
          if (live.sameToolErrors >= SAME_TOOL_ERROR_LIMIT) fail('tool_error_loop', `主会话连续 ${live.sameToolErrors} 次得到同一个工具错误：${text}`);
        } else { live.sameToolErrors = 0; live.lastToolError = ''; }
        break;
      }
      case 'extension_ui_request': {
        const method = r['method'] as string;
        if (method === 'notify') { live.lastNotify = String(r['message'] ?? ''); break; }
        if (['select', 'input', 'editor', 'confirm'].includes(method)) handleUi(r);
        break;
      }
      default: break;
    }
  };
  const rpc: RpcProcess = new RpcProcess({
    command: 'pi', args: rpcArgs, cwd: project, env, logFile: path.join(out, 'rpc.jsonl'), onRecord,
    onExit: (code, signal) => { if (!stopping) fail('pi_exit', `主会话 pi 进程意外退出（退出码 ${code}，信号 ${signal}）；stderr 末尾：${rpc.stderrTail.slice(-400)}。需人工判断是否基础设施问题`, 'infra_failed'); },
  });

  function handleUi(r: RpcRecord): void {
    const ui: UiRequest = { id: String(r['id']), method: r['method'] as UiRequest['method'], title: String(r['title'] ?? ''), ...(Array.isArray(r['options']) ? { options: r['options'] as string[] } : {}) };
    const snap = safe(() => readSnapshot(store, phase?.flowId ?? null, { nowMs: Date.now(), ui }))
      ?? ({ nowMs: Date.now(), flow: null, tasks: [], ui } as Snapshot);
    const action = decide(snap, sim);
    if (!action || action.kind === 'stuck') {
      rpc.respondUi(ui.id, { cancelled: true });
      fail(action?.failure === 'limit' ? 'limit' : 'out_of_table', action?.reason ?? '没有可用的规则');
      return;
    }
    if (action.kind !== 'ui_response') { rpc.respondUi(ui.id, { cancelled: true }); return; }
    sim = apply(sim, action, Date.now());
    rpc.respondUi(action.id, action.response);
    intervene(action);
    log(`UI ${ui.method}「${(ui.title ?? '').slice(0, 60)}」→ ${action.summary.slice(0, 60)}（${action.category}）`);
  }

  // 4. 阶段
  const maxMs = o.maxMin * 60_000;
  const stuckMs = o.stuckMin * 60_000;
  let pauseSince: number | null = null;
  const elapsed = () => Date.now() - runStart - scoringMs;

  async function drive(p: Phase): Promise<void> {
    phase = p;
    phases.push(p);
    const known = new Set(store.listFlows());
    p.startMs = Date.now();
    live.turnEnded = false;
    const first = await rpc.request({ type: 'prompt', message: p.command }, 120_000);
    if (first['success'] !== true) { fail('command_rejected', `${p.command} 被拒绝：${String(first['error'])}`); return; }
    log(`已发出 ${p.command}`);
    let lastDetailAt = 0;
    let lastActivity = Date.now();
    while (!st.failure) {
      await sleep(o.pollSec * 1000);
      if (st.failure) return;
      const now = Date.now();
      if (!p.flowId) {
        p.flowId = store.listFlows().find((f) => !known.has(f) && ['build', 'feature'].includes(store.readFlow(f).mode)) ?? null;
        if (!p.flowId) {
          if (now - p.startMs > 180_000 && !live.running) fail('no_flow', `${p.command} 之后 3 分钟没有创建流程。最后一条通知：${live.lastNotify.slice(0, 300)}`);
          continue;
        }
        log(`流程 ${p.flowId}`);
      }
      let flow;
      try { flow = store.readFlow(p.flowId); } catch { continue; }
      // 只认最后一个实施阶段的 done：阶段切换的瞬间（架构阶段刚批准）stage_status 也会短暂是 done，此前会被误判为已交付
      if (flow.stage_status === 'done' && flow.stage === flow.stages.at(-1) && /^S\d+$/.test(flow.stage)) { p.delivered = true; return; }
      if (flow.stage_status === 'aborted') { fail('flow_aborted', `流程 ${flow.id} 已中止`); return; }
      if (elapsed() > maxMs) { fail('timeout', `超过硬上限 ${o.maxMin} 分钟`); return; }
      if (o.stopAfterGates !== null && sim.counts.gate >= o.stopAfterGates && !live.inFlight) { fail('stop_after_gates', `按 --stop-after-gates ${o.stopAfterGates} 提前停止`, 'stopped_early'); return; }
      // 模型暂停（额度用完等）持续超过 10 分钟算基础设施失败
      const pauses = safe(() => activePauses(store, new Date())) ?? [];
      if (pauses.length) { pauseSince ??= now; if (now - pauseSince > 10 * 60_000) { fail('quota_pause', `模型暂停超过 10 分钟：${pauses.map((x) => x.model).join('、')}`, 'infra_failed'); return; } } else pauseSince = null;
      // 活动：事件日志、子进程会话、主会话 RPC 输出
      lastActivity = Math.max(lastActivity, rpc.lastRecordAt, safe(() => statSync(path.join(project, '.forge', 'events.jsonl')).mtimeMs) ?? 0, newestMtime(sessionsRoot(project)));
      if (now - lastDetailAt > 60_000) { lastDetailAt = now; live.lastDetail = safe(() => renderDetail(store, config)) ?? live.lastDetail; }
      const snap = safe(() => readSnapshot(store, p.flowId, { nowMs: now }));
      if (!snap) continue;
      const action = live.inFlight ? null : decide(snap, sim);
      if (action?.kind === 'stuck') { fail(action.failure === 'limit' ? 'limit' : action.failure === 'repeat' ? 'repeat' : 'out_of_table', action.reason); return; }
      if (action?.kind === 'prompt') {
        sim = apply(sim, action, now);
        intervene(action);
        log(`${action.category}：${action.message.slice(0, 100)}`);
        live.turnEnded = false;
        live.inFlight = true;
        void rpc.request({ type: 'prompt', message: action.message }, 600_000).then((r) => {
          live.inFlight = false;
          appendFileSync(interventionsFile, `${JSON.stringify({ ts: new Date().toISOString(), type: 'result', key: action.key, success: r['success'] === true, error: r['error'] ?? null, disposition: (r['data'] as { disposition?: string } | undefined)?.disposition ?? null })}\n`);
        });
        lastActivity = now;
        continue;
      }
      if (!action && !live.inFlight && now - lastActivity > stuckMs) { fail('stuck', `事件日志、子进程会话、主会话输出都已 ${o.stuckMin} 分钟没有新内容，模拟脚本也没有可做的动作`); return; }
    }
  }

  const finishPhase = async (p: Phase): Promise<void> => {
    p.endMs = Date.now();
    const kind = p.name;
    if (p.flowId) {
      p.metricsText = [
        `# /forge-status --metrics（${p.flowId}，${kind}）`, renderMetrics(flowMetrics(store, p.flowId, new Date(), project)),
        '', `# /forge-status --detail（最后一次快照；命令同时带 --metrics --detail 时只输出 detail，所以分开存）`, live.lastDetail || '（无）',
      ].join('\n');
      writeFileSync(path.join(out, `metrics-${kind}.txt`), `${p.metricsText}\n`);
    }
  };

  async function score(p: Phase): Promise<void> {
    const t0 = Date.now();
    let dir = project;
    let which = 'main';
    if (p.delivered) {
      const cur = gitTry(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (cur !== 'main') gitTry(project, ['checkout', '-q', 'main']);
    } else if (p.flowId) {
      // 从未交付：用集成分支 HEAD 计分（单独的 worktree，尽量复用项目已装好的依赖）
      const branch = safe(() => store.readFlow(p.flowId!).integration_branch);
      if (branch) {
        dir = path.join(out, `score-${p.name}`);
        if (gitTry(project, ['worktree', 'add', '--detach', dir, branch]) !== null) {
          which = `integration:${branch}`;
          if (existsSync(path.join(project, 'node_modules')) && !existsSync(path.join(dir, 'node_modules'))) runShell(dir, 'ln', ['-s', path.join(project, 'node_modules'), 'node_modules'], 10_000);
          else if (existsSync(path.join(dir, 'package.json')) && !existsSync(path.join(dir, 'node_modules'))) runShell(dir, 'npm', ['install', '--silent', '--no-audit', '--no-fund'], 5 * 60_000);
        } else dir = project;
      }
    }
    const head = gitTry(dir, ['rev-parse', 'HEAD']);
    const dirtyFiles = (gitTry(dir, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length;
    if (o.hidden) {
      log(`跑隐藏测试（${p.name}，${which}）…`);
      p.hidden = await runHidden(o.hidden, dir, p.name === 'change');
      writeFileSync(path.join(out, `hidden-${p.name}.json`), `${JSON.stringify({ phase: p.name, scored_on: which, head, uncommitted_files: dirtyFiles, result: p.hidden }, null, 2)}\n`);
    }
    // 项目自带测试：单独列出，不进入判定
    const t = await runProjectTests(dir);
    p.tests = parseTestSummary(t.out, t.code);
    p.hiddenMeta = { scored_on: which, head, uncommitted_files: dirtyFiles };
    scoringMs += Date.now() - t0;
  }

  // 5. 信号：清理子进程
  let interrupted = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (interrupted) return;
      interrupted = true;
      stopping = true;
      fail('interrupted', `收到 ${sig}`, 'stopped_early');
      log(`收到 ${sig}，结束主会话与子进程…`);
      rpc.signal('SIGTERM');
      killRuns(store);
      setTimeout(() => process.exit(130), 15_000).unref();
    });
  }

  try {
    log('等待主会话就绪…');
    await sleep(1500);
    const buildPhase = (): Phase => ({ name: 'build', command: `/forge-build --prd ${JSON.stringify(o.prd)}`, flowId: null, startMs: 0, endMs: null, delivered: false, metricsText: null, hidden: null, tests: null, hiddenMeta: {} });
    // 变更阶段原来依赖 feature 模式（已删除），脚本保留只为编译与历史记录
    const changePhase = (): Phase => ({ name: 'change', command: `/forge-build --prd ${JSON.stringify(o.change ?? '')}`, flowId: null, startMs: 0, endMs: null, delivered: false, metricsText: null, hidden: null, tests: null, hiddenMeta: {} });
    const open = o.changeOnly ? store.listFlows().find((f) => store.readFlow(f).mode === 'build' && !['done', 'aborted'].includes(store.readFlow(f).stage_status)) : undefined;
    if (o.changeOnly) {
      const c = changePhase();
      if (open) { c.flowId = open; c.command = '继续：按已确认的决定重新提交增量规格。'; }
      await drive(c);
      await finishPhase(c);
    }
    const b = buildPhase();
    if (!o.changeOnly) { await drive(b); await finishPhase(b); }
    if (b.delivered && !interrupted) {
      log('新建已交付');
      await score(b);
    }
    if (b.delivered && !interrupted && o.change) {
      await sleep(3000);
      const c = changePhase();
      await drive(c);
      await finishPhase(c);
      if (c.delivered && !interrupted) { log('变更已交付'); await score(c); }
    }
  } catch (e) {
    fail('script_error', String((e as Error).stack ?? e), 'infra_failed');
  }

  // 6. 收尾：停进程，未交付的阶段也按当时的代码计分
  stopping = true;
  await rpc.stop();
  killRuns(store);
  if (!interrupted) {
    for (const p of phases) if (!p.delivered && p.hidden === null && st.failure?.status !== 'stopped_early') { if (p.endMs === null) await finishPhase(p); await score(p); }
  } else for (const p of phases) if (p.endMs === null) await finishPhase(p);

  const summary = buildSummary({ o, runId, startedAt, sha, dirty: dirty === null ? null : dirty.length > 0, piVersion, phases, store, project, sim, failure: st.failure, notes, scoringMs, mainSessions });
  writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(`完成：${summary.status}；基础 ${summary.score.base.passed}/${summary.score.base.total}，变更 ${summary.score.change ? `${summary.score.change.passed}/${summary.score.change.total}` : '—'}，回归 ${summary.score.regression}，agent 时间 ${summary.agent_min} 分钟`);
  return summary.status === 'delivered' ? 0 : 1;
}

function killRuns(store: StateStore): void {
  try {
    for (const r of store.listRuns()) if (!r.ended_at && r.pid) { try { process.kill(-r.pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  } catch { /* 状态读不到时只能靠 pi 自己清理 */ }
}

function buildSummary(i: {
  o: Options; runId: string; startedAt: Date; sha: string | null; dirty: boolean | null; piVersion: string; phases: Phase[]; store: StateStore; project: string;
  sim: SimState; failure: { kind: string; reason: string; status: RunStatus } | null; notes: string[]; scoringMs: number; mainSessions: string;
}): Summary {
  const events = safe2(() => i.store.readEvents()) ?? [];
  const phaseSummaries: PhaseSummary[] = [];
  for (const p of i.phases) {
    const flow = p.flowId ? safe2(() => i.store.readFlow(p.flowId!)) : null;
    const end = p.endMs ?? Date.now();
    if (!flow) { phaseSummaries.push({ name: p.name, flow: p.flowId, delivered: false, wall_min: toMin(end - p.startMs), human_wait_min: 0, blocked_wait_min: 0, agent_min: toMin(end - p.startMs), metrics_agent_min: null, metrics_diff_over_2min: false }); continue; }
    const t = agentTime(events, flow, p.startMs, end);
    const agent = toMin(t.agent_ms);
    const metrics = toMin(t.metrics_agent_ms);
    phaseSummaries.push({ name: p.name, flow: p.flowId, delivered: p.delivered, wall_min: toMin(t.wall_ms), human_wait_min: toMin(t.human_ms), blocked_wait_min: toMin(t.blocked_ms), agent_min: agent, metrics_agent_min: metrics, metrics_diff_over_2min: Math.abs(agent - metrics) > 2 });
  }
  const agentMin = Math.round(phaseSummaries.reduce((a, p) => a + p.agent_min, 0) * 100) / 100;
  const build = i.phases.find((p) => p.name === 'build');
  const change = i.phases.find((p) => p.name === 'change');
  const status: RunStatus = i.failure ? i.failure.status : 'delivered';
  const runs = safe2(() => i.store.listRuns()) ?? [];
  const sum = (f: (r: (typeof runs)[number]) => number | null | undefined) => runs.reduce((a, r) => a + (f(r) ?? 0), 0);
  const o = i.o;
  return {
    schema: 1, arm: o.arm, run_id: i.runId, started_at: i.startedAt.toISOString(), ended_at: new Date().toISOString(),
    pi_version: i.piVersion, pi_forge_sha: i.sha, pi_forge_dirty: i.dirty,
    models: { planner: o.plannerModel, coder: o.coderModel, main: o.mainModel },
    thinking: { planner: o.plannerThinking, coder: o.coderThinking },
    status, failure: i.failure ? { kind: i.failure.kind, reason: i.failure.reason } : null,
    agent_min: agentMin,
    // 方案 6.1：卡住或超过上限（流程失败）时，时间按上限计入
    time_charged_min: status === 'flow_failed' ? o.maxMin : agentMin,
    phases: phaseSummaries,
    hidden: { build: build?.hidden ?? null, change: change?.hidden ?? null },
    score: scoreRun(build?.hidden ?? null, change?.hidden ?? null),
    project_tests: { after_build: build?.tests ?? null, after_change: change?.tests ?? null },
    interventions: {
      gates: i.sim.counts.gate, extra: i.sim.counts.extra, extra_total: extraTotal(i.sim.counts),
    },
    // 子进程按 run 记录累计；主会话（orchestrator）从它的会话文件累计，两者相加
    usage: (() => {
      const m = safe2(() => sessionUsage(i.mainSessions)) ?? {};
      const mm = (k: string) => Number(m[k] ?? 0) || 0;
      return {
        runs: runs.length, input: sum((r) => r.tokens.input) + mm('input'), output: sum((r) => r.tokens.output) + mm('output'),
        cache_read: sum((r) => r.tokens.cache_read) + mm('cache_read'), cache_write: sum((r) => r.tokens.cache_write) + mm('cache_write'), cost: sum((r) => r.cost) + mm('cost'),
        main_input: mm('input'), main_output: mm('output'), main_cache_read: mm('cache_read'), main_cost: mm('cost'),
      };
    })(),
    notes: [...i.notes, ...(i.o.hidden ? [] : ['没有给 --hidden，未计分']), ...(status === 'stopped_early' ? ['提前停止，未计分'] : [])],
  };
}
function safe2<T>(fn: () => T): T | null { try { return fn(); } catch { return null; } }

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); });
}
