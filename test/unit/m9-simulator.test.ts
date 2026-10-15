// M9 用户模拟的规则表（scripts/m9/simulator.ts）：逐行正例、表外反例、放行上限与计数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply, decide, initialState, pickOption, countNumberedQuestions, extraTotal,
  MAX_P0_TEXT_TURNS, REPEAT_COOLDOWN_MS,
  type Action, type FlowSnap, type SimState, type Snapshot, type TaskSnap,
} from '../../scripts/m9/simulator.ts';

const flow = (o: Partial<FlowSnap> = {}): FlowSnap => ({ id: 'B-001', mode: 'build', stage: 'P0', stageStatus: 'active', version: 1, specSubmitted: false, ...o });
const task = (id: string, o: Partial<TaskSnap> = {}): TaskSnap => ({ id, status: 'in_progress', blockedBy: null, blockedReason: null, version: 1, ...o });
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({ nowMs: 1_000_000, turnEnded: false, flow: flow(), tasks: [], ...o });
const act = (a: Action | null) => { assert.ok(a && a.kind !== 'stuck', JSON.stringify(a)); return a as Exclude<Action, { kind: 'stuck' }>; };
const stuckOf = (a: Action | null) => { assert.ok(a && a.kind === 'stuck', JSON.stringify(a)); return a as Extract<Action, { kind: 'stuck' }>; };
const step = (s: Snapshot, st: SimState): { a: Action | null; st: SimState } => { const a = decide(s, st); return { a, st: a ? apply(st, a, s.nowMs) : st }; };

// —— 行 1：P0 提问（ask_user 走 select / input） ——

test('P0 select：选带"（推荐）"的选项', () => {
  const s = snap({ ui: { id: 'u1', method: 'select', title: '1. 登录方式', options: ['1. 邮箱密码 — 简单', '2. 短信（推荐） — 快', '3. Other — type your own answer'] } });
  const a = act(decide(s, initialState()));
  assert.equal(a.kind, 'ui_response');
  if (a.kind === 'ui_response') assert.deepEqual(a.response, { value: '2. 短信（推荐） — 快' });
  assert.equal(a.category, 'p0_question');
  assert.ok(a.counts);
});

test('P0 select：没有"（推荐）"就选第一个，不选 ask_user 自带的 Other', () => {
  assert.equal(pickOption(['1. A', '2. B', '3. Other — type your own answer']), '1. A');
  assert.equal(pickOption(['3. Other — type your own answer', '1. A']), '1. A');
  const a = act(decide(snap({ ui: { id: 'u2', method: 'select', title: 'q', options: ['1. 甲', '2. 乙'] } }), initialState()));
  if (a.kind === 'ui_response') assert.deepEqual(a.response, { value: '1. 甲' });
});

test('P0 input / editor：回"按你的推荐"，按问题个数计', () => {
  for (const method of ['input', 'editor'] as const) {
    const a = act(decide(snap({ ui: { id: `u-${method}`, method, title: '请写' } }), initialState()));
    if (a.kind === 'ui_response') assert.deepEqual(a.response, { value: '按你的推荐' });
    assert.equal(a.category, 'p0_question');
  }
});

test('P0 问题数按问题个数计：同一次 ask_user 的 3 个 select 计 3', () => {
  let st = initialState();
  for (const id of ['a', 'b', 'c']) {
    const r = step(snap({ ui: { id, method: 'select', title: id, options: ['1. x', '2. y'] } }), st);
    st = r.st;
  }
  assert.equal(st.counts.p0_question, 3);
});

test('P0 之外出现的 ask_user 选择框计入额外介入 late_question，不进 P0 问题数', () => {
  const s = snap({ flow: flow({ stage: 'S1', stageStatus: 'active' }), ui: { id: 'u', method: 'select', title: 'q', options: ['1. x', '2. y'] } });
  const r = step(s, initialState());
  assert.equal(act(r.a).category, 'extra:late_question');
  assert.equal(r.st.counts.p0_question, 0);
  assert.equal(r.st.counts.extra['late_question'], 1);
});

// —— 行 2：P0 文字提问 ——

