// 主会话裁决：程序遇到需要拿主意的情况（任务阻塞、阶段门禁用尽）时，先交给 orchestrator 决定；
// orchestrator 也解决不了的，再转交用户。用户始终可以直接处理。
//  - 任务：程序或子进程造成的阻塞带 blocked_owner = orchestrator（state-machine.ts 的 blocked()）；同一任务主会话最多决定
//    MAX_ORCHESTRATOR_DECISIONS 次，之后再阻塞直接等用户。等架构师回答的阻塞不交给主会话（程序在回答后自动恢复）。
//  - 阶段：S 阶段 needs_human 时，主会话可以放行进入签收（用户仍要签收）或转交用户。
//  - 签收打回：用户 /forge-reject 之后，主会话把能明确归属的修改用 fix 交给那个任务（程序建修复任务，接着它的会话）；
//    归属不清的用 forge_ask_architect（kind: change）交给架构师。
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import { isLightFlow, type FlowFile, type TaskFile } from '../state/schemas.ts';
import { MAX_ORCHESTRATOR_DECISIONS } from '../state/state-machine.ts';
import { createStageFixTasks } from '../acceptance/stage-fix.ts';
import { isArchitectStage } from '../plan/plan-flow.ts';

export const DECISIONS = ['retry', 'accept', 'fix', 'user'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface PendingDecision {
  kind: 'task' | 'stage';
  /** 任务编号或阶段编号 */
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

/**
 * 用户签收时打回了当前阶段、阶段还没有重新进入门禁：返回打回意见，否则 null。
 * 打回后主会话可以连续交出几处修改（每处一个 fix），所以不按"之后有没有任务变化"判断。
 */
export function openRejection(store: StateStore, flow: FlowFile): string | null {
  if (flow.stage_status !== 'active' || isLightFlow(flow) || isArchitectStage(flow.stage)) return null;
  const last = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.data?.['entity'] === 'stage' && e.data['stage'] === flow.stage);
  return last?.trigger === 'reject' ? last.reason ?? '' : null;
}

function taskOptions(t: TaskFile): Decision[] {
  return ['retry', ...(t.blocked_by === 'review_exhausted' || t.blocked_by === 'no_changes' ? ['accept' as const] : []), 'user'];
}

const OPTION_TEXT: Record<Decision, string> = {
  retry: 'retry（计数清零，带着 note 里的意见重新做；也用来回答子进程的提问）',
  accept: 'accept（审查轮数用尽：接受现状进入合并，剩下的问题留给 stage-qa；合并时没有改动：确认要做的已在集成分支上，视为完成）',
  fix: 'fix（签收打回后：target 写负责的任务，note 写要改什么；程序建修复任务接着它的会话）',
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
  return out;
}

/** 各流程待决定事项的标识；事项处理掉就消失，同一任务再次阻塞时又是新出现的 */
export const decisionKeys = (store: StateStore, flowIds: readonly string[]): string[] =>
  flowIds.flatMap((f) => pendingDecisions(store, f).map((p) => `${f}:${p.kind}:${p.id}`));

/** 新出现待决定事项时发给主会话的消息（主会话空闲时没有别的东西会让它开始一轮）；没有新事项返回 null */
export function wakeMessage(before: ReadonlySet<string>, now: readonly string[]): string | null {
  const fresh = now.filter((k) => !before.has(k)).map((k) => k.split(':').slice(2).join(':'));
  if (!fresh.length) return null;
  return `[pi-forge] 有新的事项等你决定：${fresh.join('、')}。用 forge_status 看材料，再用 forge_decide 处理；已经处理过的忽略。`;
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
  if (!why) throw new DecisionError('note 必填：写明理由（retry 时写给子进程的意见，fix 时写要改什么，user 时写要用户决定什么）。');
  if (decision === 'fix') return { text: await signoffFix(store, flowId, target, why) };
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
  switch (decision) {
    case 'accept':
      await store.transitionStage(flowId, { to: 'awaiting_human', trigger: 'accept', actor: 'orchestrator', delegated: true, reason: `主会话放行：${why}` });
      return { text: `已放行阶段 ${target} 进入签收；用户签收时会看到你的说明。` };
    default:
      await store.recordEvent({ flow: flowId, actor: 'orchestrator', type: 'note', reason: `阶段 ${target} 转交用户：${why}`, data: { stage_to_user: target, needs_human: true } });
      return { text: `已把阶段 ${target} 转交用户。向用户说明原因与需要的决定。` };
  }
}

/** 签收打回后，主会话认定这处修改归 target（实现任务，或它的修复任务）：建一个修复任务，接着那个任务最后一次的会话 */
async function signoffFix(store: StateStore, flowId: string, target: string, note: string): Promise<string> {
  const flow = store.readFlow(flowId);
  const feedback = openRejection(store, flow);
  if (feedback === null) throw new DecisionError('fix 只用于用户签收时打回之后（/forge-reject）、阶段重新验收之前：把能明确归属的修改交给负责的任务。');
  let t: TaskFile;
  try { t = store.readTask(flowId, target); } catch { throw new DecisionError(`任务 ${target} 不存在。`); }
  const impl = t.kind === 'fix' && t.for_task ? store.readTask(flowId, t.for_task) : t;
  if (impl.kind !== 'impl' || impl.status !== 'done') throw new DecisionError(`${target} 不是已完成的实现任务，不能把修改交给它。归属不清或涉及多个任务时，用 forge_ask_architect（kind: change）交给架构师。`);
  const text = `用户签收阶段 ${flow.stage} 时打回：${feedback}\n\n主会话判断其中这部分归你（${impl.id}「${impl.title}」）要改：\n${note}`;
  const r = await createStageFixTasks(store, flowId, 'signoff', [{ files: [], text, owner: impl.id, writes: impl.writes }], `${flow.stage}：${note.replace(/\s+/g, ' ').slice(0, 40)}`, 'orchestrator');
  return `已为 ${impl.id} 建修复任务 ${r.tasks.join('、')}（接着它的会话）。还有别的修改就继续交出；全部修改合入后程序重新验收本阶段。`;
}
