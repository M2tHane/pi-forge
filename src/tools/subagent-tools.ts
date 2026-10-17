// subagent 使用的 forge_* 工具：forge_claim、forge_note、forge_submit、forge_block、forge_learn、notes、history，
// forge_sync 的共用同步实现见 module-tools.ts；旧验收与审查入口已删除。
// 纯业务实现，不依赖 Pi；由 pi-adapter 注册为 Pi 工具，测试中由 fake-subagent 直接调用。run token 只来自环境变量，模型看不到也不需要传。
import { listResources, resourceEnv } from '../core/workspace/resources.ts';
import { gitOk } from '../core/state/git.ts';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import type { StateStore } from '../core/state/state-store.ts';
import { KNOWLEDGE_CATEGORIES, type TaskFile } from '../core/state/schemas.ts';
import { KnowledgeError, learn, KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_PER_RUN } from '../core/engine/knowledge.ts';
import { changedFiles, cleanStrayUntracked, removeWorktree, snapshot } from '../core/workspace/worktree.ts';
import { canFinishWithoutChanges } from '../core/state/state-machine.ts';
import { testAdjustEnabled, testAdjustments } from '../core/verify/test-adjust.ts';
import { NOTES_DESCRIPTION, NotesError, NotesParams, applyNoteOps, renderNotes } from '../core/engine/notes.ts';
import { HISTORY_DESCRIPTION, HistoryParams, formatSearch, loadHistory, readHistoryEntry, searchHistory } from '../core/ops/history.ts';
import { listSessionFiles, sessionDirOf } from '../core/engine/session-log.ts';
import { taskNotesRel } from '../core/state/state-store.ts';
import { scratchDir } from '../core/workspace/worktree.ts';
import { GUI_REASON, opensGui } from '../core/security/guard.ts';
import { SERVICE_READY_MAX_S, serviceCommands, serviceLog, serviceStatus, startService, stopService } from '../core/workspace/services.ts';
import { SyncParams, flowSync, syncTaskInputs } from './module-tools.ts';
import { checkArchitecture, isArchitectTask } from '../core/plan/plan-flow.ts';
import { ChangeError, changeOfTask, proposeChange, requestChange } from '../core/plan/change-flow.ts';
import { classifyIssues, effectiveVerdict, mustOf, validateConfirm } from '../core/stage/review.ts';
import { openWriteAllowed, opensWrites } from '../core/state/paths.ts';
import { REVIEW_FILES, SUGGESTIONS_PATH, decideReview, readReviewEvidence, type ReviewConfirmFile, type ReviewInputFile, type ReviewReportFile } from '../core/stage/review-flow.ts';
import { QA_FILES } from '../core/stage/stage-qa.ts';
import { addDependencyForWorktree, linkedDeps } from '../core/workspace/shared-env.ts';
import { prepareWorkspaceRecorded } from '../core/workspace/workspace.ts';

export const NOTE_LIMIT = 8000;

export { RUN_ENV_KEYS, runEnvFrom, FlowToolError, checkRunOf, type RunEnv, type ToolContext, type ToolResult } from './tool-common.ts';
import { FlowToolError, actor, checkRun, rethrow, type ToolContext, type ToolResult } from './tool-common.ts';

export const ClaimParams = Type.Object({});
export const NoteParams = Type.Object({ text: Type.String({ minLength: 1, description: 'handoff 笔记：做到哪、下一步、踩过的坑、未决问题；需求讨论的意见也写在这里' }) });
export const SubmitParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 500, description: '一句话总结本次改动（只读任务：一句话结论）' }),
});
export const LearnParams = Type.Object({
  category: Type.Union(KNOWLEDGE_CATEGORIES.map((c) => Type.Literal(c)), { description: 'convention 约定、pitfall 坑、decision 决策、environment 环境、dependency 外部依赖' }),
  content: Type.String({ minLength: 8, maxLength: KNOWLEDGE_CONTENT_MAX, description: '一条可执行的经验：是什么、为什么、怎么做。不要写本任务的进度（那是 handoff）' }),
  scopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: '适用的 scope（workflow.yaml 中的名字）；与 paths 都不填表示全项目适用' })),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: '适用的路径 glob（相对仓库根），例如 src/server/orders/**' })),
});
export const BlockParams = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000, description: '为什么无法继续，需要决定什么' }) });

