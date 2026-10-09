// 来源：pi-flow src/tools/orchestrator-tools.ts @ 31f3f15
// orchestrator 的工具：forge_status（只读）、forge_dispatch（只收 ready 任务，非阻塞）、forge_wait（等待变化，返回精简摘要）；
// 第六轮起主 agent 自己写需求说明、规划文档、模块清单与计划修订（forge_requirements、forge_plan_doc、forge_propose_modules、forge_revise_plan），由程序写入。
import { awaitingMerge, finishReport } from '../core/finish-report.ts';
import { describeAcceptance, failedOf, manualChecksOf } from '../core/acceptance.ts';
import { activePauses, describePause } from '../core/model-pause.ts';
import { Type, type Static } from 'typebox';
import type { StateStore } from '../core/state-store.ts';
import type { Engine } from '../core/dispatcher.ts';
import { RevisionDependency, RevisionTask, TASK_STATUSES, type TaskFile } from '../core/schemas.ts';
import { FlowToolError, type ToolResult } from './subagent-tools.ts';
import { proposalSummary } from '../core/stages.ts';
import { PLANNING_STAGE, PROPOSAL_STAGES } from '../modes/plan.ts';
import type { FlowConfig } from '../core/config.ts';
import { RevisionError, formatRevision, openReplan, planSnapshot, submitRevision } from '../core/revision.ts';
import { PlanningError, proposeModules, writePlanDoc } from '../core/planning.ts';
import { ProposeModulesParams } from './module-tools.ts';
import { actionsNeeded } from '../core/status-view.ts';
import { RequirementsError, submitRequirements } from '../core/requirements.ts';
import { REVIEW_GUIDE, awaitingReview, timeoutReviewText } from '../core/run-budget.ts';
import { DispatchError } from '../core/dispatcher.ts';

export const DispatchParams = Type.Object({ task_id: Type.String({ pattern: '^T-[0-9]{3,}$' }) });
export const WaitParams = Type.Object({
  task_id: Type.Optional(Type.String({ pattern: '^T-[0-9]{3,}$' })),
  timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, default: 1200 })),
});

export const ReviseParams = Type.Object({
  add: Type.Optional(Type.Array(RevisionTask, { maxItems: 50, description: '新增任务：id 用 N-001 起的临时编号，依赖可以指向现有任务 T-xxx 或本次新增的 N-xxx；批准后由程序重新编号' })),
  rewire: Type.Optional(Type.Array(Type.Object({
    task: Type.String({ pattern: '^T-[0-9]{3,}$', description: '未开始（pending/ready）的现有任务' }),
    depends_on: Type.Array(RevisionDependency, { description: '新的完整依赖列表（整体替换），可以指向现有任务 T-xxx 或本次新增的 N-xxx' }),
  }), { description: '调整未开始任务的依赖' })),
  cancel: Type.Optional(Type.Array(Type.Object({
    task: Type.String({ pattern: '^T-[0-9]{3,}$', description: '未开始（pending/ready）的现有任务' }),
    reason: Type.String({ minLength: 1, description: '为什么取消' }),
  }), { description: '取消未开始的任务' })),
  summary: Type.String({ minLength: 1, maxLength: 500, description: '一句话说明这次修订' }),
  impact: Type.String({ minLength: 1, maxLength: 3000, description: '影响分析：要改哪些 API 接口与模块；已完成、进行中、未开始的受影响任务各自怎么处理（取消、调整、新增修改任务）' }),
});

export const PlanDocParams = Type.Object({
  path: Type.String({ minLength: 1, description: '规划文档的路径：docs/modules.md、docs/glossary.md、docs/interfaces/<模块>.md、docs/adr/*.md、docs/rules-draft/project.md、docs/rules-draft/commands.yaml、AGENTS.md，接收阶段可以写从原型提取的 DESIGN.md' }),
  content: Type.String({ minLength: 1, description: '文件的完整内容（整体覆盖）' }),
});

const asTool = (e: unknown): never => {
  if (e instanceof PlanningError || e instanceof RevisionError || e instanceof RequirementsError) throw new FlowToolError(e.message);
  throw e;
};

/** 规划文档（第六轮）：主 agent 写，程序提交到集成分支 */
export function flowPlanDoc(root: string, store: StateStore, p: Static<typeof PlanDocParams>): ToolResult {
  const flowId = activeFlowId(store);
  try {
    const r = writePlanDoc(root, store, flowId, p.path, p.content);
    return { text: r.changed ? `已写入 ${r.path}（提交到集成分支）。` : `${r.path} 内容没有变化。`, details: { path: r.path } };
  } catch (e) { return asTool(e); }
}

