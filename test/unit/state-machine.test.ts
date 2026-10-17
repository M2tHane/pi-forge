import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planTransition, planStageTransition, hashToken, IN_FLIGHT, poolOf,
  MAX_INTERRUPTIONS, type Facts, type Trigger, type StageTrigger, type StageFacts,
} from '../../src/core/state/state-machine.ts';
import { TASK_STATUSES, STAGE_STATUSES, validate, type TaskFile, type TaskStatus, type StageStatus } from '../../src/core/state/schemas.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

const NOW = new Date('2026-01-01T00:00:00Z');
const TOKEN = 'tok-impl';
const lease = { run_id: 'r-1', role: 'worker', token_hash: hashToken(TOKEN), acquired_at: NOW.toISOString(), expires_at: '2026-01-01T00:30:00Z' };
const facts = (over: Partial<Facts> = {}): Facts => ({
  now: NOW, limits: { max_attempts: 3, max_parallel: 2, max_parallel_aux: 3, max_parallel_backend: 4, max_merge_failures: 2, review_max_rounds: 2 },
  actor: 'engine', stage_active: true, status_of: new Map(), running_count: 0, queue_head: true,
  token: TOKEN, diff_files: ['src/server/t-001/a.ts'], reason: '测试失败',
  review_required: true, structured_report: true,
  ...over,
});
const task = (status: TaskStatus, over: Partial<TaskFile> = {}) => mkTask('T-001', {
  status, lease, worktree: '/wt/T-001', branch: 'task/T-001', base_sha: 'abc', ...over,
});
const ok = (r: ReturnType<typeof planTransition>) => { assert.ok(r.ok, r.ok ? '' : r.errors.join('\n')); assert.deepEqual(validate('task', r.task), []); return r; };
const bad = (r: ReturnType<typeof planTransition>) => assert.equal(r.ok, false, '应拒绝转移');