export function flowClaim(ctx: ToolContext): ToolResult {
  const t = checkRun(ctx);
  const cmds = t.verify.map((c) => `${c}：${ctx.config.commands[c] ?? '（未定义）'}`);
  const text = [
    `已确认：${ctx.env.flow}/${t.id}「${t.title}」由你（${ctx.env.role}，run ${ctx.env.run}）负责，租约到 ${t.lease!.expires_at}。`,
    `状态：${t.status}　工作目录：${t.worktree ?? '（无）'}　基线：${t.base_sha ?? '（无）'}`,
    `验收标准：\n${(t.ac ?? []).map((a) => `- ${a}`).join('\n') || '（无）'}`,
    opensWrites(t)
      ? `计划的改动范围（用于调度与合并冲突归属；工作区内任何文件都可以改，只有受保护路径与 docs/PRD.md、docs/prototype/ 除外）：\n${t.writes.map((a) => `- ${a}`).join('\n')}`
      : `可写范围：\n${(t.conflict_files ?? t.writes).map((a) => `- ${a}`).join('\n')}`,
    `verify 命令：\n${cmds.map((a) => `- ${a}`).join('\n') || '（无）'}`,
    ...(t.last_failure ? [`上次未通过的原因：\n${t.last_failure}`] : []),
  ].join('\n\n');
  return { text, details: { task: t.id, status: t.status } };
}

export async function flowNote(ctx: ToolContext, p: Static<typeof NoteParams>): Promise<ToolResult> {
  checkRun(ctx);
  // 超长的截断保存，不拒绝
  const cut = p.text.length > NOTE_LIMIT;
  await ctx.store.appendHandoff(ctx.env.flow, ctx.env.task, cut ? `${p.text.slice(0, NOTE_LIMIT)}\n……（超过 ${NOTE_LIMIT} 字，后面的已截断）` : p.text, actor(ctx));
  return { text: cut ? `已写入 handoff（超过 ${NOTE_LIMIT} 字，只保存了前 ${NOTE_LIMIT} 字）。` : '已写入 handoff。' };
}

