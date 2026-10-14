// 来源：pi-flow src/pi-adapter/extension.ts @ 31f3f15
// pi-forge 的 Pi 扩展入口。所有 Pi API 调用集中在 src/pi-adapter/，业务逻辑在 src/core、src/commands、src/tools。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { UsageAccumulator } from '../core/engine/metrics.ts';
import { hashToken } from '../core/state/state-machine.ts';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext, type PiModel } from '@earendil-works/pi-coding-agent';
import { tolerantArgs } from './tool-args.ts';
import { withoutPlaceholders } from '../core/security/tool-params.ts';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { loadConfig, type FlowConfig } from '../core/state/config.ts';
import { ROLE_SETTINGS_FILENAME, loadRoleSettings, resolveRoleModel } from '../core/insight/role-settings.ts';
import { THINKING_LEVELS, type ThinkingLevel } from '../core/state/schemas.ts';
import { forgeRead, type ForgeReadInput } from '../core/workspace/forge-read.ts';
import { StateStore } from '../core/state/state-store.ts';
import { Engine } from '../core/engine/dispatcher.ts';
import { codegraphSync } from '../core/ops/codegraph.ts';
import { acquireEngineLock, releaseEngineLock } from '../core/ops/engine-lock.ts';
import { enforceToolCall } from '../core/security/guard.ts';
import { newDrift, nextStep, turnContext } from '../core/engine/context-injector.ts';
import { dirtyFiles } from '../core/state/git.ts';
import { parseAgentFile } from '../core/engine/agents.ts';
import { runFlowConfig, type ModelOption } from '../commands/forge-config.ts';
import { RoleTable, type RoleRow, type TableModel } from '../commands/role-table.ts';
import { runFlowCommand, runFlowBuild, runFlowFix, runFlowChange, FLOW_USAGE, type CommandEnv, type EngineHandle } from '../commands/forge.ts';
import { flowChange, flowChangeRequestMain, flowDecide, flowSpec, ChangeParams, DecideParams, SpecParams, ResolveTimeoutParams, WaitParams, activeFlowId, flowResolveTimeout, flowWait, statusText } from '../tools/orchestrator-tools.ts';
import { PiLauncher } from './launcher.ts';
import { lastFailureKind, notices, snapshotOf, statusLine, visibleFlows } from '../core/ops/status-view.ts';
import { decisionKeys, wakeMessage } from '../core/engine/decisions.ts';
import { packageRoots, pluginExtensionsFor } from './plugins.ts';
import { installMemory } from './memory.ts';
import { redactToolResult } from './redact-hook.ts';
import { notifyEvents, runNotify } from '../core/ops/notify.ts';
import { NOTES_DESCRIPTION, NotesError, NotesParams, applyNoteOps, notesContextMessage, renderNotes } from '../core/engine/notes.ts';
import { HISTORY_DESCRIPTION, HistoryParams } from '../core/ops/history.ts';
import { ChangeRequestParams, historyTool } from '../tools/subagent-tools.ts';
import { MAIN_NOTES_REL } from '../core/state/state-store.ts';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_WORKFLOW = path.join(PACKAGE_ROOT, 'templates', 'workflow.yaml');
const SUBAGENT_EXTENSION = path.join(PACKAGE_ROOT, 'src', 'pi-adapter', 'subagent.ts');
const ORCHESTRATOR_TOOLS = ['forge_read', 'forge_spec', 'forge_change', 'forge_change_request', 'forge_status', 'forge_wait', 'forge_resolve_timeout', 'forge_decide'];

/** 用户级设置文件：~/.pi/agent/pi-forge.json（与 Pi 官方 preset 示例的全局配置位置一致） */
export function roleSettingsPath(): string {
  return path.join(getAgentDir(), ROLE_SETTINGS_FILENAME);
}

/** 项目有 workflow.yaml 时用项目配置，否则用模板（用于在初始化前也能设置角色）。 */
export function loadProjectConfig(cwd: string): { config: FlowConfig; source: string } {
  const project = path.join(cwd, 'workflow.yaml');
  const file = existsSync(project) ? project : TEMPLATE_WORKFLOW;
  return { config: loadConfig(file), source: file };
}

