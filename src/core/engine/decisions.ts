// 主会话裁决：程序遇到需要拿主意的情况（任务阻塞、阶段门禁用尽、变更请求的修订就绪）时，先交给 orchestrator 决定；
// orchestrator 也解决不了的，再转交用户。用户始终可以直接处理。
//  - 任务：程序或子进程造成的阻塞带 blocked_owner = orchestrator（state-machine.ts 的 blocked()）；同一任务主会话最多决定
//    MAX_ORCHESTRATOR_DECISIONS 次，之后再阻塞直接等用户。
//  - 阶段：S 阶段 needs_human 时，主会话可以放行进入签收（用户仍要签收）或转交用户。
//  - 变更请求：修订就绪后主会话可以批准、打回（最多打回到第 3 轮）或转交用户。
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import { isLightFlow, type ChangeFile, type FlowFile, type TaskFile } from '../state/schemas.ts';
import { MAX_ORCHESTRATOR_DECISIONS } from '../state/state-machine.ts';
import { approveChange, changeApprovalText, pendingChanges, rejectChange } from '../plan/change-flow.ts';

export const DECISIONS = ['retry', 'accept', 'approve', 'reject', 'user'] as const;
export type Decision = (typeof DECISIONS)[number];

/** 变更请求最多起草几轮还能由主会话打回 */
const MAX_CHANGE_ROUNDS_FOR_ORCHESTRATOR = 3;

export interface PendingDecision {
  kind: 'task' | 'stage' | 'change';
  /** 任务编号、阶段编号或变更请求编号 */
  id: string;
  options: Decision[];
  /** 给主会话看的材料 */
  text: string;
}

export class DecisionError extends Error {}

const one = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

const isSStage = (flow: FlowFile) => (flow.s_stages ?? []).some((s) => s.id === flow.stage);

/** 阶段最近一次进入 needs_human 的事件序号与原因 */
function needsHumanEntry(store: StateStore, flow: FlowFile): { seq: number; reason: string } | null {
  const ev = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.data?.['entity'] === 'stage' && e.data['stage'] === flow.stage && e.to === 'needs_human');
  return ev ? { seq: ev.seq, reason: ev.reason ?? '' } : null;
}

/** S 阶段的 needs_human 是否交给主会话决定：进入之后主会话还没有转交用户 */
export function stageDelegated(store: StateStore, flow: FlowFile): boolean {
  if (flow.stage_status !== 'needs_human' || isLightFlow(flow) || !isSStage(flow)) return false;
  const entry = needsHumanEntry(store, flow);
  const events = store.readEvents().filter((e) => e.flow === flow.id);
  if (entry && events.some((e) => e.seq > entry.seq && e.data?.['stage_to_user'] === flow.stage)) return false;
  return true;
}

/** 修订就绪、还没转交用户的变更请求 */
export const changeDelegated = (c: ChangeFile) => !c.to_user;

function taskOptions(t: TaskFile): Decision[] {
  return ['retry', ...(t.blocked_by === 'review_exhausted' || t.blocked_by === 'no_changes' ? ['accept' as const] : []), 'user'];
}

const OPTION_TEXT: Record<Decision, string> = {
  retry: 'retry（计数清零，带着 note 里的意见重新做；也用来回答子进程的提问）',
  accept: 'accept（审查轮数用尽：接受现状进入合并，剩下的问题留给 stage-qa；合并时没有改动：确认要做的已在集成分支上，视为完成）',
  approve: 'approve（批准修订并落地）',
  reject: 'reject（打回，note 写修改意见，architect 返工）',
  user: 'user（转交用户，note 写清楚要用户决定什么）',
};

export function pendingDecisions(store: StateStore, flowId: string): PendingDecision[] {
  const out: PendingDecision[] = [];
  for (const t of store.listTasks(flowId).filter((x) => x.status === 'blocked' && x.blocked_owner === 'orchestrator')) {
    const h = store.readHandoff(flowId, t.id).trim();
    out.push({
      kind: 'task', id: t.id, options: taskOptions(t),
      text: [`### ${t.id}「${t.title}」（${t.role}，阻塞原因 ${t.blocked_by ?? '未知'}，主会话已决定 ${t.decisions ?? 0}/${MAX_ORCHESTRATOR_DECISIONS} 次）`,
        `- 原因：${one(t.blocked_reason ?? '', 800)}`,
        ...(h ? [`- handoff（最近部分）：\n${tail(h, 1200).split('\n').map((x) => `  ${x}`).join('\n')}`] : [])].join('\n'),
    });
  }
  const flow = store.readFlow(flowId);
  if (stageDelegated(store, flow)) {
    out.push({ kind: 'stage', id: flow.stage, options: ['accept', 'user'],
      text: `### 阶段 ${flow.stage} 门禁或 stage-qa 的修复轮数用尽\n- 原因：${one(needsHumanEntry(store, flow)?.reason ?? '', 1200)}\n- accept 放行进入签收（用户签收时会看到你的说明）；问题影响需求或需要用户判断时转交用户` });
  }
  for (const c of pendingChanges(store, flowId).filter(changeDelegated)) {
    out.push({ kind: 'change', id: c.id, options: ['approve', ...(c.rounds < MAX_CHANGE_ROUNDS_FOR_ORCHESTRATOR ? ['reject' as const] : []), 'user'],
      text: `### 变更请求 ${c.id}（${c.source}，第 ${c.rounds} 轮修订）：${one(c.what, 200)}\n- 原因：${one(c.why, 400)}\n${changeApprovalText(c)}` });
  }
  return out;
}