export async function flowSubmit(ctx: ToolContext, p: Static<typeof SubmitParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (t.status !== 'in_progress') throw new FlowToolError(`任务当前是 ${t.status}，不能提交。`);
  if (!t.worktree || !t.base_sha) throw new FlowToolError('任务没有 worktree 或 base_sha，无法提交，请调用 forge_block 报告。');
  // impl / fix 可以在任何位置新建文件，只清理落在不能改的位置（PRD 与原型）的未跟踪文件
  const stray = opensWrites(t)
    ? cleanStrayUntracked(t.worktree, (f) => openWriteAllowed(f))
    : cleanStrayUntracked(t.worktree, t.conflict_files ?? [...t.writes, ...(t.shared ?? [])]);
  if (stray.length) {
    await ctx.store.appendHandoff(ctx.env.flow, t.id, `提交前程序清理了可写范围外、未被 git 跟踪的文件：${stray.slice(0, 20).join('、')}${stray.length > 20 ? ` 等 ${stray.length} 个` : ''}（多为测试或运行产生的数据；测试应把数据写到临时目录）`, 'forge-submit');
  }
  // 上一次提交时同步出的冲突还没收尾（MERGE_HEAD 还在）：由下面的同步检查冲突标记并完成合并提交
  const midMerge = gitOk(t.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (!midMerge) {
    snapshot(t.worktree, `[${ctx.env.flow}/${t.id}] ${p.summary.split('\n')[0]}`);
    // 没有改动（要做的已在集成分支上、文档无需更新）：不走合并（没有内容可合），直接完成，依赖它的任务照常推进
    if (!changedFiles(t.worktree, t.base_sha).length && canFinishWithoutChanges(t)) {
      try {
        await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'done', trigger: 'report', actor: actor(ctx), facts: { token: ctx.env.token, diff_files: [], structured_report: true } });
      } catch (e) { rethrow(e, '请调用 forge_block 报告。'); }
      await ctx.store.appendHandoff(ctx.env.flow, t.id, `提交说明（没有改动）：${p.summary}`, actor(ctx));
      removeWorktree(ctx.env.root, t.worktree, t.branch ?? undefined);
      await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交（没有改动）');
      return { text: `已记录：${p.summary.split('\n')[0]}。没有改动，任务视为完成。请直接结束，不要再调用工具。`, details: { files: [], no_changes: true } };
    }
  }
  // 架构阶段：缺必需文件或 docs/plan.md 的 yaml 区块不过时退回，其余只提醒
  const arch = isArchitectTask(t) ? checkArchitecture({ dir: t.worktree }) : null;
  const archWarnings = arch?.warnings.length ? `\n\n提醒（不影响提交，批准页上会列给用户）：\n${arch.warnings.map((w) => `- ${w}`).join('\n')}` : '';
  if (arch?.errors.length) throw new FlowToolError(`架构产出还不能提交（${arch.errors.length} 处），改好后再 forge_submit：\n${arch.errors.map((e) => `- ${e}`).join('\n')}${archWarnings}`);
  // 程序把集成分支同步进任务分支（别的任务已合入的改动）：有冲突时不提交，冲突标记留在文件里，交回原 agent 解决
  const synced = await syncTaskInputs(ctx.store, ctx.env.flow, t, actor(ctx));
  if (synced.conflicts.length) throw new FlowToolError(`提交前程序把集成分支（其他任务已合入的改动）同步进你的工作区，这些文件有冲突：${synced.conflicts.join('、')}。冲突标记留在文件里：保留双方的意图解决冲突、跑一下相关测试，再 forge_submit。`);
  const cur = ctx.store.readTask(ctx.env.flow, t.id);
  const diff = changedFiles(cur.worktree!, cur.base_sha!);
  // 适配已有测试：writes 之外只修改过的已有测试文件不算越界，记在任务上（验收时一并检查）
  const adjusted = testAdjustEnabled(ctx.config, cur) ? testAdjustments(cur.worktree!, cur.base_sha!, cur.writes) : [];
  // 需要审查的进 in_review（程序随后建 .rv），不需要的直接排队合并
  const reviewRequired = decideReview(ctx.store, ctx.config, ctx.env.flow, cur) !== 'skip';
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: reviewRequired ? 'in_review' : 'queued_merge', trigger: 'submit', actor: actor(ctx),
      facts: { token: ctx.env.token, diff_files: diff, test_adjustments: adjusted, review_required: reviewRequired } });
  } catch (e) {
    rethrow(e, `只修改可写范围内的文件（登记的公共文件可以改；别的模块已有的测试可以改来适配，但不能新增或删除可写范围外的文件）。还原越界改动：新增的文件用 git rm <文件>，修改过或删除的文件用 git checkout ${cur.base_sha} -- <文件>，然后再次 forge_submit。`);
  }
  await ctx.store.appendHandoff(ctx.env.flow, t.id, `提交说明：${p.summary}`, actor(ctx));
  if (adjusted.length) await ctx.store.appendHandoff(ctx.env.flow, t.id, `修改了可写范围外的已有测试（适配接口变化）：${adjusted.join('、')}`, 'forge-submit');
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交');
  const next = reviewRequired ? '接下来 reviewer 会读你的 diff 并运行本任务自己的测试；' : '';
  return { text: `已提交合并（改动 ${diff.length} 个文件${stray.length ? `；已清理可写范围外、未被跟踪的文件 ${stray.length} 个：${stray.slice(0, 5).join('、')}` : ''}）。${next}合并时不再跑测试，全量测试在阶段门禁运行。你的工作已完成，请直接结束，不要再调用工具。${archWarnings}`, details: { files: diff, cleaned: stray } };
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
  name: Type.Optional(Type.String({ description: '服务名（start、stop、logs 需要）；start 不给 command 时运行 commands.yaml 里同名的命令' })),
  command: Type.Optional(Type.String({ minLength: 1, description: 'start 时要运行的命令；不给时用 commands.yaml 里名为 name 的命令' })),
  ready: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.String()], { description: 'start 时等它就绪：本机端口号，或 http://localhost:<端口>/… 的地址' })),
  timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: SERVICE_READY_MAX_S, description: `等就绪的秒数（最多 ${SERVICE_READY_MAX_S}）` })),
});

/**
 * 服务的工作目录：只能是任务自己的 worktree；没有 worktree 时拒绝，**绝不回退到主工作区**（纯函数）。
 * stage-qa 与阶段审查有集成分支 HEAD 的临时 worktree，所以正常情况下不会走到拒绝。
 */