export function availableModels(ctx: ExtensionContext): ModelOption[] {
  return ctx.modelRegistry.getAvailable().map((m) => {
    let levels: ThinkingLevel[];
    try {
      levels = getSupportedThinkingLevels(m).filter((l): l is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(l));
    } catch {
      levels = m.reasoning ? [...THINKING_LEVELS] : ['off'];
    }
    return { ref: `${m.provider}/${m.id}`, name: m.name, levels: levels.length ? levels : ['off'] };
  });
}

function report(ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  // json/rpc 模式的 stdout 保留给事件流
  else if (ctx.mode === 'json' || ctx.mode === 'rpc') process.stderr.write(`${message}\n`);
  else process.stdout.write(`${message}\n`);
}

const toolResult = (text: string, details: unknown = {}) => ({ content: [{ type: 'text' as const, text }], details });

function checked<T>(schema: unknown, raw: unknown, name: string): T {
  const params = withoutPlaceholders(schema, raw);
  if (!Value.Check(schema as never, params)) throw new Error(`${name} 参数不合法：${[...Value.Errors(schema as never, params)].map((e) => `${e.instancePath || '/'} ${e.message}`).join('；')}`);
  return params as T;
}

// —— 每个项目根一份会话状态（引擎运行在本 pi 进程内） ——

interface SavedSession { model: PiModel | undefined; thinking: ThinkingLevel; tools: string[] }

interface RootSession {
  handle: EngineHandle | null;
  orchestrator: boolean;
  driftBefore: Set<string> | null;
  notify: (m: string, l?: 'info' | 'warning' | 'error') => void;
  /** 进入调度模式前的模型、思考级别与工具，用于退出时恢复 */
  saved: SavedSession | null;
  /** 退出调度模式（由最近一次命令的上下文提供） */
  deactivate: (() => Promise<string>) | null;
  /** 调度模式下的状态栏（只在终端界面设置）；null 表示不显示 */
  status: ((text: string | undefined) => void) | null;
  /** 调度模式下给主会话发消息，让它开始一轮（有界面时才有）；null 表示不发 */
  wake: ((text: string) => void) | null;
}
const sessions = new Map<string, RootSession>();

/** 每个流程一条 orchestrator 用量记录（run_id 按会话与流程区分），在同一 pi 进程内累加；写入按顺序串行 */
const orchUsage = new Map<string, { runId: string; acc: UsageAccumulator; chain: Promise<void> }>();

