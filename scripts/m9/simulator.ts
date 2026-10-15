// M9 用户模拟：M9 实验方案的规则表（原 docs/M9-PLAN.md 第 4 节，见 git 历史），做成纯函数。
// decide(snapshot, state) 只读快照与计数状态，返回要做的动作；apply(state, action) 返回新的计数状态。
// 表里没有的情况一律返回 stuck 动作（算作流程失败），不即兴处理。
// 不依赖 Pi，不读磁盘；脚本（real-build.ts）负责把 .forge/ 与 RPC 事件整理成快照、把动作发出去。

/** 计数类别：p0_question（P0 问题数）、gate（必经闸门）、extra:<类别>（额外介入，每类单独一列） */
export type Category = 'p0_question' | 'gate' | `extra:${string}`;

export const EXTRA_CATEGORIES = ['dispute', 'blocked_question', 'blocked_reset', 'blocked_accept', 'needs_human', 'change_request', 'late_question'] as const;

/** 放行上限（第 4 节）：同一 task 放行 3 次后又停住算卡住；同一阶段放行 2 次后又 needs_human 算卡住 */
export const MAX_TASK_RELEASES = 3;
export const MAX_STAGE_ACCEPTS = 2;
/** 同一个动作（key 相同）重复发出的上限与最短间隔：命令发出后状态没变时才会重发 */
export const MAX_REPEATS = 3;
export const REPEAT_COOLDOWN_MS = 20_000;
/** P0 里连续用文字提问的轮数上限（规则表没写；防止脚本与模型无限对话，超过算卡住） */
export const MAX_P0_TEXT_TURNS = 10;

export const CONFIRM_MERGE_OPTION = '确认合入并结束流程';
export const BLOCKED_ANSWER = '按你的推荐做，以规格和契约为准';
export const ACCEPT_NOTE = '模拟用户：按现状放行';
export const P0_TEXT_REPLY = '都按你的推荐，继续';
export const P0_INPUT_REPLY = '按你的推荐';
export const FIX_TEST_NOTE = '按 worker 给出的依据改测试';

export interface UiRequest {
  id: string;
  method: 'select' | 'input' | 'editor' | 'confirm';
  title?: string;
  options?: string[];
}

export interface FlowSnap {
  id: string;
  mode: 'build' | 'fix' | 'change';
  stage: string;
  /** active | awaiting_gate | needs_human | awaiting_human | done | aborted */
  stageStatus: string;
  /** flow.version：状态变化后会变，用来区分"同一个闸门的第二次出现" */
  version: number;
  /** P0：规格是否已通过检查并提交 */
  specSubmitted: boolean;
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
  /** 争议的测试标识（handoff 里最后一个"## 争议：<测试>"） */
  disputeTest?: string | null;
}

export interface SimState {
  /** key → 已发出次数 */
  issued: Record<string, number>;
  /** key → 最近一次发出的时刻（毫秒） */
  lastAt: Record<string, number>;
  /** `${流程}:${task}` → 放行次数（unblock、reset、decide 合计） */
  releases: Record<string, number>;
  /** `${流程}:${阶段}` → accept 次数 */
  accepts: Record<string, number>;
  /** `${流程}:${task}:${测试}` → 争议裁决次数 */
  decisions: Record<string, number>;
  p0TextTurns: number;
  counts: {
    /** P0 问题数：select / input 按问题计，文字提问按轮计 */
    p0_question: number;
    p0_text_turns: number;
    /** 文字提问那几轮里编号的问题个数合计 */
    p0_text_numbered: number;
    /** 必经闸门（不含"确认合入"那次 select，它是 /forge-approve 的一部分） */
    gate: number;
    extra: Record<string, number>;
  };
}

export interface Snapshot {
  nowMs: number;
  /** 等待回答的扩展 UI 请求 */
  ui?: UiRequest | null;
  /** 主会话一轮已结束（收到 agent_settled）且尚未对它回复 */
  turnEnded: boolean;
  /** 主会话最后一条 assistant 文本（数编号问题用） */
  lastAssistantText?: string;
  flow: FlowSnap | null;
  tasks: TaskSnap[];
  /** 主会话转交用户、等待批准的变更请求（"change:<id>"）；用户批准。其他对象规则表没有，出现即算卡住 */
  otherApprovals?: string[];
}

export interface ActionMeta {
  /** 去重键：同一键重复出现时受冷却与次数限制 */
  key: string;
  category: Category;
  /** 是否计入类别计数（"确认合入"的 select 不重复计闸门） */
  counts: boolean;
  /** 触发原因，写进 interventions.jsonl */
  note: string;
  /** 文字提问那一轮里编号的问题个数 */
  numbered?: number;
  /** 计数副作用：哪个 task / 阶段 / 测试的放行次数加一 */
  release?: string;
  accept?: string;
  decision?: string;
}

