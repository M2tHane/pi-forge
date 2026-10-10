// 来源：pi-flow src/tools/subagent-tools.ts @ 31f3f15
// subagent 使用的 forge_* 工具：forge_claim、forge_note、forge_submit、forge_block、forge_learn、notes、history，
// forge_sync 的共用同步实现见 module-tools.ts；旧验收与审查入口已删除。
// 纯业务实现，不依赖 Pi；由 pi-adapter 注册为 Pi 工具，测试中由 fake-subagent 直接调用。run token 只来自环境变量，模型看不到也不需要传。
import { Type, type Static } from 'typebox';
import type { StateStore } from '../core/state-store.ts';
import { KNOWLEDGE_CATEGORIES, type TaskFile } from '../core/schemas.ts';
import { KnowledgeError, learn, KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_PER_RUN } from '../core/knowledge.ts';
import { changedFiles, cleanStrayUntracked, snapshot } from '../core/worktree.ts';
import { git } from '../core/git.ts';
import { canAppendInterfaces } from '../core/state-machine.ts';
import { testAdjustEnabled, testAdjustments } from '../core/test-adjust.ts';
import { NOTES_DESCRIPTION, NotesError, NotesParams, applyNoteOps, renderNotes } from '../core/notes.ts';
import { HISTORY_DESCRIPTION, HistoryParams, formatSearch, loadHistory, readHistoryEntry, searchHistory } from '../core/history.ts';
import { listSessionFiles, sessionDirOf } from '../core/session-log.ts';
import { taskNotesRel } from '../core/state-store.ts';
import { scratchDir } from '../core/worktree.ts';
import { GUI_REASON, opensGui } from '../core/guard.ts';
import { SERVICE_READY_MAX_S, serviceCommands, serviceLog, serviceStatus, startService, stopService } from '../core/services.ts';
import { SCOPE_KINDS, SCOPE_PATHS_MAX, checkScope } from '../core/scope.ts';
import { SyncParams, flowSync } from './module-tools.ts';

export const NOTE_LIMIT = 8000;

export { RUN_ENV_KEYS, runEnvFrom, FlowToolError, checkRunOf, type RunEnv, type ToolContext, type ToolResult } from './tool-common.ts';
import { FlowToolError, actor, checkRun, rethrow, type ToolContext, type ToolResult } from './tool-common.ts';

export const ClaimParams = Type.Object({});
export const NoteParams = Type.Object({ text: Type.String({ minLength: 1, maxLength: NOTE_LIMIT, description: 'handoff 笔记：做到哪、下一步、踩过的坑、未决问题；需求讨论的意见也写在这里' }) });
export const SubmitParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 500, description: '一句话总结本次改动（只读任务：一句话结论）' }),
});
export const LearnParams = Type.Object({
  category: Type.Union(KNOWLEDGE_CATEGORIES.map((c) => Type.Literal(c)), { description: 'convention 约定、pitfall 坑、decision 决策、environment 环境、dependency 外部依赖' }),
  content: Type.String({ minLength: 8, maxLength: KNOWLEDGE_CONTENT_MAX, description: '一条可执行的经验：是什么、为什么、怎么做。不要写本任务的进度（那是 handoff）' }),
  scopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: '适用的 scope（workflow.yaml 中的名字）；与 paths 都不填表示全项目适用' })),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: '适用的路径 glob（相对仓库根），例如 src/server/orders/**' })),
});
export const BlockParams = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000, description: '为什么无法继续，需要用户决定什么' }) });

export function flowClaim(ctx: ToolContext): ToolResult {
  const t = checkRun(ctx);
  const cmds = t.verify.map((c) => `${c}：${ctx.config.commands[c] ?? '（未定义）'}`);
  const text = [
    `已确认：${ctx.env.flow}/${t.id}「${t.title}」由你（${ctx.env.role}，run ${ctx.env.run}）负责，租约到 ${t.lease!.expires_at}。`,
    `状态：${t.status}　工作目录：${t.worktree ?? '（无）'}　基线：${t.base_sha ?? '（无）'}`,
    `验收标准：\n${(t.ac ?? []).map((a) => `- ${a}`).join('\n') || '（无）'}`,
    `输入文件：\n${t.inputs.map((a) => `- ${a}`).join('\n') || '（无）'}`,
    `可写范围：\n${(t.conflict_files ?? t.writes).map((a) => `- ${a}`).join('\n')}`,
    `verify 命令：\n${cmds.map((a) => `- ${a}`).join('\n') || '（无）'}`,
    ...(t.last_failure ? [`上次未通过的原因：\n${t.last_failure}`] : []),
  ].join('\n\n');
  return { text, details: { task: t.id, status: t.status } };
}