interface Case {
  from: TaskStatus; to: TaskStatus; trigger: Trigger;
  task?: Partial<TaskFile>; facts?: Partial<Facts>; reject: Partial<Facts>;
  rejectTask?: Partial<TaskFile>;
}
// 独立于实现的规格转移清单；每行都运行正例和条件、actor 或 kind 反例。
const cases: Case[] = [
  { from: 'pending', to: 'ready', trigger: 'schedule', task: { depends_on: [hard('T-002')] }, facts: { status_of: new Map([['T-002', 'done']]) }, reject: { stage_active: false } },
  { from: 'ready', to: 'in_progress', trigger: 'dispatch', reject: { running_count: 2 } },
  ...(['impl', 'fix', 'doc', 'merge-fix'] as const).map((kind): Case => ({ from: 'in_progress', to: 'in_review', trigger: 'submit', task: { kind }, reject: { diff_files: [] }, rejectTask: { kind: 'review' } })),
  ...(['impl', 'fix', 'doc', 'merge-fix'] as const).map((kind): Case => ({ from: 'in_progress', to: 'queued_merge', trigger: 'submit', task: { kind }, facts: { review_required: false }, reject: { review_required: true }, rejectTask: { kind: 'qa' } })),
  { from: 'in_review', to: 'in_progress', trigger: 'review_changes', facts: { unresolved_must: 1 }, reject: { unresolved_must: 0 } },
  { from: 'in_review', to: 'queued_merge', trigger: 'review_pass', facts: { unresolved_must: 0 }, reject: { unresolved_must: 1 } },
  { from: 'in_review', to: 'blocked', trigger: 'review_exhausted', task: { review_rounds: 2 }, facts: { unresolved_must: 1 }, reject: { unresolved_must: 0 }, rejectTask: { review_rounds: 1 } },
  { from: 'queued_merge', to: 'merging', trigger: 'merge_start', reject: { queue_head: false } },
  { from: 'merging', to: 'done', trigger: 'merge_done', facts: { rebase_ok: true, post_verify_ok: true, fast_forwarded: true }, reject: { fast_forwarded: false } },
  { from: 'merging', to: 'in_progress', trigger: 'merge_verify_fail', facts: { post_verify_ok: false }, reject: { post_verify_ok: true }, rejectTask: { kind: 'review' } },
  { from: 'merging', to: 'in_progress', trigger: 'merge_conflict', facts: { conflict_files: ['src/a.ts'] }, reject: { conflict_files: [] }, rejectTask: { kind: 'doc' } },
  { from: 'merging', to: 'blocked', trigger: 'merge_blocked', reject: { reason: '' } },
  { from: 'merging', to: 'queued_merge', trigger: 'merge_requeue', reject: {}, rejectTask: { kind: 'review' } },
  { from: 'blocked', to: 'queued_merge', trigger: 'accept', task: { blocked_by: 'review_exhausted' }, facts: { actor: 'human' }, reject: { actor: 'orchestrator' }, rejectTask: { blocked_by: 'merge_exhausted' } },
  { from: 'blocked', to: 'done', trigger: 'accept', task: { blocked_by: 'no_changes' }, facts: { actor: 'human' }, reject: { actor: 'engine' }, rejectTask: { blocked_by: 'review_exhausted' } },
  { from: 'blocked', to: 'blocked', trigger: 'hand_to_user', task: { blocked_by: 'dispatcher', blocked_owner: 'orchestrator' }, facts: { actor: 'orchestrator' }, reject: { actor: 'human' }, rejectTask: { blocked_owner: undefined } },
  { from: 'blocked', to: 'in_progress', trigger: 'unblock', facts: { actor: 'human' }, reject: { actor: 'engine' }, rejectTask: { worktree: null, branch: null } },
  { from: 'blocked', to: 'ready', trigger: 'unblock', task: { worktree: null, branch: null }, facts: { actor: 'human' }, reject: { actor: 'orchestrator' }, rejectTask: { branch: 'started' } },
  ...(['review', 'qa'] as const).map((kind): Case => ({ from: 'in_progress', to: 'done', trigger: 'report', task: { kind }, facts: { diff_files: [] }, reject: { structured_report: false }, rejectTask: { kind: 'merge-fix' } })),
  { from: 'ready', to: 'blocked', trigger: 'block', facts: { actor: 'dispatcher' }, reject: { actor: 'orchestrator' } },
  ...(['in_progress', 'in_review', 'queued_merge', 'merging'] as const).map((from): Case => ({ from, to: 'blocked', trigger: 'block', reject: { reason: '' } })),
  ...(['run_failed', 'run_interrupted', 'run_paused', 'run_timeout'] as const).map((trigger): Case => ({ from: 'in_progress', to: 'in_progress', trigger, task: trigger === 'run_timeout' ? { timeout_review: { run: 'r-1', at: NOW.toISOString(), minutes: 30 } } : {}, reject: { reason: '' }, rejectTask: { lease: null } })),
  { from: 'in_progress', to: 'ready', trigger: 'lease_expired', facts: { now: new Date('2026-01-01T00:31:00Z'), worktree_clean: true }, reject: { worktree_clean: false } },
  ...(['pending', 'ready', 'blocked'] as const).map((from): Case => ({ from, to: 'cancelled', trigger: 'cancel', facts: { actor: 'human' }, reject: { actor: 'engine' } })),
  { from: 'in_progress', to: 'queued_merge', trigger: 'submit', task: { kind: 'consult', writes: ['**'] }, facts: { review_required: false }, reject: { review_required: true }, rejectTask: { kind: 'review' } },
  { from: 'in_progress', to: 'done', trigger: 'report', task: { kind: 'consult' }, facts: { diff_files: [] }, reject: { structured_report: false }, rejectTask: { kind: 'merge-fix' } },
  { from: 'in_progress', to: 'blocked', trigger: 'ask', facts: { actor: 'run:r-1' }, reject: { reason: '' }, rejectTask: { lease: null } },
  { from: 'blocked', to: 'in_progress', trigger: 'answered', task: { blocked_by: 'architect' }, reject: { actor: 'orchestrator' }, rejectTask: { blocked_by: 'agent' } },
];
for (const [i, c] of cases.entries()) test(`转移 ${i + 1}：${c.from} → ${c.to}（${c.trigger}，${c.task?.kind ?? 'impl'}）正反例`, () => {
  const t = task(c.from, c.task), f = facts(c.facts);
  const result = ok(planTransition(t, c.to, c.trigger, f));
  assert.equal(result.to, c.to);
  bad(planTransition({ ...t, ...c.rejectTask }, c.to, c.trigger, { ...f, ...c.reject }));
  if (c.rejectTask) bad(planTransition({ ...t, ...c.rejectTask }, c.to, c.trigger, f));
  // 检查整份任务变化前的形状与 blocked 原因。
  if (c.to === 'blocked') assert.ok(result.task.blocked_by);
  if (c.from === 'blocked' && c.to !== 'blocked') assert.equal(result.task.blocked_by, null);
});