export function serviceCwd(task: Pick<TaskFile, 'id' | 'worktree'>, root: string): string {
  if (!task.worktree) throw new FlowToolError(`任务 ${task.id} 没有 worktree，不能启动服务：服务不会在主工作区里运行。请用 forge_block 说明。`);
  if (path.resolve(task.worktree) === path.resolve(root)) throw new FlowToolError(`任务 ${task.id} 的工作目录是主工作区，不能启动服务。请用 forge_block 说明。`);
  return task.worktree;
}

/** 长时间运行的服务（第六轮 D2）：开发服务器、数据库等；本次运行结束时程序一并结束 */
export async function flowService(ctx: ToolContext, p: Static<typeof ServiceParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  const scratch = scratchDir(ctx.env.root, ctx.env.run);
  const names = serviceCommands(ctx.config.commands);
  if (p.action === 'status') {
    const list = serviceStatus(scratch);
    return { text: `${list.length ? list.map((s) => `${s.name}（${s.running ? '运行中' : '已退出'}，pid ${s.pid}）：${s.command}`).join('\n') : '没有启动的服务。'}\ncommands.yaml 里的服务命令：${names.join('、') || '（没有 serve 或 serve_* 命令；可以用 command 参数直接给出命令）'}` };
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
  if (!/^[\w.-]+$/.test(p.name)) throw new FlowToolError(`服务名 ${p.name} 只能用字母、数字、下划线、点和短横线。`);
  const command = p.command ?? ctx.config.commands[p.name];
  if (!command) throw new FlowToolError(`commands.yaml 里没有命令 ${p.name}（服务命令：${names.join('、') || '没有'}）；用 command 参数直接给出要运行的命令。`);
  if (opensGui(command.split(/\s+/).filter(Boolean), ctx.config.guiCommands)) throw new FlowToolError(GUI_REASON);
  // 服务拿到本次运行分配的 PORT、FORGE_PORT_BASE、FORGE_DB_NAME、FORGE_TMP
  const res = listResources(ctx.env.root).find((e) => e.run === ctx.env.run);
  const r = await startService({ name: p.name, command, cwd: serviceCwd(t, ctx.env.root), scratch, ...(res ? { env: { ...process.env, ...resourceEnv(res) } } : {}),
    ...(p.ready !== undefined ? { ready: p.ready } : {}), ...(p.timeout_s ? { timeoutS: p.timeout_s } : {}) });
  if (!r.ok) throw new FlowToolError(`${r.error}。${r.log ? `\n日志末尾：\n${r.log}` : ''}`);
  const state = r.ready === null ? '已启动（没给 ready，没等就绪）' : r.ready ? '已就绪' : `已启动，但 ${p.timeout_s ?? SERVICE_READY_MAX_S} 秒内没有就绪（仍在运行，可以用 logs 查看）`;
  return { text: `服务 ${p.name}（${command}）${state}，pid ${r.record.pid}。本次运行结束时程序会结束它；用完可以 stop。${r.log ? `\n日志末尾：\n${r.log}` : ''}`, details: { pid: r.record.pid } };
}


export const AddDependencyParams = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 214, description: '依赖名，例如 left-pad 或 @scope/pkg' }),
  version: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: '版本或范围，例如 1.2.3、^1.2.0；不填取最新' })),
  dev: Type.Optional(Type.Boolean({ description: '是否开发依赖（devDependencies），默认否' })),
});
export const PrivateDepsParams = Type.Object({});

/** forge_add_dependency：缺依赖时装进共享构建环境（程序持锁、串行），并把依赖清单与锁文件的改动同步回本任务的 worktree */
export async function flowAddDependency(ctx: ToolContext, p: Static<typeof AddDependencyParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (!t.worktree) throw new FlowToolError('任务没有 worktree，不能追加依赖，请调用 forge_block 报告。');
  try {
    const text = await addDependencyForWorktree(ctx.env.root, ctx.config, t.worktree, { name: p.name, ...(p.version ? { version: p.version } : {}), ...(p.dev ? { dev: true } : {}) }, `${t.id}`);
    return { text, details: { name: p.name, version: p.version ?? null } };
  } catch (e) { throw new FlowToolError((e as Error).message); }
}