/** 模块清单（第六轮）：主 agent 提交后程序执行规划闸门 */
export async function flowProposeModules(root: string, store: StateStore, config: FlowConfig, engine: Engine, p: Static<typeof ProposeModulesParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  let order: string;
  try { order = await proposeModules(root, store, config, flowId, p); } catch (e) { return asTool(e); }
  await engine.pump(flowId);
  await engine.idle();
  const f = store.readFlow(flowId);
  if (f.stage_status === 'awaiting_human') return { text: `模块清单已保存：\n${order}\n规划检查通过，等用户审批：向用户概述模块划分、依赖与按默认方案处理的地方，请其 /forge-approve 或 /forge-reject "<意见>"；你只能等待。` };
  if (f.stage !== PLANNING_STAGE) return { text: `模块清单已保存：\n${order}\n规划检查通过（自动批准），已创建模块任务并进入 ${f.stage}，程序会自动派发。用 forge_wait 等待。` };
  return { text: `模块清单已保存，但规划检查没有通过：${f.planning?.feedback ?? f.stage_status}\n修改后重新提交。` };
}

/** 计划修订（第六轮）：主 agent 直接起草，用户批准后生效 */
export async function flowRevisePlan(root: string, store: StateStore, config: FlowConfig, p: Static<typeof ReviseParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  try {
    const summary = await submitRevision({ root, store, config }, flowId, { add: p.add ?? [], rewire: p.rewire ?? [], cancel: p.cancel ?? [], summary: p.summary, impact: p.impact });
    return { text: `修订已保存，等用户批准（批准前可以重新提交覆盖）：\n${summary}\n向用户概述修订与影响，请其 /forge-approve 或 /forge-reject "<意见>"。` };
  } catch (e) { return asTool(e); }
}

export const ResolveTimeoutParams = Type.Object({
  task_id: Type.String({ pattern: '^T-[0-9]{3,}$' }),
  decision: Type.Union([Type.Literal('continue'), Type.Literal('restart'), Type.Literal('block')], {
    description: 'continue：有进展、方向对，接着原会话再给一份预算；restart：原地打转或方向错了，不带旧对话从头换个思路（保留工作区与 handoff）；block：做不到或需要用户决定，交给用户',
  }),
  note: Type.Optional(Type.String({ maxLength: 2000, description: '给子进程的意见（continue、restart：下一步该怎么做、别再试什么）；block 时必填：为什么要用户处理、需要用户决定什么' })),
});

/** 运行超时后的复核：主会话看过材料后决定接着做、从头做，或交给用户 */
export async function flowResolveTimeout(store: StateStore, engine: Engine, p: Static<typeof ResolveTimeoutParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  let t: TaskFile;
  try { t = store.readTask(flowId, p.task_id); } catch { throw new FlowToolError(`任务 ${p.task_id} 不存在。`); }
  if (!awaitingReview(t)) throw new FlowToolError(`任务 ${t.id} 没有等待复核的超时（当前 ${t.status}）。用 forge_status 查看。`);
  const note = p.note?.trim();
  if (p.decision === 'block') {
    if (!note) throw new FlowToolError('block 需要 note：写明为什么要用户处理、需要用户决定什么。');
    await store.transitionTask(flowId, t.id, { to: 'blocked', trigger: 'block', actor: 'orchestrator', facts: { reason: `运行超时，主会话复核后交给用户：${note}` } });
    return { text: `已把 ${t.id} 交给用户（blocked）。向用户说明原因与需要的决定。` };
  }
  await store.updateTask(flowId, t.id, { timeout_review: { ...t.timeout_review!, decision: p.decision, ...(note ? { note } : {}) } },
    { actor: 'orchestrator', type: 'note', reason: `超时复核：${p.decision === 'continue' ? '接着原会话继续' : '从头换个思路'}${note ? `（${note.slice(0, 200)}）` : ''}` });
  try {
    const d = await engine.dispatch(flowId, t.id);
    return { text: `已${p.decision === 'continue' ? '接着原会话' : '从头'}重新派发 ${t.id}（run ${d.run_id}）。用 forge_wait 等待。`, details: { ...d } };
  } catch (e) {
    if (!(e instanceof DispatchError)) throw e;
    return { text: `已记下决定；${t.id} 暂时无法派发（${e.message}），程序会在条件满足后自动派发。用 forge_wait 等待。` };
  }
}

