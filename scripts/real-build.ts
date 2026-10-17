// 全流程真实模型实验的驱动（RPC 模式的主会话 + 脚本扮演用户）。花钱：只在用户明确要求时运行。
// 用法：
//   node scripts/real-build.ts [--suite scripts/real-build-suites/stock] [--title "<项目名>"] [--out <目录>]
//        [--max-parallel-backend N] [--planner-model ..] [--planner-thinking medium] [--coder-model ..] [--coder-thinking low]
//        [--reviewer-model ..] [--reviewer-thinking high] [--main-model ..] [--ext <扩展>]... [--max-min 480] [--stuck-min 30] [--poll-sec 5]
// 做的事：
//   建空仓库 → /forge init → 写实验配置（按角色设模型与思考级别、关闭升级、兜底模型、max_parallel_backend）
//   → 把套件的 PRD.md 与 prototype/ 放到 docs/PRD.md 与 docs/prototype/ 并提交 → 用 `pi --mode rpc` 拉起主会话 → /forge-build
//   → 架构批准与每批签收都发 /forge-approve（规则表见 real-build/user.ts）→ 看门狗（卡住、上限）
//   → 在 main 上跑套件的 hidden.mjs → 留档（interventions.jsonl、rpc.jsonl、hidden.json、metrics.txt、summary.json）。
// 脚本只读 .forge/，不改状态；所有改状态的动作都是发给主会话的命令。
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { loadConfig } from '../src/core/state/config.ts';
import { stageDelegated } from '../src/core/engine/decisions.ts';
import { activePauses } from '../src/core/engine/model-pause.ts';
import { renderDetail } from '../src/core/ops/status-detail.ts';
import { flowMetrics, renderMetrics, stageDurations } from '../src/core/stage/signoff.ts';
import { sessionsRoot } from '../src/core/engine/session-log.ts';
import { StateStore } from '../src/core/state/state-store.ts';
import { packageRoots, pluginExtensionsFor } from '../src/pi-adapter/plugins.ts';
import {
  CODER_ROLES, parseTestSummary, readSessionEntries, reworkStats, roleUsage, runHidden, runProjectTests, scoreHidden, toMin,
  type HiddenResult, type RunStatus, type Summary, type TestSummary,
} from './real-build/common.ts';
import { RpcProcess, type RpcRecord } from './real-build/rpc.ts';
import { apply, decide, extraTotal, initialState, type Action, type Snapshot, type SimState, type UiRequest } from './real-build/user.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION = path.join(ROOT, 'src/pi-adapter/extension.ts');
export const EXPECTED_PI_VERSION = '1.1.0';

// —— 参数 ——

export interface Options {
  /** 套件目录：PRD.md、prototype/（必需），hidden.mjs（可选，有就计分） */
  suite: string;
  title: string;
  out: string | null;
  maxMin: number;
  stuckMin: number;
  plannerModel: string;
  plannerThinking: string;
  coderModel: string;
  coderThinking: string;
  reviewerModel: string;
  reviewerThinking: string;
  mainModel: string;
  /** limits.max_parallel_backend；不给就用模板的值 */
  maxParallelBackend: number | null;
  ext: string[];
  pollSec: number;
}

/** 默认配置同 stock run-04：主会话与 architect gpt-6.1-sol medium，写代码 glm-5.3-flash low，审查与 stage-qa glm-5.3-flash high */
export function parseArgs(argv: string[]): Options {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const all = (k: string): string[] => argv.flatMap((a, i) => (a === k && argv[i + 1] ? [argv[i + 1]!] : []));
  for (const k of ['--arm', '--prd', '--change', '--change-only', '--hidden', '--stop-after-gates', '--max-parallel']) if (argv.includes(k)) throw new Error(`${k} 已不再支持：输入是套件里的 PRD.md 与 prototype/，见脚本开头的用法`);
  const suite = path.resolve(get('--suite') ?? path.join(ROOT, 'scripts/real-build-suites/stock'));
  const plannerModel = get('--planner-model') ?? 'magpie/codex/gpt-6.1-sol';
  const coderModel = get('--coder-model') ?? 'magpie/workbuddy/glm-5.3-flash';
  const mpb = get('--max-parallel-backend');
  return {
    suite, title: get('--title') ?? path.basename(suite),
    out: get('--out') ? path.resolve(get('--out')!) : null,
    maxMin: Number(get('--max-min') ?? 480), stuckMin: Number(get('--stuck-min') ?? 30),
    plannerModel, plannerThinking: get('--planner-thinking') ?? 'medium',
    coderModel, coderThinking: get('--coder-thinking') ?? 'low',
    reviewerModel: get('--reviewer-model') ?? coderModel, reviewerThinking: get('--reviewer-thinking') ?? 'high',
    mainModel: get('--main-model') ?? plannerModel,
    maxParallelBackend: mpb ? Number(mpb) : null,
    ext: all('--ext').map((e) => path.resolve(e)),
    pollSec: Number(get('--poll-sec') ?? 5),
  };
}

