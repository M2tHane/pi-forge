// 来源：pi-flow src/core/status-view.ts @ 31f3f15（M1 改编）
// 用户界面只显示规格、契约与计划、实施、交付；内部状态保留在 --detail。
import { specStatus, amendSummary } from './spec-flow.ts';
import type { FlowConfig } from './config.ts';
import { isFinished, type StateStore } from './state-store.ts';
import { budgetState, formatBudget } from './cost-control.ts';
import { activePauses, describePause } from './model-pause.ts';
import { type FlowFile, type Phase, type TaskFile } from './schemas.ts';
import { stallOf, stuckTasks } from './forge-watch.ts';
import { IN_FLIGHT } from './state-machine.ts';
import { awaitingReview } from './run-budget.ts';

export type PhaseOrDone = Phase | 'done';
export const PHASE_LABEL: Record<PhaseOrDone, string> = { spec: '规格', plan: '契约与计划', implementation: '实施', done: '交付' };
export const awaitingMerge = (flow: Pick<FlowFile, 'stage' | 'stages' | 'stage_status'>) => flow.stage === flow.stages.at(-1) && flow.stage_status === 'awaiting_human';
export const phaseLabel = (flow: Pick<FlowFile, 'stage' | 'stages' | 'stage_status'>, p: PhaseOrDone) => awaitingMerge(flow) ? '交付（待合入）' : PHASE_LABEL[p];
const INFLIGHT = new Set<string>(IN_FLIGHT);
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');
export function phaseOfStage(config: FlowConfig, mode: 'build' | 'feature', stage: string): Phase {
  return config.raw.modes[mode]?.stages.find((s) => s.id === stage)?.phase ?? (stage === 'P0' ? 'spec' : stage === 'P1' ? 'plan' : 'implementation');
}
export function currentPhase(config: FlowConfig, flow: FlowFile, _tasks: TaskFile[]): PhaseOrDone {
  return isFinished(flow) && flow.stage_status === 'done' ? 'done' : flow.mode === 'fix' ? 'implementation' : phaseOfStage(config, flow.mode, flow.stage);
}
export function phasesOf(config: FlowConfig, flow: FlowFile): Phase[] {
  return flow.mode === 'fix' ? ['implementation'] : [...new Set(flow.stages.map((s) => phaseOfStage(config, flow.mode as 'build' | 'feature', s)))];
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
export interface Action { key: string; text: string; command: string }
export function actionsNeeded(store: StateStore, config: FlowConfig, now = new Date()): Action[] {
  const out: Action[] = [];
  for (const flow of visibleFlows(store)) {
    for (const a of store.listAmends(flow.id).filter((a) => a.status === 'proposed')) out.push({ key: `${flow.id}:amend:${a.id}`, text: amendSummary(a), command: `/forge-approve amend:${a.id} 或 /forge-reject amend:${a.id} "<意见>"` });
    const tasks = store.listTasks(flow.id);
    if (flow.stage_status === 'awaiting_human') out.push({ key: `${flow.id}:gate:${flow.stage}`, text: awaitingMerge(flow) ? '全部任务已完成，等你批准合入主分支' : `${phaseLabel(flow, currentPhase(config, flow, tasks))}阶段的产出等待你审批`, command: `/forge-approve stage:${flow.stage} 或 /forge-reject stage:${flow.stage} "<意见>"` });
    if (flow.stage_status === 'needs_human') out.push({ key: `${flow.id}:gatefail:${flow.stage}`, text: '阶段门禁修复轮数用尽，需要你处理', command: '/forge gate 重跑、/forge-reject "<意见>" 或 /forge accept <阶段> --note "<说明>"' });
    const gate = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.type === 'gate_result');
    if (flow.stage_status === 'active' && gate?.to === 'active' && gate.data?.['stage'] === flow.stage && !tasks.some((t) => t.stage === flow.stage && !['done', 'cancelled'].includes(t.status))) out.push({ key: `${flow.id}:gatefail:${gate.seq}`, text: `阶段检查未通过：${short(gate.reason ?? '')}`, command: '处理后执行 /forge gate 重跑' });
    for (const t of tasks.filter(awaitingReview)) out.push({ key: `${flow.id}:timeout:${t.id}:${t.timeout_review!.run}`, text: `${t.id} 运行超时，等主会话复核`, command: '主会话调用 forge_resolve_timeout；查看材料：/forge-status --detail' });
    for (const t of tasks.filter((x) => x.scope_request)) out.push({ key: `${flow.id}:scope:${t.id}:${t.scope_request!.at}`, text: `${t.id} 申请扩大可写范围：${t.scope_request!.paths.join('、')}`, command: '主会话调用 forge_resolve_scope；查看材料：/forge-status --detail' });
    for (const t of tasks.filter((x) => x.status === 'blocked')) out.push({ key: `${flow.id}:blocked:${t.id}:${t.version}`, text: `${t.id}「${short(t.title, 40)}」阻塞：${short(t.blocked_reason ?? '')}`, command: `/forge answer ${t.id}` });
    for (const t of tasks.filter((x) => x.status === 'awaiting_inputs')) {
      const latest = tasks.filter((a) => a.kind === 'acctest' && a.for_task === (t.for_task ?? t.id)).sort((a, b) => Number(a.id.match(/\.at-(\d+)$/)?.[1] ?? 1) - Number(b.id.match(/\.at-(\d+)$/)?.[1] ?? 1)).at(-1);
      const deps = tasks.filter((a) => a.status === 'blocked' && (a.id === latest?.id || t.depends_on.some((d) => d.type === 'soft' && d.task === a.id)));
      for (const dep of deps) out.push({ key: `${flow.id}:inputs:${t.id}:${dep.id}:${dep.version}`, text: `${t.id} 在等 ${dep.id}；${dep.id} 已阻塞：${short(dep.blocked_reason ?? '')}`, command: `/forge unblock ${dep.id}` });
    }
    const stuck = stuckTasks(flow, tasks);
    if (stuck?.length) out.push({ key: `${flow.id}:stuck:${stuck.map((t) => `${t.id}@${t.version}`).join(',')}`, text: `流程卡住：剩下的任务都被 ${stuck.map((t) => t.id).join('、')} 挡住`, command: '/forge unblock <任务>' });
    const stall = stallOf(store, config, flow, now);
    if (stall) out.push({ key: `${flow.id}:stall:${stall.seq}`, text: `流程停滞：${stall.minutes} 分钟没有进展`, command: '/forge-status --detail；/forge-resume' });
    const budget = budgetState(store, config, flow, now);
    if (budget?.warn) out.push({ key: `${flow.id}:budget:${budget.exceeded ? 'over' : 'warn'}`, text: formatBudget(budget), command: '/forge budget tokens|cost|minutes <数值>' });
    if (flow.sync?.status === 'conflict') out.push({ key: `${flow.id}:sync:${flow.sync.main_sha}`, text: `把 ${config.raw.main_branch} 同步进集成分支时冲突，已暂停派发新任务：${short(flow.sync.reason ?? '')}`, command: '/forge sync' });
  }
  for (const p of activePauses(store, now)) out.push({ key: `model-pause:${p.model}@${p.since}`, text: describePause(p, now), command: `/forge models resume ${p.model} 或 /forge-config 换模型` });
  const cand = store.readKnowledge().entries.filter((e) => e.status === 'candidate');
  if (cand.length) out.push({ key: `knowledge:candidates:${cand.at(-1)!.id}`, text: `${cand.length} 条知识候选待确认`, command: '/forge knowledge accept <K-编号> 或 retire <K-编号>' });
  return out;
}
export function visibleFlows(store: StateStore): FlowFile[] {
  const active = store.readState().active_flow;
  return [...(active ? [store.readFlow(active)] : []), ...(store.openFixFlow() ? [store.openFixFlow()!] : [])];
}
function phaseBar(config: FlowConfig, flow: FlowFile, cur: PhaseOrDone): string {
  const phases: PhaseOrDone[] = [...phasesOf(config, flow), 'done'];
  const index = phases.indexOf(cur);
  return phases.map((p, i) => i < index ? `${PHASE_LABEL[p]} ✓` : i === index ? `[${phaseLabel(flow, p)}]` : PHASE_LABEL[p]).join(' → ');
}
export function renderFlow(store: StateStore, config: FlowConfig, flow: FlowFile): string {
  const tasks = store.listTasks(flow.id);
  const cur = currentPhase(config, flow, tasks);
  const counted = tasks.filter((t) => t.status !== 'cancelled' && (flow.mode === 'fix' || cur === 'done' || phaseOfStage(config, flow.mode, t.stage) === cur));
  const active = tasks.filter((t) => INFLIGHT.has(t.status));
  return [`${flow.id}「${short(flow.title, 60)}」`, phaseBar(config, flow, cur), `${PHASE_LABEL[cur]}阶段：${cur === 'spec' ? '整理可验证的规格' : cur === 'plan' ? '制定契约与计划（M3 实现）' : cur === 'implementation' ? '按任务实施并运行全量验证' : '已合入主分支'}`, `进度：${counted.filter((t) => t.status === 'done').length} / ${counted.length} 个任务完成`, specStatus(store, flow.id), active.length ? `正在进行：\n${active.map((t) => `- ${t.id} ${short(t.title, 40)}（${t.lease?.role ?? t.role}）${taskActivity(t, lastFailureKind(store, flow.id, t.id))}`).join('\n')}` : `正在进行：${flow.stage_status === 'awaiting_human' ? '无（等待你审批）' : flow.stage_status === 'awaiting_gate' ? '阶段检查中' : '无'}`, `阻塞：${tasks.filter((t) => t.status === 'blocked').map((t) => t.id).join('、') || '无'}`].join('\n');
}
export function renderStatus(store: StateStore, config: FlowConfig): string {
  const flows = visibleFlows(store);
  if (!flows.length) return '当前没有进行中的流程。开始：/forge-build --prd <文件>。';
  const actions = actionsNeeded(store, config);
  return [actions.length ? `需要你处理：\n${actions.map((a) => `- ${a.text}\n  → ${a.command}`).join('\n')}` : '需要你处理：无', ...flows.map((f) => renderFlow(store, config, f)), '（完整任务列表：/forge-status --detail；成本：/forge-status --cost）'].join('\n\n');
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
 * 状态栏一行（调度模式、终端界面）：流程、高层阶段、本阶段进度、正在进行的任务、需要用户处理的事项数。
 * 没有可见流程时返回 null（清除状态栏）。
 */
export function statusLine(store: StateStore, config: FlowConfig): string | null {
  const flows = visibleFlows(store);
  if (!flows.length) return null;
  const actions = actionsNeeded(store, config).length;
  const parts = flows.map((flow) => {
    const tasks = store.listTasks(flow.id);
    const cur = currentPhase(config, flow, tasks);
    const inPhase = (flow.mode === 'fix' || cur === 'done' ? tasks : tasks.filter((t) => phaseOfStage(config, flow.mode as 'build' | 'feature', t.stage) === cur))
      .filter((t) => t.status !== 'cancelled');
    const active = tasks.filter((t) => INFLIGHT.has(t.status));
    const running = active.slice(0, 3).map((t) => `${t.id} ${taskActivity(t, null)}`).join('，');
    const state = awaitingMerge(flow) ? '等你批准合入' : flow.stage_status === 'awaiting_human' ? '等待你审批' : flow.stage_status === 'awaiting_gate' ? '阶段检查中' : '';
    return [`${flow.id} ${phaseLabel(flow, cur)}`, inPhase.length ? `${inPhase.filter((t) => t.status === 'done').length}/${inPhase.length}` : '',
      running ? `进行中：${running}${active.length > 3 ? ` 等 ${active.length} 个` : ''}` : state].filter(Boolean).join(' · ');
  });
  return `pi-forge ${parts.join(' ｜ ')}${actions ? ` · 需要你处理 ${actions} 项` : ''}`;
}