/** forge_private_deps：要升级、删除或改动已有依赖的版本时，把共享依赖目录换成本任务的私有副本（程序在 worktree 里运行 install），不影响别的任务 */
export async function flowPrivateDeps(ctx: ToolContext): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (!t.worktree) throw new FlowToolError('任务没有 worktree，请调用 forge_block 报告。');
  if (!linkedDeps(ctx.env.root, ctx.config, t.worktree).length) return { text: '依赖目录已经是本任务私有的（或没有共享环境），直接用包管理器安装即可。' };
  const r = await prepareWorkspaceRecorded(ctx.store, ctx.env.root, ctx.config, t.worktree, 'writable', { flow: ctx.env.flow, task: t.id, actor: actor(ctx) }, undefined, true);
  if (!r.ok) throw new FlowToolError(`私有依赖副本安装失败：${r.reason ?? ''}\n先检查依赖清单是否写对，再调用一次；仍然失败用 forge_block 说明。`);
  return { text: '已换成本任务的私有依赖副本（按你当前的依赖清单安装完毕）。之后可以直接用包管理器增删改依赖，不会影响别的任务。' };
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

export const ProposePlanParams = Type.Object({
  assumptions: Type.Optional(Type.Array(Type.Object({
    question: Type.String({ minLength: 1, maxLength: 500, description: '规格没说清的问题' }),
    decision: Type.String({ minLength: 1, maxLength: 1000, description: '采用的方案' }),
  }), { maxItems: 50, description: 'architect 默认的处理（"问题 → 采用的方案"），用户批准时逐条确认' })),
  extras: Type.Optional(Type.Array(Type.Object({
    what: Type.String({ minLength: 1, maxLength: 500 }),
    why: Type.String({ minLength: 1, maxLength: 1000 }),
  }), { maxItems: 50, description: '超出需求但不得不做的设计（安全、数据完整性）' })),
});

/** forge_propose_plan（变更请求的 architect task）：校验修订后的计划与差异，通过后变更请求进入 proposed */
export async function flowProposePlan(ctx: ToolContext, p: Static<typeof ProposePlanParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (t.kind !== 'doc' || !changeOfTask(ctx.store, ctx.env.flow, t.id)) throw new FlowToolError('只有变更请求的 architect task 用 forge_propose_plan；架构阶段直接 forge_submit，程序在提交时检查。');
  const c = await proposeChange(ctx.env.root, ctx.store, ctx.config, ctx.env.flow, t, { assumptions: p.assumptions ?? [], extras: p.extras ?? [] }, actor(ctx));
  if (!c.ok) throw new FlowToolError(c.text);
  return { text: c.text };
}

export const ChangeRequestParams = Type.Object({
  what: Type.String({ minLength: 1, maxLength: 2000, description: '要改什么：哪条契约、哪个接口或哪段计划，改成什么' }),
  why: Type.String({ minLength: 1, maxLength: 2000, description: '为什么必须改（引用规格的 AC 或遇到的具体问题）' }),
  impact: Type.String({ minLength: 1, maxLength: 4000, description: '影响分析：受影响的契约条目、task（已完成、进行中、未开始）、验收测试' }),
}, { additionalProperties: false });

/** forge_change_request（worker）：提交变更请求；自己的任务继续运行，做不下去就 forge_block */
export async function flowChangeRequest(ctx: ToolContext, p: Static<typeof ChangeRequestParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  try {
    const r = await requestChange(ctx.env.root, ctx.store, ctx.config, ctx.env.flow, p, `worker:${t.id}` as `worker:${string}`);
    return { text: `已提交变更请求 ${r.change.id}：程序派 architect（${r.task.id}）起草修订，修订经主会话（或用户）批准才生效。你自己的任务不受影响，可以继续做不依赖这处改动的部分；做不下去时调用 forge_block 说明。`, details: { change: r.change.id, task: r.task.id } };
  } catch (e) {
    if (e instanceof ChangeError) throw new FlowToolError(e.message);
    throw e;
  }
}