// —— 实验配置 ——

export const PLANNER_ROLES = ['orchestrator', 'architect'] as const;
export const REVIEWER_ROLES = ['reviewer', 'stage-qa'] as const;

/**
 * 在 workflow.yaml 上写实验配置：新增 planner / coder / reviewer 三个模型档位，角色的 model 指向档位，thinking 写在角色上
 * （workflow.yaml 本来支持的方式，不动 ~/.pi/agent/pi-forge.json）；模板里没有的角色跳过。
 * 关闭升级，兜底模型用写代码的模型（同 run-04）。用 yaml 的 Document 改，保留模板里的注释与行内写法。
 */
export function applyExperimentConfig(yamlText: string, o: Pick<Options, 'plannerModel' | 'plannerThinking' | 'coderModel' | 'coderThinking' | 'reviewerModel' | 'reviewerThinking' | 'maxParallelBackend'>): string {
  const doc = parseDocument(yamlText);
  const tiers: [string, readonly string[], string, string][] = [
    ['planner', PLANNER_ROLES, o.plannerModel, o.plannerThinking],
    ['coder', CODER_ROLES, o.coderModel, o.coderThinking],
    ['reviewer', REVIEWER_ROLES, o.reviewerModel, o.reviewerThinking],
  ];
  for (const [tier, roles, model, thinking] of tiers) {
    doc.setIn(['models', tier], model);
    for (const r of roles) { if (!doc.hasIn(['roles', r])) continue; doc.setIn(['roles', r, 'model'], tier); doc.setIn(['roles', r, 'thinking'], thinking); }
  }
  // 旧档位也指向实验用的模型，避免留下占位符
  doc.setIn(['models', 'strong'], o.plannerModel);
  doc.setIn(['models', 'medium'], o.reviewerModel);
  doc.setIn(['models', 'cheap'], o.coderModel);
  doc.setIn(['models', 'fallback'], o.coderModel);
  doc.setIn(['escalation', 'enabled'], false);
  if (o.maxParallelBackend) doc.setIn(['limits', 'max_parallel_backend'], o.maxParallelBackend);
  return String(doc);
}

// —— 快照（只读 .forge/） ——

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const gitTry = (cwd: string, args: string[]): string | null => { try { return git(cwd, args); } catch { return null; } };
function safe<T>(fn: () => T): T | null { try { return fn(); } catch { return null; } }

/** 把 .forge/ 整理成规则表的快照（只读） */
export function readSnapshot(store: StateStore, flowId: string | null, extra: { nowMs: number; ui?: UiRequest | null }): Snapshot {
  const base: Snapshot = { nowMs: extra.nowMs, ui: extra.ui ?? null, flow: null, tasks: [] };
  if (!flowId) return base;
  const flow = store.readFlow(flowId);
  return {
    ...base,
    flow: { id: flow.id, stage: flow.stage, stageStatus: flow.stage_status, version: flow.version, delegated: stageDelegated(store, flow) },
    tasks: store.listTasks(flowId).map((t) => ({
      id: t.id, status: t.status, blockedBy: t.blocked_by ?? null, blockedReason: t.blocked_reason, version: t.version, blockedOwner: t.blocked_owner ?? null,
    })),
  };
}

/** 交付：最后一个批次阶段 done（架构阶段 S0 批准前也是最后一个阶段，它的 done 不算） */
export const delivered = (flow: { stage: string; stage_status: string; stages: string[] }): boolean =>
  flow.stage_status === 'done' && flow.stage === flow.stages.at(-1) && flow.stage !== 'S0' && /^S\d+$/.test(flow.stage);

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function defaultOut(suite: string): string {
  const base = path.join(homedir(), 'pi-forge-runs', path.basename(suite));
  mkdirSync(base, { recursive: true });
  const n = readdirSync(base).filter((d) => d.startsWith('rework-')).length + 1;
  return path.join(base, `rework-${String(n).padStart(2, '0')}-${stamp()}`);
}