export const ResolveScopeParams = Type.Object({
  task_id: Type.String({ pattern: '^T-[0-9]{3,}$' }),
  decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')], { description: 'approve：追加到该任务的可写范围（重叠的任务各改各的部分、合并时程序处理冲突）；reject：不追加' }),
  note: Type.Optional(Type.String({ maxLength: 2000, description: '给子进程的说明（reject 时必填：为什么不行、该怎么做）' })),
});

/** 范围申请与其他未完成任务重叠（第六轮 D3）：主会话决定批准还是拒绝 */
export async function flowResolveScope(store: StateStore, p: Static<typeof ResolveScopeParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  let t: TaskFile;
  try { t = store.readTask(flowId, p.task_id); } catch { throw new FlowToolError(`任务 ${p.task_id} 不存在。`); }
  const req = t.scope_request;
  if (!req) throw new FlowToolError(`任务 ${t.id} 没有等待决定的范围申请。`);
  const note = p.note?.trim();
  if (p.decision === 'approve') {
    await store.grantScope(flowId, t.id, { paths: req.paths, reason: `${req.reason}${note ? `（主会话：${note}）` : ''}`, by: 'orchestrator', run: req.run }, 'orchestrator');
    if (note) await store.appendHandoff(flowId, t.id, `主会话批准了范围申请（${req.paths.join('、')}）：${note}`, 'orchestrator');
    return { text: `已批准，${t.id} 的可写范围追加：${req.paths.join('、')}。` };
  }
  if (!note) throw new FlowToolError('reject 需要 note：写明为什么不行、该怎么做。');
  await store.setScopeRequest(flowId, t.id, null, 'orchestrator', `拒绝范围申请（${req.paths.join('、')}）：${note}`);
  await store.appendHandoff(flowId, t.id, `主会话拒绝了范围申请（${req.paths.join('、')}）：${note}`, 'orchestrator');
  return { text: `已拒绝 ${t.id} 的范围申请，原因写进了它的 handoff。` };
}

export const RequirementsParams = Type.Object({
  content: Type.String({ minLength: 1, description: '完整的需求说明（Markdown，结构见技能 write-requirements；验收条目带编号 AC-01…）' }),
});

/** 需求（D0）：就绪检查或讨论后提交需求说明；程序提交到集成分支并执行阶段闸门，通过即进入规划 */
export async function flowRequirements(root: string, store: StateStore, engine: Engine, p: Static<typeof RequirementsParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  let r: { path: string; sha: string | null };
  try {
    r = await submitRequirements(root, store, flowId, p.content, 'orchestrator');
  } catch (e) {
    if (e instanceof RequirementsError) throw new FlowToolError(e.message);
    throw e;
  }
  await engine.pump(flowId);
  await engine.idle();
  const f = store.readFlow(flowId);
  if (f.stage === PLANNING_STAGE) return { text: `已提交需求说明 ${r.path}${r.sha ? '' : '（内容没有变化）'}，检查通过，进入规划：现在开始规划（见下一步指引）。`, details: { path: r.path } };
  if (f.stage_status === 'awaiting_human') {
    return { text: `已提交需求说明 ${r.path}${r.sha ? '' : '（内容没有变化）'}。请用户查看后执行 /forge-approve，或 /forge-reject "<意见>" 打回；你只能等待。`, details: { path: r.path } };
  }
  const reason = f.requirements?.feedback;
  return { text: `已提交需求说明 ${r.path}，阶段 ${f.stage}（${f.stage_status}）${!f.requirements?.submitted && reason ? `。检查未通过：${reason}，请修改后重新提交` : ''}。`, details: { path: r.path } };
}

export function activeFlowId(store: StateStore): string {
  const id = store.readState().active_flow;
  if (!id) throw new FlowToolError('当前没有进行中的流程。请用户执行 /forge-build 或 /forge-build --feature 开始。');
  return id;
}

const one = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