test('提问等架构师：阻塞原因 architect，不交给主会话；只有程序能在回答后恢复', () => {
  const asked = ok(planTransition(task('in_progress'), 'blocked', 'ask', facts({ actor: 'run:r-1', reason: '等架构师回答' }))).task;
  assert.deepEqual([asked.blocked_by, asked.blocked_owner, asked.lease], ['architect', undefined, null]);
  bad(planTransition(asked, 'in_progress', 'answered', facts({ actor: 'human' })));
  assert.equal(ok(planTransition(asked, 'in_progress', 'answered', facts())).task.blocked_by, null);
});

test('阻塞先交给主会话：程序与子进程造成的阻塞带 blocked_owner；主会话可解除、放行、转交用户；决定次数到上限后直接等用户', () => {
  const byEngine = ok(planTransition(task('in_progress'), 'blocked', 'block', facts({ actor: 'dispatcher' }))).task;
  assert.equal(byEngine.blocked_owner, 'orchestrator');
  assert.equal(ok(planTransition(task('in_progress'), 'blocked', 'block', facts({ actor: 'run:r-1' }))).task.blocked_owner, 'orchestrator');
  assert.equal(ok(planTransition(task('in_progress'), 'blocked', 'block', facts({ actor: 'orchestrator' }))).task.blocked_owner, undefined, '主会话自己交出来的直接等用户');
  // 计数耗尽转 blocked 同样先交给主会话
  const exhausted = ok(planTransition(task('in_review', { review_rounds: 1 }), 'in_progress', 'review_changes', facts({ unresolved_must: 1 }))).task;
  assert.deepEqual([exhausted.status, exhausted.blocked_by, exhausted.blocked_owner], ['blocked', 'review_exhausted', 'orchestrator']);

  const o = facts({ actor: 'orchestrator', reset: true });
  const retried = ok(planTransition(byEngine, 'in_progress', 'unblock', o)).task;
  assert.deepEqual([retried.decisions, retried.blocked_owner, retried.blocked_by], [1, undefined, null]);
  bad(planTransition({ ...byEngine, blocked_owner: undefined }, 'in_progress', 'unblock', o));
  const accepted = ok(planTransition(exhausted, 'queued_merge', 'accept', o)).task;
  assert.equal(accepted.decisions, 1);
  const handed = ok(planTransition(byEngine, 'blocked', 'hand_to_user', facts({ actor: 'orchestrator', reason: '要用户的账号' }))).task;
  assert.equal(handed.blocked_owner, undefined);
  assert.match(handed.blocked_reason ?? '', /主会话：要用户的账号/);
  bad(planTransition(handed, 'in_progress', 'unblock', o));
  ok(planTransition(handed, 'in_progress', 'unblock', facts({ actor: 'human' })));

  const twice = ok(planTransition(task('in_progress', { decisions: 2 }), 'blocked', 'block', facts({ actor: 'dispatcher' }))).task;
  assert.equal(twice.blocked_owner, undefined, '主会话已决定 2 次');
  const human = ok(planTransition(byEngine, 'in_progress', 'unblock', facts({ actor: 'human' }))).task;
  assert.equal(human.decisions, undefined, '用户的决定不计数');
});