export async function flowNote(ctx: ToolContext, p: Static<typeof NoteParams>): Promise<ToolResult> {
  checkRun(ctx);
  if (p.text.length > NOTE_LIMIT) throw new FlowToolError(`handoff 笔记超过 ${NOTE_LIMIT} 字，请精简后再写。`);
  await ctx.store.appendHandoff(ctx.env.flow, ctx.env.task, p.text, actor(ctx));
  return { text: '已写入 handoff。' };
}

export async function flowSubmit(ctx: ToolContext, p: Static<typeof SubmitParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (t.status !== 'in_progress') throw new FlowToolError(`任务当前是 ${t.status}，不能提交。`);
  if (!t.worktree || !t.base_sha) throw new FlowToolError('任务没有 worktree 或 base_sha，无法提交，请调用 forge_block 报告。');
  const stray = cleanStrayUntracked(t.worktree, t.conflict_files ?? [...t.writes, ...(t.shared ?? []), ...(canAppendInterfaces(t) ? ['docs/contracts/**'] : [])]);
  if (stray.length) {
    await ctx.store.appendHandoff(ctx.env.flow, t.id, `提交前程序清理了可写范围外、未被 git 跟踪的文件：${stray.slice(0, 20).join('、')}${stray.length > 20 ? ` 等 ${stray.length} 个` : ''}（多为测试或运行产生的数据；测试应把数据写到临时目录）`, 'forge-submit');
  }
  snapshot(t.worktree, `[${ctx.env.flow}/${t.id}] ${p.summary.split('\n')[0]}`);
  const diff = changedFiles(t.worktree, t.base_sha);
  // 模块之间的接口文档只能追加：有删除行（含修改）的接口文档由状态机拒绝（自己可写范围内的除外）
  const rewrites = canAppendInterfaces(t) ? interfaceRewrites(t.worktree, t.base_sha).filter((f) => !t.writes.some((w) => f.startsWith(w.replace(/\*\*$/, '')))) : [];
  // 适配已有测试：writes 之外只修改过的已有测试文件不算越界，记在任务上（验收时一并检查）
  const adjusted = testAdjustEnabled(ctx.config, t) ? testAdjustments(t.worktree, t.base_sha, t.writes) : [];
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: t.kind === 'acctest' ? 'checking' : 'awaiting_inputs', trigger: 'submit', actor: actor(ctx),
      facts: { token: ctx.env.token, diff_files: diff, interface_rewrites: rewrites, test_adjustments: adjusted } });
  } catch (e) {
    if (rewrites.length) rethrow(e, `接口文档只能追加。还原对已有内容的修改：git checkout ${t.base_sha} -- ${rewrites.join(' ')}，再只追加需要的调用；确需改已有接口时调用 forge_block 说明，由用户决定是否修订计划。`);
    rethrow(e, `只修改可写范围内的文件（登记的公共文件可以改；别的模块已有的测试可以改来适配，但不能新增或删除可写范围外的文件）。还原越界改动：新增的文件用 git rm <文件>，修改过或删除的文件用 git checkout ${t.base_sha} -- <文件>。先 forge_note 写 handoff，然后再次 forge_submit。`);
  }
  await ctx.store.appendHandoff(ctx.env.flow, t.id, `提交说明：${p.summary}`, actor(ctx));
  if (adjusted.length) await ctx.store.appendHandoff(ctx.env.flow, t.id, `修改了可写范围外的已有测试（适配接口变化）：${adjusted.join('、')}`, 'forge-submit');
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交');
  return { text: `已提交合并（改动 ${diff.length} 个文件${stray.length ? `；已清理可写范围外、未被跟踪的文件 ${stray.length} 个：${stray.slice(0, 5).join('、')}` : ''}）。合并时程序会跑全量测试。你的工作已完成，请直接结束，不要再调用工具。`, details: { files: diff, cleaned: stray } };
}