function recordOrchestratorUsage(s: RootSession, message: Record<string, unknown>): Promise<void> {
  const { store } = s.handle!;
  const flow = store.readState().active_flow ?? store.openLightFlow()?.id ?? null;
  const key = `${store.abs('')}|${flow ?? '-'}`;
  let u = orchUsage.get(key);
  if (!u) {
    const runId = `o-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const at = new Date().toISOString();
    // 记录创建即视为已结束（ended_at 随每条回复更新），恢复流程不会把它当成中断的子进程
    u = { runId, acc: new UsageAccumulator(), chain: store.createRun({ run_id: runId, flow, task: null, role: 'orchestrator', model: null, started_at: at, ended_at: at,
      tokens: { input: null, output: null, cache_read: null, cache_write: null }, outcome: 'noted', token_hash: hashToken(randomBytes(24).toString('hex')), violations: 0 }).then(() => {}) };
    orchUsage.set(key, u);
  }
  u.acc.pushEvent({ type: 'message_end', message });
  const m = u.acc.result();
  const rec = u;
  rec.chain = rec.chain.catch(() => {}).then(() => store.updateRun(rec.runId, { ended_at: new Date().toISOString(), tokens: m.tokens, model: m.model, turns: m.turns,
    ...(m.cost !== undefined ? { cost: m.cost } : {}) }, 'orchestrator', '主会话用量')).then(() => {});
  return rec.chain;
}

function session(root: string): RootSession {
  let s = sessions.get(root);
  if (!s) {
    s = { handle: null, orchestrator: false, driftBefore: null, notify: () => {}, saved: null, deactivate: null, status: null, wake: null };
    sessions.set(root, s);
  }
  return s;
}

const initialized = (root: string) => existsSync(path.join(root, '.forge', 'state.json'));

export function engineFor(root: string): EngineHandle {
  const s = session(root);
  if (s.handle) return s.handle;
  if (!initialized(root)) throw new Error('当前项目尚未初始化 pi-forge（缺少 .forge/），请先执行 /forge init。');
  const holder = acquireEngineLock(root);
  if (holder) throw new Error(`另一个 pi 会话（pid ${holder.pid}，自 ${holder.since}）正在运行该项目的流程。请在那个会话中操作，或关闭它后再执行 /forge-resume。`);
  const config = loadConfig(path.join(root, 'workflow.yaml'));
  const store = new StateStore(root, { limits: config.limits });
  const extra = (process.env['PI_FORGE_EXTRA_EXTENSIONS'] ?? '').split(',').filter(Boolean);
  const engine = new Engine({
    root, store, config, launcher: new PiLauncher(),
    roleSettings: () => loadRoleSettings(roleSettingsPath()),
    packageAgentsDir: path.join(PACKAGE_ROOT, 'agents'),
    subagentExtension: SUBAGENT_EXTENSION,
    // 测试用的额外扩展（假模型 provider）在前，随后是第三方插件；guard 所在的 subagent 扩展由引擎放在最后
    extraExtensions: (role) => [...extra, ...pluginExtensionsFor(config, role, packageRoots(root, getAgentDir())).paths],
    packageSkillsDir: path.join(PACKAGE_ROOT, 'skills'),
    mergeHooks: { afterMerge: codegraphSync },
    onError: (e) => s.notify(`pi-forge 程序步骤出错：${(e as Error).message}`, 'warning'),
  });
  s.handle = { store, engine, config };
  // 任何命令启动引擎都要检查租约：卡住的子进程（例如挂起的测试命令）到期会被结束，不只在 /forge-resume 时
  engine.startLeaseWatch();
  // 进程退出时（没有经过 session_shutdown 的情况）也结束子进程，避免留下无人管理的 subagent
  process.once('exit', () => engine.killAll());
  // 主动通知只在进入新阶段、出现需要你处理的事、任务首次失败重试时出现
  let prev = snapshotOf(store, config);
  let prevDecisions = new Set(decisionKeys(store, visibleFlows(store).map((f) => f.id)));
  const check = () => {
    try {
      if (s.orchestrator && s.status) s.status(statusLine(store, config) ?? undefined);
      const next = snapshotOf(store, config);
      for (const n of notices(prev, next, (f, t) => lastFailureKind(store, f, t))) s.notify(n, n.includes('需要你处理') ? 'warning' : 'info');
      runNotify(config, root, notifyEvents(prev, next));
      prev = next;
      // 交给主会话的决定：主会话这一轮已经结束时，不叫醒它就会一直等到用户说话
      const decisions = decisionKeys(store, visibleFlows(store).map((f) => f.id));
      const wake = wakeMessage(prevDecisions, decisions);
      prevDecisions = new Set(decisions);
      if (wake && s.orchestrator && s.wake) s.wake(wake);
      // 没有进行中的流程与修复时自动退出调度模式
      if (s.orchestrator && s.deactivate && !visibleFlows(store).length) void s.deactivate().then((m) => s.notify(m));
    } catch { /* 通知失败不影响流程 */ }
  };
  // 通知检测节流：状态变化密集时（一次合并会有多次转移）最多每 NOTICE_THROTTLE_MS 检测一次，末尾一定再检测一次
  let timer: NodeJS.Timeout | null = null;
  engine.onChange(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; check(); }, NOTICE_THROTTLE_MS);
    timer.unref();
  });
  return s.handle;
}

const NOTICE_THROTTLE_MS = 300;

function agentPrompt(root: string, name: string): string {
  const project = path.join(root, '.pi', 'agents', `${name}.md`);
  const file = existsSync(project) ? project : path.join(PACKAGE_ROOT, 'agents', `${name}.md`);
  return parseAgentFile(readFileSync(file, 'utf8'), file).prompt;
}

export default function piFlow(pi: ExtensionAPI): void {
  /** 进入调度模式前记住会话状态，并提供退出时的恢复 */
  const enterManagedMode = (ctx: ExtensionContext, s: RootSession) => {
    if (!s.orchestrator) s.saved = { model: ctx.model, thinking: pi.getThinkingLevel(), tools: pi.getActiveTools() };
    s.deactivate = async () => {
      if (!s.orchestrator) return '当前不在调度模式。';
      s.orchestrator = false;
      s.status?.(undefined);
      s.status = null;
      s.wake = null;
      const saved = s.saved;
      s.saved = null;
      if (!saved) return '已退出调度模式。';
      pi.setActiveTools(saved.tools);
      if (saved.model) await pi.setModel(saved.model);
      pi.setThinkingLevel(saved.thinking);
      return `已退出调度模式，恢复原来的模型${saved.model ? `（${saved.model.provider}/${saved.model.id}）` : ''}与工具。流程状态不变，/forge-resume 可重新进入。`;
    };
  };

  /** 主会话切换到 /forge-config 中为 orchestrator（对话角色）设置的模型与思考级别 */
  const applyOrchestratorModel = async (ctx: ExtensionContext, config: FlowConfig) => {
    const r = resolveRoleModel(config, loadRoleSettings(roleSettingsPath()), 'orchestrator');
    if (r.model) {
      const [provider, ...rest] = r.model.split('/');
      const id = rest.join('/');
      const m = ctx.modelRegistry.getAvailable().find((x) => x.provider.toLowerCase() === provider!.toLowerCase() && x.id === id)
        ?? ctx.modelRegistry.find(provider!, id);
      if (!m) report(ctx, `orchestrator 的模型 ${r.model} 不可用，保留当前模型。执行 /forge-config 检查。`, 'warning');
      else if (!(await pi.setModel(m))) report(ctx, `无法切换到 ${r.model}（该 provider 没有配置凭据），保留当前模型。`, 'warning');
    }
    if (r.thinking) pi.setThinkingLevel(r.thinking);
  };

  const commandEnv = (ctx: ExtensionContext): CommandEnv => {
    const root = ctx.cwd;
    const s = session(root);
    s.notify = (m, l) => report(ctx, m, l);
    return {
      root, packageRoot: PACKAGE_ROOT,
      ui: ctx.hasUI ? { select: (t, o) => ctx.ui.select(t, o), input: (t, p) => ctx.ui.input(t, p), notify: (m, l) => ctx.ui.notify(m, l) } : null,
      engine: () => engineFor(root),
      store: () => s.handle?.store ?? new StateStore(root),
      roleSettings: () => loadRoleSettings(roleSettingsPath()),
      availableModels: () => availableModels(ctx).map((m) => m.ref),
      activateOrchestrator: async () => {
        const config = engineFor(root).config;
        enterManagedMode(ctx, s);
        s.orchestrator = true;
        registerFlowTools();
        const registered = new Set(pi.getAllTools().map((t) => t.name));
        pi.setActiveTools(config.activeTools('orchestrator').filter((t) => registered.has(t)));
        await applyOrchestratorModel(ctx, config);
        // 主会话正忙时排在这一轮之后（Pi 1.0.0 sendUserMessage 总会触发一轮）
        if (ctx.hasUI) s.wake = (text) => pi.sendUserMessage(text, { deliverAs: 'followUp' });
        // 实时进度：只在终端界面显示状态栏，随引擎状态变化（节流）刷新，退出调度模式时清除
        if (ctx.mode === 'tui') {
          s.status = (text) => ctx.ui.setStatus('pi-forge', text);
          s.status(statusLine(engineFor(root).store, config) ?? undefined);
        }
      },
      deactivateOrchestrator: () => (s.deactivate ? s.deactivate() : '当前不在调度模式。'),
      waitForIdle: !ctx.hasUI,
      // 需求讨论开始时让主 agent 先提问（只在终端界面；Pi 1.0.0 sendUserMessage 总会触发一轮，忙时作为 followUp 排队）
      ...(ctx.hasUI ? { startConversation: (text: string) => pi.sendUserMessage(text, { deliverAs: 'followUp' }) } : {}),
      dependencies: () => ({ piVersion: VERSION, packageRoots: packageRoots(root, getAgentDir()) }),
    };
  };

  // orchestrator 工具只在已初始化 pi-forge 的项目中注册，避免影响普通 pi 会话；在空仓库里 /forge-build 初始化后进入调度模式时再注册
  let flowToolsRegistered = false;
  const registerFlowTools = () => {
    if (flowToolsRegistered) return;
    flowToolsRegistered = true;
    const readParams = Type.Object({
      path: Type.String({ minLength: 1, description: '仓库内的文件或目录路径' }),
      ref: Type.Optional(Type.String({ description: '主分支或存在的流程分支；默认使用活动流程的集成分支' })),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: '起始行号，从 1 开始' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: '最多读取的行数' })),
    }, { additionalProperties: false });
    pi.registerTool(tolerantArgs({
      name: 'forge_read', label: 'forge_read', description: '从集成分支读取 PRD、原型与产物；目录列出内容，图片作为附件，文本上限为 2000 行或 50 KiB，截断时给出下一次 offset。',
      parameters: readParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = forgeRead(ctx.cwd, checked<ForgeReadInput>(readParams, p, 'forge_read'), h);
        if (r.kind === 'image') {
          return { content: [{ type: 'text' as const, text: `图片 ${r.path}（分支 ${r.ref}，${r.mimeType}）` }, { type: 'image' as const, mimeType: r.mimeType, data: r.data }], details: { ref: r.ref, path: r.path, kind: r.kind } };
        }
        return toolResult(r.text, { ref: r.ref, path: r.path, kind: r.kind, ...(r.nextOffset !== undefined ? { nextOffset: r.nextOffset } : {}) });
      },
    }));
    pi.registerTool(tolerantArgs({
      name: 'forge_spec', label: 'forge_spec', description: 'P0 与用户确认后提交 requirements、screens、permissions、glossary 四份完整规格。spec-lint 拒绝时修正重提；通过后等待用户批准。',
      parameters: SpecParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowSpec(ctx.cwd, h.store, h.config, checked(SpecParams, p, 'forge_spec'));
        return toolResult(r.text, r.details);
      },
    }));
    pi.registerTool(tolerantArgs({
      name: 'forge_change', label: 'forge_change', description: '在做完的项目上加小功能：与用户商量后提交 1 到 3 个 task 的迷你计划（title、description、tasks[]：title、writes、ac、可选 id/depends_on/layers/module）。程序校验通过后直接开始实施（不经 P0/P1 批准）：实现者实现、审查者审查、合入主分支，结束前程序建“更新架构图与契约”任务，最后由验收者确认。改动更大时让用户用 /forge-build。',
      parameters: ChangeParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowChange(ctx.cwd, h.store, h.config, checked(ChangeParams, p, 'forge_change'), h.engine);
        return toolResult(r.text, r.details);
      },
    }));
    pi.registerTool(tolerantArgs({
      name: 'forge_change_request', label: 'forge_change_request', description: '计划批准后需要修改已有契约或计划时提交变更请求（what、why、impact）：程序派 architect 起草修订，修订先交给你审核（forge_decide），必要时转交用户。同一时间只能有一个未结束的变更请求。',
      parameters: ChangeRequestParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowChangeRequestMain(ctx.cwd, h.store, h.config, checked(ChangeRequestParams, p, 'forge_change_request'));
        return toolResult(r.text, r.details);
      },
    }));
    pi.registerTool(tolerantArgs({
      name: 'forge_status', label: 'forge_status', description: '只读：当前流程、阶段、任务计数、可派发与失败任务摘要、等待用户处理的事项。',
      parameters: Type.Object({}),
      async execute(_id, _p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        return toolResult(statusText(h.store, h.engine, activeFlowId(h.store)));
      },
    }));
    pi.registerTool(tolerantArgs({
      name: 'forge_resolve_timeout', label: 'forge_resolve_timeout', description: '任务运行超过时间预算被结束后，看过 forge_status 里的材料再调用：continue 接着原会话做，restart 换个思路从头做（保留工作区），block 交给用户。',
      parameters: ResolveTimeoutParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowResolveTimeout(h.store, h.engine, checked(ResolveTimeoutParams, p, 'forge_resolve_timeout'));
        return toolResult(r.text, r.details);
      },
    }));
    pi.registerTool(tolerantArgs({
      name: 'forge_decide', label: 'forge_decide', description: '程序交给你决定的事（forge_status 的"等你决定"）：阻塞的任务 retry 重新做或 accept 放行，门禁用尽的阶段 accept 放行进入签收，变更请求的修订 approve 批准或 reject 打回；解决不了的 user 转交用户。note 必填。',
      parameters: DecideParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowDecide(ctx.cwd, h.store, h.config, h.engine, checked(DecideParams, p, 'forge_decide'));
        return toolResult(r.text, r.details);
      },
    }));
    pi.registerTool(tolerantArgs({
      name: 'forge_wait', label: 'forge_wait', description: '等待任务状态变化或超时，返回精简摘要（不含 subagent 的对话）。',
      parameters: WaitParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowWait(h.store, h.engine, checked(WaitParams, p, 'forge_wait'), h.config);
        return toolResult(r.text, r.details);
      },
    }));

    // 主 agent 的结构化笔记与历史检索（第五轮）：笔记跨流程保留在 .forge/notes/main.json
    pi.registerTool(tolerantArgs({
      name: 'notes', label: 'notes', description: `${NOTES_DESCRIPTION} 主会话的笔记跨流程保留：记录用户的偏好、讨论的结论、进行中的事项。`,
      parameters: NotesParams,
      async execute(_id, p, _s, _u, ctx) {
        const params = checked<{ action: 'read' | 'update'; ops?: Parameters<typeof applyNoteOps>[1] }>(NotesParams, p, 'notes');
        const store = mainStore(ctx.cwd);
        if (params.action === 'read') return toolResult(renderNotes(store.readNotes(MAIN_NOTES_REL), '主会话笔记'));
        if (!params.ops?.length) throw new Error('update 需要 ops：每条写 section、op 与 text / index / items。');
        try {
          const n = await store.writeNotes(MAIN_NOTES_REL, (cur) => { applyNoteOps(cur, params.ops!); return cur; }, { actor: 'orchestrator', reason: '更新主会话笔记' });
          return toolResult(`已更新。\n${renderNotes(n, '主会话笔记')}`);
        } catch (e) {
          if (e instanceof NotesError) throw new Error(e.message);
          throw e;
        }
      },
    }));
    pi.registerTool(tolerantArgs({
      name: 'history', label: 'history', description: HISTORY_DESCRIPTION,
      parameters: HistoryParams,
      async execute(_id, p, _s, _u, ctx) {
        const file = ctx.sessionManager.getSessionFile();
        return toolResult(historyTool(file ? [file] : [], checked(HistoryParams, p, 'history')).text);
      },
    }));
  };
  const mainStore = (cwd: string) => sessions.get(cwd)?.handle?.store ?? new StateStore(cwd);
  if (initialized(process.cwd())) registerFlowTools();
  // 笔记放回上下文与压缩：每次按当前目录是否已初始化决定
  installMemory(pi, {
    active: (ctx) => initialized(ctx.cwd),
    notesMessage: (ctx, near) => notesContextMessage(mainStore(ctx.cwd).readNotes(MAIN_NOTES_REL), { title: '主会话笔记', nearCompaction: near }),
    compactAt: (ctx) => { try { return loadProjectConfig(ctx.cwd).config.compactAt; } catch { return 0.7; } },
  });

  pi.on('session_start', (_e, ctx) => {
    if (!initialized(ctx.cwd)) return;
    try {
      const flow = new StateStore(ctx.cwd).readState().active_flow;
      if (flow) report(ctx, `pi-forge：检测到进行中的流程 ${flow}。执行 /forge-resume 恢复并进入调度模式；/forge-status 查看进度。`);
    } catch (e) {
      report(ctx, `pi-forge：读取状态失败（${(e as Error).message}），请执行 /forge doctor。`, 'warning');
    }
  });

  // 调度模式：每轮注入状态与唯一允许的下一步，并记录轮开始时主工作区的改动
  pi.on('before_agent_start', (event, ctx) => {
    const s = sessions.get(ctx.cwd);
    if (!s?.orchestrator || !s.handle) return;
    const { store, engine, config } = s.handle;
    s.driftBefore = dirtyFiles(ctx.cwd);
    const flowId = store.readState().active_flow;
    const flow = flowId ? store.readFlow(flowId) : null;
    const skills = flow?.stage === 'P0'
      ? ['spec-from-prd', 'grilling'].map((name) => readFileSync(path.join(PACKAGE_ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim()).join('\n\n') : '';
    const injected = `${agentPrompt(ctx.cwd, 'orchestrator')}\n\n${skills}\n\n${turnContext(store, config.limits.max_parallel, engine.activeRuns().length, config, (f, t) => engine.pausedFor(f, t))}`;
    event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ''}\n\n${injected}`.trim();
  });

  // 主工作区在本轮期间出现 .forge/ 之外的新改动：视为越权（第 20 节第 6 条）
  // 主会话（orchestrator）的用量记入 runs（role=orchestrator，每个流程一条），成本统计与预算都能看到（第三轮后续 5）
  pi.on('message_end', async (event, ctx) => {
    const s = sessions.get(ctx.cwd);
    if (!s?.orchestrator || !s.handle || event.message['role'] !== 'assistant') return;
    try { await recordOrchestratorUsage(s, event.message); } catch { /* 记账失败不影响对话 */ }
  });

  pi.on('agent_end', async (_e, ctx) => {
    const s = sessions.get(ctx.cwd);
    if (!s?.orchestrator || !s.handle || !s.driftBefore) return;
    const drift = newDrift(s.driftBefore, dirtyFiles(ctx.cwd));
    s.driftBefore = null;
    if (!drift.length) return;
    const flow = s.handle.store.readState().active_flow;
    await s.handle.store.recordEvent({ flow, actor: 'orchestrator', type: 'violation', reason: `本轮期间主工作区出现改动：${drift.slice(0, 20).join('、')}`, data: { run: 'orchestrator', role: 'orchestrator', rule: 'main_workspace_drift', files: drift.slice(0, 50) } });
    report(ctx, `pi-forge：本轮期间主工作区出现了未经派发的改动（${drift.slice(0, 5).join('、')}${drift.length > 5 ? ' 等' : ''}），已记录为越权。如果是你本人修改的，可以忽略。`, 'warning');
  });

  // 调度模式下的 guard：orchestrator 只能读（read_paths 内），只能用 forge_* 调度工具，不能写
  pi.on('tool_call', async (event, ctx) => {
    const s = sessions.get(ctx.cwd);
    if (!s?.handle || !s.orchestrator) return;
    const { store, config, engine } = s.handle;
    const step = nextStep(store, config.limits.max_parallel, 0, config, (f, t) => engine.pausedFor(f, t));
    const r = await enforceToolCall({ toolName: event.toolName, input: event.input }, {
      config, role: 'orchestrator', cwd: ctx.cwd, workspaceRoot: ctx.cwd, mainRoot: ctx.cwd,
      ...(step.task ? { readyTaskId: step.task } : {}),
    }, store, { flow: store.readState().active_flow, task: null, run: 'orchestrator' });
    if (r.allow) return;
    return { block: true, reason: r.reason };
  });

  // 调度模式下工具结果里的密钥打码（第六轮 D4；子进程扩展同样处理）
  pi.on('tool_result', async (event, ctx) => {
    if (!sessions.get(ctx.cwd)?.orchestrator) return;
    const red = redactToolResult(event);
    if (!red) return;
    return { content: red.content, ...(red.structuredContent !== undefined ? { structuredContent: red.structuredContent } : {}) };
  });

  pi.on('session_shutdown', (_e, ctx) => {
    const h = sessions.get(ctx.cwd)?.handle;
    if (!h) return;
    // 引擎所在的 pi 退出（含 pi -p 收到 SIGTERM）时结束它拉起的子进程；子进程的 pi 收到 SIGTERM 会结束自己的 bash 进程组
    h.engine.killAll();
    releaseEngineLock(ctx.cwd);
  });

  pi.registerCommand('forge', {
    description: 'pi-forge 管理：status、next、resume、approve、reject、unblock、gate、doctor、init',
    getArgumentCompletions: (prefix) => ['status', 'report', 'next', 'resume', 'answer', 'accept', 'rules', 'knowledge', 'run', 'sync', 'budget', 'models', 'off', 'approve', 'reject', 'unblock', 'gate', 'abort', 'doctor', 'init', 'help']
      .filter((x) => x.startsWith(prefix.trim())).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      try {
        report(ctx, await runFlowCommand(args, commandEnv(ctx)));
      } catch (e) {
        report(ctx, `${(e as Error).message}${/未知子命令/.test((e as Error).message) ? '' : `\n${FLOW_USAGE.split('\n')[0]} /forge help`}`, 'error');
      }
    },
  });

  // 常用操作的独立命令（第五轮）：/forge-approve、/forge-reject、/forge-resume、/forge-status
  const shortcuts: [string, string, string][] = [
    ['forge-approve', 'approve', 'pi-forge：批准当前阶段（规划、最终合入主分支）或待批准的计划修订'],
    ['forge-reject', 'reject', 'pi-forge：打回需求、规划或计划修订并写明意见，主 agent 带着意见修改'],
    ['forge-resume', 'resume', 'pi-forge：会话丢失或进程被杀后恢复流程，并进入调度模式'],
    ['forge-status', 'status', 'pi-forge：当前阶段、进度、正在做什么、需要你处理什么（--detail 看完整任务列表）'],
  ];
  for (const [name, sub, description] of shortcuts) {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        try {
          report(ctx, await runFlowCommand(`${sub} ${args}`.trim(), commandEnv(ctx)));
        } catch (e) {
          report(ctx, (e as Error).message, 'error');
        }
      },
    });
  }

  pi.registerCommand('forge-build', {
    description: 'pi-forge：建新项目。需求文档放在 docs/ 下（可选，也可用 --prd/--prototype 指定），主会话先读文档、只问疑点，没有文档时详细问你',
    getArgumentCompletions: (prefix) => ['--prd', '--prototype'].filter((x) => x.startsWith(prefix.trim().split(' ').at(-1) ?? '')).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      try {
        report(ctx, await runFlowBuild(args, commandEnv(ctx)));
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });

  pi.registerCommand('forge-fix', {
    description: 'pi-forge：修复缺陷（实现者定位并修复 → 全量测试 → 验收者复现确认 → 直接合入主分支）',
    handler: async (args, ctx) => {
      try {
        report(ctx, await runFlowFix(args, commandEnv(ctx)));
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });

  pi.registerCommand('forge-change', {
    description: 'pi-forge：在做完的项目上加小功能（--from <yaml 计划文件>：1 到 3 个 task → 实现、审查、合入主分支 → 更新架构图与契约 → 验收者确认）',
    handler: async (args, ctx) => {
      try {
        report(ctx, await runFlowChange(args, commandEnv(ctx)));
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });

  pi.registerCommand('forge-config', {
    description: 'pi-forge 配置：为各角色设置模型与思考级别（effort）',
    getArgumentCompletions: (prefix) => ['show', 'models', 'set', 'unset', 'help']
      .filter((x) => x.startsWith(prefix.trim())).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      try {
        const { config } = loadProjectConfig(ctx.cwd);
        const ui = ctx.hasUI ? {
          select: (t: string, o: string[]) => ctx.ui.select(t, o),
          notify: (m: string, l?: 'info' | 'warning' | 'error') => ctx.ui.notify(m, l),
          // 只有终端界面能承载自定义组件；其他模式退回逐级菜单
          ...(ctx.mode === 'tui' ? { editTable: (rows: RoleRow[], tableModels: TableModel[]) => editRoleTable(ctx, rows, tableModels) } : {}),
        } : null;
        report(ctx, await runFlowConfig(args, { ui, models: availableModels(ctx), config, settingsPath: roleSettingsPath() }));
        // 换了模型的角色不再等被暂停的模型：立即继续
        sessions.get(ctx.cwd)?.handle?.engine.retryPaused();
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });
}

/** 用 ctx.ui.custom 承载角色表格 */
function editRoleTable(ctx: ExtensionContext, rows: RoleRow[], models: TableModel[]): Promise<RoleRow[] | null> {
  const table = new RoleTable(rows, models);
  return ctx.ui.custom<RoleRow[] | null>((tui, _theme, _kb, done) => ({
    render: (width) => table.render(width),
    handleInput: (data) => {
      const r = table.handleInput(data);
      if (r === 'save') done(table.rows);
      else tui.requestRender();
    },
    invalidate: () => {},
  }));
}

export { ORCHESTRATOR_TOOLS };