test('合并时没有改动：阻塞原因 no_changes，确认后视为完成', () => {
  const t = ok(planTransition(task('merging'), 'blocked', 'merge_blocked', facts({ no_changes: true }))).task;
  assert.equal(t.blocked_by, 'no_changes');
  const done = ok(planTransition(t, 'done', 'accept', facts({ actor: 'orchestrator' }))).task;
  assert.deepEqual([done.status, done.worktree, done.decisions], ['done', null, 1]);
  assert.equal(ok(planTransition(task('merging'), 'blocked', 'merge_blocked', facts())).task.blocked_by, 'dispatcher');
});
// 穷举的允许集合来自上面的规格用例，与 TRANSITIONS 无关。
test('状态 × 触发 × 目标穷举：只有清单中的组合可成功；done、cancelled 没有出边', () => {
  const triggers = [...new Set(cases.map((c) => c.trigger))];
  const allowed = new Set(cases.map((c) => `${c.from}/${c.trigger}/${c.to}`));
  for (const from of TASK_STATUSES) for (const trigger of triggers) for (const to of TASK_STATUSES) {
    if (allowed.has(`${from}/${trigger}/${to}`)) continue;
    for (const kind of ['impl', 'review', 'qa'] as const) bad(planTransition(task(from, { kind }), to, trigger, facts()));
  }
  assert.deepEqual(IN_FLIGHT, ['in_progress', 'in_review', 'queued_merge', 'merging']);
});

test('review 与 qa 的完成只接受 report，不能进入合并', () => {
  for (const kind of ['review', 'qa'] as const) {
    for (const [to, trigger] of [['merging', 'merge_start'], ['done', 'merge_done'], ['blocked', 'merge_blocked'], ['queued_merge', 'merge_requeue']] as const) {
      bad(planTransition(task(trigger === 'merge_start' ? 'queued_merge' : 'merging', { kind }), to, trigger, facts({ rebase_ok: true, post_verify_ok: true, fast_forwarded: true })));
    }
  }
});

test('依赖只认 done（没有软依赖）；合并不等别的任务', () => {
  const t = task('pending', { depends_on: [hard('T-002'), hard('T-003')] });
  const f = facts({ status_of: new Map([['T-002', 'done'], ['T-003', 'done']]) });
  ok(planTransition(t, 'ready', 'schedule', f));
  for (const state of ['pending', 'in_review', 'blocked', 'cancelled']) bad(planTransition(t, 'ready', 'schedule', { ...f, status_of: new Map([['T-002', 'done'], ['T-003', state]]) }));
  ok(planTransition({ ...t, status: 'queued_merge' }, 'merging', 'merge_start', facts()));
});

test('dispatch：按池限流（running_count 是同池的运行数），worktree、branch、base_sha、租约必需', () => {
  // 上限：impl（architect、worker）max_parallel=2，backend max_parallel_backend=4，frontend 固定 1，review、qa max_parallel_aux=3
  const limits = [['impl', 'worker', 2], ['impl', 'backend', 4], ['impl', 'frontend', 1], ['fix', 'frontend', 1], ['review', 'reviewer', 3], ['qa', 'stage-qa', 3]] as const;
  for (const [kind, role, limit] of limits) {
    const t = task('ready', { kind, role });
    ok(planTransition(t, 'in_progress', 'dispatch', facts({ running_count: limit - 1 })));
    bad(planTransition(t, 'in_progress', 'dispatch', facts({ running_count: limit })));
    for (const key of ['worktree', 'branch', 'base_sha', 'lease'] as const) bad(planTransition(t, 'in_progress', 'dispatch', facts(), { [key]: null }));
  }
  assert.deepEqual([poolOf({ kind: 'impl', role: 'backend' }), poolOf({ kind: 'merge-fix', role: 'frontend' }), poolOf({ kind: 'review', role: 'reviewer' }), poolOf({ kind: 'impl', role: 'architect' })],
    ['backend', 'frontend', 'aux', 'impl']);
});