test('P0 文字提问：一轮结束、仍在 P0、规格未提交 → 回"都按你的推荐，继续"，按轮计并记编号问题数', () => {
  const s = snap({ turnEnded: true, lastAssistantText: '请回答：\n1. 要不要登录？\n2. 数据存哪里？\n3. 端口？' });
  const r = step(s, initialState());
  const a = act(r.a);
  assert.equal(a.kind, 'prompt');
  if (a.kind === 'prompt') assert.equal(a.message, '都按你的推荐，继续');
  assert.equal(a.category, 'p0_question');
  assert.equal(r.st.counts.p0_question, 1);
  assert.equal(r.st.counts.p0_text_turns, 1);
  assert.equal(r.st.counts.p0_text_numbered, 3);
  assert.equal(countNumberedQuestions('没有编号的文字'), 0);
  assert.equal(countNumberedQuestions('问题 1：甲\n问题 2：乙'), 2);
});

test('P0 文字提问的反例：规格已提交、一轮没结束、已不在 P0 都不回复', () => {
  assert.equal(decide(snap({ turnEnded: true, flow: flow({ specSubmitted: true }) }), initialState()), null);
  assert.equal(decide(snap({ turnEnded: false }), initialState()), null);
  assert.equal(decide(snap({ turnEnded: true, flow: flow({ stage: 'P1' }) }), initialState()), null);
  assert.equal(decide(snap({ turnEnded: true, flow: null }), initialState()), null);
});

test('P0 文字回复超过上限算卡住（防无限对话）', () => {
  let st = initialState();
  for (let i = 0; i < MAX_P0_TEXT_TURNS; i++) st = step(snap({ turnEnded: true }), st).st;
  assert.equal(stuckOf(decide(snap({ turnEnded: true }), st)).failure, 'limit');
});

// —— 行 3：闸门 ——

test('规格审批、阶段签收：/forge-approve stage:<阶段>，计必经闸门', () => {
  for (const [stage, mode] of [['P0', 'build'], ['S1', 'build'], ['S2', 'build']] as const) {
    const r = step(snap({ flow: flow({ stage, mode, stageStatus: 'awaiting_human' }) }), initialState());
    const a = act(r.a);
    assert.equal(a.kind === 'prompt' && a.message, `/forge-approve stage:${stage}`);
    assert.equal(a.category, 'gate');
    assert.equal(r.st.counts.gate, 1);
  }
});

test('交付确认：select 选"确认合入并结束流程"，不重复计闸门', () => {
  const s = snap({ flow: flow({ stage: 'S3', stageStatus: 'awaiting_human' }), ui: { id: 'm', method: 'select', title: '批准阶段 S3 将把 ... 合入 main，流程随之结束。确认？', options: ['确认合入并结束流程', '取消'] } });
  const r = step(s, initialState());
  const a = act(r.a);
  if (a.kind === 'ui_response') assert.deepEqual(a.response, { value: '确认合入并结束流程' });
  assert.equal(a.counts, false);
  assert.equal(r.st.counts.gate, 0);
});

test('P1 等待批准 → 批准', () => {
  const a = act(decide(snap({ flow: flow({ stage: 'P1', stageStatus: 'awaiting_human' }) }), initialState()));
  assert.equal(a.kind === 'prompt' && a.message, '/forge-approve stage:P1');
  assert.equal(a.category, 'gate');
});

test('同一个批准命令发出后冷却中不重发，状态没变重发到上限后算卡住', () => {
  const s = snap({ flow: flow({ stage: 'S1', stageStatus: 'awaiting_human' }) });
  let st = step(s, initialState()).st;
  assert.equal(decide({ ...s, nowMs: s.nowMs + 1000 }, st), null);
  let now = s.nowMs;
  for (let i = 0; i < 2; i++) { now += REPEAT_COOLDOWN_MS + 1; const r = step({ ...s, nowMs: now }, st); act(r.a); st = r.st; }
  assert.equal(st.counts.gate, 1, '重发不重复计数');
  now += REPEAT_COOLDOWN_MS + 1;
  assert.equal(stuckOf(decide({ ...s, nowMs: now }, st)).failure, 'repeat');
});

// —— 行 4：争议 ——

test('测试争议：同一个测试第一次 keep-test，第二次 fix-test 并写明说明', () => {
  const blocked = (v: number) => snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-001', { status: 'blocked', blockedBy: 'dispute', blockedReason: '争议', version: v, disputeTest: 'login 空密码' })] });
  const r1 = step(blocked(1), initialState());
  assert.equal(act(r1.a).kind === 'prompt' && (act(r1.a) as { message: string }).message, '/forge-decide T-001 keep-test');
  assert.equal(act(r1.a).category, 'extra:dispute');
  const r2 = step(blocked(2), r1.st);
  assert.equal((act(r2.a) as { message: string }).message, '/forge-decide T-001 fix-test "按 worker 给出的依据改测试"');
});