const ReviewIssue = Type.Object({
  level: Type.Union([Type.Literal('must'), Type.Literal('suggest')], { description: 'must 必须改；suggest 建议（不阻塞合并）' }),
  basis: Type.String({ minLength: 1, maxLength: 500, description: '出处：rule:<文件>#<条目>、ac:<编号>、contract:<位置> 或 defect:<什么输入下会出什么错>' }),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20, description: '涉及的文件（同一类问题合并成一条，列出所有文件）' })),
  file: Type.Optional(Type.String({ minLength: 1, description: '单个文件（与 files 二选一）' })),
  location: Type.String({ maxLength: 500, description: '函数名或行号范围' }),
  problem: Type.String({ minLength: 1, maxLength: 2000 }),
  expected: Type.String({ minLength: 1, maxLength: 2000, description: '期望怎么改' }),
}, { additionalProperties: false });
export const ReviewReportParams = Type.Object({
  verdict: Type.Union([Type.Literal('pass'), Type.Literal('changes')]),
  issues: Type.Array(ReviewIssue, { maxItems: 60, description: '没有问题提交空列表；程序给问题编号 R-1…' }),
}, { additionalProperties: false });
export const ReviewConfirmParams = Type.Object({
  items: Type.Array(Type.Object({
    id: Type.String({ pattern: '^R-[0-9]+$' }),
    resolved: Type.Boolean(),
    note: Type.Optional(Type.String({ maxLength: 1000, description: '清单之外的发现写在这里，交给阶段验收' })),
  }, { additionalProperties: false }), { maxItems: 60 }),
}, { additionalProperties: false });

/** 审查 task 自己：必须是进行中的 review task，且有 evidence 里的输入 */
type ReviewFlavor = { kind: 'review' | 'qa'; files: typeof REVIEW_FILES | typeof QA_FILES; report: string; confirm: string; what: string };
const REVIEW_FLAVOR: ReviewFlavor = { kind: 'review', files: REVIEW_FILES, report: 'forge_review_report', confirm: 'forge_review_confirm', what: '审查' };
const QA_FLAVOR: ReviewFlavor = { kind: 'qa', files: QA_FILES, report: 'forge_qa_report', confirm: 'forge_qa_confirm', what: '阶段验收' };

function reviewRun(ctx: ToolContext, f: ReviewFlavor = REVIEW_FLAVOR): { t: TaskFile; input: ReviewInputFile } {
  const t = checkRun(ctx);
  if (t.kind !== f.kind || t.status !== 'in_progress') throw new FlowToolError(`只有进行中的${f.kind === 'qa' ? '阶段验收（stage-qa）' : '审查'}任务可以提交${f.what}结论。`);
  const input = readReviewEvidence<ReviewInputFile>(ctx.store, ctx.env.flow, t.id, f.files.input);
  if (!input) throw new FlowToolError('找不到本轮审查的输入记录，请调用 forge_block 说明。');
  return { t, input };
}

async function finishReview(ctx: ToolContext, t: TaskFile): Promise<void> {
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'done', trigger: 'report', actor: actor(ctx), facts: { token: ctx.env.token, diff_files: [], structured_report: true } });
  } catch (e) { rethrow(e, '审查结论没有提交成功，请重试。'); }
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交审查结论');
}

/**
 * forge_review_report（第一轮）：程序给问题编号，级别与出处照 reviewer 写的保存；有 must 就是 changes，没有就是 pass。
 * 结论存为 evidence，由引擎的 resolveReviews 推进原 task。
 */
export const flowReviewReport = (ctx: ToolContext, p: Static<typeof ReviewReportParams>): Promise<ToolResult> => submitReport(ctx, p, REVIEW_FLAVOR);
/** forge_qa_report（第一轮）：规则同 forge_review_report；结论存为 qa-report.json，由 resolveQa 处理 */
export const flowQaReport = (ctx: ToolContext, p: Static<typeof ReviewReportParams>): Promise<ToolResult> => submitReport(ctx, p, QA_FLAVOR);

async function submitReport(ctx: ToolContext, p: Static<typeof ReviewReportParams>, f: ReviewFlavor): Promise<ToolResult> {
  const { t, input } = reviewRun(ctx, f);
  if (input.prior_must.length) throw new FlowToolError(`这是确认轮：只能用 ${f.confirm} 逐条回答上一轮的问题清单，不能提出新问题。`);
  const inputs = p.issues.map((i, n) => {
    const files = i.files ?? (i.file ? [i.file] : []);
    if (!files.length) throw new FlowToolError(`第 ${n + 1} 个问题没有写 files（涉及的文件）。`);
    return { level: i.level, basis: i.basis, files, location: i.location, problem: i.problem, expected: i.expected };
  });
  const issues = classifyIssues(inputs);
  const verdict = effectiveVerdict(issues);
  const file: ReviewReportFile = { round: input.round, requested: p.verdict, verdict, issues, head: input.head };
  await ctx.store.saveEvidence(ctx.env.flow, t.id, f.files.report, JSON.stringify(file, null, 2), actor(ctx));
  await finishReview(ctx, t);
  const must = mustOf(issues);
  const notes = [
    p.verdict === 'changes' && !must.length ? '没有 must，按 pass 处理。' : '',
    p.verdict === 'pass' && must.length ? `你写的是 pass 但提交了 ${must.length} 条 must，程序按 changes 处理。` : '',
  ].filter(Boolean);
  return { text: `已提交审查结论：${verdict === 'pass' ? '通过' : `需要修改（must ${must.length} 条：${must.map((m) => m.id).join('、')}）`}；suggest ${issues.length - must.length} 条会记入 ${SUGGESTIONS_PATH}。${notes.join('')}你的工作已完成，请直接结束，不要再调用工具。`, details: { verdict, must: must.map((m) => m.id) } };
}