/** 相对基线删除或修改过已有行的接口文档 */
function interfaceRewrites(worktree: string, base: string): string[] {
  return git(worktree, ['diff', '--numstat', '--no-renames', base, 'HEAD', '--', 'docs/contracts']).split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([, del]) => del !== '0').map(([, , p]) => p!);
}

export async function flowLearn(ctx: ToolContext, p: Static<typeof LearnParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  try {
    const e = await learn(ctx.store, ctx.config, {
      category: p.category, content: p.content, scopes: p.scopes ?? [], paths: p.paths ?? [],
      source: { kind: 'agent', flow: ctx.env.flow, task: t.id, run: ctx.env.run, role: ctx.env.role }, status: 'active',
    }, actor(ctx));
    return { text: `已记入项目知识 ${e.id}，之后相关任务的提示中会看到它。`, details: { id: e.id } };
  } catch (e) {
    if (e instanceof KnowledgeError) throw new FlowToolError(`知识未保存：${e.message}`);
    throw e;
  }
}

export async function flowBlock(ctx: ToolContext, p: Static<typeof BlockParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'blocked', trigger: 'block', actor: actor(ctx), facts: { reason: p.reason } });
  } catch (e) { rethrow(e, '请写明原因后重试。'); }
  await ctx.store.updateRun(ctx.env.run, { outcome: 'blocked' }, actor(ctx), '阻塞');
  return { text: '已标记为阻塞，等待用户处理。请直接结束。' };
}

export const ServiceParams = Type.Object({
  action: Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('status'), Type.Literal('logs')]),
  name: Type.Optional(Type.String({ description: 'commands 里 serve 或 serve_* 命名的命令（start、stop、logs 需要）' })),
  ready: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.String()], { description: 'start 时等它就绪：本机端口号，或 http://localhost:<端口>/… 的地址' })),
  timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: SERVICE_READY_MAX_S, description: `等就绪的秒数（最多 ${SERVICE_READY_MAX_S}）` })),
});

/** 长时间运行的服务（第六轮 D2）：开发服务器、数据库等；本次运行结束时程序一并结束 */
export async function flowService(ctx: ToolContext, p: Static<typeof ServiceParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  const scratch = scratchDir(ctx.env.root, ctx.env.run);
  const names = serviceCommands(ctx.config.commands);
  if (p.action === 'status') {
    const list = serviceStatus(scratch);
    return { text: `${list.length ? list.map((s) => `${s.name}（${s.running ? '运行中' : '已退出'}，pid ${s.pid}）：${s.command}`).join('\n') : '没有启动的服务。'}\n可启动：${names.join('、') || '（commands 里没有 serve 或 serve_* 命令）'}` };
  }
  if (!p.name) throw new FlowToolError(`${p.action} 需要 name。`);
  if (p.action === 'logs') {
    const log = serviceLog(scratch, p.name);
    if (log === null) throw new FlowToolError(`没有启动过服务 ${p.name}。`);
    return { text: log || '（日志为空）' };
  }
  if (p.action === 'stop') {
    const s = stopService(scratch, p.name);
    return { text: s ? `已结束服务 ${p.name}。` : `服务 ${p.name} 没有在运行。` };
  }
  if (!names.includes(p.name)) {
    throw new FlowToolError(`只能启动 workflow.yaml commands 里 serve 或 serve_* 命名的命令（${names.join('、') || '当前没有'}）；需要新的服务命令写进 handoff，由主 agent 或用户补到 commands。`);
  }
  const command = ctx.config.commands[p.name]!;
  if (opensGui(command.split(/\s+/).filter(Boolean), ctx.config.raw.gui_commands ?? [])) throw new FlowToolError(GUI_REASON);
  const r = await startService({ name: p.name, command, cwd: t.worktree ?? ctx.env.root, scratch, ...(p.ready !== undefined ? { ready: p.ready } : {}), ...(p.timeout_s ? { timeoutS: p.timeout_s } : {}) });
  if (!r.ok) throw new FlowToolError(`${r.error}。${r.log ? `\n日志末尾：\n${r.log}` : ''}`);
  const state = r.ready === null ? '已启动（没给 ready，没等就绪）' : r.ready ? '已就绪' : `已启动，但 ${p.timeout_s ?? SERVICE_READY_MAX_S} 秒内没有就绪（仍在运行，可以用 logs 查看）`;
  return { text: `服务 ${p.name}（${command}）${state}，pid ${r.record.pid}。本次运行结束时程序会结束它；用完可以 stop。${r.log ? `\n日志末尾：\n${r.log}` : ''}`, details: { pid: r.record.pid } };
}

