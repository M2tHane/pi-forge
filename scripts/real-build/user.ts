// 模拟用户的规则表，做成纯函数：decide(snapshot, state) 只读快照与计数状态，返回要做的动作；apply(state, action) 返回新的计数状态。
// 表里没有的情况一律返回 stuck 动作（算作流程失败），不即兴处理。
// 不依赖 Pi，不读磁盘；real-build.ts 负责把 .forge/ 与 RPC 事件整理成快照、把动作发出去。

/** 计数类别：gate（必经闸门：架构批准与各批签收）、extra:<类别>（额外介入，每类单独一列） */
export type Category = 'gate' | `extra:${string}`;

/** 放行上限：同一 task 放行 3 次后又停住算卡住；同一阶段放行 2 次后又 needs_human 算卡住 */
export const MAX_TASK_RELEASES = 3;
export const MAX_STAGE_ACCEPTS = 2;
/** 同一个动作（key 相同）重复发出的上限与最短间隔：命令发出后状态没变时才会重发 */
export const MAX_REPEATS = 3;
export const REPEAT_COOLDOWN_MS = 20_000;

export const CONFIRM_MERGE_OPTION = '确认合入并结束流程';
export const BLOCKED_ANSWER = '按你的推荐做，以 PRD 和契约为准';
export const ACCEPT_NOTE = '模拟用户：按现状放行';
export const INPUT_REPLY = '按你的推荐';

export interface UiRequest {
  id: string;
  method: 'select' | 'input' | 'editor' | 'confirm';
  title?: string;
  options?: string[];
}

export interface FlowSnap {
  id: string;
  stage: string;
  /** active | needs_human | awaiting_human | done | aborted */
  stageStatus: string;
  /** flow.version：状态变化后会变，用来区分"同一个闸门的第二次出现" */
  version: number;
  /** needs_human 交给主会话决定（还没转交用户）：用户这时不处理 */
  delegated?: boolean;
}

export interface TaskSnap {
  id: string;
  status: string;
  blockedBy: string | null;
  blockedReason: string | null;
  version: number;
  /** 'orchestrator'：先由主会话决定，用户这时不处理 */
  blockedOwner?: string | null;
}

export interface SimState {
  /** key → 已发出次数 */
  issued: Record<string, number>;
  /** key → 最近一次发出的时刻（毫秒） */
  lastAt: Record<string, number>;
  /** `${流程}:${task}` → 放行次数 */
  releases: Record<string, number>;
  /** `${流程}:${阶段}` → accept 次数 */
  accepts: Record<string, number>;
  counts: {
    /** 必经闸门（不含"确认合入"那次 select，它是最后一次 /forge-approve 的一部分） */
    gate: number;
    extra: Record<string, number>;
  };
}

export interface Snapshot {
  nowMs: number;
  /** 等待回答的扩展 UI 请求 */
  ui?: UiRequest | null;
  flow: FlowSnap | null;
  tasks: TaskSnap[];
}

export interface ActionMeta {
  /** 去重键：同一键重复出现时受冷却与次数限制 */
  key: string;
  category: Category;
  /** 是否计入类别计数（"确认合入"的 select 不重复计闸门） */
  counts: boolean;
  /** 触发原因，写进 interventions.jsonl */
  note: string;
  /** 计数副作用：哪个 task / 阶段的放行次数加一 */
  release?: string;
  accept?: string;
}

export type UiResponse = { value: string } | { cancelled: true } | { confirmed: boolean };
export type UiAction = ActionMeta & { kind: 'ui_response'; id: string; response: UiResponse; summary: string };
export type PromptAction = ActionMeta & { kind: 'prompt'; message: string };
export type StuckAction = { kind: 'stuck'; key: string; failure: 'limit' | 'out_of_table' | 'repeat'; reason: string };
export type Action = UiAction | PromptAction | StuckAction;

export function initialState(): SimState {
  return { issued: {}, lastAt: {}, releases: {}, accepts: {}, counts: { gate: 0, extra: {} } };
}