/** 写给主会话的做法 */
export const DECISION_GUIDE = '用 forge_decide(target, decision, note) 决定。先看材料，能自己判断的自己决定（note 写清楚理由或给子进程的意见）；需求取舍、要看界面效果、要用户的账号或环境、主工作区里用户自己的改动，这些转交用户。';

export function decisionsText(pending: readonly PendingDecision[]): string {
  return pending.map((p) => `${p.text}\n- 可选：${p.options.map((o) => OPTION_TEXT[o]).join('；')}`).join('\n');
}

export interface DecideDeps { root: string; store: StateStore; config: FlowConfig }
export interface DecideResult { text: string }

export async function decide(d: DecideDeps, flowId: string, target: string, decision: Decision, note: string): Promise<DecideResult> {
  const { store } = d;
  const why = note.trim();
  if (!why) throw new DecisionError('note 必填：写明理由（retry 时写给子进程的意见，user 时写要用户决定什么）。');
  const p = pendingDecisions(store, flowId).find((x) => x.id === target);
  if (!p) throw new DecisionError(`${target} 没有等主会话决定的事项。用 forge_status 查看。`);
  if (!p.options.includes(decision)) throw new DecisionError(`${target} 不能 ${decision}，可选：${p.options.join('、')}。`);

  if (p.kind === 'task') {
    const t = store.readTask(flowId, target);
    switch (decision) {
      case 'retry': {
        await store.appendHandoff(flowId, t.id, `主会话的意见：\n${why}`, 'orchestrator');
        const next = await store.transitionTask(flowId, t.id, { to: t.worktree || t.branch ? 'in_progress' : 'ready', trigger: 'unblock', actor: 'orchestrator', facts: { reset: true, reason: why } });
        return { text: `已让 ${t.id} 重新做（回到 ${next.status}，计数清零），意见已写进 handoff。` };
      }
      case 'accept':
        if (t.blocked_by === 'no_changes') {
          await store.transitionTask(flowId, t.id, { to: 'done', trigger: 'accept', actor: 'orchestrator', facts: { reason: why } });
          return { text: `已确认 ${t.id} 要做的已在集成分支上，视为完成。` };
        }
        await store.appendHandoff(flowId, t.id, `主会话接受了审查例外：\n${why}`, 'orchestrator');
        await store.transitionTask(flowId, t.id, { to: 'queued_merge', trigger: 'accept', actor: 'orchestrator', facts: { reason: why } });
        return { text: `已接受 ${t.id} 的审查例外，程序继续合并。` };
      default:
        await store.transitionTask(flowId, t.id, { to: 'blocked', trigger: 'hand_to_user', actor: 'orchestrator', facts: { reason: why } });
        return { text: `已把 ${t.id} 转交用户。向用户说明原因与需要的决定。` };
    }
  }
  if (p.kind === 'stage') {
    switch (decision) {
      case 'accept':
        await store.transitionStage(flowId, { to: 'awaiting_human', trigger: 'accept', actor: 'orchestrator', delegated: true, reason: `主会话放行：${why}` });
        return { text: `已放行阶段 ${target} 进入签收；用户签收时会看到你的说明。` };
      default:
        await store.recordEvent({ flow: flowId, actor: 'orchestrator', type: 'note', reason: `阶段 ${target} 转交用户：${why}`, data: { stage_to_user: target, needs_human: true } });
        return { text: `已把阶段 ${target} 转交用户。向用户说明原因与需要的决定。` };
    }
  }
  switch (decision) {
    case 'approve': return { text: await approveChange(d.root, store, d.config, flowId, target, 'orchestrator') };
    case 'reject': return { text: await rejectChange(d.root, store, d.config, flowId, target, why, 'orchestrator') };
    default:
      await store.handChangeToUser(flowId, target, why);
      return { text: `已把变更请求 ${target} 转交用户批准（/forge-approve change:${target}）。向用户说明修订内容与你的看法。` };
  }
}