export type UiResponse = { value: string } | { cancelled: true } | { confirmed: boolean };
export type UiAction = ActionMeta & { kind: 'ui_response'; id: string; response: UiResponse; summary: string };
export type PromptAction = ActionMeta & { kind: 'prompt'; message: string };
export type StuckAction = { kind: 'stuck'; key: string; failure: 'limit' | 'out_of_table' | 'repeat'; reason: string };
export type Action = UiAction | PromptAction | StuckAction;

export function initialState(): SimState {
  return {
    issued: {}, lastAt: {}, releases: {}, accepts: {}, decisions: {}, p0TextTurns: 0,
    counts: { p0_question: 0, p0_text_turns: 0, p0_text_numbered: 0, gate: 0, extra: {} },
  };
}

// —— 小工具（纯函数） ——

/** 选项里的"（推荐）"标记 */
export const isRecommended = (label: string): boolean => /（推荐）|\(推荐\)|\(recommended\)/i.test(label);
/** ask_user 插件自己追加的"Other"选项（@tian.zuo/pi-ask-user 0.2.1：`N. Other — type your own answer`） */
export const isOtherOption = (label: string): boolean => /^\s*(\d+\.\s*)?other\b/i.test(label);

/** select：选带"（推荐）"的选项，没有就选第一个（跳过 ask_user 自己加的 Other） */
export function pickOption(options: readonly string[]): string | undefined {
  return options.find(isRecommended) ?? options.find((o) => !isOtherOption(o)) ?? options[0];
}

/** ask_user 的 select 选项形如 "1. 标签 — 说明" */
export const looksLikeAskUser = (options: readonly string[]): boolean => options.length >= 2 && options.every((o) => /^\s*\d+\.\s/.test(o));

/** 文字里编号问题的个数（"1." "2、" "3）" 开头的行，或"问题 3"） */
export function countNumberedQuestions(text: string): number {
  const lines = text.split('\n');
  const numbered = lines.filter((l) => /^\s*(?:[-*]\s*)?(?:\*\*)?\d{1,2}\s*[.、)）]\s*\S/.test(l)).length;
  return numbered || lines.filter((l) => /^\s*(?:\*\*)?问题\s*\d+/.test(l)).length;
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

function decideUi(s: Snapshot, ui: UiRequest): Action {
  const key = `ui:${ui.id}`;
  const inP0 = !s.flow || s.flow.stage === 'P0';
  const questionCategory: Category = inP0 ? 'p0_question' : 'extra:late_question';
  if (ui.method === 'select') {
    const options = ui.options ?? [];
    if (options.includes(CONFIRM_MERGE_OPTION)) {
      // 交付确认：/forge-approve 的一部分，闸门已在发命令时计过
      return { kind: 'ui_response', id: ui.id, response: { value: CONFIRM_MERGE_OPTION }, summary: CONFIRM_MERGE_OPTION, key, category: 'gate', counts: false, note: `交付确认：${ui.title ?? ''}` };
    }
    if (inP0 || looksLikeAskUser(options)) {
      const pick = pickOption(options);
      if (pick === undefined) return stuck(key, 'out_of_table', `select 请求没有选项：${ui.title ?? ''}`);
      return { kind: 'ui_response', id: ui.id, response: { value: pick }, summary: pick, key, category: questionCategory, counts: true, note: `${ui.title ?? ''}｜选项：${options.join(' / ')}` };
    }
    return stuck(key, 'out_of_table', `规则表没有这个选择框：${ui.title ?? ''}（${options.join(' / ')}）`);
  }
  if (ui.method === 'input' || ui.method === 'editor') {
    return { kind: 'ui_response', id: ui.id, response: { value: P0_INPUT_REPLY }, summary: P0_INPUT_REPLY, key, category: questionCategory, counts: true, note: `${ui.method}：${ui.title ?? ''}` };
  }
  return stuck(key, 'out_of_table', `规则表没有 ${ui.method} 对话框：${ui.title ?? ''}`);
}