export const RequestScopeParams = Type.Object({
  paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: SCOPE_PATHS_MAX, description: '要追加的可写路径或 glob（相对仓库根），尽量具体，例如 src/shared/date.ts 或 src/server/export/**' }),
  reason: Type.String({ minLength: 4, maxLength: 1000, description: '为什么本任务必须改这些文件' }),
});

/** 申请追加可写范围（第六轮 D3）：不与其他未完成任务重叠的程序直接批准；重叠的交给主会话决定 */
export async function flowRequestScope(ctx: ToolContext, p: Static<typeof RequestScopeParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (!SCOPE_KINDS.has(t.kind)) throw new FlowToolError('只有实现与修复任务可以申请追加可写范围；需要越界时用 forge_block 说明。');
  if (t.scope_request) throw new FlowToolError(`已有一份申请（${t.scope_request.paths.join('、')}）等主会话决定，先做范围内的部分，稍后用 forge_claim 查看可写范围。`);
  const paths = [...new Set(p.paths.map((x) => x.trim()))].filter((x) => !t.writes.includes(x));
  if (!paths.length) return { text: '这些路径已经在可写范围内。' };
  const c = checkScope(t, ctx.store.listTasks(ctx.env.flow), paths, ctx.config.role(ctx.env.role).writes);
  if (c.invalid.length) throw new FlowToolError(`不能申请：${c.invalid.join('；')}`);
  if (!c.conflicts.length && !c.outsideRole.length) {
    await ctx.store.grantScope(ctx.env.flow, t.id, { paths, reason: p.reason, by: 'program', run: ctx.env.run }, actor(ctx));
    return { text: `已批准，可写范围追加：${paths.join('、')}。现在可以修改这些文件了。`, details: { granted: paths } };
  }
  const conflicts = [...c.conflicts.map((x) => `${x.path}（与 ${x.task} 的范围重叠）`), ...c.outsideRole.map((x) => `${x}（超出角色 ${ctx.env.role} 的范围）`)];
  await ctx.store.setScopeRequest(ctx.env.flow, t.id, { paths, reason: p.reason, conflicts, run: ctx.env.run }, actor(ctx), `申请追加可写范围，等主会话决定：${conflicts.join('、')}；${p.reason}`);
  return { text: `与其他未完成任务的范围重叠或超出角色范围，已交给主会话决定：${conflicts.join('、')}。先做范围内的部分；稍后用 forge_claim 查看可写范围是否已追加。做不下去就写 handoff 后 forge_block。`, details: { pending: paths } };
}

/** 结构化笔记（第五轮）：本任务所有运行共用一份 */
export async function flowNotes(ctx: ToolContext, p: Static<typeof NotesParams>): Promise<ToolResult> {
  checkRun(ctx);
  const rel = taskNotesRel(ctx.env.flow, ctx.env.task);
  if (p.action === 'read') return { text: renderNotes(ctx.store.readNotes(rel)) };
  if (!p.ops?.length) throw new FlowToolError('update 需要 ops：每条写 section、op 与 text / index / items。');
  try {
    const n = await ctx.store.writeNotes(rel, (cur) => { applyNoteOps(cur, p.ops!); return cur; }, { actor: actor(ctx), flow: ctx.env.flow, task: ctx.env.task, reason: '更新笔记' });
    return { text: `已更新。\n${renderNotes(n)}` };
  } catch (e) {
    if (e instanceof NotesError) throw new FlowToolError(e.message);
    throw e;
  }
}