test('测试争议：换一个测试重新从 keep-test 开始', () => {
  let st = initialState();
  st = step(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-001', { status: 'blocked', blockedBy: 'dispute', version: 1, disputeTest: 'A' })] }), st).st;
  const r = step(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-001', { status: 'blocked', blockedBy: 'dispute', version: 2, disputeTest: 'B' })] }), st);
  assert.match((act(r.a) as { message: string }).message, /keep-test/);
});

// —— 行 5、6：task blocked ——

test('forge_block 提问（blocked_by agent）→ unblock 并回答，计 blocked_question', () => {
  const r = step(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-002', { status: 'blocked', blockedBy: 'agent', blockedReason: '用 JWT 还是 session？' })] }), initialState());
  const a = act(r.a);
  assert.equal(a.kind === 'prompt' && a.message, '/forge unblock T-002 "按你的推荐做，以规格和契约为准"');
  assert.equal(a.category, 'extra:blocked_question');
});

test('失败次数用完（attempts / precheck_exhausted / merge_exhausted）→ unblock --reset，计 blocked_reset', () => {
  for (const by of ['attempts', 'precheck_exhausted', 'merge_exhausted']) {
    const r = step(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-003', { status: 'blocked', blockedBy: by })] }), initialState());
    const a = act(r.a);
    assert.equal(a.kind === 'prompt' && a.message, '/forge unblock T-003 --reset');
    assert.equal(a.category, 'extra:blocked_reset');
  }
});

test('程序停下的 task（dispatcher）→ /forge unblock，计为 blocked_reset（方案修订 2）', () => {
  const a = act(decide(snap({ flow: flow({ stage: 'P1' }), tasks: [task('T-004', { status: 'blocked', blockedBy: 'dispatcher' })] }), initialState()));
  assert.equal(a.kind === 'prompt' && a.message, '/forge unblock T-004');
  assert.equal(a.category, 'extra:blocked_reset');
});

test('表外的阻塞原因（integration_broken）→ 卡住', () => {
  for (const by of ['integration_broken', null]) {
    const a = stuckOf(decide(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-004', { status: 'blocked', blockedBy: by })] }), initialState()));
    assert.equal(a.failure, 'out_of_table');
  }
});

test('同一个 task 放行 3 次后又停住算卡住（版本变了才算新的一次）', () => {
  let st = initialState();
  for (let v = 1; v <= 3; v++) {
    const r = step(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-005', { status: 'blocked', blockedBy: v === 2 ? 'attempts' : 'agent', version: v })] }), st);
    act(r.a);
    st = r.st;
  }
  assert.equal(st.releases['B-001:T-005'], 3);
  const a = stuckOf(decide(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-005', { status: 'blocked', blockedBy: 'agent', version: 4 })] }), st));
  assert.equal(a.failure, 'limit');
  assert.match(a.reason, /T-005/);
});

test('放行上限按 task 分别计：别的 task 不受影响', () => {
  let st = initialState();
  for (let v = 1; v <= 3; v++) st = step(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-005', { status: 'blocked', blockedBy: 'agent', version: v })] }), st).st;
  act(decide(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-006', { status: 'blocked', blockedBy: 'agent', version: 1 })] }), st));
});

// —— 行 7：阶段 needs_human ——

test('阶段 needs_human → /forge accept <阶段> --note，计 needs_human', () => {
  const r = step(snap({ flow: flow({ stage: 'S2', stageStatus: 'needs_human' }) }), initialState());
  const a = act(r.a);
  assert.equal(a.kind === 'prompt' && a.message, '/forge accept S2 --note "模拟用户：按现状放行"');
  assert.equal(a.category, 'extra:needs_human');
});

test('同一阶段放行 2 次后又 needs_human 算卡住', () => {
  let st = initialState();
  for (let v = 1; v <= 2; v++) st = step(snap({ flow: flow({ stage: 'S2', stageStatus: 'needs_human', version: v }) }), st).st;
  assert.equal(st.accepts['B-001:S2'], 2);
  assert.equal(stuckOf(decide(snap({ flow: flow({ stage: 'S2', stageStatus: 'needs_human', version: 3 }) }), st)).failure, 'limit');
  // 另一个阶段不受影响
  act(decide(snap({ flow: flow({ stage: 'S3', stageStatus: 'needs_human', version: 4 }) }), st));
});

// —— 行 8：超时复核等主会话决定 → 不处理 ——

test('超时复核、合并队列、普通进行中的 task：不处理（null）', () => {
  const s = snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-001', { status: 'in_progress' }), task('T-002', { status: 'ready' }), task('T-003', { status: 'checking' })] });
  assert.equal(decide(s, initialState()), null);
});

// —— 表外 ——

test('主会话转交用户的变更请求 → 用户批准；其他等待批准的对象 → 卡住', () => {
  const a = act(decide(snap({ flow: flow({ stage: 'S1' }), otherApprovals: ['change:C-001'] }), initialState()));
  assert.deepEqual([a.kind === 'prompt' && a.message, a.category], ['/forge-approve change:C-001', 'extra:change_request']);
  const st = stuckOf(decide(snap({ flow: flow({ stage: 'S1' }), otherApprovals: ['amend:A-1'] }), initialState()));
  assert.equal(st.failure, 'out_of_table');
});

test('主会话负责的阻塞与 needs_human：用户不抢着处理（null）；转交用户后才处理', () => {
  const owned = snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-001', { status: 'blocked', blockedBy: 'agent', blockedOwner: 'orchestrator' })] });
  assert.equal(decide(owned, initialState()), null);
  assert.equal(decide(snap({ flow: flow({ stage: 'S1', stageStatus: 'needs_human', delegated: true }) }), initialState()), null);
  for (const blockedBy of ['review_exhausted', 'no_changes']) {
    const a = act(decide(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-001', { status: 'blocked', blockedBy })] }), initialState()));
    assert.deepEqual([a.kind === 'prompt' && a.message.startsWith('/forge accept T-001 --note'), a.category], [true, 'extra:blocked_accept']);
  }
});

test('表外：不认识的 select、confirm 对话框 → 卡住', () => {
  const sel = snap({ flow: flow({ stage: 'S1' }), ui: { id: 'x', method: 'select', title: '继续修复？', options: ['继续修复', '取消'] } });
  assert.equal(stuckOf(decide(sel, initialState())).failure, 'out_of_table');
  assert.equal(stuckOf(decide(snap({ ui: { id: 'y', method: 'confirm', title: '确定？' } }), initialState())).failure, 'out_of_table');
});

test('没有流程、流程已结束：什么都不做', () => {
  assert.equal(decide(snap({ flow: null }), initialState()), null);
  assert.equal(decide(snap({ flow: flow({ stageStatus: 'done' }) }), initialState()), null);
  assert.equal(decide(snap({ flow: flow({ stageStatus: 'aborted' }) }), initialState()), null);
});

// —— 计数 ——

test('计数：各类别分开累计，extraTotal 合计额外介入', () => {
  let st = initialState();
  st = step(snap({ ui: { id: '1', method: 'select', options: ['1. a', '2. b'] } }), st).st;
  st = step(snap({ flow: flow({ stage: 'P0', stageStatus: 'awaiting_human' }) }), st).st;
  st = step(snap({ flow: flow({ stage: 'S1' }), tasks: [task('T-001', { status: 'blocked', blockedBy: 'agent' })] }), st).st;
  st = step(snap({ flow: flow({ stage: 'S1', version: 9 }), tasks: [task('T-002', { status: 'blocked', blockedBy: 'attempts' })] }), st).st;
  st = step(snap({ flow: flow({ stage: 'S1', stageStatus: 'needs_human', version: 10 }) }), st).st;
  assert.equal(st.counts.p0_question, 1);
  assert.equal(st.counts.gate, 1);
  assert.deepEqual(st.counts.extra, { blocked_question: 1, blocked_reset: 1, needs_human: 1 });
  assert.equal(extraTotal(st.counts), 3);
});

test('apply 不改传入的状态对象（纯函数）', () => {
  const st = initialState();
  const a = act(decide(snap({ flow: flow({ stage: 'S1', stageStatus: 'awaiting_human' }) }), st));
  apply(st, a, 5);
  assert.deepEqual(st, initialState());
});