function decideGate(s: Snapshot, state: SimState, flow: FlowSnap): Action | null {
  const key = `gate:${flow.id}:${flow.stage}:v${flow.version}`;
  const guard = repeatGuard(state, key, s.nowMs);
  if (guard === 'wait') return null;
  if (guard === 'repeat') return stuck(key, 'repeat', `阶段 ${flow.stage} 的批准命令发出 ${MAX_REPEATS} 次后状态仍没变`);
  return { kind: 'prompt', message: `/forge-approve stage:${flow.stage}`, key, category: 'gate', counts: true, note: `${flow.id} 阶段 ${flow.stage} 等待批准` };
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
      // 方案修订 2：程序停下的 task（违规上限、同样的失败连续出现、谱系预算、工作区准备失败），用户的正常做法是直接放行
      case 'dispatcher':
        return { kind: 'prompt', message: `/forge unblock ${t.id}`, key, category: 'extra:blocked_reset', counts: true, note: why, release: rk };
      // 审查轮数用尽、合并时没有改动：主会话转交过来的，用户按现状接受
      case 'review_exhausted': case 'no_changes':
        return { kind: 'prompt', message: `/forge accept ${t.id} --note "${ACCEPT_NOTE}"`, key, category: 'extra:blocked_accept', counts: true, note: why, release: rk };
      case 'dispute': {
        const test = t.disputeTest ?? '';
        const dk = `${flow.id}:${t.id}:${test}`;
        const n = state.decisions[dk] ?? 0;
        const message = n === 0 ? `/forge-decide ${t.id} keep-test` : `/forge-decide ${t.id} fix-test "${FIX_TEST_NOTE}"`;
        return { kind: 'prompt', message, key, category: 'extra:dispute', counts: true, note: `${why}｜测试：${test || '（未知）'}｜第 ${n + 1} 次裁决`, release: rk, decision: dk };
      }
      default:
        return stuck(key, 'out_of_table', `规则表没有这种阻塞：${why}`);
    }
  }
  return null;
}

/** 规则表。返回 null 表示现在没有要做的事（等待、冷却中，或主会话/引擎在工作） */
export function decide(s: Snapshot, state: SimState): Action | null {
  if (s.ui) return decideUi(s, s.ui);
  const flow = s.flow;
  if (!flow || flow.stageStatus === 'done' || flow.stageStatus === 'aborted') return null;
  if (s.otherApprovals?.length) {
    const other = s.otherApprovals.filter((x) => !x.startsWith('change:'));
    if (other.length) return stuck(`other:${other.join(',')}`, 'out_of_table', `规则表没有这些等待批准的对象：${other.join('、')}`);
    const target = s.otherApprovals[0]!;
    const key = `approve:${flow.id}:${target}`;
    const guard = repeatGuard(state, key, s.nowMs);
    if (guard === 'repeat') return stuck(key, 'repeat', `${target} 的批准命令发出 ${MAX_REPEATS} 次后仍在等待批准`);
    if (guard === 'ok') return { kind: 'prompt', message: `/forge-approve ${target}`, key, category: 'extra:change_request', counts: true, note: `${target} 由主会话转交用户批准` };
  }
  if (flow.stageStatus === 'awaiting_human') return decideGate(s, state, flow);
  if (flow.stageStatus === 'needs_human' && !flow.delegated) return decideNeedsHuman(s, state, flow);
  const blockedAction = decideBlocked(s, state, flow);
  if (blockedAction) return blockedAction;
  // P0 用文字提问：主会话一轮结束，流程还在 P0，规格还没提交
  if (s.turnEnded && flow.stage === 'P0' && flow.stageStatus === 'active' && !flow.specSubmitted) {
    const key = `p0text:${flow.id}:${state.p0TextTurns + 1}`;
    if (state.p0TextTurns >= MAX_P0_TEXT_TURNS) return stuck(key, 'limit', `P0 已用文字回复 ${MAX_P0_TEXT_TURNS} 轮，规格仍未提交`);
    return { kind: 'prompt', message: P0_TEXT_REPLY, key, category: 'p0_question', counts: true, note: 'P0 主会话一轮结束但规格未提交（文字提问）', numbered: countNumberedQuestions(s.lastAssistantText ?? '') };
  }
  return null;
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
  if (action.decision) next.decisions[action.decision] = (next.decisions[action.decision] ?? 0) + 1;
  if (action.key.startsWith('p0text:')) {
    next.p0TextTurns++;
    next.counts.p0_text_turns++;
    next.counts.p0_text_numbered += action.numbered ?? 0;
  }
  if (action.counts) {
    if (action.category === 'p0_question') next.counts.p0_question++;
    else if (action.category === 'gate') next.counts.gate++;
    else {
      const name = action.category.slice('extra:'.length);
      next.counts.extra[name] = (next.counts.extra[name] ?? 0) + 1;
    }
  }
  return next;
}

export const extraTotal = (counts: SimState['counts']): number => Object.values(counts.extra).reduce((a, b) => a + b, 0);
