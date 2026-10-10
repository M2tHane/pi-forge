// 来源：pi-flow src/core/status-view.ts @ 31f3f15（M1 改编）
// 用户界面只显示规格、契约与计划、实施、交付；内部状态保留在 --detail。
import { stalls } from './waits.ts';
import { pendingChanges } from './change-flow.ts';
import { planStatus } from './plan-flow.ts';
import type { FlowConfig } from './config.ts';
import { isFinished, type StateStore } from './state-store.ts';
import { budgetState, formatBudget } from './cost-control.ts';
import { activePauses, describePause } from './model-pause.ts';
import { type AmendFile, type ChangeFile, type FlowFile, type Phase, type TaskFile } from './schemas.ts';
import { stallOf, stuckTasks } from './forge-watch.ts';
import { IN_FLIGHT } from './state-machine.ts';
import { awaitingReview } from './run-budget.ts';
import { isStageLevelTask } from './stage-worktree.ts';
import { fixStatusLine, fixPhase, FIX_PHASE_LABEL } from '../modes/fix.ts';

export type PhaseOrDone = Phase | 'done';
export const PHASE_LABEL: Record<PhaseOrDone, string> = { spec: '规格', plan: '契约与计划', implementation: '实施', done: '交付' };
/** 最后一个阶段等你批准 = 等你批准合入主分支。P0、P1 批准前 S 阶段还没生成，它们也是"最后一个阶段"，但批准的只是规格或计划 */
export const awaitingMerge = (flow: Pick<FlowFile, 'stage' | 'stages' | 'stage_status'>) => flow.stage === flow.stages.at(-1) && flow.stage_status === 'awaiting_human' && flow.stage !== 'P0' && flow.stage !== 'P1';
export const phaseLabel = (flow: Pick<FlowFile, 'stage' | 'stages' | 'stage_status'>, p: PhaseOrDone) => awaitingMerge(flow) ? '交付（待合入）' : PHASE_LABEL[p];
const INFLIGHT = new Set<string>(IN_FLIGHT);
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');
export function phaseOfStage(config: FlowConfig, mode: 'build' | 'feature', stage: string): Phase {
  return config.raw.modes[mode]?.stages.find((s) => s.id === stage)?.phase ?? (stage === 'P0' ? 'spec' : stage === 'P1' || stage === 'ADOPT' ? 'plan' : 'implementation');
}
export function currentPhase(config: FlowConfig, flow: FlowFile, _tasks: TaskFile[]): PhaseOrDone {
  return isFinished(flow) && flow.stage_status === 'done' ? 'done' : flow.mode === 'fix' ? 'implementation' : phaseOfStage(config, flow.mode, flow.stage);
}
export function phasesOf(config: FlowConfig, flow: FlowFile): Phase[] {
  if (flow.mode === 'fix') return ['implementation'];
  const phases = [...new Set(flow.stages.map((s) => phaseOfStage(config, flow.mode as 'build' | 'feature', s)))];
  // P1 批准前 S 阶段还没生成：界面上始终显示完整的 规格 → 契约与计划 → 实施 → 交付
  if (!phases.includes('implementation') && flow.stages.some((s) => s === 'P0' || s === 'P1')) phases.push('implementation');
  return phases;
}
const FAILURE_KIND: Record<string, string> = { merge_verify_fail: '合并时全量测试失败', precheck_fail: '预检失败', run_failed: '运行中断', run_timeout: '运行超时', lease_expired: '租约过期' };
export function lastFailureKind(store: StateStore, flowId: string, taskId: string): string | null {
  const ev = [...store.readEvents()].reverse().find((e) => e.flow === flowId && e.task === taskId && e.type === 'transition' && e.trigger && e.trigger in FAILURE_KIND);
  return ev ? FAILURE_KIND[ev.trigger!]! : null;
}
export function taskActivity(t: TaskFile, failureKind: string | null): string {
  const working = t.kind === 'fix' ? '修复中' : t.kind === 'merge-fix' ? '解决合并冲突' : t.kind === 'doc' ? '撰写中' : t.kind === 'acctest' ? '编写验收测试' : t.kind === 'review' ? '代码审查中' : t.kind === 'qa' ? '阶段验收中' : '实现中';
  const states: Record<string, string> = { awaiting_inputs: '等待输入', checking: '预检中', in_review: '审查中', disputed: '等待争议裁决', queued_merge: '合入中', merging: '合入中', ready: '待派发', pending: '等待前置任务', blocked: '阻塞', cancelled: '已取消', done: '已完成' };
  const base = t.status === 'in_progress' ? t.lease ? working : '等待重新派发' : states[t.status]!;
  return base + (t.attempts > 0 && !['done', 'blocked'].includes(t.status) ? `（第 ${t.attempts + 1} 次${failureKind ? `，上次：${failureKind}` : ''}）` : '');
}
const BLOCKED_LABEL: Record<string, string> = {
  dispute: '与验收测试有争议，等你裁决', review_exhausted: '审查多轮仍有问题，等你决定', precheck_exhausted: '预检多次失败', merge_exhausted: '合并验证多次失败',
  attempts: '多次尝试仍失败', integration_broken: '集成分支已坏', agent: '有问题要问你', user: '有问题要问你', dispatcher: '无法继续',
};
/** 阻塞任务对应的解除命令：按 blocked_by 区分，写出可以直接执行的命令 */
export function blockedCommand(t: Pick<TaskFile, 'id' | 'blocked_by'>): string {
  switch (t.blocked_by) {
    case 'dispute': return `/forge-decide ${t.id} keep-test 或 /forge-decide ${t.id} fix-test "<说明>"`;
    case 'review_exhausted': return `/forge accept ${t.id} --note "<说明>"（接受现状，程序继续合并验证）或 /forge unblock ${t.id} "<意见>" --reset（清零后重新审查）`;
    case 'precheck_exhausted': case 'merge_exhausted': case 'attempts': return `/forge unblock ${t.id} "<提示>" --reset（计数清零后重试）`;
    case 'integration_broken': return `集成分支本身已坏：修好后 /forge unblock ${t.id}`;
    case 'dispatcher': return `/forge unblock ${t.id}`;
    default: return `/forge answer ${t.id}`;
  }
}
const amendText = (a: AmendFile) => `规格修订 amend:${a.id}「${short(a.name, 30)}」等你批准：${short(a.reason, 80)}（AC 新增 ${a.diff.added.length}、修改 ${a.diff.changed.length}、删除 ${a.diff.removed.length}；影响任务：${a.affected_tasks.join('、') || '无'}）`;
export interface Action { key: string; text: string; command: string }
export function actionsNeeded(store: StateStore, config: FlowConfig, now = new Date()): Action[] {
  const out: Action[] = [];
  for (const flow of visibleFlows(store)) {
    for (const a of store.listAmends(flow.id).filter((a) => a.status === 'proposed')) out.push({ key: `${flow.id}:amend:${a.id}`, text: amendText(a), command: `/forge-approve amend:${a.id} 或 /forge-reject amend:${a.id} "<意见>"` });
    for (const c of pendingChanges(store, flow.id)) out.push({ key: `${flow.id}:change:${c.id}`, text: `变更请求 ${c.id} 的修订已就绪：${short(c.what, 80)}`, command: `/forge-approve change:${c.id} 或 /forge-reject change:${c.id} "<意见>"` });
    const tasks = store.listTasks(flow.id);
    const isS = (flow.s_stages ?? []).some((x) => x.id === flow.stage);
    if (flow.stage_status === 'awaiting_human') out.push({ key: `${flow.id}:gate:${flow.stage}`, text: awaitingMerge(flow) ? '全部任务已完成，等你批准合入主分支' : isS ? `${flow.stage} 阶段已通过检查，等你签收后进入下一阶段` : flow.stage === 'P0' ? '规格已通过检查，等你批准' : flow.stage === 'P1' ? '契约与计划已通过检查，等你批准' : `${phaseLabel(flow, currentPhase(config, flow, tasks))}阶段的产出等待你审批`, command: `/forge-approve stage:${flow.stage} 或 /forge-reject stage:${flow.stage} "<意见>"${isS ? '；签收材料：/forge report' : ''}` });
    if (flow.stage_status === 'needs_human') {
      const why = needsHumanReason(store, flow);
      if (flow.mode === 'fix') out.push({ key: `${flow.id}:fixhelp`, text: `修复需要你处理${why ? `：${short(why, 200)}` : ''}`, command: '/forge accept --note "<说明>"（放行并结束）或 /forge abort（放弃）' });
      else out.push({ key: `${flow.id}:gatefail:${flow.stage}`, text: `阶段门禁修复轮数用尽，需要你处理${why ? `：${short(why, 200)}` : ''}`, command: `/forge accept ${flow.stage} --note "<说明>"（人工放行进入签收）、/forge gate（重跑门禁）或 /forge-reject "<意见>"（打回）` });
    }
    const gate = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.type === 'gate_result');
    if (flow.stage_status === 'active' && gate?.to === 'active' && gate.data?.['stage'] === flow.stage && !tasks.some((t) => t.stage === flow.stage && !['done', 'cancelled'].includes(t.status))) out.push({ key: `${flow.id}:gatefail:${gate.seq}`, text: `阶段检查未通过：${short(gate.reason ?? '')}`, command: '处理后执行 /forge gate 重跑' });
    for (const t of tasks.filter(awaitingReview)) out.push({ key: `${flow.id}:timeout:${t.id}:${t.timeout_review!.run}`, text: `${t.id} 运行超时，等主会话复核`, command: '主会话调用 forge_resolve_timeout；查看材料：/forge-status --detail' });
    for (const t of tasks.filter((x) => x.scope_request)) out.push({ key: `${flow.id}:scope:${t.id}:${t.scope_request!.at}`, text: `${t.id} 申请扩大可写范围：${t.scope_request!.paths.join('、')}`, command: '主会话调用 forge_resolve_scope；查看材料：/forge-status --detail' });
    for (const t of tasks.filter((x) => x.status === 'blocked')) {
      out.push({ key: `${flow.id}:blocked:${t.id}:${t.version}`, text: `${t.id}「${short(t.title, 40)}」${BLOCKED_LABEL[t.blocked_by ?? ''] ?? '阻塞'}：${short(t.blocked_reason ?? '')}`, command: blockedCommand(t) });
    }
    const stuck = stuckTasks(flow, tasks);
    // 停滞（waits.ts 的等待图）：每条一项。pending 的 task 等在 blocked 的硬依赖上不另报：那是排队的常态，blocked 的 task 自己有一条带解除命令的项，
    // 全都被挡住时还有下面的"流程卡住"；其余——awaiting_inputs / disputed 在等已阻塞的 task、环、等到已取消——只有这里会报
    for (const s of stalls(tasks)) {
      const waiter = s.kind === 'cycle' ? undefined : tasks.find((x) => x.id === s.tasks[0]);
      if (s.kind === 'blocked' && waiter?.status === 'pending') continue;
      const target = s.target ? tasks.find((x) => x.id === s.target) : undefined;
      out.push({ key: `${flow.id}:stall-wait:${s.kind}:${s.tasks.join(',')}${s.target ? `:${s.target}@${target?.version ?? 0}` : ''}`, text: s.reason,
        command: s.kind === 'blocked' ? `/forge unblock ${s.target}` : '/forge-status --detail 查看等待关系；无法自行恢复时 /forge abort' });
    }
    if (stuck?.length) out.push({ key: `${flow.id}:stuck:${stuck.map((t) => `${t.id}@${t.version}`).join(',')}`, text: `流程卡住：剩下的任务都被 ${stuck.map((t) => t.id).join('、')} 挡住`, command: '/forge unblock <任务>' });
    const budget = budgetState(store, config, flow, now);
    // 预算用尽、同步冲突本身就是停下来的原因，下面各有一条；不再重复报"停滞"
    const stall = budget?.exceeded || flow.sync?.status === 'conflict' ? null : stallOf(store, config, flow, now);
    if (stall) out.push({ key: `${flow.id}:stall:${stall.seq}`, text: `流程停滞：${stall.minutes} 分钟没有进展`, command: '/forge-status --detail；/forge-resume' });
    if (budget?.warn) out.push({ key: `${flow.id}:budget:${budget.exceeded ? 'over' : 'warn'}`, text: formatBudget(budget), command: '/forge budget tokens|cost|minutes <数值>' });
    if (flow.sync?.status === 'conflict') out.push({ key: `${flow.id}:sync:${flow.sync.main_sha}`, text: `把 ${config.raw.main_branch} 同步进集成分支时冲突，已暂停派发新任务：${short(flow.sync.reason ?? '')}`, command: '/forge sync' });
  }
  for (const p of activePauses(store, now)) out.push({ key: `model-pause:${p.model}@${p.since}`, text: describePause(p, now), command: `/forge models resume ${p.model} 或 /forge-config 换模型` });
  const cand = store.readKnowledge().entries.filter((e) => e.status === 'candidate');
  if (cand.length) out.push({ key: `knowledge:candidates:${cand.at(-1)!.id}`, text: `${cand.length} 条知识候选待确认`, command: '/forge knowledge accept <K-编号> 或 retire <K-编号>' });
  return out;
}
/** 阶段进入 needs_human 的原因（最近一次转入 needs_human 的事件的 reason） */
export function needsHumanReason(store: StateStore, flow: Pick<FlowFile, 'id' | 'stage'>): string | null {
  const ev = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.data?.['entity'] === 'stage' && e.data['stage'] === flow.stage && e.to === 'needs_human');
  return ev?.reason ?? null;
}
export function visibleFlows(store: StateStore): FlowFile[] {
  const active = store.readState().active_flow;
  return [...(active ? [store.readFlow(active)] : []), ...(store.openFixFlow() ? [store.openFixFlow()!] : [])];
}
function phaseBar(config: FlowConfig, flow: FlowFile, cur: PhaseOrDone): string {
  const phases: PhaseOrDone[] = [...phasesOf(config, flow), 'done'];
  // 最后一个阶段通过检查、等你批准合入时，已经走到"交付"：前面的阶段都打勾
  if (awaitingMerge(flow)) return phases.map((p, i) => i < phases.length - 1 ? `${PHASE_LABEL[p]} ✓` : '[交付（待合入）]').join(' → ');
  const index = phases.indexOf(cur);
  return phases.map((p, i) => i < index ? `${PHASE_LABEL[p]} ✓` : i === index ? `[${PHASE_LABEL[p]}]` : PHASE_LABEL[p]).join(' → ');
}
const MODE_LABEL: Record<FlowFile['mode'], string> = { build: '新项目', feature: '新功能', fix: '修复' };
/** S0 是骨架阶段，其余直接用编号 */
const stageName = (id: string) => (id === 'S0' ? 'S0 骨架' : id);
const isAdopt = (flow: Pick<FlowFile, 'stages'>) => flow.stages.includes('ADOPT');
const isLastStage = (flow: Pick<FlowFile, 'stage' | 'stages'>) => flow.stage === flow.stages.at(-1);

