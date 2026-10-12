// 来源：pi-flow test/unit/state-machine.test.ts @ 31f3f15；按 M1 批复重写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planTransition, planStageTransition, hashToken, IN_FLIGHT,
  MAX_INTERRUPTIONS, type Facts, type Trigger, type StageTrigger, type StageFacts,
} from '../../src/core/state/state-machine.ts';
import { TASK_STATUSES, STAGE_STATUSES, validate, type TaskFile, type TaskStatus, type StageStatus } from '../../src/core/state/schemas.ts';
import { mkTask, hard, soft } from '../helpers/tasks.ts';

const NOW = new Date('2026-01-01T00:00:00Z');
const TOKEN = 'tok-impl';
const lease = { run_id: 'r-1', role: 'worker', token_hash: hashToken(TOKEN), acquired_at: NOW.toISOString(), expires_at: '2026-01-01T00:30:00Z' };
const facts = (over: Partial<Facts> = {}): Facts => ({
  now: NOW, limits: { max_attempts: 3, max_parallel: 2, max_parallel_aux: 3, max_precheck_failures: 2, max_merge_failures: 2, review_max_rounds: 2, max_disputes: 1 },
  actor: 'engine', stage_active: true, status_of: new Map(), running_count: 0, conflicting_running: [], queue_head: true,
  token: TOKEN, handoff_written: true, diff_files: ['src/server/t-001/a.ts'], reason: '测试失败',
  latest_acctest_done: true, soft_deps_done: true, inputs_synced: true, structured_report: true,
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
  ...(['impl', 'fix', 'doc', 'merge-fix'] as const).map((kind): Case => ({ from: 'in_progress', to: 'awaiting_inputs', trigger: 'submit', task: { kind }, reject: { handoff_written: false }, rejectTask: { kind: 'acctest' } })),
  { from: 'awaiting_inputs', to: 'checking', trigger: 'inputs_ready', reject: { actor: 'orchestrator' } },
  { from: 'awaiting_inputs', to: 'in_progress', trigger: 'sync_conflict', facts: { conflict_files: ['src/a.ts'] }, reject: { conflict_files: [] } },
  { from: 'checking', to: 'in_progress', trigger: 'precheck_fail', facts: { precheck_ok: false }, reject: { precheck_ok: true }, rejectTask: { kind: 'acctest' } },
  { from: 'checking', to: 'in_review', trigger: 'precheck_pass', facts: { precheck_ok: true, review_required: true }, reject: { review_required: false }, rejectTask: { kind: 'qa' } },
  { from: 'checking', to: 'queued_merge', trigger: 'precheck_pass_skip', facts: { precheck_ok: true, review_required: false }, reject: { review_required: true }, rejectTask: { kind: 'acctest' } },
  { from: 'in_review', to: 'in_progress', trigger: 'review_changes', facts: { unresolved_must: 1 }, reject: { unresolved_must: 0 } },
  { from: 'in_review', to: 'queued_merge', trigger: 'review_pass', facts: { unresolved_must: 0 }, reject: { unresolved_must: 1 } },
  { from: 'in_review', to: 'blocked', trigger: 'review_exhausted', task: { review_rounds: 2 }, facts: { unresolved_must: 1 }, reject: { unresolved_must: 0 }, rejectTask: { review_rounds: 1 } },
  { from: 'queued_merge', to: 'merging', trigger: 'merge_start', reject: { soft_deps_done: false } },
  { from: 'merging', to: 'done', trigger: 'merge_done', facts: { rebase_ok: true, post_verify_ok: true, fast_forwarded: true }, reject: { fast_forwarded: false } },
  { from: 'merging', to: 'in_progress', trigger: 'merge_verify_fail', facts: { post_verify_ok: false }, reject: { post_verify_ok: true }, rejectTask: { kind: 'acctest' } },
  { from: 'merging', to: 'blocked', trigger: 'merge_blocked', reject: { reason: '' } },
  { from: 'merging', to: 'queued_merge', trigger: 'merge_requeue', reject: {}, rejectTask: { status: 'checking' } },
  { from: 'in_progress', to: 'disputed', trigger: 'dispute', facts: { dispute_test: 'test-a', dispute_evidence: 'docs/spec/requirements.md:AC1', dispute_evidence_valid: true }, reject: { dispute_evidence_valid: false }, rejectTask: { kind: 'doc' } },
  { from: 'disputed', to: 'checking', trigger: 'dispute_fixed', facts: { acctest_changed_tests: true }, reject: { acctest_changed_tests: false } },
  { from: 'disputed', to: 'in_progress', trigger: 'dispute_upheld', facts: { acctest_changed_tests: false }, reject: { acctest_changed_tests: true } },
  { from: 'disputed', to: 'blocked', trigger: 'dispute_escalated', task: { disputes: { 'test-a': 2 } }, facts: { dispute_test: 'test-a' }, reject: {}, rejectTask: { disputes: { 'test-a': 1 } } },
  { from: 'blocked', to: 'in_progress', trigger: 'decide_keep', task: { blocked_by: 'dispute' }, facts: { actor: 'human' }, reject: { actor: 'orchestrator' }, rejectTask: { blocked_by: 'agent' } },
  { from: 'blocked', to: 'disputed', trigger: 'decide_fix', task: { blocked_by: 'dispute' }, facts: { actor: 'human' }, reject: { actor: 'engine' }, rejectTask: { blocked_by: 'merge_exhausted' } },
  { from: 'blocked', to: 'queued_merge', trigger: 'accept', task: { blocked_by: 'review_exhausted' }, facts: { actor: 'human' }, reject: { actor: 'orchestrator' }, rejectTask: { blocked_by: 'precheck_exhausted' } },
  { from: 'blocked', to: 'in_progress', trigger: 'unblock', facts: { actor: 'human' }, reject: { actor: 'engine' }, rejectTask: { worktree: null, branch: null } },
  { from: 'blocked', to: 'ready', trigger: 'unblock', task: { worktree: null, branch: null }, facts: { actor: 'human' }, reject: { actor: 'orchestrator' }, rejectTask: { branch: 'started' } },
  ...(['acctest', 'review', 'qa'] as const).map((kind): Case => ({ from: 'in_progress', to: 'done', trigger: 'report', task: { kind }, facts: { diff_files: [], impl_done: false }, reject: { structured_report: false }, rejectTask: { kind: 'impl' } })),
  { from: 'in_progress', to: 'checking', trigger: 'submit', task: { kind: 'acctest' }, facts: { impl_done: true }, reject: { impl_done: false } },
  { from: 'checking', to: 'queued_merge', trigger: 'precheck_pass', task: { kind: 'acctest' }, facts: { impl_done: true, precheck_ok: true }, reject: { precheck_ok: false } },
  ...(['checking', 'merging'] as const).map((from): Case => ({ from, to: 'done', trigger: 'precheck_fail_handoff', task: { kind: 'acctest' }, facts: { impl_done: true, precheck_ok: false, post_verify_ok: false, failed_tests_own_directory: true }, reject: from === 'checking' ? { precheck_ok: true } : { failed_tests_own_directory: false }, rejectTask: { kind: 'impl' } })),
  { from: 'merging', to: 'blocked', trigger: 'merge_blocked', task: { kind: 'acctest' }, facts: { impl_done: true, post_verify_ok: false, failed_tests_own_directory: false }, reject: { failed_tests_own_directory: true } },
  ...(['checking', 'merging'] as const).map((from): Case => ({ from, to: 'awaiting_inputs', trigger: 'foreign_tests_broken', facts: { foreign_acceptance_failed: true, waits_for: ['T-002.at-2'] }, reject: { foreign_acceptance_failed: false }, rejectTask: { kind: 'acctest' } })),
  { from: 'ready', to: 'blocked', trigger: 'block', facts: { actor: 'dispatcher' }, reject: { actor: 'orchestrator' } },
  ...(['in_progress', 'awaiting_inputs', 'checking', 'in_review', 'disputed', 'queued_merge', 'merging'] as const).map((from): Case => ({ from, to: 'blocked', trigger: 'block', reject: { reason: '' } })),
  ...(['run_failed', 'run_interrupted', 'run_paused', 'run_timeout'] as const).map((trigger): Case => ({ from: 'in_progress', to: 'in_progress', trigger, task: trigger === 'run_timeout' ? { timeout_review: { run: 'r-1', at: NOW.toISOString(), minutes: 30 } } : {}, reject: { reason: '' }, rejectTask: { lease: null } })),
  { from: 'in_progress', to: 'ready', trigger: 'lease_expired', facts: { now: new Date('2026-01-01T00:31:00Z'), worktree_clean: true }, reject: { worktree_clean: false } },
  ...(['pending', 'ready', 'blocked'] as const).map((from): Case => ({ from, to: 'cancelled', trigger: 'cancel', facts: { actor: 'human' }, reject: { actor: 'engine' } })),
];
for (const [i, c] of cases.entries()) test(`转移 ${i + 1}：${c.from} → ${c.to}（${c.trigger}，${c.task?.kind ?? 'impl'}）正反例`, () => {
  const t = task(c.from, c.task), f = facts(c.facts);
  const result = ok(planTransition(t, c.to, c.trigger, f));
  assert.equal(result.to, c.to);
  bad(planTransition({ ...t, ...c.rejectTask }, c.to, c.trigger, { ...f, ...c.reject }));
  if (c.rejectTask) bad(planTransition({ ...t, ...c.rejectTask }, c.to, c.trigger, f));
  // 检查整份任务变化前的形状与 blocked 原因。
  if (c.to === 'blocked') assert.ok(result.task.blocked_by);
  if (c.from === 'blocked') assert.equal(result.task.blocked_by, null);
});
// 穷举的允许集合来自上面的规格用例，与 TRANSITIONS 无关。
test('状态 × 触发 × 目标穷举：只有清单中的组合可成功；done、cancelled 没有出边', () => {
  const triggers = [...new Set(cases.map((c) => c.trigger))];
  const allowed = new Set(cases.map((c) => `${c.from}/${c.trigger}/${c.to}`));
  for (const from of TASK_STATUSES) for (const trigger of triggers) for (const to of TASK_STATUSES) {
    if (allowed.has(`${from}/${trigger}/${to}`)) continue;
    for (const kind of ['impl', 'acctest', 'review', 'qa'] as const) bad(planTransition(task(from, { kind }), to, trigger, facts()));
  }
  assert.deepEqual(IN_FLIGHT, ['in_progress', 'awaiting_inputs', 'checking', 'in_review', 'disputed', 'queued_merge', 'merging']);
});

test('review 与 qa 的完成只接受 report，不能进入合并；辅助池不占实施池', () => {
  for (const kind of ['review', 'qa'] as const) {
    for (const [to, trigger] of [['merging', 'merge_start'], ['done', 'merge_done'], ['blocked', 'merge_blocked'], ['queued_merge', 'merge_requeue']] as const) {
      bad(planTransition(task(trigger === 'merge_start' ? 'queued_merge' : 'merging', { kind }), to, trigger, facts({ rebase_ok: true, post_verify_ok: true, fast_forwarded: true })));
    }
    ok(planTransition(task('ready', { kind }), 'in_progress', 'dispatch', facts({ running_count: 2, aux_running_count: 0 })));
  }
  ok(planTransition(task('ready'), 'in_progress', 'dispatch', facts({ running_count: 0, aux_running_count: 3 })));
});

test('争议需有效租约与具体引用；fix 也可以提出争议；超过单个测试上限才升级', () => {
  const f = facts({ dispute_test: 'a', dispute_evidence: 'docs/spec/requirements.md:REQ-001.AC1', dispute_evidence_valid: true });
  ok(planTransition(task('in_progress', { kind: 'fix' }), 'disputed', 'dispute', f));
  for (const over of [{ token: '伪造' }, { dispute_test: '' }, { dispute_evidence: '' }, { dispute_evidence_valid: false }]) bad(planTransition(task('in_progress'), 'disputed', 'dispute', { ...f, ...over }));
  bad(planTransition(task('in_progress', { lease: null }), 'disputed', 'dispute', f));
  bad(planTransition(task('disputed', { disputes: { a: 1, b: 99 } }), 'blocked', 'dispute_escalated', f));
  const result = ok(planTransition(task('disputed', { disputes: { a: 2, b: 99 } }), 'blocked', 'dispute_escalated', f));
  assert.equal(result.task.blocked_by, 'dispute');
});

test('硬依赖只认 done，软依赖不阻塞 schedule；输入与合并必须等待软依赖', () => {
  const t = task('pending', { depends_on: [hard('T-002'), soft('T-003')] });
  const f = facts({ status_of: new Map([['T-002', 'done'], ['T-003', 'blocked']]) });
  ok(planTransition(t, 'ready', 'schedule', f));
  for (const state of ['pending', 'accepting', 'blocked', 'cancelled']) bad(planTransition(t, 'ready', 'schedule', { ...f, status_of: new Map([['T-002', state]]) }));
  bad(planTransition({ ...t, status: 'awaiting_inputs' }, 'checking', 'inputs_ready', { ...f, soft_deps_done: false }));
  bad(planTransition({ ...t, status: 'queued_merge' }, 'merging', 'merge_start', { ...f, soft_deps_done: false }));
});

test('dispatch：两个池分别限流，worktree、branch、base_sha、租约必需', () => {
  for (const kind of ['impl', 'acctest', 'review', 'qa'] as const) {
    const t = task('ready', { kind });
    const f = facts({ running_count: 0, aux_running_count: 0 });
    ok(planTransition(t, 'in_progress', 'dispatch', f));
    bad(planTransition(t, 'in_progress', 'dispatch', { ...f, running_count: 2, aux_running_count: 3 }));
    bad(planTransition(t, 'in_progress', 'dispatch', { ...f, conflicting_running: ['T-009'] }));
    for (const key of ['worktree', 'branch', 'base_sha', 'lease'] as const) bad(planTransition(t, 'in_progress', 'dispatch', f, { [key]: null }));
  }
});

test('submit：鉴权、范围、公共文件、已有测试调整、契约追加与 S0 验收路径例外', () => {
  const t = task('in_progress', { writes: ['**'] });
  const f = facts();
  for (const token of [undefined, 'forged']) bad(planTransition(t, 'awaiting_inputs', 'submit', { ...f, token }));
  bad(planTransition(t, 'awaiting_inputs', 'submit', { ...f, now: new Date('2026-01-01T00:30:00Z') }));
  for (const path of ['.forge/state.json', 'rules/project.md', 'tests/acceptance/T-002/a.test.ts']) bad(planTransition(t, 'awaiting_inputs', 'submit', { ...f, diff_files: [path], test_adjustments: [path] }));
  for (const path of ['tests/acceptance/_support/a.ts', 'tests/acceptance/S0-smoke/a.ts']) {
    ok(planTransition({ ...t, stage: 'S0' }, 'awaiting_inputs', 'submit', { ...f, diff_files: [path] }));
    for (const kind of ['fix', 'doc'] as const) bad(planTransition({ ...t, stage: 'S0', kind }, 'awaiting_inputs', 'submit', { ...f, diff_files: [path] }));
  }
  bad(planTransition({ ...t, stage: 'S0' }, 'awaiting_inputs', 'submit', { ...f, diff_files: ['tests/acceptance/T-001/a.ts'] }));
  const narrow = task('in_progress', { shared: ['src/routes.ts'] });
  // 偏离 115：impl / fix 不受 writes 限制；规格、未列测试路径时新建的测试代码仍越界；其他种类照旧
  ok(planTransition(narrow, 'awaiting_inputs', 'submit', { ...f, diff_files: ['outside.ts', 'src/server/index.js'] }));
  for (const path of ['docs/spec/requirements.md', 'tests/unit/new.test.js']) bad(planTransition(narrow, 'awaiting_inputs', 'submit', { ...f, diff_files: [path] }));
  bad(planTransition({ ...narrow, kind: 'doc' }, 'awaiting_inputs', 'submit', { ...f, diff_files: ['outside.ts'] }));
  ok(planTransition(narrow, 'awaiting_inputs', 'submit', { ...f, diff_files: ['src/routes.ts', 'unit/a.test.ts', 'docs/contracts/modules/a.md'], test_adjustments: ['unit/a.test.ts'], contract_additions: ['docs/contracts/modules/a.md'] }));
  bad(planTransition(t, 'awaiting_inputs', 'submit', { ...f, interface_rewrites: ['docs/contracts/modules/a.md'] }));
  for (const diff_files of [undefined, []]) bad(planTransition(t, 'awaiting_inputs', 'submit', { ...f, diff_files }));
  const submitted = ok(planTransition(narrow, 'awaiting_inputs', 'submit', f));
  assert.equal(submitted.task.lease, null);
  assert.equal(submitted.task.impl_run, 'r-1');
});

test('输入、审查、争议和合并的独立事实必须满足', () => {
  for (const key of ['latest_acctest_done', 'soft_deps_done', 'inputs_synced'] as const) bad(planTransition(task('awaiting_inputs'), 'checking', 'inputs_ready', facts({ [key]: false })));
  bad(planTransition(task('queued_merge'), 'merging', 'merge_start', facts({ merging_other: 'T-002' })));
  bad(planTransition(task('queued_merge'), 'merging', 'merge_start', facts({ queue_head: false })));
  for (const key of ['rebase_ok', 'post_verify_ok', 'fast_forwarded'] as const) bad(planTransition(task('merging'), 'done', 'merge_done', facts({ rebase_ok: true, post_verify_ok: true, fast_forwarded: true, [key]: false })));
  for (const trigger of ['dispute_fixed', 'dispute_upheld'] as const) bad(planTransition(task('disputed'), trigger === 'dispute_fixed' ? 'checking' : 'in_progress', trigger, facts({ latest_acctest_done: false, acctest_changed_tests: trigger === 'dispute_fixed' })));
  ok(planTransition(task('disputed'), 'blocked', 'dispute_escalated', facts({ acctest_escalated: true })));
  const a = task('in_progress', { kind: 'acctest' });
  bad(planTransition(a, 'done', 'report', facts({ diff_files: ['x'] })));
  bad(planTransition(a, 'done', 'report', facts({ diff_files: [], impl_done: true })));
  bad(planTransition(a, 'done', 'report', facts({ diff_files: [], handoff_written: false })));
});

const counts = (t: TaskFile) => [t.attempts, t.precheck_failures ?? 0, t.review_rounds ?? 0, t.merge_failures ?? 0, t.disputes ?? {}];
test('计数独立、预算耗尽设置对应 blocked_by，foreign_tests_broken 不动计数', () => {
  const baseline = { attempts: 0, precheck_failures: 0, review_rounds: 0, merge_failures: 0, disputes: { other: 2 } };
  const scenarios = [
    { from: 'checking', to: 'in_progress', trigger: 'precheck_fail', facts: { precheck_ok: false }, expected: [0, 1, 0, 0, { other: 2 }], blocked: 'precheck_exhausted', counter: 'precheck_failures' },
    { from: 'in_review', to: 'in_progress', trigger: 'review_changes', facts: { unresolved_must: 1 }, expected: [0, 0, 1, 0, { other: 2 }], blocked: 'review_exhausted', counter: 'review_rounds' },
    { from: 'merging', to: 'in_progress', trigger: 'merge_verify_fail', facts: { post_verify_ok: false }, expected: [0, 0, 0, 1, { other: 2 }], blocked: 'merge_exhausted', counter: 'merge_failures' },
  ] as const;
  for (const s of scenarios) {
    const result = ok(planTransition(task(s.from, baseline), s.to, s.trigger, facts(s.facts)));
    assert.deepEqual(counts(result.task), s.expected);
    const capped = ok(planTransition(task(s.from, { ...baseline, [s.counter]: 1 }), s.to, s.trigger, facts(s.facts)));
    assert.equal(capped.to, 'blocked'); assert.equal(capped.task.blocked_by, s.blocked);
  }
  const d = ok(planTransition(task('in_progress', baseline), 'disputed', 'dispute', facts({ dispute_test: 'test-a', dispute_evidence: 'docs/contracts/a.yaml:10', dispute_evidence_valid: true })));
  assert.deepEqual(counts(d.task), [0, 0, 0, 0, { other: 2, 'test-a': 1 }]);
  for (const from of ['checking', 'merging'] as const) {
    const t = task(from, { ...baseline, attempts: 2, precheck_failures: 1 });
    const r = ok(planTransition(t, 'awaiting_inputs', 'foreign_tests_broken', facts({ foreign_acceptance_failed: true, waits_for: ['T-002.at-2'] })));
    assert.deepEqual(counts(r.task), counts(t)); assert.equal(r.task.lease, null);
  }
  const at = task('merging', { kind: 'acctest' });
  const broken = ok(planTransition(at, 'blocked', 'merge_blocked', facts({ impl_done: true, post_verify_ok: false, failed_tests_own_directory: false })));
  assert.equal(broken.task.blocked_by, 'integration_broken'); assert.deepEqual(counts(broken.task), counts(at));
});

test('运行失败、租约过期与超时计 attempts；暂停和中断沿用独立计数', () => {
  const t = task('in_progress', { timeout_review: { run: 'r-1', at: NOW.toISOString(), minutes: 30 }, precheck_failures: 1, review_rounds: 1, merge_failures: 1 });
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
  const baseline = { attempts: 2, precheck_failures: 3, review_rounds: 4, merge_failures: 5, disputes: { a: 2, b: 3 } };
  const mapping = { attempts: 'attempts', precheck_exhausted: 'precheck_failures', review_exhausted: 'review_rounds', merge_exhausted: 'merge_failures' } as const;
  for (const [blocked_by, counter] of Object.entries(mapping)) {
    const t = task('blocked', { ...baseline, blocked_by: blocked_by as TaskFile['blocked_by'] });
    const kept = ok(planTransition(t, 'in_progress', 'unblock', facts({ actor: 'human' })));
    assert.deepEqual(counts(kept.task), counts(t)); assert.equal(kept.task.worktree, t.worktree); assert.equal(kept.task.branch, t.branch);
    const reset = ok(planTransition(t, 'in_progress', 'unblock', facts({ actor: 'human', reset: true })));
    assert.deepEqual(counts(reset.task), counts({ ...t, [counter]: 0 }));
  }
  const disputed = task('blocked', { ...baseline, blocked_by: 'dispute' });
  const reset = ok(planTransition(disputed, 'in_progress', 'unblock', facts({ actor: 'human', reset: true, dispute_test: 'a' })));
  assert.deepEqual(reset.task.disputes, { a: 0, b: 3 });
  for (const actor of ['human', 'orchestrator', 'dispatcher', 'engine', 'run:r-1']) {
    const r = ok(planTransition(task('checking'), 'blocked', 'block', facts({ actor })));
    assert.equal(r.task.blocked_by, actor === 'human' || actor === 'orchestrator' ? 'user' : actor === 'run:r-1' ? 'agent' : 'dispatcher');
  }
});

test('转移不修改 task、facts、patch，包含 disputes 与 lease 嵌套对象', () => {
  const t = task('in_progress', { disputes: { a: 1 } }); const patch = { worktree: '/other' }; const f = facts({ dispute_test: 'a', dispute_evidence: 'docs/spec/a.md:1', dispute_evidence_valid: true });
  const snapshot = structuredClone({ t, patch, f });
  ok(planTransition(t, 'disputed', 'dispute', f, patch));
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
test('阶段状态 × 触发 × 目标穷举，只允许阶段清单内的组合', () => {
  const allowed = new Set(stages.map((c) => `${c.from}/${c.trigger}/${c.to}`));
  for (const from of STAGE_STATUSES) for (const to of STAGE_STATUSES) for (const trigger of new Set(stages.map((c) => c.trigger))) {
    if (allowed.has(`${from}/${trigger}/${to}`)) continue;
    assert.ok(planStageTransition(from, to, trigger, { actor: 'human', reason: 'x', needs_human: true }).length);
  }
});

test('第 9.4 节：foreign_tests_broken 记下要等的 .at-n；inputs_ready 要等它们 done，之后清除', () => {
  bad(planTransition(task('checking'), 'awaiting_inputs', 'foreign_tests_broken', facts({ foreign_acceptance_failed: true })));
  const waiting = ok(planTransition(task('merging'), 'awaiting_inputs', 'foreign_tests_broken', facts({ foreign_acceptance_failed: true, waits_for: ['T-002.at-2'] }))).task;
  assert.deepEqual(waiting.waits_for, ['T-002.at-2']);
  assert.equal(waiting.merge_failures ?? 0, 0);
  bad(planTransition(waiting, 'checking', 'inputs_ready', facts()));
  const r = ok(planTransition(waiting, 'checking', 'inputs_ready', facts({ waits_for_done: true })));
  assert.equal(r.task.waits_for, undefined);
});

test('acctest 以结论结束时记下是否改了测试（争议裁决据此区分改测试与维持）', () => {
  const at = task('in_progress', { id: 'T-001.at-2', kind: 'acctest', role: 'test-author', for_task: 'T-001' });
  assert.equal(ok(planTransition(at, 'done', 'report', facts({ diff_files: [], impl_done: false, acctest_changed_tests: true }))).task.changed_tests, true);
  assert.equal(ok(planTransition(at, 'done', 'report', facts({ diff_files: [], impl_done: false }))).task.changed_tests, false);
});

test('acctest 单独合并（submit → checking）时记下 changed_tests = true，争议裁决据此走 dispute_fixed', () => {
  const at = task('in_progress', { id: 'T-001.at-2', kind: 'acctest', role: 'test-author', for_task: 'T-001', writes: ['tests/acceptance/T-001/**'] });
  const r = ok(planTransition(at, 'checking', 'submit', facts({ impl_done: true, diff_files: ['tests/acceptance/T-001/a.test.ts'] })));
  assert.equal(r.task.changed_tests, true);
});

test('submit：test_author 为 false 时 impl 与它的 fix 只放开自己的验收目录（偏离 81）', () => {
  const f = facts();
  const own = task('in_progress', { writes: ['src/**', 'tests/acceptance/T-001/**'] });
  ok(planTransition(own, 'awaiting_inputs', 'submit', { ...f, diff_files: ['src/a.ts', 'tests/acceptance/T-001/a.test.ts', 'tests/acceptance/T-001/sub/b.test.ts'] }));
  // 别的 task 的目录、_support、S0-smoke 仍然不行
  for (const p of ['tests/acceptance/T-002/a.test.ts', 'tests/acceptance/_support/T-001/a.ts', 'tests/acceptance/S0-smoke/a.ts']) {
    bad(planTransition({ ...own, writes: [...own.writes, 'tests/acceptance/**'] }, 'awaiting_inputs', 'submit', { ...f, diff_files: [p] }));
  }
  // writes 里没有自己的验收目录（默认流程）：照旧拒绝
  bad(planTransition(task('in_progress', { writes: ['**'] }), 'awaiting_inputs', 'submit', { ...f, diff_files: ['tests/acceptance/T-001/a.test.ts'] }));
  // 覆盖缺口的 fix：for_task 的目录
  const fx = task('in_progress', { id: 'T-001.fx-1', kind: 'fix', for_task: 'T-001', writes: ['tests/acceptance/T-001/**'] });
  ok(planTransition(fx, 'awaiting_inputs', 'submit', { ...f, diff_files: ['tests/acceptance/T-001/a.test.ts'] }));
  bad(planTransition(fx, 'awaiting_inputs', 'submit', { ...f, diff_files: ['tests/acceptance/T-002/a.test.ts'] }));
  // 偏离 107：程序因旧测试被打破而加入的别的 task 目录（含 _support）放开；没加入的仍然不行
  const widened = task('in_progress', { id: 'T-001.fx-1', kind: 'fix', for_task: 'T-001', writes: ['tests/acceptance/T-001/**', 'tests/acceptance/T-009/**', 'tests/acceptance/_support/T-009/**'] });
  ok(planTransition(widened, 'awaiting_inputs', 'submit', { ...f, diff_files: ['tests/acceptance/T-009/old.test.js', 'tests/acceptance/_support/T-009/h.js'] }));
  bad(planTransition(widened, 'awaiting_inputs', 'submit', { ...f, diff_files: ['tests/acceptance/T-004/a.test.js'] }));
  // doc 任务不放开
  bad(planTransition({ ...own, kind: 'doc' }, 'awaiting_inputs', 'submit', { ...f, diff_files: ['tests/acceptance/T-001/a.test.ts'] }));
});