test('submit：鉴权、范围、公共文件、已有测试调整、契约追加与 S0 验收路径例外', () => {
  const t = task('in_progress', { writes: ['**'] });
  const f = facts();
  for (const token of [undefined, 'forged']) bad(planTransition(t, 'in_review', 'submit', { ...f, token }));
  bad(planTransition(t, 'in_review', 'submit', { ...f, now: new Date('2026-01-01T00:30:00Z') }));
  for (const path of ['.forge/state.json', 'rules/project.md']) bad(planTransition(t, 'in_review', 'submit', { ...f, diff_files: [path], test_adjustments: [path] }));
  bad(planTransition(t, 'in_review', 'submit', { ...f, diff_files: ['docs/PRD.md'] }));
  bad(planTransition(t, 'in_review', 'submit', { ...f, diff_files: ['docs/prototype/a.html'] }));
  // S0 的 architect：writes 显式含 rules/** 时放行 rules/，其余受保护路径仍拒
  const s0 = { ...t, stage: 'S0', role: 'architect', writes: ['**', 'rules/**'] };
  ok(planTransition(s0, 'in_review', 'submit', { ...f, diff_files: ['rules/project.md', 'src/a.ts'] }));
  for (const path of ['.forge/state.json', 'workflow.yaml', '.git/config', '.pi/x']) bad(planTransition(s0, 'in_review', 'submit', { ...f, diff_files: [path] }));
  for (const path of ['tests/acceptance/_support/a.ts', 'tests/acceptance/S0-smoke/a.ts']) {
    ok(planTransition({ ...t, stage: 'S0' }, 'in_review', 'submit', { ...f, diff_files: [path] }));
    // doc 任务按 writes（这里是 **），验收测试也能改
    ok(planTransition({ ...t, stage: 'S0', kind: 'doc' }, 'in_review', 'submit', { ...f, diff_files: [path] }));
  }
  const narrow = task('in_progress', { shared: ['src/routes.ts'] });
  // impl / fix 不受 writes 限制（包括单元测试与任何 task 的验收测试）；PRD 与原型仍越界；其他种类照旧
  ok(planTransition(narrow, 'in_review', 'submit', { ...f, diff_files: ['outside.ts', 'src/server/index.js', 'tests/unit/new.test.js', 'tests/acceptance/T-002/a.test.ts'] }));
  for (const path of ['docs/PRD.md', 'docs/prototype/a.html']) bad(planTransition(narrow, 'in_review', 'submit', { ...f, diff_files: [path] }));
  bad(planTransition({ ...narrow, kind: 'doc' }, 'in_review', 'submit', { ...f, diff_files: ['outside.ts'] }));
  ok(planTransition(narrow, 'in_review', 'submit', { ...f, diff_files: ['src/routes.ts', 'unit/a.test.ts', 'docs/contracts/modules/a.md'], test_adjustments: ['unit/a.test.ts'] }));
  // backend、frontend 不能改架构师负责的文档（契约、架构文档、plan.md、AGENTS.md）；worker（轻流程）照旧
  for (const role of ['backend', 'frontend']) {
    for (const path of ['docs/contracts/openapi.yaml', 'docs/arch/overview.md', 'docs/plan.md', 'AGENTS.md', 'rules/backend.md']) bad(planTransition({ ...narrow, role }, 'in_review', 'submit', { ...f, diff_files: [path] }));
    ok(planTransition({ ...narrow, role }, 'in_review', 'submit', { ...f, diff_files: ['src/routes.ts', 'docs/notes.md'] }));
  }
  for (const diff_files of [undefined, []]) bad(planTransition(t, 'in_review', 'submit', { ...f, diff_files }));
  const submitted = ok(planTransition(narrow, 'in_review', 'submit', f));
  assert.equal(submitted.task.lease, null);
  assert.equal(submitted.task.impl_run, 'r-1');
});