/** 实施阶段的 S 阶段条：S0 骨架 ✓ → [S1] → S2 */
function stageBar(flow: FlowFile): string {
  const ss = flow.s_stages ?? [];
  const idx = ss.findIndex((s) => s.id === flow.stage);
  return ss.map((s, i) => i < idx || (i === idx && flow.stage_status === 'done') ? `${stageName(s.id)} ✓` : i === idx ? `[${stageName(s.id)}]` : stageName(s.id)).join(' → ');
}
function stageStateText(flow: FlowFile, tasks: readonly TaskFile[]): string {
  const qaRunning = tasks.some((t) => t.kind === 'qa' && t.stage === flow.stage && !['done', 'cancelled'].includes(t.status));
  switch (flow.stage_status) {
    case 'awaiting_gate': return qaRunning ? '阶段验收中' : '阶段检查中（全量测试与合规检查）';
    case 'needs_human': return '阶段检查未通过，等你处理';
    case 'awaiting_human': return awaitingMerge(flow) ? '全部完成，等你批准交付' : '已通过检查，等你签收';
    case 'done': return '已完成';
    case 'aborted': return '已中止';
    default: return '进行中';
  }
}
/** 当前阶段的一行说明：规格、契约与计划阶段说明在做什么；实施阶段给出 S 阶段名、目标与状态 */
function phaseLine(flow: FlowFile, tasks: readonly TaskFile[], cur: PhaseOrDone, main: string): string[] {
  if (flow.mode === 'fix') return [fixStatusLine(flow, tasks)];
  if (cur === 'done') return ['交付：已合入主分支'];
  if (awaitingMerge(flow)) {
    const def = flow.s_stages?.find((s) => s.id === flow.stage);
    return [`交付阶段：${def ? `${stageName(def.id)}「${short(def.goal, 80)}」` : '全部任务'}已通过检查，等你批准合入 ${main}`];
  }
  const st = flow.stage_status;
  if (cur === 'spec') {
    const state = st === 'awaiting_human' ? '规格已通过检查，等你批准' : st === 'awaiting_gate' ? '规格检查中' : st === 'needs_human' ? '规格检查多次未通过，等你处理' : '与你讨论需求，整理成可验证的规格';
    return [`规格阶段：${state}`];
  }
  if (cur === 'plan') {
    if (isAdopt(flow)) return ['契约与计划阶段：纳管现有代码，整理契约'];
    const state = st === 'awaiting_human' ? '契约与计划已通过检查，等你批准' : st === 'awaiting_gate' ? '契约与计划检查中' : st === 'needs_human' ? '契约与计划检查多次未通过，等你处理' : 'architect 起草契约与计划';
    return [`契约与计划阶段：${state}`];
  }
  const def = flow.s_stages?.find((s) => s.id === flow.stage);
  if (!def) return ['实施阶段：按任务实施并运行全量验证'];
  return [`实施阶段：${stageBar(flow)}`, `当前阶段 ${stageName(def.id)}：${short(def.goal, 80)}（${stageStateText(flow, tasks)}）`];
}
function specLines(flow: FlowFile): string[] {
  const spec = flow.spec;
  if (flow.stage !== 'P0' && !spec) return [];
  return [`规格：${spec?.submitted ? '已提交' : '尚未提交'}；检查：${spec ? spec.errors.length ? '未通过' : '通过' : '尚未检查'}`, ...(spec?.errors ?? []).map((s) => `- ${s}`), ...(spec?.warnings ?? []).map((s) => `警告：${s}`), ...(spec?.feedback ? [`反馈：${spec.feedback}`] : []), ...(spec?.permission_changes ?? [])];
}
const CHANGE_STATE = (c: ChangeFile, ready: boolean) => c.status === 'proposed' ? (ready ? '修订已就绪，等你批准' : '修订已提交，合并中') : c.status === 'rejected' ? '已打回，等待返工' : 'architect 起草修订中';
function changeLines(store: StateStore, flowId: string): string[] {
  const ready = new Set(pendingChanges(store, flowId).map((c) => c.id));
  return store.listChanges(flowId).filter((c) => ['drafting', 'proposed', 'rejected'].includes(c.status)).map((c) => `变更请求 ${c.id}：${CHANGE_STATE(c, ready.has(c.id))}（${short(c.what, 60)}）`);
}
function idleText(flow: FlowFile, tasks: readonly TaskFile[]): string {
  if (flow.stage_status === 'awaiting_human') return `无（等待你审批${(flow.s_stages ?? []).some((x) => x.id === flow.stage) ? '，签收材料：/forge report' : ''}）`;
  if (flow.stage_status === 'needs_human') return '无（阶段检查未通过，等你决定）';
  if (flow.stage_status === 'awaiting_gate') return '阶段检查中';
  if (tasks.some((t) => t.status === 'blocked')) return '无（有任务在等你处理，见上）';
  return '无';
}
export function renderFlow(store: StateStore, config: FlowConfig, flow: FlowFile, now = new Date()): string {
  const tasks = store.listTasks(flow.id);
  const cur = currentPhase(config, flow, tasks);
  const counted = tasks.filter((t) => t.status !== 'cancelled' && !isStageLevelTask(t) && (flow.mode === 'fix' || cur === 'done' || phaseOfStage(config, flow.mode, t.stage) === cur));
  const doneN = (xs: readonly TaskFile[]) => xs.filter((t) => t.status === 'done').length;
  const stageTasks = counted.filter((t) => t.stage === flow.stage);
  const hasStages = cur === 'implementation' && flow.mode !== 'fix' && !!flow.s_stages?.some((s) => s.id === flow.stage);
  const progress = hasStages ? `进度：${flow.stage} ${doneN(stageTasks)} / ${stageTasks.length} 个任务完成（全部实施阶段 ${doneN(counted)} / ${counted.length}）` : `进度：${doneN(counted)} / ${counted.length} 个任务完成`;
  const active = tasks.filter((t) => INFLIGHT.has(t.status));
  const budget = budgetState(store, config, flow, now);
  return [
    `${flow.id}「${short(flow.title, 60)}」（${isAdopt(flow) ? '纳管' : MODE_LABEL[flow.mode]}）`,
    ...(flow.mode === 'fix' ? [] : [phaseBar(config, flow, cur)]),
    ...phaseLine(flow, tasks, cur, config.raw.main_branch),
    ...(cur === 'done' && flow.mode !== 'fix' || cur === 'spec' || (cur === 'plan' && !counted.length) ? [] : [progress]),
    ...(cur === 'spec' ? specLines(flow) : []),
    ...(cur === 'plan' ? [planStatus(store, flow.id)].filter(Boolean) : []),
    ...changeLines(store, flow.id),
    active.length ? `正在进行：\n${active.map((t) => `- ${t.id} ${short(t.title, 40)}（${t.lease?.role ?? t.role}）${flow.mode === 'fix' && t.kind === 'qa' ? '复现确认中' : taskActivity(t, lastFailureKind(store, flow.id, t.id))}`).join('\n')}` : `正在进行：${idleText(flow, tasks)}`,
    ...(tasks.some((t) => t.status === 'blocked') ? [`阻塞：${tasks.filter((t) => t.status === 'blocked').map((t) => t.id).join('、')}`] : []),
    ...(flow.sync?.status === 'fixing' ? [`主分支同步：有冲突，正在自动解决`] : []),
    ...(budget && !budget.warn ? [formatBudget(budget)] : []),
  ].join('\n');
}
/** 没有进行中的流程时：最近结束的那个流程（完成或中止）及下一步 */
function lastEnded(store: StateStore): FlowFile | null {
  const ended = store.listFlows().map((id) => store.readFlow(id)).filter((f) => f.stage_status === 'done' || f.stage_status === 'aborted');
  return ended.at(-1) ?? null;
}
const START_HINT = '开始：把需求文档放进 docs/ 后 /forge-build（没有文档也可以，主会话会问你）、/forge-build --feature 或 /forge-fix "<问题>"。';
export function renderStatus(store: StateStore, config: FlowConfig, now = new Date()): string {
  const flows = visibleFlows(store);
  if (!flows.length) {
    const last = lastEnded(store);
    if (!last) return `当前没有进行中的流程。${START_HINT}`;
    const done = last.stage_status === 'done';
    return `当前没有进行中的流程。\n最近的流程 ${last.id}「${short(last.title, 60)}」（${isAdopt(last) ? '纳管' : MODE_LABEL[last.mode]}）${done ? last.mode === 'fix' ? '已结束，修复日志：/forge-status --detail' : `已完成，交付到 ${config.raw.main_branch}` : '已中止（集成分支与 worktree 保留）'}。\n${START_HINT}`;
  }
  const actions = actionsNeeded(store, config, now);
  return [actions.length ? `需要你处理：\n${actions.map((a) => `- ${a.text}\n  → ${a.command}`).join('\n')}` : '需要你处理：无', ...flows.map((f) => renderFlow(store, config, f, now)), '（完整任务表与最近事件：/forge-status --detail；成本：/forge-status --cost；度量：/forge-status --metrics）'].join('\n\n');
}

