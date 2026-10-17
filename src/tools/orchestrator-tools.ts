// orchestrator 的工具：forge_status、forge_wait、超时复核与范围申请处理；派发由程序执行。
import { isArchitectStage, planApprovalSummary, planStatus } from '../core/plan/plan-flow.ts';
import { activePauses, describePause } from '../core/engine/model-pause.ts';
import { Type, type Static } from 'typebox';
import type { StateStore } from '../core/state/state-store.ts';
import type { Engine } from '../core/engine/dispatcher.ts';
import { TASK_STATUSES, isLightFlow, type TaskFile } from '../core/state/schemas.ts';
import { FlowToolError, type ToolResult } from './subagent-tools.ts';
import type { FlowConfig } from '../core/state/config.ts';
import { actionsNeeded } from '../core/ops/status-view.ts';
import { REVIEW_GUIDE, awaitingReview, timeoutReviewText } from '../core/engine/run-budget.ts';
import { DispatchError } from '../core/engine/dispatcher.ts';
import { fixHelpHint, fixStatusLine, readFixLog } from '../modes/fix.ts';
import { ChangeStartError, startChange } from '../modes/change.ts';
import type { ChangePlanInput } from '../core/plan/change-plan.ts';
import { isFinished } from '../core/state/state-store.ts';
import { approvalTargets } from '../core/stage/stages.ts';
import { AskArchitectParams } from './subagent-tools.ts';
import { DECISION_GUIDE, DecisionError, decide, decisionsText, pendingDecisions } from '../core/engine/decisions.ts';
import { createConsult, markDelivered, openMainConsults, undeliveredAnswers } from '../core/engine/consult.ts';
import { StateError } from '../core/state/state-store.ts';
import { postMergeStatus } from '../core/engine/post-merge-test.ts';

export const ChangeParams = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120, description: '一句话写明这次要加什么' }),
  description: Type.Optional(Type.String({ maxLength: 20000, description: '背景与要求（与用户商量的结论）' })),
  tasks: Type.Array(Type.Object({
    id: Type.Optional(Type.String({ pattern: '^T-[0-9]{3,}$', description: '省略时按顺序编号 T-001…' })),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    writes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: '计划改动的文件或目录；不能包含 tests/acceptance、docs/spec、docs/contracts、rules 等' }),
    depends_on: Type.Optional(Type.Array(Type.Object({ task: Type.String({ pattern: '^T-[0-9]{3,}$' }), type: Type.Literal('hard') }, { additionalProperties: false }))),
    ac: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: '验收标准：做到什么算完成' }),
    layers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    module: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 20, description: '迷你计划的 task（数量上限见 limits.change_max_tasks，默认 3）' }),
}, { additionalProperties: false });
/**
 * forge_change（orchestrator）：在做完的项目上加小功能。提交 1 到 3 个 task 的迷你计划，程序校验后直接开始（不经 P0/P1 批准）：
 * worker 实现 → reviewer 审查 → 合入主分支 → 程序建“更新架构图与契约”任务 → stage-qa 确认。
 * 有 build 流程正在等待审批时直接继续（用户在主会话里已经同意）；build 流程在运行时拒绝。
 */
export async function flowChange(root: string, store: StateStore, config: FlowConfig, input: Static<typeof ChangeParams>, engine?: Pick<Engine, 'pump'>): Promise<ToolResult> {
  try {
    const r = await startChange({ root, store, config, ...(engine ? { pump: (f: string) => engine.pump(f) } : {}) }, input as ChangePlanInput, { yes: true });
    if (r.kind !== 'started') throw new FlowToolError('小改动没有开始。');
    return { text: `${r.lines.join('\n')}\n用 forge_wait 等待进展；需要你处理的事项（阻塞、验收未通过）会在 forge_status 中列出。`, details: { flow: r.flow.id, tasks: r.tasks.map((t) => t.id) } };
  } catch (e) {
    if (e instanceof ChangeStartError) throw new FlowToolError(e.message);
    throw e;
  }
}