test('输入、审查和合并的独立事实必须满足', () => {
  bad(planTransition(task('queued_merge'), 'merging', 'merge_start', facts({ merging_other: 'T-002' })));
  bad(planTransition(task('queued_merge'), 'merging', 'merge_start', facts({ queue_head: false })));
  for (const key of ['rebase_ok', 'post_verify_ok', 'fast_forwarded'] as const) bad(planTransition(task('merging'), 'done', 'merge_done', facts({ rebase_ok: true, post_verify_ok: true, fast_forwarded: true, [key]: false })));
  const a = task('in_progress', { kind: 'review' });
  bad(planTransition(a, 'done', 'report', facts({ diff_files: ['x'] })));
  // 没有改动的 impl、fix、doc 可以直接完成；merge-fix 没有改动说明冲突没解决，不行
  for (const kind of ['impl', 'fix', 'doc'] as const) ok(planTransition(task('in_progress', { kind }), 'done', 'report', facts({ diff_files: [] })));
  bad(planTransition(task('in_progress', { kind: 'merge-fix' }), 'done', 'report', facts({ diff_files: [] })));
  bad(planTransition(task('in_progress', { kind: 'impl' }), 'done', 'report', facts({ diff_files: ['src/a.ts'] })));
});

const counts = (t: TaskFile) => [t.attempts, t.review_rounds ?? 0, t.merge_failures ?? 0];
test('计数独立、预算耗尽设置对应 blocked_by', () => {
  const baseline = { attempts: 0, review_rounds: 0, merge_failures: 0 };
  const scenarios = [
    { from: 'in_review', to: 'in_progress', trigger: 'review_changes', facts: { unresolved_must: 1 }, expected: [0, 1, 0], blocked: 'review_exhausted', counter: 'review_rounds' },
    { from: 'merging', to: 'in_progress', trigger: 'merge_verify_fail', facts: { post_verify_ok: false }, expected: [0, 0, 1], blocked: 'merge_exhausted', counter: 'merge_failures' },
  ] as const;
  for (const s of scenarios) {
    const result = ok(planTransition(task(s.from, baseline), s.to, s.trigger, facts(s.facts)));
    assert.deepEqual(counts(result.task), s.expected);
    const capped = ok(planTransition(task(s.from, { ...baseline, [s.counter]: 1 }), s.to, s.trigger, facts(s.facts)));
    assert.equal(capped.to, 'blocked'); assert.equal(capped.task.blocked_by, s.blocked);
  }
});

test('运行失败、租约过期与超时计 attempts；暂停和中断沿用独立计数', () => {
  const t = task('in_progress', { timeout_review: { run: 'r-1', at: NOW.toISOString(), minutes: 30 }, review_rounds: 1, merge_failures: 1 });
  for (const trigger of ['run_failed', 'run_timeout', 'lease_expired'] as const) {
    const to = trigger === 'lease_expired' ? 'ready' : 'in_progress';
    const f = facts({ now: new Date('2026-01-01T00:31:00Z'), worktree_clean: true });
    const r = ok(planTransition(t, to, trigger, f));
    assert.equal(r.task.attempts, 1); assert.deepEqual(counts(r.task).slice(1), counts(t).slice(1)); assert.equal(r.task.lease, null);
    const capped = ok(planTransition({ ...t, attempts: 2 }, to, trigger, f));
    assert.equal(capped.to, 'blocked'); assert.equal(capped.task.blocked_by, 'attempts');
  }
  const expiredTwice = ok(planTransition({ ...t, lease_expirations: 1 }, 'ready', 'lease_expired', facts({ now: new Date('2026-01-01T00:31:00Z'), worktree_clean: true })));
  assert.equal(expiredTwice.task.blocked_by, 'attempts');
  for (const trigger of ['run_interrupted', 'run_paused'] as const) assert.equal(ok(planTransition(t, 'in_progress', trigger, facts())).task.attempts, 0);
  const interrupted = ok(planTransition({ ...t, interruptions: MAX_INTERRUPTIONS - 1 }, 'in_progress', 'run_interrupted', facts()));
  assert.equal(interrupted.task.blocked_by, 'dispatcher');
  const timed = ok(planTransition({ ...t, timeouts: 2 }, 'in_progress', 'run_timeout', facts()));
  assert.equal(timed.to, 'blocked'); assert.equal(timed.task.blocked_by, 'attempts');
});