export interface StatusSnapshot {
  phases: Record<string, PhaseOrDone>;
  actions: Record<string, string>;
  attempts: Record<string, number>;
}

export function snapshotOf(store: StateStore, config: FlowConfig): StatusSnapshot {
  const snap: StatusSnapshot = { phases: {}, actions: {}, attempts: {} };
  const flows = visibleFlows(store);
  for (const f of flows) {
    const tasks = store.listTasks(f.id);
    snap.phases[f.id] = currentPhase(config, f, tasks);
    for (const t of tasks) snap.attempts[`${f.id}/${t.id}`] = t.attempts;
  }
  for (const a of actionsNeeded(store, config)) snap.actions[a.key] = `${a.text} → ${a.command}`;
  return snap;
}

export function notices(prev: StatusSnapshot, next: StatusSnapshot, failureKind?: (flow: string, task: string) => string | null): string[] {
  const out: string[] = [];
  for (const [flow, phase] of Object.entries(next.phases)) {
    const before = prev.phases[flow];
    if (before && before !== phase) out.push(phase === 'done' ? `pi-forge：${flow} 已完成。` : `pi-forge：${flow} 进入${PHASE_LABEL[phase]}阶段。`);
  }
  for (const flow of Object.keys(prev.phases)) {
    if (!(flow in next.phases)) out.push(`pi-forge：${flow} 已结束${flow.startsWith('X-') ? '，修复已合入主分支或已中止，详见 /forge-status --cost 中的修复日志' : ''}。`);
  }
  for (const [key, text] of Object.entries(next.actions)) {
    if (!(key in prev.actions)) out.push(`pi-forge 需要你处理：${text}`);
  }
  for (const key of Object.keys(prev.actions)) {
    if (key.startsWith('model-pause:') && !(key in next.actions)) out.push(`pi-forge：模型 ${key.slice('model-pause:'.length, key.lastIndexOf('@'))} 已恢复派发。`);
  }
  for (const [key, n] of Object.entries(next.attempts)) {
    if (n === 1 && (prev.attempts[key] ?? 0) === 0) {
      const [flow, task] = key.split('/') as [string, string];
      const kind = failureKind?.(flow, task);
      out.push(`pi-forge：${task} 第一次未通过${kind ? `（${kind}）` : ''}，程序已自动重试。`);
    }
  }
  return out;
}