/** forge_ask_architect（主会话）：技术问题交给架构师；回答在之后的 forge_wait 返回 */
export async function flowAskArchitectMain(store: StateStore, config: FlowConfig, engine: Pick<Engine, 'pump'> | null, p: Static<typeof AskArchitectParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  if (isLightFlow(store.readFlow(flowId))) throw new FlowToolError('修复与小改动流程没有架构师咨询。');
  const c = await createConsult(store, config, flowId, p.question, p.kind, null, 'orchestrator');
  if (engine) await engine.pump(flowId);
  return { text: `已交给架构师（${c.id}）。回答会在之后的 forge_wait 返回时交给你，再转达给用户。`, details: { consult: c.id } };
}

/** 架构师给主会话的回答：取出还没交付的，记为已交付 */
async function takeAnswers(store: StateStore, flowId: string): Promise<string> {
  const answers = undeliveredAnswers(store, flowId);
  if (!answers.length) return '';
  await markDelivered(store, flowId, answers.map((a) => a.task));
  return answers.map((a) => `架构师的回答（${a.task}）：\n${a.answer}`).join('\n\n');
}

export const WaitParams = Type.Object({
  task_id: Type.Optional(Type.String({ pattern: '^(T-[0-9]{3,}(\\.(at|rv|fx)(-[0-9]+)?)?|[A-Za-z][A-Za-z0-9_]*\\.(rv|qa)(-[0-9]+)?)$' })),
  timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, default: 1200 })),
});