test('unblock 默认保留计数与 worktree；reset 只清零阻塞原因对应计数', () => {
  const baseline = { attempts: 2, review_rounds: 4, merge_failures: 5 };
  const mapping = { attempts: 'attempts', review_exhausted: 'review_rounds', merge_exhausted: 'merge_failures' } as const;
  for (const [blocked_by, counter] of Object.entries(mapping)) {
    const t = task('blocked', { ...baseline, blocked_by: blocked_by as TaskFile['blocked_by'] });
    const kept = ok(planTransition(t, 'in_progress', 'unblock', facts({ actor: 'human' })));
    assert.deepEqual(counts(kept.task), counts(t)); assert.equal(kept.task.worktree, t.worktree); assert.equal(kept.task.branch, t.branch);
    const reset = ok(planTransition(t, 'in_progress', 'unblock', facts({ actor: 'human', reset: true })));
    assert.deepEqual(counts(reset.task), counts({ ...t, [counter]: 0 }));
  }
  for (const actor of ['human', 'orchestrator', 'dispatcher', 'engine', 'run:r-1']) {
    const r = ok(planTransition(task('in_review'), 'blocked', 'block', facts({ actor })));
    assert.equal(r.task.blocked_by, actor === 'human' || actor === 'orchestrator' ? 'user' : actor === 'run:r-1' ? 'agent' : 'dispatcher');
  }
});

test('转移不修改 task、facts、patch，包含 lease 嵌套对象', () => {
  const t = task('in_progress'); const patch = { worktree: '/other' }; const f = facts();
  const snapshot = structuredClone({ t, patch, f });
  ok(planTransition(t, 'in_review', 'submit', f, patch));
  assert.deepEqual({ t, patch, f }, snapshot);
});

interface StageCase { from: StageStatus; to: StageStatus; trigger: StageTrigger; facts?: Partial<StageFacts>; reject?: Partial<StageFacts> }
const stages: StageCase[] = [
  { from: 'active', to: 'awaiting_gate', trigger: 'submit_gate' },
  { from: 'awaiting_gate', to: 'active', trigger: 'gate_failed', reject: { reason: '' } },
  { from: 'awaiting_gate', to: 'awaiting_human', trigger: 'gate_passed', facts: { needs_human: true }, reject: { needs_human: false } },
  { from: 'awaiting_gate', to: 'done', trigger: 'gate_passed', facts: { needs_human: false }, reject: { needs_human: true } },
  { from: 'awaiting_gate', to: 'needs_human', trigger: 'gate_exhausted', reject: { reason: '' } },
  { from: 'needs_human', to: 'awaiting_human', trigger: 'accept', facts: { actor: 'human' }, reject: { actor: 'orchestrator' } },
  { from: 'needs_human', to: 'awaiting_gate', trigger: 'gate_rerun', facts: { actor: 'human' }, reject: { actor: 'engine' } },
  ...(['needs_human', 'awaiting_human'] as const).map((from): StageCase => ({ from, to: 'active', trigger: 'reject', facts: { actor: 'human' }, reject: { actor: 'orchestrator' } })),
  { from: 'awaiting_human', to: 'done', trigger: 'approve', facts: { actor: 'human' }, reject: { actor: 'engine' } },
  ...(['active', 'awaiting_gate', 'needs_human', 'awaiting_human'] as const).map((from): StageCase => ({ from, to: 'aborted', trigger: 'abort', facts: { actor: 'human' }, reject: { actor: 'orchestrator' } })),
];
for (const c of stages) test(`阶段：${c.from} → ${c.to}（${c.trigger}）正反例`, () => {
  const f: StageFacts = { actor: 'engine', reason: '门禁失败', ...c.facts };
  assert.deepEqual(planStageTransition(c.from, c.to, c.trigger, f), []);
  assert.ok(planStageTransition(c.reject ? c.from : 'done', c.to, c.trigger, { ...f, ...c.reject }).length);
});
test('阶段：needs_human 交给主会话时，主会话可以放行进入签收，不能重跑门禁、打回或中止', () => {
  const o: StageFacts = { actor: 'orchestrator', reason: 'x', delegated: true };
  assert.deepEqual(planStageTransition('needs_human', 'awaiting_human', 'accept', o), []);
  assert.ok(planStageTransition('needs_human', 'awaiting_human', 'accept', { ...o, delegated: false }).length);
  assert.ok(planStageTransition('needs_human', 'awaiting_gate', 'gate_rerun', o).length);
  assert.ok(planStageTransition('needs_human', 'active', 'reject', o).length);
  assert.ok(planStageTransition('awaiting_human', 'done', 'approve', o).length, '签收始终由用户');
});
test('阶段状态 × 触发 × 目标穷举，只允许阶段清单内的组合', () => {
  const allowed = new Set(stages.map((c) => `${c.from}/${c.trigger}/${c.to}`));
  for (const from of STAGE_STATUSES) for (const to of STAGE_STATUSES) for (const trigger of new Set(stages.map((c) => c.trigger))) {
    if (allowed.has(`${from}/${trigger}/${to}`)) continue;
    assert.ok(planStageTransition(from, to, trigger, { actor: 'human', reason: 'x', needs_human: true }).length);
  }
});