export function statusText(store: StateStore, engine: Engine | null, flowId: string): string {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  const lines = [
    `流程 ${flow.id}「${flow.title}」（${flow.mode}）阶段 ${flow.stage}：${flow.stage_status}`,
    `任务 ${tasks.length} 个：${TASK_STATUSES.filter((s) => count(s)).map((s) => `${s} ${count(s)}`).join('，') || '无'}`,
  ];
  const running = engine?.activeRuns().filter((r) => r.flow === flowId) ?? [];
  const leased = tasks.filter((t) => t.lease);
  if (leased.length) lines.push(`运行中：${leased.map((t) => `${t.id}（${t.lease!.role}，run ${t.lease!.run_id}${running.some((r) => r.run_id === t.lease!.run_id) ? '' : '，不在本会话'}）`).join('；')}`);
  const ready = tasks.filter((t) => t.status === 'ready');
  if (ready.length) lines.push(`可派发：${ready.map((t) => `${t.id} ${t.title}（${t.role}）`).join('；')}`);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) lines.push(`阻塞，需要用户处理：\n${blocked.map((t) => `- ${t.id}：${one(t.blocked_reason ?? '')} → /forge unblock ${t.id}`).join('\n')}`);
  const now = new Date();
  const pauses = activePauses(store, now);
  if (pauses.length) lines.push(`模型暂停，需要用户处理：\n${pauses.map((p) => `- ${describePause(p, now)} → /forge models resume ${p.model} 或 /forge-config 换模型`).join('\n')}`);
  const reviews = tasks.filter(awaitingReview);
  if (reviews.length) lines.push(`运行超时，等你复核（forge_resolve_timeout）：${REVIEW_GUIDE}\n${reviews.map((t) => timeoutReviewText(store, flowId, t)).join('\n')}`);
  const scopes = tasks.filter((t) => t.scope_request);
  if (scopes.length) lines.push(`范围申请，等你决定（forge_resolve_scope）：\n${scopes.map((t) => `- ${t.id} 申请 ${t.scope_request!.paths.join('、')}：${one(t.scope_request!.reason)}（${t.scope_request!.conflicts.join('；')}）`).join('\n')}`);
  const failing = tasks.filter((t) => t.last_failure && !['blocked', 'done', 'cancelled'].includes(t.status));
  if (failing.length) lines.push(`最近失败：\n${failing.map((t) => `- ${t.id}（第 ${t.attempts} 次）：${one(t.last_failure!)}`).join('\n')}`);
  if (awaitingMerge(flow)) lines.push(`等待用户批准合入主分支 → /forge-approve\n${finishReport(store, flowId)}`);
  else if (flow.stage_status === 'awaiting_human') {
    lines.push(`等待用户：阶段 ${flow.stage} 的闸门待批准 → /forge-approve（或 /forge-reject "<意见>"）`);
    const p = proposalSummary(store, flowId);
    if (p && PROPOSAL_STAGES.has(flow.stage)) lines.push(p);
  }
  if (flow.replan_request) lines.push(`修订请求（等你起草，forge_revise_plan）：${one(flow.replan_request.reason, 400)}\n${planSnapshot(tasks)}`);
  const rev = openReplan(store, flowId)?.revision;
  if (rev) lines.push(`等待用户：计划修订待批准 → /forge-approve（或 /forge-reject "<意见>"）\n${formatRevision(rev)}`);
  const manual = manualChecksOf(store, flowId);
  if (manual.length) lines.push(`需要用户自己打开应用查看（agent 不启动桌面应用与浏览器，提醒用户去看）：\n${manual.map((m) => `- ${m.task}「${one(m.title, 40)}」：${m.items.map((x, i) => `${i + 1}. ${one(x, 120)}`).join('；')}`).join('\n')}`);
  // 模块验收（第五轮）：进行中与需要用户处理的
  const accepts = store.listAcceptances(flowId).filter((a) => a.status !== 'accepted');
  if (accepts.length) lines.push(`模块验收：\n${accepts.map((a) => `- ${a.task}：${describeAcceptance(a)}${failedOf(a).length ? `\n${failedOf(a).map((c) => `  · ${c.id} ${one(c.text, 80)}：${one(a.results.find((r) => r.id === c.id)?.evidence ?? '', 120)}`).join('\n')}` : ''}`).join('\n')}`);
  const gateFail = [...store.readEvents()].reverse().find((e) => e.flow === flowId && e.type === 'gate_result');
  if (gateFail && gateFail.to === 'active' && flow.stage_status === 'active') lines.push(`阶段闸门未通过：${one(gateFail.reason ?? '', 300)}（修复后执行 /forge gate 重跑）`);
  return lines.join('\n');
}