/** 选项里的"（推荐）"标记 */
const isRecommended = (label: string): boolean => /（推荐）|\(推荐\)|\(recommended\)/i.test(label);
/** ask_user 插件自己追加的"Other"选项 */
const isOtherOption = (label: string): boolean => /^\s*(\d+\.\s*)?other\b/i.test(label);
/** select：选带"（推荐）"的选项，没有就选第一个（跳过 Other） */
export function pickOption(options: readonly string[]): string | undefined {
  return options.find(isRecommended) ?? options.find((o) => !isOtherOption(o)) ?? options[0];
}

const scopeKey = (flow: string, id: string) => `${flow}:${id}`;

/** 同一个键刚发出不久、或已达到重复上限时的处理 */
function repeatGuard(state: SimState, key: string, nowMs: number): 'ok' | 'wait' | 'repeat' {
  const n = state.issued[key] ?? 0;
  if (n === 0) return 'ok';
  if (n >= MAX_REPEATS) return 'repeat';
  return nowMs - (state.lastAt[key] ?? 0) < REPEAT_COOLDOWN_MS ? 'wait' : 'ok';
}

const stuck = (key: string, failure: StuckAction['failure'], reason: string): StuckAction => ({ kind: 'stuck', key, failure, reason });

// —— 规则表 ——

function decideUi(ui: UiRequest): Action {
  const key = `ui:${ui.id}`;
  if (ui.method === 'select') {
    const options = ui.options ?? [];
    // 最后一批签收时的交付确认：/forge-approve 的一部分，闸门已在发命令时计过
    if (options.includes(CONFIRM_MERGE_OPTION)) return { kind: 'ui_response', id: ui.id, response: { value: CONFIRM_MERGE_OPTION }, summary: CONFIRM_MERGE_OPTION, key, category: 'gate', counts: false, note: `交付确认：${ui.title ?? ''}` };
    const pick = pickOption(options);
    if (pick === undefined) return stuck(key, 'out_of_table', `select 请求没有选项：${ui.title ?? ''}`);
    return { kind: 'ui_response', id: ui.id, response: { value: pick }, summary: pick, key, category: 'extra:question', counts: true, note: `${ui.title ?? ''}｜选项：${options.join(' / ')}` };
  }
  if (ui.method === 'input' || ui.method === 'editor') {
    return { kind: 'ui_response', id: ui.id, response: { value: INPUT_REPLY }, summary: INPUT_REPLY, key, category: 'extra:question', counts: true, note: `${ui.method}：${ui.title ?? ''}` };
  }
  return stuck(key, 'out_of_table', `规则表没有 ${ui.method} 对话框：${ui.title ?? ''}`);
}

/** 架构批准与各批签收：都是 /forge-approve */
function decideGate(s: Snapshot, state: SimState, flow: FlowSnap): Action | null {
  const key = `gate:${flow.id}:${flow.stage}:v${flow.version}`;
  const guard = repeatGuard(state, key, s.nowMs);
  if (guard === 'wait') return null;
  if (guard === 'repeat') return stuck(key, 'repeat', `阶段 ${flow.stage} 的批准命令发出 ${MAX_REPEATS} 次后状态仍没变`);
  return { kind: 'prompt', message: '/forge-approve', key, category: 'gate', counts: true, note: `${flow.id} 阶段 ${flow.stage} 等待批准` };
}

function decideNeedsHuman(s: Snapshot, state: SimState, flow: FlowSnap): Action | null {
  const key = `accept:${flow.id}:${flow.stage}:v${flow.version}`;
  const guard = repeatGuard(state, key, s.nowMs);
  if (guard === 'wait') return null;
  if (guard === 'repeat') return stuck(key, 'repeat', `阶段 ${flow.stage} 的 accept 发出 ${MAX_REPEATS} 次后状态仍没变`);
  const stageKey = scopeKey(flow.id, flow.stage);
  if ((state.accepts[stageKey] ?? 0) >= MAX_STAGE_ACCEPTS) return stuck(key, 'limit', `阶段 ${flow.stage} 已放行 ${MAX_STAGE_ACCEPTS} 次，又进入 needs_human`);
  return { kind: 'prompt', message: `/forge accept ${flow.stage} --note "${ACCEPT_NOTE}"`, key, category: 'extra:needs_human', counts: true, note: `${flow.id} 阶段 ${flow.stage} needs_human`, accept: stageKey };
}