test('submit：impl 与它的 fix 可以改任何 task 的验收测试，doc 任务按 writes', () => {
  const f = facts();
  const own = task('in_progress', { writes: ['src/**', 'tests/acceptance/T-001/**'] });
  ok(planTransition(own, 'in_review', 'submit', { ...f, diff_files: ['src/a.ts', 'tests/acceptance/T-001/a.test.ts', 'tests/acceptance/T-001/sub/b.test.ts'] }));
  for (const p of ['tests/acceptance/T-002/a.test.ts', 'tests/acceptance/_support/T-001/a.ts', 'tests/acceptance/S0-smoke/a.ts']) {
    ok(planTransition(own, 'in_review', 'submit', { ...f, diff_files: [p] }));
    ok(planTransition(task('in_progress', { id: 'T-001.fx-1', kind: 'fix', for_task: 'T-001', writes: ['tests/acceptance/T-001/**'] }), 'in_review', 'submit', { ...f, diff_files: [p] }));
  }
  // PRD 与原型仍不能改
  bad(planTransition(own, 'in_review', 'submit', { ...f, diff_files: ['docs/PRD.md'] }));
  // doc 任务不放开 writes，writes 里的验收测试可以改
  ok(planTransition({ ...own, kind: 'doc' }, 'in_review', 'submit', { ...f, diff_files: ['tests/acceptance/T-001/a.test.ts'] }));
  bad(planTransition({ ...own, kind: 'doc' }, 'in_review', 'submit', { ...f, diff_files: ['tests/acceptance/T-002/a.test.ts'] }));
});

test('merge_conflict：impl / fix 的合并冲突交回 worker，与 merge_verify_fail 共用 merge_failures，达到上限转 blocked', () => {
  for (const kind of ['impl', 'fix'] as const) {
    const r = ok(planTransition(task('merging', { kind }), 'in_progress', 'merge_conflict', facts({ conflict_files: ['src/a.ts'] })));
    assert.equal(r.task.merge_failures, 1); assert.equal(r.task.lease, null); assert.equal(r.task.conflict_files, undefined);
    const capped = ok(planTransition(task('merging', { kind, merge_failures: 1 }), 'in_progress', 'merge_conflict', facts({ conflict_files: ['src/a.ts'] })));
    assert.equal(capped.to, 'blocked'); assert.equal(capped.task.blocked_by, 'merge_exhausted');
  }
});