/** forge_review_confirm（第二轮及以后）：只回答上一轮 must 的编号，必须覆盖全部；没有新增问题的字段 */
export const flowReviewConfirm = (ctx: ToolContext, p: Static<typeof ReviewConfirmParams>): Promise<ToolResult> => submitConfirm(ctx, p, REVIEW_FLAVOR);
/** forge_qa_confirm（第二轮及以后）：规则同 forge_review_confirm；结论存为 qa-confirm.json */
export const flowQaConfirm = (ctx: ToolContext, p: Static<typeof ReviewConfirmParams>): Promise<ToolResult> => submitConfirm(ctx, p, QA_FLAVOR);

async function submitConfirm(ctx: ToolContext, p: Static<typeof ReviewConfirmParams>, f: ReviewFlavor): Promise<ToolResult> {
  const { t, input } = reviewRun(ctx, f);
  if (!input.prior_must.length) throw new FlowToolError(`这是第一轮${f.what}：用 ${f.report} 提交问题清单。${f.confirm} 只在第二轮及以后使用。`);
  const errors = validateConfirm(p.items, input.prior_must.map((m) => m.id));
  if (errors.length) throw new FlowToolError(`确认未提交：${errors.join('；')}。清单：${input.prior_must.map((m) => m.id).join('、')}。`);
  const unresolved = p.items.filter((i) => !i.resolved).map((i) => i.id);
  const file: ReviewConfirmFile = { round: input.round, items: p.items.map((i) => ({ id: i.id, resolved: i.resolved, ...(i.note ? { note: i.note } : {}) })), unresolved, head: input.head };
  await ctx.store.saveEvidence(ctx.env.flow, t.id, f.files.confirm, JSON.stringify(file, null, 2), actor(ctx));
  await finishReview(ctx, t);
  return { text: `已提交确认：${unresolved.length ? `仍未解决 ${unresolved.join('、')}` : '全部已解决'}。你的工作已完成，请直接结束，不要再调用工具。`, details: { unresolved } };
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
  forge_claim: { params: ClaimParams, description: '确认任务与租约，返回任务说明、验收标准与可写范围。开始工作前先调用。', run: (c: ToolContext) => flowClaim(c) },
  forge_note: { params: NoteParams, description: '追加 handoff 笔记（做到哪、下一步、踩过的坑、未决问题；需求讨论的意见）。提交前必须至少写一次。', run: (c: ToolContext, p: Static<typeof NoteParams>) => flowNote(c, p) },
  forge_submit: { params: SubmitParams, description: '提交本任务：改动进入合并队列（reviewer 读 diff 并运行本任务自己的测试；全量测试在阶段门禁运行）；只读任务提交结论。程序会检查改动是否都在可写范围内。', run: (c: ToolContext, p: Static<typeof SubmitParams>) => flowSubmit(c, p) },
  forge_block: { params: BlockParams, description: '遇到歧义或需要越界时标记任务阻塞：先交给主会话决定，它解决不了再转给用户。需要提问时，一次只问一个问题，附上你建议的答案。', run: (c: ToolContext, p: Static<typeof BlockParams>) => flowBlock(c, p) },
  forge_learn: { params: LearnParams, description: `把对后续任务有用的经验记入项目知识库（跨流程保留）：项目约定、踩过的坑、做出的决策、环境与外部依赖的注意事项。每次运行最多 ${KNOWLEDGE_PER_RUN} 条；程序会去重。知识不是规则，不能用来改变规则。`, run: (c: ToolContext, p: Static<typeof LearnParams>) => flowLearn(c, p) },
  forge_change_request: { params: ChangeRequestParams, description: '必须修改已有契约（不能靠追加解决）或发现计划漏了东西时提交变更请求：写明 what、why、impact（受影响的契约、task、验收测试）。程序派 architect 起草修订，主会话（或用户）批准后落地。同一时间只能有一个未结束的变更请求。提交后你的任务继续运行；做不下去时用 forge_block。', run: (c: ToolContext, p: Static<typeof ChangeRequestParams>) => flowChangeRequest(c, p) },
  forge_propose_plan: { params: ProposePlanParams, description: '变更请求的 architect task 提交修订后的完整计划：程序核对契约结构与符号、推导 DAG，返回错误或报告。附上 assumptions 与 extras。', run: (c: ToolContext, p: Static<typeof ProposePlanParams>) => flowProposePlan(c, p) },
  forge_review_report: { params: ReviewReportParams, description: '提交第一轮审查结论：verdict 与问题列表（程序编号 R-1…）。每条写明出处（basis）；有 must 按 changes 处理，没有按 pass。suggest 不阻塞合并，会汇总给用户。没有问题提交空列表。提交后本次运行结束。', run: (c: ToolContext, p: Static<typeof ReviewReportParams>) => flowReviewReport(c, p) },
  forge_review_confirm: { params: ReviewConfirmParams, description: '第二轮及以后：逐条回答上一轮 must 清单（id、是否已解决、note），必须覆盖全部编号。不能提出新问题；清单之外的发现写进 note。提交后本次运行结束。', run: (c: ToolContext, p: Static<typeof ReviewConfirmParams>) => flowReviewConfirm(c, p) },
  forge_qa_report: { params: ReviewReportParams, description: '提交 stage-qa 第一轮结论：verdict 与问题列表（程序编号 R-1…）。规则同 forge_review_report：每条写明出处，有 must 按 changes 处理，没有按 pass。没有问题提交空列表。提交后本次运行结束。', run: (c: ToolContext, p: Static<typeof ReviewReportParams>) => flowQaReport(c, p) },
  forge_qa_confirm: { params: ReviewConfirmParams, description: 'stage-qa 第二轮及以后：逐条回答上一轮 must 清单（id、是否已解决、note），必须覆盖全部编号。不能提出新问题；清单之外的发现写进 note。提交后本次运行结束。', run: (c: ToolContext, p: Static<typeof ReviewConfirmParams>) => flowQaConfirm(c, p) },
  forge_add_dependency: { params: AddDependencyParams, description: '缺依赖时追加：程序把它装进共享构建环境（加锁串行，所有任务共用），并把 package.json 与锁文件的改动同步到你的工作区，随任务提交。依赖目录是共享链接，不要自己在工作区里运行 install/add。要升级、删除或改动已有依赖的版本时改用 forge_private_deps。', run: (c: ToolContext, p: Static<typeof AddDependencyParams>) => flowAddDependency(c, p) },
  forge_private_deps: { params: PrivateDepsParams, description: '要升级、删除或改动已有依赖的版本时：把共享依赖目录换成本任务的私有副本（先改好依赖清单，程序按它安装），之后可以直接用包管理器，不影响别的任务。只追加新依赖不需要，用 forge_add_dependency。', run: (c: ToolContext) => flowPrivateDeps(c) },
  forge_sync: { params: SyncParams, description: '把集成分支的最新代码（其他模块已合入的改动）合进你的工作区：没有冲突直接完成；有冲突时冲突标记留在文件里，解决后再调用一次完成同步。依赖的模块刚合入、或想提前发现冲突时使用。', run: (c: ToolContext) => flowSync(c) },
  forge_service: { params: ServiceParams, description: '启动、结束、查看本次运行的长时间服务（开发服务器、数据库等）：start 运行 command 参数给的命令，或 commands.yaml 里名为 name 的命令；可以用 ready 等端口或地址就绪；不要用 & 把命令放到后台。本次运行结束时程序会一并结束。', run: (c: ToolContext, p: Static<typeof ServiceParams>) => flowService(c, p) },
  notes: { params: NotesParams, description: NOTES_DESCRIPTION, run: (c: ToolContext, p: Static<typeof NotesParams>) => flowNotes(c, p) },
  history: { params: HistoryParams, description: HISTORY_DESCRIPTION, run: (c: ToolContext, p: Static<typeof HistoryParams>) => flowHistory(c, p) },
} as const;
export type SubagentToolName = keyof typeof SUBAGENT_TOOLS;