function runShell(cwd: string, cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): { code: number | null; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const prd = path.join(o.suite, 'PRD.md');
  const prototype = path.join(o.suite, 'prototype');
  const hidden = path.join(o.suite, 'hidden.mjs');
  if (!existsSync(prd) || !existsSync(prototype)) throw new Error(`套件 ${o.suite} 里要有 PRD.md 与 prototype/`);
  const piVersion = execFileSync('pi', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!piVersion.includes(EXPECTED_PI_VERSION)) throw new Error(`Pi 版本必须是 ${EXPECTED_PI_VERSION}（当前 ${piVersion}）`);
  const sha = gitTry(ROOT, ['rev-parse', 'HEAD']);
  const dirty = gitTry(ROOT, ['status', '--porcelain', '--', 'src', 'agents', 'rules', 'skills', 'templates', 'scripts']);
  const out = o.out ?? defaultOut(o.suite);
  const project = path.join(out, 'project');
  const mainSessions = path.join(out, 'main-session');
  mkdirSync(project, { recursive: true });
  mkdirSync(mainSessions, { recursive: true });
  const runId = path.basename(out);
  const startedAt = new Date();
  const runStart = Date.now();
  const log = (s: string) => console.log(`[${Math.round((Date.now() - runStart) / 1000)}s] ${s}`);
  log(`输出目录：${out}\nPi ${piVersion}；pi-forge ${sha?.slice(0, 8) ?? '?'}${dirty ? '（有未提交改动）' : ''}\n套件 ${o.suite}；规划 ${o.plannerModel}（${o.plannerThinking}）；写代码 ${o.coderModel}（${o.coderThinking}）；审查与验收 ${o.reviewerModel}（${o.reviewerThinking}）；max_parallel_backend ${o.maxParallelBackend ?? '模板值'}`);

  // 1. 空仓库 + /forge init + 实验配置 + 输入
  const env: NodeJS.ProcessEnv = { ...process.env, PI_SKIP_VERSION_CHECK: '1' };
  const id = ['-c', 'user.name=real-build', '-c', 'user.email=real-build@local'];
  const piBase = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp'];
  const wf = path.join(project, 'workflow.yaml');
  git(project, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(project, 'package.json'), '{ "name": "real-build-project", "version": "0.0.0", "private": true }\n');
  git(project, ['add', '.']);
  git(project, [...id, 'commit', '-q', '-m', '空项目']);
  const init = runShell(project, 'pi', ['-p', ...piBase, '-e', EXTENSION, ...o.ext.flatMap((e) => ['-e', e]), '--model', o.mainModel, '/forge init'], 5 * 60_000, env);
  writeFileSync(path.join(out, 'init.log'), init.out);
  if (init.code !== 0 || !existsSync(wf)) throw new Error(`/forge init 失败（退出码 ${init.code}）：${init.out.slice(-500)}`);
  writeFileSync(wf, applyExperimentConfig(readFileSync(wf, 'utf8'), o));
  // /forge init 可能生成了 PRD 模板，用套件的覆盖
  mkdirSync(path.join(project, 'docs'), { recursive: true });
  cpSync(prd, path.join(project, 'docs', 'PRD.md'));
  cpSync(prototype, path.join(project, 'docs', 'prototype'), { recursive: true });
  git(project, ['add', '-A']);
  git(project, [...id, 'commit', '-q', '-m', '实验配置与输入：角色模型与思考级别、关闭升级；docs/PRD.md、docs/prototype/']);
  const config = loadConfig(wf); // 校验：模板之外的键写错会在这里报
  const agentDir = process.env['PI_CODING_AGENT_DIR'] ?? path.join(homedir(), '.pi', 'agent');
  const plugins = pluginExtensionsFor(config, 'orchestrator', packageRoots(project, agentDir));
  const notes: string[] = [];
  // --ext 显式给出的插件包不算缺失
  plugins.missing = plugins.missing.filter((pkg) => !o.ext.some((e) => e.endsWith(`/node_modules/${pkg}`)));
  if (plugins.missing.length) {
    const msg = `主会话缺少插件 ${plugins.missing.join('、')}（pi install npm:${plugins.missing[0]}）`;
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
  const live = { running: false, lastNotify: '', inFlight: false, lastDetail: '', lastToolError: '', sameToolErrors: 0 };
  // 主会话同一工具连续报同一个错误达到这个次数，算卡住（RPC 一直有输出，30 分钟无活动的规则发现不了）
  const SAME_TOOL_ERROR_LIMIT = 10;
  const run = { flowId: null as string | null, startMs: 0, endMs: null as number | null, delivered: false };
  let stopping = false;
  const intervene = (a: Exclude<Action, { kind: 'stuck' }>) => {
    const snap = run.flowId ? safe(() => readSnapshot(store, run.flowId, { nowMs: Date.now() })) : null;
    appendFileSync(interventionsFile, `${JSON.stringify({
      ts: new Date().toISOString(), elapsed_s: Math.round((Date.now() - runStart) / 1000),
      category: a.category, counts: a.counts, key: a.key, kind: a.kind,
      ...(a.kind === 'prompt' ? { command: a.message } : { ui_id: a.id, answer: a.summary }),
      note: a.note,
      state: snap ? { flow: snap.flow && { id: snap.flow.id, stage: snap.flow.stage, status: snap.flow.stageStatus }, blocked: snap.tasks.filter((t) => t.status === 'blocked').map((t) => t.id) } : null,
    })}\n`);
  };

  // 3. RPC 主会话
  const rpcArgs = ['--mode', 'rpc', '--session-dir', mainSessions, ...piBase, '-e', EXTENSION, ...plugins.paths.flatMap((e) => ['-e', e]), ...o.ext.flatMap((e) => ['-e', e]),
    '--model', o.mainModel, '--thinking', o.plannerThinking];
  const onRecord = (r: RpcRecord) => {
    switch (r.type) {
      case 'agent_start': live.running = true; break;
      case 'agent_settled': live.running = false; break;
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
    const snap = safe(() => readSnapshot(store, run.flowId, { nowMs: Date.now(), ui })) ?? ({ nowMs: Date.now(), flow: null, tasks: [], ui } as Snapshot);
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

  // 4. 推进：/forge-build 之后按规则表回应，直到交付、失败或超时
  const maxMs = o.maxMin * 60_000;
  const stuckMs = o.stuckMin * 60_000;
  let pauseSince: number | null = null;
  const command = `/forge-build ${JSON.stringify(o.title)}`;

  async function drive(): Promise<void> {
    run.startMs = Date.now();
    const first = await rpc.request({ type: 'prompt', message: command }, 120_000);
    if (first['success'] !== true) { fail('command_rejected', `${command} 被拒绝：${String(first['error'])}`); return; }
    log(`已发出 ${command}`);
    let lastDetailAt = 0;
    let lastActivity = Date.now();
    while (!st.failure) {
      await sleep(o.pollSec * 1000);
      if (st.failure) return;
      const now = Date.now();
      if (!run.flowId) {
        run.flowId = store.listFlows().find((f) => store.readFlow(f).mode === 'build') ?? null;
        if (!run.flowId) {
          if (now - run.startMs > 180_000 && !live.running) fail('no_flow', `${command} 之后 3 分钟没有创建流程。最后一条通知：${live.lastNotify.slice(0, 300)}`);
          continue;
        }
        log(`流程 ${run.flowId}`);
      }
      let flow;
      try { flow = store.readFlow(run.flowId); } catch { continue; }
      if (delivered(flow)) { run.delivered = true; return; }
      if (flow.stage_status === 'aborted') { fail('flow_aborted', `流程 ${flow.id} 已中止`); return; }
      if (now - runStart > maxMs) { fail('timeout', `超过硬上限 ${o.maxMin} 分钟`); return; }
      // 模型暂停（额度用完等）持续超过 10 分钟算基础设施失败
      const pauses = safe(() => activePauses(store, new Date())) ?? [];
      if (pauses.length) { pauseSince ??= now; if (now - pauseSince > 10 * 60_000) { fail('quota_pause', `模型暂停超过 10 分钟：${pauses.map((x) => x.model).join('、')}`, 'infra_failed'); return; } } else pauseSince = null;
      // 活动：事件日志、子进程会话、主会话 RPC 输出
      lastActivity = Math.max(lastActivity, rpc.lastRecordAt, safe(() => statSync(path.join(project, '.forge', 'events.jsonl')).mtimeMs) ?? 0, newestMtime(sessionsRoot(project)));
      if (now - lastDetailAt > 60_000) { lastDetailAt = now; live.lastDetail = safe(() => renderDetail(store, config)) ?? live.lastDetail; }
      const snap = safe(() => readSnapshot(store, run.flowId, { nowMs: now }));
      if (!snap) continue;
      const action = live.inFlight ? null : decide(snap, sim);
      if (action?.kind === 'stuck') { fail(action.failure, action.reason); return; }
      if (action?.kind === 'prompt') {
        sim = apply(sim, action, now);
        intervene(action);
        log(`${action.category}：${action.message.slice(0, 100)}`);
        live.inFlight = true;
        void rpc.request({ type: 'prompt', message: action.message }, 600_000).then((r) => {
          live.inFlight = false;
          appendFileSync(interventionsFile, `${JSON.stringify({ ts: new Date().toISOString(), type: 'result', key: action.key, success: r['success'] === true, error: r['error'] ?? null, disposition: (r['data'] as { disposition?: string } | undefined)?.disposition ?? null })}\n`);
        });
        lastActivity = now;
        continue;
      }
      if (!action && !live.inFlight && now - lastActivity > stuckMs) { fail('stuck', `事件日志、子进程会话、主会话输出都已 ${o.stuckMin} 分钟没有新内容，规则表也没有可做的动作`); return; }
    }
  }

  const writeMetrics = (): void => {
    if (!run.flowId) return;
    const text = [
      `# /forge-status --metrics（${run.flowId}）`, safe(() => renderMetrics(flowMetrics(store, run.flowId!, new Date(), project))) ?? '（读取失败）',
      '', '# /forge-status --detail（最后一次快照）', live.lastDetail || '（无）',
    ].join('\n');
    writeFileSync(path.join(out, 'metrics.txt'), `${text}\n`);
  };

  let hiddenResult: HiddenResult | null = null;
  let tests: TestSummary | null = null;
  async function score(): Promise<void> {
    let dir = project;
    let which = 'main';
    if (run.delivered) {
      if (gitTry(project, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') gitTry(project, ['checkout', '-q', 'main']);
    } else if (run.flowId) {
      // 没交付：用集成分支 HEAD 计分（单独的 worktree，尽量复用项目已装好的依赖）
      const branch = safe(() => store.readFlow(run.flowId!).integration_branch);
      if (branch) {
        dir = path.join(out, 'score');
        if (gitTry(project, ['worktree', 'add', '--detach', dir, branch]) !== null) {
          which = `integration:${branch}`;
          if (existsSync(path.join(project, 'node_modules')) && !existsSync(path.join(dir, 'node_modules'))) runShell(dir, 'ln', ['-s', path.join(project, 'node_modules'), 'node_modules'], 10_000);
          else if (existsSync(path.join(dir, 'package.json')) && !existsSync(path.join(dir, 'node_modules'))) runShell(dir, 'npm', ['install', '--silent', '--no-audit', '--no-fund'], 5 * 60_000);
        } else dir = project;
      }
    }
    const head = gitTry(dir, ['rev-parse', 'HEAD']);
    const dirtyFiles = (gitTry(dir, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length;
    if (existsSync(hidden)) {
      log(`跑隐藏测试（${which}）…`);
      hiddenResult = await runHidden(hidden, dir);
      writeFileSync(path.join(out, 'hidden.json'), `${JSON.stringify({ scored_on: which, head, uncommitted_files: dirtyFiles, score: scoreHidden(hiddenResult), result: hiddenResult }, null, 2)}\n`);
    }
    // 项目自带测试：单独列出，不进入判定
    const t = await runProjectTests(dir);
    tests = parseTestSummary(t.out, t.code);
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
    await drive();
    run.endMs = Date.now();
    writeMetrics();
    if (run.delivered) log('已交付');
  } catch (e) {
    fail('script_error', String((e as Error).stack ?? e), 'infra_failed');
  }

  // 6. 收尾：停进程；没交付的也按当时集成分支的代码计分（提前停止的不计分）
  stopping = true;
  await rpc.stop();
  killRuns(store);
  run.endMs ??= Date.now();
  if (!interrupted && st.failure?.status !== 'stopped_early') await score();

  const summary = buildSummary({ o, runId, startedAt, sha, dirty: dirty === null ? null : dirty.length > 0, piVersion, store, run, sim, failure: st.failure, notes, hidden: hiddenResult, tests, mainSessions, hasHidden: existsSync(hidden) });
  writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(`完成：${summary.status}；隐藏测试 ${summary.hidden ? `${summary.hidden.passed}/${summary.hidden.total}` : '—'}；用时 ${summary.wall_min} 分钟；费用 $${summary.usage.cost.toFixed(2)}；返工 run ${summary.rework?.rework_runs ?? '—'}；冲突 ${summary.rework ? summary.rework.conflicts.merge + summary.rework.conflicts.sync : '—'}；审查轮数 ${summary.rework?.review_rounds ?? '—'}`);
  return summary.status === 'delivered' ? 0 : 1;
}

function killRuns(store: StateStore): void {
  try {
    for (const r of store.listRuns()) if (!r.ended_at && r.pid) { try { process.kill(-r.pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  } catch { /* 状态读不到时只能靠 pi 自己清理 */ }
}

function buildSummary(i: {
  o: Options; runId: string; startedAt: Date; sha: string | null; dirty: boolean | null; piVersion: string; store: StateStore;
  run: { flowId: string | null; startMs: number; endMs: number | null; delivered: boolean };
  sim: SimState; failure: { kind: string; reason: string; status: RunStatus } | null; notes: string[];
  hidden: HiddenResult | null; tests: TestSummary | null; mainSessions: string; hasHidden: boolean;
}): Summary {
  const { o, run, store } = i;
  const end = run.endMs ?? Date.now();
  const flow = run.flowId ? safe(() => store.readFlow(run.flowId!)) : null;
  const events = safe(() => store.readEvents()) ?? [];
  const runs = (safe(() => store.listRuns()) ?? []).filter((r) => r.flow === run.flowId);
  const tasks = run.flowId ? safe(() => store.listTasks(run.flowId!)) ?? [] : [];
  const stages = flow
    ? [...stageDurations(events, flow.id, flow.stages[0]!, flow.created_at, end)].map(([stage, d]) => ({ stage, wall_min: toMin(d.wall_ms), human_min: toMin(d.human_ms) }))
    : [];
  // 子进程按 run 的会话目录统计，主会话单独一个目录；按开始时间排序，去重时保留先出现的
  const sources = [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at)).map((r) => ({ role: r.role, entries: readSessionEntries(r.session_dir) }));
  sources.push({ role: 'orchestrator', entries: readSessionEntries(i.mainSessions) });
  const byRole = roleUsage(sources);
  const status: RunStatus = i.failure ? i.failure.status : 'delivered';
  return {
    schema: 2, run_id: i.runId, started_at: i.startedAt.toISOString(), ended_at: new Date().toISOString(),
    pi_version: i.piVersion, pi_forge_sha: i.sha, pi_forge_dirty: i.dirty, suite: o.suite,
    models: { planner: o.plannerModel, coder: o.coderModel, reviewer: o.reviewerModel, main: o.mainModel },
    thinking: { planner: o.plannerThinking, coder: o.coderThinking, reviewer: o.reviewerThinking },
    max_parallel_backend: o.maxParallelBackend,
    status, failure: i.failure ? { kind: i.failure.kind, reason: i.failure.reason } : null,
    flow: run.flowId,
    wall_min: toMin(end - run.startMs),
    stages,
    hidden: i.hidden ? scoreHidden(i.hidden) : null,
    project_tests: i.tests,
    interventions: { gates: i.sim.counts.gate, extra: i.sim.counts.extra, extra_total: extraTotal(i.sim.counts) },
    usage: { by_role: byRole, cost: Math.round(Object.values(byRole).reduce((a, u) => a + u.cost, 0) * 100) / 100 },
    rework: run.flowId ? reworkStats(runs, tasks, events, run.flowId) : null,
    notes: [...i.notes, ...(i.hasHidden ? [] : ['套件没有 hidden.mjs，未计分']), ...(status === 'stopped_early' ? ['提前停止，未计分'] : [])],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); });
}