/**
 * 状态栏一行（调度模式、终端界面）：流程、高层阶段（实施时带 S 阶段）、本阶段进度、一句话状态、需要用户处理的事项数。
 * 保持短：不列任务编号。没有可见流程时返回 null（清除状态栏）。
 */
export function statusLine(store: StateStore, config: FlowConfig, now = new Date()): string | null {
  const flows = visibleFlows(store);
  if (!flows.length) return null;
  const actions = actionsNeeded(store, config, now).length;
  const parts = flows.map((flow) => {
    const tasks = store.listTasks(flow.id);
    const cur = currentPhase(config, flow, tasks);
    const live = tasks.filter((t) => t.status !== 'cancelled' && !isStageLevelTask(t));
    const inPhase = (flow.mode === 'fix' || cur === 'done' ? live : live.filter((t) => phaseOfStage(config, flow.mode as 'build' | 'feature', t.stage) === cur))
      .filter((t) => flow.mode === 'fix' || cur !== 'implementation' || !flow.s_stages?.length || t.stage === flow.stage);
    const active = tasks.filter((t) => INFLIGHT.has(t.status));
    const head = flow.mode === 'fix' ? `${flow.id} 修复·${FIX_PHASE_LABEL[fixPhase(flow, tasks)]}` : awaitingMerge(flow) ? `${flow.id} 交付`
      : `${flow.id} ${phaseLabel(flow, cur)}${cur === 'implementation' && flow.s_stages?.some((s) => s.id === flow.stage) ? ` ${flow.stage}` : ''}`;
    const state = awaitingMerge(flow) ? '等你批准合入' : flow.stage_status === 'awaiting_human' ? '等你审批' : flow.stage_status === 'needs_human' ? '等你处理'
      : flow.stage_status === 'awaiting_gate' ? (tasks.some((t) => t.kind === 'qa' && INFLIGHT.has(t.status)) ? '阶段验收中' : '阶段检查中') : active.length ? `${active.length} 个任务进行中` : '';
    return [head, flow.mode === 'fix' ? '' : inPhase.length ? `${inPhase.filter((t) => t.status === 'done').length}/${inPhase.length}` : '', state].filter(Boolean).join(' · ');
  });
  return `pi-forge ${parts.join(' ｜ ')}${actions ? ` · 需要你处理 ${actions} 项` : ''}`;
}