/** 本任务所有运行的会话文件（返工、恢复之前的历史也能查到） */
export function taskSessionFiles(store: StateStore, root: string, flow: string, task: string): string[] {
  const runs = store.listRuns().filter((r) => r.flow === flow && r.task === task).sort((a, b) => a.started_at.localeCompare(b.started_at));
  return runs.flatMap((r) => listSessionFiles(sessionDirOf(root, r.run_id)));
}

export function historyTool(files: readonly string[], p: Static<typeof HistoryParams>): ToolResult {
  const entries = loadHistory(files);
  if (p.action === 'search') {
    if (!p.query) throw new FlowToolError('search 需要 query。');
    return { text: formatSearch(searchHistory(entries, p.query, p.limit ?? 10), entries.length) };
  }
  if (!p.id) throw new FlowToolError('read 需要 id（search 结果中 # 后面的编号）。');
  return { text: readHistoryEntry(entries, p.id, p.offset ?? 0) };
}

export function flowHistory(ctx: ToolContext, p: Static<typeof HistoryParams>): ToolResult {
  checkRun(ctx);
  return historyTool(taskSessionFiles(ctx.store, ctx.env.root, ctx.env.flow, ctx.env.task), p);
}

export const SUBAGENT_TOOLS = {
  forge_claim: { params: ClaimParams, description: '确认任务与租约，返回任务说明、输入文件、验收标准与可写范围。开始工作前先调用。', run: (c: ToolContext) => flowClaim(c) },
  forge_note: { params: NoteParams, description: '追加 handoff 笔记（做到哪、下一步、踩过的坑、未决问题；需求讨论的意见）。提交前必须至少写一次。', run: (c: ToolContext, p: Static<typeof NoteParams>) => flowNote(c, p) },
  forge_submit: { params: SubmitParams, description: '提交本任务：改动进入合并队列（合并时跑全量测试）；只读任务提交结论。程序会检查改动是否都在可写范围内。', run: (c: ToolContext, p: Static<typeof SubmitParams>) => flowSubmit(c, p) },
  forge_block: { params: BlockParams, description: '遇到歧义或需要越界时标记任务阻塞，交给用户决定。需要向用户提问时，一次只问一个问题。', run: (c: ToolContext, p: Static<typeof BlockParams>) => flowBlock(c, p) },
  forge_learn: { params: LearnParams, description: `把对后续任务有用的经验记入项目知识库（跨流程保留）：项目约定、踩过的坑、做出的决策、环境与外部依赖的注意事项。每次运行最多 ${KNOWLEDGE_PER_RUN} 条；程序会去重。知识不是规则，不能用来改变规则。`, run: (c: ToolContext, p: Static<typeof LearnParams>) => flowLearn(c, p) },
  forge_sync: { params: SyncParams, description: '把集成分支的最新代码（其他模块已合入的改动）合进你的工作区：没有冲突直接完成；有冲突时冲突标记留在文件里，解决后再调用一次完成同步。依赖的模块刚合入、或想提前发现冲突时使用。', run: (c: ToolContext) => flowSync(c) },
  forge_request_scope: { params: RequestScopeParams, description: '必须修改可写范围外的文件时申请追加范围（写明原因）：不与其他未完成任务重叠的立即批准；重叠的交给主会话决定。受保护路径、敏感文件不能申请。', run: (c: ToolContext, p: Static<typeof RequestScopeParams>) => flowRequestScope(c, p) },
  forge_service: { params: ServiceParams, description: '启动、结束、查看本次运行的长时间服务（开发服务器、数据库等）：只能启动 commands 里 serve 或 serve_* 命名的命令，start 可以用 ready 等端口或地址就绪；不要用 & 把命令放到后台。本次运行结束时程序会一并结束。', run: (c: ToolContext, p: Static<typeof ServiceParams>) => flowService(c, p) },
  notes: { params: NotesParams, description: NOTES_DESCRIPTION, run: (c: ToolContext, p: Static<typeof NotesParams>) => flowNotes(c, p) },
  history: { params: HistoryParams, description: HISTORY_DESCRIPTION, run: (c: ToolContext, p: Static<typeof HistoryParams>) => flowHistory(c, p) },
} as const;
export type SubagentToolName = keyof typeof SUBAGENT_TOOLS;