export async function flowDispatch(store: StateStore, engine: Engine, p: Static<typeof DispatchParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  await engine.promote(flowId);
  let t: TaskFile;
  try {
    t = store.readTask(flowId, p.task_id);
  } catch {
    throw new FlowToolError(`任务 ${p.task_id} 不存在。先调用 forge_status 查看可派发的任务。`);
  }
  if (t.status !== 'ready') {
    const ready = store.listTasks(flowId).filter((x) => x.status === 'ready').map((x) => x.id);
    throw new FlowToolError(`任务 ${t.id} 当前是 ${t.status}，forge_dispatch 只接受 ready 任务。${ready.length ? `当前可派发：${ready.join('、')}` : '当前没有可派发的任务，调用 forge_wait 等待。'}`);
  }
  const d = await engine.dispatch(flowId, t.id);
  return { text: `已派发 ${d.task} 给 ${d.role}（模型 ${d.model}，run ${d.run_id}）。用 forge_wait 等待结果。`, details: { ...d } };
}

/**
 * 等待值得告诉用户的变化（第三轮后续 5）：任务完成、阻塞或取消，出现需要用户处理的事，阶段或流程状态变化，
 * 关闭自动派发时出现可派发的任务，或者引擎已无事可做。合并、验收等中间步骤不唤醒 orchestrator。
 * 给了 task_id 时只等这个任务的状态变化。
 */
export async function flowWait(store: StateStore, engine: Engine, p: Static<typeof WaitParams>, config?: FlowConfig): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  const statuses = () => new Map(store.listTasks(flowId).map((t) => [t.id, t.status as string]));
  const flowState = () => { const f = store.readFlow(flowId); return `${f.stage}|${f.stage_status}|${store.readState().active_flow ?? ''}|${store.readRevision(flowId)?.status ?? ''}`; };
  const actionKeys = () => new Set(config ? actionsNeeded(store, config).map((a) => a.key) : []);
  const reviewing = () => new Set(store.listTasks(flowId).filter(awaitingReview).map((t) => `${t.id}:${t.timeouts ?? 0}`));
  const beforeReview = reviewing();
  const before = statuses();
  const beforeFlow = flowState();
  const beforeActions = actionKeys();
  const deadline = Date.now() + (p.timeout_s ?? 1200) * 1000;
  const settled = (id: string) => ['done', 'blocked', 'cancelled'].includes(store.readTask(flowId, id).status);
  if (p.task_id && settled(p.task_id)) return { text: `${p.task_id} 已是 ${store.readTask(flowId, p.task_id).status}。\n\n${statusText(store, engine, flowId)}`, details: { changed: [] } };
  const worthWaking = (): boolean => {
    const now = statuses();
    // 运行超时等主会话复核
    for (const k of reviewing()) if (!beforeReview.has(k)) return true;
    if (p.task_id) return now.get(p.task_id) !== before.get(p.task_id);
    for (const [id, s] of now) {
      if (s === before.get(id)) continue;
      if (!before.has(id) || s === 'done' || s === 'blocked' || s === 'cancelled') return true;
      if (s === 'ready' && !engine.autoDispatch) return true;
    }
    if (flowState() !== beforeFlow) return true;
    for (const k of actionKeys()) if (!beforeActions.has(k)) return true;
    return engine.isIdle();
  };
  let woke = false;
  while (Date.now() < deadline) {
    await engine.waitForChange(Math.min(5000, deadline - Date.now()));
    try { woke = worthWaking(); } catch { woke = true; } // 流程已结束等：交给 orchestrator 看状态
    if (woke) break;
  }
  let flowGone = false;
  try { store.readFlow(flowId); } catch { flowGone = true; }
  if (flowGone || store.readState().active_flow !== flowId) return { text: `流程 ${flowId} 已结束或不再是活动流程。`, details: { changed: [] } };
  const tasks = store.listTasks(flowId);
  const changed = tasks.filter((t) => before.get(t.id) !== t.status).map((t) => t.id);
  const desc = (id: string) => {
    const t = tasks.find((x) => x.id === id)!;
    return `${id}：${before.get(id) ?? '（新任务）'} → ${t.status}${t.status === 'blocked' ? `（${one(t.blocked_reason ?? '')}）` : t.last_failure && t.status === 'in_progress' ? `（${one(t.last_failure)}）` : ''}`;
  };
  const newReviews = tasks.filter(awaitingReview).filter((t) => !beforeReview.has(`${t.id}:${t.timeouts ?? 0}`)).map((t) => `- ${t.id}：运行超时，等你复核`);
  const changes = changed.length ? `变化：\n${changed.map((id) => `- ${desc(id)}`).join('\n')}` : '';
  const head = [newReviews.join('\n'), changes].filter(Boolean).join('\n') || (woke ? '没有任务状态变化。' : '等待超时，没有值得报告的变化。');
  return { text: `${head}\n\n${statusText(store, engine, flowId)}`, details: { changed } };
}