function decideBlocked(s: Snapshot, state: SimState, flow: FlowSnap): Action | null {
  const blocked = s.tasks.filter((t) => t.status === 'blocked' && t.blockedOwner !== 'orchestrator').sort((a, b) => a.id.localeCompare(b.id));
  for (const t of blocked) {
    // 等架构师回答：程序会派咨询任务，用户不处理
    if (t.blockedBy === 'architect') continue;
    const key = `blocked:${flow.id}:${t.id}:v${t.version}`;
    const guard = repeatGuard(state, key, s.nowMs);
    if (guard === 'wait') continue;
    if (guard === 'repeat') return stuck(key, 'repeat', `${t.id} 的解除命令发出 ${MAX_REPEATS} 次后仍是 blocked`);
    const rk = scopeKey(flow.id, t.id);
    if ((state.releases[rk] ?? 0) >= MAX_TASK_RELEASES) return stuck(key, 'limit', `${t.id} 已放行 ${MAX_TASK_RELEASES} 次，又停住（${t.blockedBy ?? ''}：${(t.blockedReason ?? '').slice(0, 120)}）`);
    const why = `${t.id} blocked（${t.blockedBy ?? '?'}）：${(t.blockedReason ?? '').slice(0, 200)}`;
    switch (t.blockedBy) {
      case 'agent': case 'user':
        return { kind: 'prompt', message: `/forge unblock ${t.id} "${BLOCKED_ANSWER}"`, key, category: 'extra:blocked_question', counts: true, note: why, release: rk };
      case 'attempts': case 'precheck_exhausted': case 'merge_exhausted':
        return { kind: 'prompt', message: `/forge unblock ${t.id} --reset`, key, category: 'extra:blocked_reset', counts: true, note: why, release: rk };
      // 程序停下的 task（违规上限、同样的失败连续出现、谱系预算、工作区准备失败），用户的正常做法是直接放行
      case 'dispatcher':
        return { kind: 'prompt', message: `/forge unblock ${t.id}`, key, category: 'extra:blocked_reset', counts: true, note: why, release: rk };
      // 审查轮数用尽、合并时没有改动：主会话转交过来的，用户按现状接受
      case 'review_exhausted': case 'no_changes':
        return { kind: 'prompt', message: `/forge accept ${t.id} --note "${ACCEPT_NOTE}"`, key, category: 'extra:blocked_accept', counts: true, note: why, release: rk };
      default:
        return stuck(key, 'out_of_table', `规则表没有这种阻塞：${why}`);
    }
  }
  return null;
}

/** 规则表。返回 null 表示现在没有要做的事（等待、冷却中，或主会话/引擎在工作） */
export function decide(s: Snapshot, state: SimState): Action | null {
  if (s.ui) return decideUi(s.ui);
  const flow = s.flow;
  if (!flow || flow.stageStatus === 'done' || flow.stageStatus === 'aborted') return null;
  if (flow.stageStatus === 'awaiting_human') return decideGate(s, state, flow);
  if (flow.stageStatus === 'needs_human' && !flow.delegated) return decideNeedsHuman(s, state, flow);
  return decideBlocked(s, state, flow);
}

/** 动作发出后更新计数状态（stuck 不改状态） */
export function apply(state: SimState, action: Action, nowMs: number): SimState {
  if (action.kind === 'stuck') return state;
  const next: SimState = structuredClone(state);
  next.issued[action.key] = (next.issued[action.key] ?? 0) + 1;
  next.lastAt[action.key] = nowMs;
  // 同一个键重发不重复计数
  if (next.issued[action.key]! > 1) return next;
  if (action.release) next.releases[action.release] = (next.releases[action.release] ?? 0) + 1;
  if (action.accept) next.accepts[action.accept] = (next.accepts[action.accept] ?? 0) + 1;
  if (action.counts) {
    if (action.category === 'gate') next.counts.gate++;
    else {
      const name = action.category.slice('extra:'.length);
      next.counts.extra[name] = (next.counts.extra[name] ?? 0) + 1;
    }
  }
  return next;
}

export const extraTotal = (counts: SimState['counts']): number => Object.values(counts.extra).reduce((a, b) => a + b, 0);