export const ResolveTimeoutParams = Type.Object({
  task_id: Type.String({ pattern: '^(T-[0-9]{3,}(\\.(at|rv|fx)(-[0-9]+)?)?|[A-Za-z][A-Za-z0-9_]*\\.(rv|qa)(-[0-9]+)?)$' }),
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

export const DecideParams = Type.Object({
  target: Type.String({ pattern: '^(T-[0-9]{3,}(\\.(at|rv|fx)(-[0-9]+)?)?|[A-Za-z][A-Za-z0-9_]*\\.(rv|qa)(-[0-9]+)?|S[0-9]+)$', description: '等你决定的任务（T-…）或阶段（S…）；fix 时是负责这处修改的任务' }),
  decision: Type.Union([Type.Literal('retry'), Type.Literal('accept'), Type.Literal('fix'), Type.Literal('user')], { description: 'retry 重新做；accept 放行；fix 签收打回后把修改交给负责的任务；user 转交用户。forge_status 里每项列出可选的决定' }),
  note: Type.String({ minLength: 1, maxLength: 4000, description: '理由；retry 时是给子进程的意见（也可以是对它提问的回答），fix 时写要改什么，user 时写清楚要用户决定什么' }),
});

/** forge_decide：阻塞、门禁用尽先由主会话决定，解决不了的转交用户；签收打回后把能归属的修改交给负责的任务 */
export async function flowDecide(root: string, store: StateStore, config: FlowConfig, engine: Engine, p: Static<typeof DecideParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  let r;
  try {
    r = await decide({ root, store, config }, flowId, p.target, p.decision, p.note);
  } catch (e) {
    if (e instanceof DecisionError || e instanceof StateError) throw new FlowToolError(e.message);
    throw e;
  }
  await engine.pump(flowId);
  return { text: `${r.text}用 forge_wait 等待进展。`, details: { target: p.target, decision: p.decision } };
}

export function activeFlowId(store: StateStore): string {
  // 没有 build 流程时，进行中的轻流程（修复、小改动）就是当前流程
  const id = store.readState().active_flow ?? store.openLightFlow()?.id;
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
  if (isLightFlow(flow)) lines.push(fixStatusLine(flow, tasks));
  for (const a of approvalTargets(store, flowId)) lines.push(`等待批准：${a.object}`);
  const plan = planStatus(store, flowId);
  if (plan) lines.push(plan);
  if (isArchitectStage(flow.stage) && flow.stage_status === 'awaiting_human' && !flow.s_stages?.length) lines.push(planApprovalSummary(store.root, store, flowId));
  const asking = tasks.filter((t) => t.status === 'blocked' && t.blocked_by === 'architect');
  const consults = openMainConsults(tasks);
  if (asking.length || consults.length) lines.push(`等架构师回答（程序推进，不用处理）：${[...asking.map((t) => t.id), ...consults.map((t) => `${t.id}（你的问题）`)].join('、')}`);
  const pm = postMergeStatus(store, flowId, engine?.postMergeRunning(flowId) ?? false);
  if (pm) lines.push(pm);
  const running = engine?.activeRuns().filter((r) => r.flow === flowId) ?? [];
  const leased = tasks.filter((t) => t.lease);
  if (leased.length) lines.push(`运行中：${leased.map((t) => `${t.id}（${t.lease!.role}，run ${t.lease!.run_id}${running.some((r) => r.run_id === t.lease!.run_id) ? '' : '，不在本会话'}）`).join('；')}`);
  const ready = tasks.filter((t) => t.status === 'ready');
  if (ready.length) lines.push(`可派发：${ready.map((t) => `${t.id} ${t.title}（${t.role}）`).join('；')}`);
  const decisions = pendingDecisions(store, flowId);
  if (decisions.length) lines.push(`等你决定（forge_decide）：${DECISION_GUIDE}\n${decisionsText(decisions)}`);
  const blocked = tasks.filter((t) => t.status === 'blocked' && t.blocked_owner !== 'orchestrator' && t.blocked_by !== 'architect');
  if (blocked.length) lines.push(`阻塞，需要用户处理：\n${blocked.map((t) => `- ${t.id}：${one(t.blocked_reason ?? '')} → /forge unblock ${t.id}`).join('\n')}`);
  const now = new Date();
  const pauses = activePauses(store, now);
  if (pauses.length) lines.push(`模型暂停，需要用户处理：\n${pauses.map((p) => `- ${describePause(p, now)} → /forge models resume ${p.model} 或 /forge-config 换模型`).join('\n')}`);
  const reviews = tasks.filter(awaitingReview);
  if (reviews.length) lines.push(`运行超时，等你复核（forge_resolve_timeout）：${REVIEW_GUIDE}\n${reviews.map((t) => timeoutReviewText(store, flowId, t)).join('\n')}`);
  const failing = tasks.filter((t) => t.last_failure && !['blocked', 'done', 'cancelled'].includes(t.status));
  if (failing.length) lines.push(`最近失败：\n${failing.map((t) => `- ${t.id}（第 ${t.attempts} 次）：${one(t.last_failure!)}`).join('\n')}`);
  if (['awaiting_human', 'needs_human'].includes(flow.stage_status) && !decisions.some((d) => d.kind === 'stage')) lines.push(`等待用户：阶段 ${flow.stage}（${flow.stage_status}）→ /forge-approve 或 /forge-reject "<意见>"`);
  const gateFail = [...store.readEvents()].reverse().find((e) => e.flow === flowId && e.type === 'gate_result');
  if (gateFail && gateFail.to === 'active' && flow.stage_status === 'active') lines.push(`阶段闸门未通过：${one(gateFail.reason ?? '', 300)}（修复任务合入后程序自动重新验收，不用叫用户执行命令）`);
  if (isLightFlow(flow) && flow.stage_status === 'needs_human') lines.push(fixHelpHint(flow.id, flow.mode));
  if (isLightFlow(flow) && isFinished(flow)) {
    const log = readFixLog(store, flowId);
    if (log) lines.push(`${flow.mode === 'change' ? '变更' : '修复'}日志：\n${log.trim()}`);
  }
  return lines.join('\n');
}

/**
 * 等待值得告诉用户的变化（第三轮后续 5）：任务完成、阻塞或取消，出现需要用户处理的事，阶段或流程状态变化，
 * 关闭自动派发时出现可派发的任务，或者引擎已无事可做。合并、验收等中间步骤不唤醒 orchestrator。
 * 给了 task_id 时只等这个任务的状态变化。
 */
export async function flowWait(store: StateStore, engine: Engine, p: Static<typeof WaitParams>, config?: FlowConfig): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  // 等架构师回答的任务仍算进行中：提问与回答由程序推进，回答后它接着 in_progress
  const seen = (t: TaskFile): string => t.status === 'blocked' && t.blocked_by === 'architect' ? 'in_progress' : t.status;
  const statuses = () => new Map(store.listTasks(flowId).map((t) => [t.id, seen(t)]));
  const flowState = () => { const f = store.readFlow(flowId); return `${f.stage}|${f.stage_status}|${store.readState().active_flow ?? ''}`; };
  const actionKeys = () => new Set(config ? actionsNeeded(store, config).map((a) => a.key) : []);
  const reviewing = () => new Set(store.listTasks(flowId).filter(awaitingReview).map((t) => `${t.id}:${t.timeouts ?? 0}`));
  const beforeReview = reviewing();
  const before = statuses();
  const beforeFlow = flowState();
  const beforeActions = actionKeys();
  const deadline = Date.now() + (p.timeout_s ?? 1200) * 1000;
  const settled = (id: string) => ['done', 'blocked', 'cancelled'].includes(seen(store.readTask(flowId, id)));
  if (p.task_id && settled(p.task_id)) return { text: `${p.task_id} 已是 ${store.readTask(flowId, p.task_id).status}。\n\n${statusText(store, engine, flowId)}`, details: { changed: [] } };
  // 上次等待之后架构师已经回答了主会话的问题：直接交给它
  const ready = await takeAnswers(store, flowId);
  if (ready) return { text: `${ready}\n\n${statusText(store, engine, flowId)}`, details: { changed: [] } };
  const worthWaking = (): boolean => {
    const now = statuses();
    // 运行超时等主会话复核
    for (const k of reviewing()) if (!beforeReview.has(k)) return true;
    if (p.task_id) return now.get(p.task_id) !== before.get(p.task_id);
    // 子 agent 的咨询任务由程序推进，不唤醒主会话（主会话自己的提问在回答完成时唤醒）
    const internal = new Set(store.listTasks(flowId).filter((t) => t.kind === 'consult' && t.for_task).map((t) => t.id));
    for (const [id, s] of now) {
      if (s === before.get(id) || internal.has(id)) continue;
      // impl 一律有审查任务，.rv 的新建与完成由程序驱动，不单独唤醒（结论体现在被审查任务的状态上）；审查者 blocked 时只有 .rv 阻塞，要唤醒
      if (/\.rv(-\d+)?$/.test(id) && s !== 'blocked') continue;
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
  if (flowGone || (store.readState().active_flow !== flowId && store.openLightFlow()?.id !== flowId)) return { text: `流程 ${flowId} 已结束或不再是活动流程。`, details: { changed: [] } };
  const tasks = store.listTasks(flowId);
  const changed = tasks.filter((t) => before.get(t.id) !== seen(t)).map((t) => t.id);
  const desc = (id: string) => {
    const t = tasks.find((x) => x.id === id)!;
    return `${id}：${before.get(id) ?? '（新任务）'} → ${t.status}${t.status === 'blocked' ? `（${one(t.blocked_reason ?? '')}）` : t.last_failure && t.status === 'in_progress' ? `（${one(t.last_failure)}）` : ''}`;
  };
  const newReviews = tasks.filter(awaitingReview).filter((t) => !beforeReview.has(`${t.id}:${t.timeouts ?? 0}`)).map((t) => `- ${t.id}：运行超时，等你复核`);
  const changes = changed.length ? `变化：\n${changed.map((id) => `- ${desc(id)}`).join('\n')}` : '';
  const answers = await takeAnswers(store, flowId);
  const head = [answers, newReviews.join('\n'), changes].filter(Boolean).join('\n') || (woke ? '没有任务状态变化。' : '等待超时，没有值得报告的变化。');
  // 等待超时又没有变化：只给两行概况，完整状态上一次已经给过（stock 实验：52 次 forge_wait 返回合计 27 万字，留在主会话里每次请求都要付费）
  const status = statusText(store, engine, flowId);
  if (!woke && !changed.length && !newReviews.length && !answers) return { text: `${head}\n${status.split('\n').slice(0, 2).join('\n')}\n（完整状态：forge_status）`, details: { changed } };
  return { text: `${head}\n\n${status}`, details: { changed } };
}
