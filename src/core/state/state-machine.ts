// 来源：pi-flow src/core/state-machine.ts @ 31f3f15；按 M1 转移表与批复改编。
// 纯函数：只根据程序推导的 facts 判断，不做 IO，也不修改入参。
import { createHash } from 'node:crypto';
import type { Lease, StageStatus, TaskFile, TaskStatus } from './schemas.ts';
import { isProtected, matchesAny, ownAcceptanceGlob, writesOwnAcceptance } from './paths.ts';
import { failureSignature } from '../verify/verify-runner.ts';

export type Trigger =
  | 'schedule' | 'dispatch' | 'submit' | 'inputs_ready' | 'sync_conflict'
  | 'precheck_fail' | 'precheck_pass' | 'precheck_pass_skip' | 'precheck_fail_handoff'
  | 'review_changes' | 'review_pass' | 'review_exhausted'
  | 'merge_start' | 'merge_done' | 'merge_verify_fail' | 'merge_blocked' | 'merge_requeue'
  | 'dispute' | 'dispute_fixed' | 'dispute_upheld' | 'dispute_escalated' | 'decide_keep' | 'decide_fix'
  | 'accept' | 'foreign_tests_broken' | 'block' | 'unblock' | 'lease_expired'
  | 'run_failed' | 'run_interrupted' | 'run_paused' | 'run_timeout' | 'report' | 'cancel';

export const MAX_INTERRUPTIONS = 5;
export const DEFAULT_MAX_CONTINUATIONS = 2;

export interface Facts {
  now: Date;
  limits: {
    max_attempts: number; max_parallel: number; max_continuations?: number;
    max_parallel_aux?: number; max_precheck_failures?: number; max_merge_failures?: number;
    review_max_rounds?: number; max_disputes?: number;
  };
  /** 发起者：human、orchestrator、engine、dispatcher、run:<id> 等 */
  actor: string;
  /** 任务所在阶段是否 active */
  stage_active?: boolean;
  /** 依赖任务的真实状态，只认 done */
  status_of?: ReadonlyMap<string, string>;
  /** 实施池中的运行数；M4 前由现有单池提供 */
  running_count?: number;
  /** 辅助池中的运行数；缺省沿用单池运行数 */
  aux_running_count?: number;
  /** 与全部在途任务的可写范围互斥的任务编号 */
  conflicting_running?: string[];
  /** 是否已有其他任务占用合并名额 */
  merging_other?: string | null;
  /** 是否是队列里第一个合格任务，保留原字段名供运行时集成 */
  queue_head?: boolean;
  /** 本次运行是否已写 handoff */
  handoff_written?: boolean;
  /** 最新的验收测试派生任务是否 done；不需要派生测试时由程序传 true */
  latest_acctest_done?: boolean;
  /** 所有软依赖生产方是否 done；缺省由 status_of 推导 */
  soft_deps_done?: boolean;
  /** 集成分支与验收测试是否已成功同步进任务分支 */
  inputs_synced?: boolean;
  /** 同步产生的实际冲突文件 */
  conflict_files?: string[];
  /** 预检命令是否全部通过 */
  precheck_ok?: boolean;
  /** 根据模式、kind、风险、契约追加与配置推导的审查要求 */
  review_required?: boolean;
  /** 最近一轮审查尚未解决的 must 数量 */
  unresolved_must?: number;
  /** acctest 对应的原 impl 是否已经 done */
  impl_done?: boolean;
  /** 只读辅助任务是否已提交通过形状校验的结构化结论 */
  structured_report?: boolean;
  /** 争议对应的测试标识，按测试分别计数 */
  dispute_test?: string;
  /** 争议中引用的规格或契约具体位置 */
  dispute_evidence?: string;
  /** 程序是否确认引用的位置存在且来自规格或契约 */
  dispute_evidence_valid?: boolean;
  /** 最新 .at-n 相对于上一版是否改动了测试 */
  acctest_changed_tests?: boolean;
  /** 最新 .at-n 是否把争议交给用户 */
  acctest_escalated?: boolean;
  /** 失败是否涉及另一个任务的验收目录；M4 校验契约追加后提供 */
  foreign_acceptance_failed?: boolean;
  /** foreign_tests_broken：当前 task 要等的 .at-n（第 9.4 节） */
  waits_for?: string[];
  /** inputs_ready：waits_for 里的 task 都已 done */
  waits_for_done?: boolean;
  /** 失败测试是否全部在当前 .at 所属任务的验收目录；false 表示含目录外失败 */
  failed_tests_own_directory?: boolean;
  /** 程序验证为本模块契约的纯追加文件，可以越出 writes */
  contract_additions?: string[];
  /** 修改或删除了契约已有内容的文件；保留原名供运行时集成 */
  interface_rewrites?: string[];
  /** 程序验证为只改已有测试的文件；验收目录仍不能放行 */
  test_adjustments?: string[];
  /** 用户要求清零 blocked_by 对应的计数 */
  reset?: boolean;
  /** 原调用接口保留；只有 --reset 且阻塞原因为 attempts 时应用 */
  attempts?: number;
  token?: string;
  diff_files?: string[];
  rebase_ok?: boolean;
  post_verify_ok?: boolean;
  fast_forwarded?: boolean;
  worktree_clean?: boolean;
  reason?: string;
}

export type TaskPatch = Partial<Pick<TaskFile,
  'lease' | 'worktree' | 'branch' | 'base_sha' | 'timeout_review' | 'timeout_progress'>>;
interface Rule {
  from: readonly TaskStatus[];
  to: TaskStatus;
  trigger: Trigger;
  check: (t: TaskFile, f: Facts) => string[];
  effect?: (t: TaskFile, f: Facts) => void;
  failure?: boolean;
  counter?: 'precheck_failures' | 'review_rounds' | 'merge_failures';
}
export const IN_FLIGHT: readonly TaskStatus[] = [
  'in_progress', 'awaiting_inputs', 'checking', 'in_review', 'disputed', 'queued_merge', 'merging',
];
export const isSettled = (t: { status: TaskStatus }) => t.status === 'done' || t.status === 'cancelled';
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const need = (cond: boolean | undefined, msg: string): string[] => cond ? [] : [msg];
const reasonRequired = (f: { reason?: string }) => need(!!f.reason?.trim(), '必须写明原因');
const humanOnly = (f: Facts) => need(f.actor === 'human', '只有用户可以执行此操作');
const workerKind = (t: TaskFile) => ['impl', 'fix', 'doc', 'merge-fix'].includes(t.kind);
const pipelineOnly = (t: TaskFile) => need(workerKind(t), '只有实现、修复、文档或合并修复任务可以走此流水线');
const mergeOnly = (t: TaskFile) => need(workerKind(t) || t.kind === 'acctest', '只有实施类任务与验收测试可以进入合并流程');
const workerDisputeOnly = (t: TaskFile) => need(t.kind === 'impl' || t.kind === 'fix', '只有 impl 或 fix 可以提出或处理争议');
const softDone = (t: TaskFile, f: Facts) => f.soft_deps_done ?? t.depends_on.filter((d) => d.type === 'soft').every((d) => f.status_of?.get(d.task) === 'done');
const started = (t: TaskFile) => !!(t.worktree || t.branch);

function leaseValid(lease: Lease | null, f: Facts, what: string): string[] {
  if (!lease) return [`${what}：任务没有有效租约`];
  if (!f.token) return [`${what}：缺少 run token，请确认在 pi-forge 派发的子进程中调用`];
  if (hashToken(f.token) !== lease.token_hash) return [`${what}：run token 无效`];
  if (!Number.isFinite(Date.parse(lease.expires_at)) || f.now.getTime() >= Date.parse(lease.expires_at)) return [`${what}：租约已过期，请联系用户执行 /forge-resume`];
  return [];
}

/** 保留给工具层与运行时的能力判断；具体契约文件必须由程序验证后通过 contract_additions 提供。 */
export const canAppendInterfaces = (t: Pick<TaskFile, 'kind'>) => t.kind === 'impl' || t.kind === 'fix';

function submitErrors(t: TaskFile, f: Facts): string[] {
  const errors = leaseValid(t.lease, f, '提交被拒');
  const diff = f.diff_files;
  if (!diff) errors.push('缺少 worktree diff');
  else if (!diff.length) errors.push('worktree 没有改动，无可提交内容');
  else {
    const protectedFiles = diff.filter(isProtected);
    if (protectedFiles.length) errors.push(`diff 含受保护路径：${protectedFiles.join('、')}`);
    if (workerKind(t)) {
      const forbidden = diff.filter((p) => matchesAny(p, ['tests/acceptance/**']) &&
        !(t.kind === 'impl' && t.stage === 'S0' && matchesAny(p, ['tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**'])) &&
        // test_author 为 false（偏离 81）：impl 与它的 fix 只放开自己的验收目录，别的 task 的目录仍不能改
        !((t.kind === 'impl' || t.kind === 'fix') && writesOwnAcceptance(t) && matchesAny(p, [ownAcceptanceGlob(t.for_task ?? t.id)])));
      if (forbidden.length) errors.push(`不能修改验收测试：${forbidden.join('、')}`);
    }
    const allowed = [...t.writes, ...(t.shared ?? [])];
    const adjusted = new Set(f.test_adjustments ?? []);
    const additions = new Set(canAppendInterfaces(t) ? f.contract_additions ?? [] : []);
    const outside = diff.filter((p) => !matchesAny(p, allowed) && !adjusted.has(p) &&
      !(additions.has(p) && matchesAny(p, ['docs/contracts/**'])));
    if (outside.length) errors.push(`diff 越出任务 writes：${outside.join('、')}`);
    if (f.interface_rewrites?.length) errors.push(`契约只能追加，不能修改或删除已有内容：${f.interface_rewrites.join('、')}`);
  }
  errors.push(...need(f.handoff_written, '尚未写 handoff，请先调用 forge_note'));
  return errors;
}
function submitted(t: TaskFile, f: Facts): void {
  t.impl_run = t.lease!.run_id;
  t.lease = null;
  if (f.test_adjustments?.length) t.test_adjustments = [...f.test_adjustments];
  else delete t.test_adjustments;
}
function blocked(t: TaskFile, f: Facts, by: NonNullable<TaskFile['blocked_by']>): void {
  t.blocked_by = by;
  t.blocked_reason = f.reason ?? '需要用户处理';
  t.lease = null;
  delete t.timeout_review;
}
function clearRun(t: TaskFile): void { t.lease = null; }
function acctestOnly(t: TaskFile, f: Facts): string[] {
  return [...need(t.kind === 'acctest', '只有 acctest 可以单独合并验收测试'), ...need(f.impl_done === true, '原 impl 尚未 done，验收测试应提交结论')];
}
function unblockEffect(t: TaskFile, f: Facts): void {
  if (f.reset) {
    switch (t.blocked_by) {
      case 'attempts':
        t.attempts = f.attempts ?? 0;
        t.lease_expirations = 0;
        delete t.timeouts;
        break;
      case 'precheck_exhausted': t.precheck_failures = 0; break;
      case 'review_exhausted': t.review_rounds = 0; break;
      case 'merge_exhausted': t.merge_failures = 0; break;
      case 'dispute':
        t.disputes = f.dispute_test ? { ...t.disputes, [f.dispute_test]: 0 } : Object.fromEntries(Object.keys(t.disputes ?? {}).map((id) => [id, 0]));
        break;
      case 'dispatcher': delete t.interruptions; break;
    }
  }
  delete t.timeout_review;
  delete t.timeout_progress;
  delete t.same_failures;
  delete t.failure_sig;
  t.lease = null;
}

export const TRANSITIONS: readonly Rule[] = [
  {
    from: ['pending'], to: 'ready', trigger: 'schedule',
    check: (t, f) => {
      const waiting = t.depends_on.filter((d) => d.type === 'hard' && f.status_of?.get(d.task) !== 'done');
      return [...need(f.stage_active, `任务所属 stage ${t.stage} 不是 active`), ...need(!waiting.length, `硬依赖未完成：${waiting.map((d) => d.task).join('、')}`)];
    },
  },
  {
    from: ['ready'], to: 'in_progress', trigger: 'dispatch',
    check: (t, f) => {
      const aux = ['acctest', 'review', 'qa'].includes(t.kind);
      const count = aux ? f.aux_running_count ?? f.running_count : f.running_count;
      const limit = aux ? f.limits.max_parallel_aux ?? f.limits.max_parallel : f.limits.max_parallel;
      return [
        ...need((count ?? Infinity) < limit, `并发已达上限 ${limit}`),
        ...need((f.conflicting_running ?? []).length === 0, `与在途任务互斥：${(f.conflicting_running ?? []).join('、')}`),
        ...need(!!t.worktree && !!t.branch, '尚未建立 worktree 与任务分支'),
        ...need(!!t.base_sha, '尚未记录 base_sha'), ...need(!!t.lease, '尚未颁发 token 与租约'),
        ...need(!!t.lease && Date.parse(t.lease.expires_at) > f.now.getTime(), '颁发的租约已过期'),
      ];
    },
  },
  {
    from: ['in_progress'], to: 'awaiting_inputs', trigger: 'submit',
    check: (t, f) => [...pipelineOnly(t), ...submitErrors(t, f)], effect: submitted,
  },
  {
    from: ['in_progress'], to: 'checking', trigger: 'submit',
    // acctest 走 submit 只发生在单独合并（impl 已 done 且改了测试）；争议裁决靠它认出"改了测试"
    check: (t, f) => [...acctestOnly(t, f), ...submitErrors(t, f)], effect: (t, f) => { submitted(t, f); if (t.kind === 'acctest') t.changed_tests = true; },
  },
  {
    from: ['awaiting_inputs'], to: 'checking', trigger: 'inputs_ready',
    check: (t, f) => [
      ...pipelineOnly(t), ...need(f.actor === 'engine', '只有 engine 可以开始预检'),
      ...need(f.latest_acctest_done, '最新验收测试尚未 done'), ...need(softDone(t, f), '软依赖生产方尚未 done'),
      ...need(f.inputs_synced, '输入尚未同步成功'), ...need(!f.conflict_files?.length, '输入同步仍有冲突'),
      ...need(!t.waits_for?.length || f.waits_for_done === true, `还在等 ${t.waits_for?.join('、')} 修好被破坏的验收测试`),
    ],
    effect: (t) => { delete t.waits_for; },
  },
  {
    from: ['awaiting_inputs'], to: 'in_progress', trigger: 'sync_conflict',
    check: (t, f) => [...pipelineOnly(t), ...need(!!f.conflict_files?.length, '同步没有冲突文件')],
    effect: (t, f) => { t.lease = null; t.conflict_files = [...f.conflict_files!]; },
  },
  {
    from: ['checking'], to: 'in_progress', trigger: 'precheck_fail', counter: 'precheck_failures',
    check: (t, f) => [...pipelineOnly(t), ...need(f.precheck_ok === false, '预检并未失败'), ...need(!f.foreign_acceptance_failed, '其他任务验收测试失败应等待输入'), ...reasonRequired(f)],
  },
  {
    from: ['checking'], to: 'in_review', trigger: 'precheck_pass',
    check: (t, f) => [...pipelineOnly(t), ...need(f.precheck_ok === true, '预检尚未通过'), ...need(f.review_required === true, '此任务不需要审查')],
  },
  {
    from: ['checking'], to: 'queued_merge', trigger: 'precheck_pass_skip',
    check: (t, f) => [...pipelineOnly(t), ...need(f.precheck_ok === true, '预检尚未通过'), ...need(f.review_required === false, '此任务需要审查')],
  },
  {
    from: ['checking'], to: 'queued_merge', trigger: 'precheck_pass',
    check: (t, f) => [...acctestOnly(t, f), ...need(f.precheck_ok === true, '验收测试预检尚未通过')],
  },
  {
    from: ['checking', 'merging'], to: 'done', trigger: 'precheck_fail_handoff',
    check: (t, f) => [
      ...acctestOnly(t, f), ...need((t.status === 'checking' ? f.precheck_ok : f.post_verify_ok) === false, '验收测试验证并未失败'),
      ...need(f.failed_tests_own_directory === true, '失败测试不全在本验收目录'), ...reasonRequired(f),
    ],
    effect: (t) => { t.lease = null; t.worktree = null; },
  },
  {
    from: ['in_review'], to: 'in_progress', trigger: 'review_changes', counter: 'review_rounds',
    check: (t, f) => [...pipelineOnly(t), ...need((f.unresolved_must ?? 0) > 0, '没有未解决的 must'), ...reasonRequired(f)],
  },
  {
    from: ['in_review'], to: 'queued_merge', trigger: 'review_pass',
    check: (t, f) => [...pipelineOnly(t), ...need(f.unresolved_must === 0, '仍有未解决的 must 或缺少审查结论')],
  },
  {
    from: ['in_review'], to: 'blocked', trigger: 'review_exhausted',
    check: (t, f) => [...pipelineOnly(t), ...need((f.unresolved_must ?? 0) > 0, '没有未解决的 must'), ...need((t.review_rounds ?? 0) >= (f.limits.review_max_rounds ?? 2), '审查轮数尚未用完'), ...reasonRequired(f)],
    effect: (t, f) => blocked(t, f, 'review_exhausted'),
  },
  {
    from: ['queued_merge'], to: 'merging', trigger: 'merge_start',
    check: (t, f) => [...mergeOnly(t), ...need(!f.merging_other, `已有任务在合并中：${f.merging_other}`), ...need(f.queue_head === true, '不是队列里第一个合格任务'), ...need(softDone(t, f), '软依赖生产方尚未 done')],
  },
  {
    from: ['merging'], to: 'done', trigger: 'merge_done',
    check: (t, f) => [...mergeOnly(t), ...need(f.rebase_ok, 'rebase 未成功'), ...need(f.post_verify_ok, '合并后验证未通过'), ...need(f.fast_forwarded, '尚未快进到集成分支')],
    effect: (t) => { t.worktree = null; t.lease = null; },
  },
  {
    from: ['merging'], to: 'in_progress', trigger: 'merge_verify_fail', counter: 'merge_failures',
    check: (t, f) => [...pipelineOnly(t), ...need(f.post_verify_ok === false, '合并后验证并未失败'), ...need(!f.foreign_acceptance_failed, '其他任务验收测试失败应等待输入'), ...reasonRequired(f)],
  },
  {
    from: ['merging'], to: 'blocked', trigger: 'merge_blocked',
    check: (t, f) => [
      ...mergeOnly(t), ...reasonRequired(f),
      ...(t.kind === 'acctest' && f.post_verify_ok === false ? [...acctestOnly(t, f), ...need(f.failed_tests_own_directory === false, '本目录内失败应交给原实现任务修复')] : []),
    ],
    effect: (t, f) => blocked(t, f, t.kind === 'acctest' && f.post_verify_ok === false && f.failed_tests_own_directory === false ? 'integration_broken' : 'dispatcher'),
  },
  { from: ['merging'], to: 'queued_merge', trigger: 'merge_requeue', check: (t) => mergeOnly(t) },
  {
    from: ['checking', 'merging'], to: 'awaiting_inputs', trigger: 'foreign_tests_broken',
    check: (t, f) => [...pipelineOnly(t), ...need(f.foreign_acceptance_failed === true, '没有其他任务的验收测试失败'), ...need(!!f.waits_for?.length, '缺少要等待的 .at-n')],
    effect: (t, f) => { clearRun(t); t.waits_for = [...f.waits_for!]; },
  },
  {
    from: ['in_progress'], to: 'disputed', trigger: 'dispute',
    check: (t, f) => [...workerDisputeOnly(t), ...leaseValid(t.lease, f, '争议被拒'), ...reasonRequired(f), ...need(!!f.dispute_test?.trim(), '缺少争议测试标识'), ...need(!!f.dispute_evidence?.trim() && f.dispute_evidence_valid === true, '争议必须引用规格或契约的具体位置')],
    effect: (t, f) => { t.disputes = { ...t.disputes, [f.dispute_test!]: (t.disputes?.[f.dispute_test!] ?? 0) + 1 }; t.impl_run = t.lease!.run_id; t.lease = null; },
  },
  {
    from: ['disputed'], to: 'checking', trigger: 'dispute_fixed',
    check: (t, f) => [...workerDisputeOnly(t), ...need(f.latest_acctest_done, '最新 .at-n 尚未 done'), ...need(f.acctest_changed_tests === true, '.at-n 没有修改测试'), ...need(softDone(t, f), '软依赖生产方尚未 done')],
  },
  {
    from: ['disputed'], to: 'in_progress', trigger: 'dispute_upheld',
    check: (t, f) => [...workerDisputeOnly(t), ...need(f.latest_acctest_done, '最新 .at-n 尚未 done'), ...need(f.acctest_changed_tests === false, '.at-n 没有维持原测试')], effect: clearRun,
  },
  {
    from: ['disputed'], to: 'blocked', trigger: 'dispute_escalated',
    check: (t, f) => [...workerDisputeOnly(t), ...need(f.acctest_escalated === true || (!!f.dispute_test && (t.disputes?.[f.dispute_test] ?? 0) > (f.limits.max_disputes ?? 1)), '该测试争议次数未超过上限，且未交给用户'), ...reasonRequired(f)],
    effect: (t, f) => blocked(t, f, 'dispute'),
  },
  ...(['decide_keep', 'decide_fix'] as const).map((trigger): Rule => ({
    from: ['blocked'], to: trigger === 'decide_keep' ? 'in_progress' : 'disputed', trigger,
    check: (t, f) => [...humanOnly(f), ...workerDisputeOnly(t), ...need(t.blocked_by === 'dispute', '只能裁决因争议而阻塞的任务')], effect: clearRun,
  })),
  {
    from: ['blocked'], to: 'queued_merge', trigger: 'accept',
    check: (t, f) => [...humanOnly(f), ...need(t.blocked_by === 'review_exhausted', '只能人工放行因审查轮数用尽而阻塞的任务')], effect: clearRun,
  },
  ...(['in_progress', 'ready'] as const).map((to): Rule => ({
    from: ['blocked'], to, trigger: 'unblock',
    check: (t, f) => [...humanOnly(f), ...need(started(t) === (to === 'in_progress'), to === 'in_progress' ? '任务尚未开工，应回到 ready' : '任务已开工，应保留工作区回到 in_progress')], effect: unblockEffect,
  })),
  {
    from: ['ready'], to: 'blocked', trigger: 'block',
    check: (_t, f) => [...need(f.actor === 'dispatcher', '只有调度器可以阻塞还没开始的任务'), ...reasonRequired(f)], effect: (t, f) => blocked(t, f, 'dispatcher'),
  },
  {
    from: IN_FLIGHT, to: 'blocked', trigger: 'block', check: (_t, f) => reasonRequired(f),
    effect: (t, f) => blocked(t, f, f.actor === 'human' || f.actor === 'orchestrator' ? 'user' : f.actor.startsWith('run:') ? 'agent' : 'dispatcher'),
  },
  {
    from: ['in_progress'], to: 'done', trigger: 'report',
    check: (t, f) => [
      ...leaseValid(t.lease, f, '提交被拒'), ...need(['acctest', 'review', 'qa'].includes(t.kind), '只有 acctest、review、qa 可以直接提交结论'),
      ...need(t.kind !== 'acctest' || f.impl_done === false, '原 impl 已 done 或状态未知，acctest 应单独合并'),
      ...need(!!f.diff_files && f.diff_files.length === 0, '只读任务不得有改动，且必须提供 diff'),
      ...need(f.handoff_written, '尚未写 handoff，请先调用 forge_note'), ...need(f.structured_report, '缺少结构化结论'),
    ], effect: (t, f) => {
      t.impl_run = t.lease!.run_id; t.lease = null; t.worktree = null;
      if (t.kind === 'acctest') t.changed_tests = f.acctest_changed_tests === true;
    },
  },
  {
    from: ['pending', 'ready', 'blocked'], to: 'cancelled', trigger: 'cancel',
    check: (_t, f) => [...humanOnly(f), ...reasonRequired(f)], effect: clearRun,
  },
  {
    from: ['in_progress'], to: 'in_progress', trigger: 'run_failed', failure: true,
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的 run'), ...reasonRequired(f)],
  },
  {
    from: ['in_progress'], to: 'in_progress', trigger: 'run_interrupted',
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的 run'), ...reasonRequired(f)],
    effect: (t) => { t.lease = null; t.interruptions = (t.interruptions ?? 0) + 1; },
  },
  {
    from: ['in_progress'], to: 'in_progress', trigger: 'run_paused',
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的 run'), ...reasonRequired(f)], effect: clearRun,
  },
  {
    from: ['in_progress'], to: 'in_progress', trigger: 'run_timeout', failure: true,
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的 run'), ...need(!!t.timeout_review, '缺少超时复核信息'), ...reasonRequired(f)],
    effect: (t) => { t.timeouts = (t.timeouts ?? 0) + 1; },
  },
  {
    from: ['in_progress'], to: 'ready', trigger: 'lease_expired', failure: true,
    check: (t, f) => [...need(!!t.lease, '任务没有租约'), ...need(!!t.lease && f.now.getTime() >= Date.parse(t.lease.expires_at), '租约未过期'), ...need(f.worktree_clean, 'worktree 有未提交改动，需要用户决定继续或丢弃')],
    effect: (t) => { t.lease_expirations += 1; t.worktree = null; t.branch = null; t.base_sha = null; },
  },
];

export type PlanResult = { ok: true; task: TaskFile; to: TaskStatus; rule: Rule } | { ok: false; errors: string[] };

/** 返回转移后的副本。计数耗尽会把名义目标改为 blocked，保持现有调用约定。 */
export function planTransition(task: TaskFile, to: TaskStatus, trigger: Trigger, facts: Facts, patch: TaskPatch = {}): PlanResult {
  const rule = TRANSITIONS.find((r) => r.trigger === trigger && r.to === to && r.from.includes(task.status));
  if (!rule) return { ok: false, errors: [`非法转移：${task.status} -> ${to}（触发 ${trigger}）`] };
  const next: TaskFile = structuredClone(task);
  Object.assign(next, structuredClone(patch));
  const errors = rule.check(next, facts);
  if (errors.length) return { ok: false, errors };
  rule.effect?.(next, facts);
  let effective = to;
  if (rule.counter) {
    const counter = rule.counter;
    next[counter] = (next[counter] ?? 0) + 1;
    next.lease = null;
    next.last_failure = facts.reason ?? null;
    const limit = counter === 'precheck_failures' ? facts.limits.max_precheck_failures ?? 3 : counter === 'merge_failures' ? facts.limits.max_merge_failures ?? 2 : facts.limits.review_max_rounds ?? 2;
    if (next[counter]! >= limit) {
      effective = 'blocked';
      blocked(next, { ...facts, reason: `次数达到上限 ${limit}：${facts.reason ?? trigger}` }, counter === 'precheck_failures' ? 'precheck_exhausted' : counter === 'merge_failures' ? 'merge_exhausted' : 'review_exhausted');
    }
  }
  if (rule.failure) {
    next.attempts += 1;
    next.lease = null;
    if (facts.reason) next.last_failure = facts.reason;
    if (facts.reason && trigger !== 'lease_expired') {
      const sig = failureSignature(facts.reason);
      next.same_failures = sig === next.failure_sig ? (next.same_failures ?? 1) + 1 : 1;
      next.failure_sig = sig;
    }
    if (next.attempts >= facts.limits.max_attempts || (trigger === 'lease_expired' && next.lease_expirations >= 2)) {
      effective = 'blocked';
      blocked(next, { ...facts, reason: trigger === 'lease_expired' && next.lease_expirations >= 2 ? '租约过期两次' : `失败次数达到上限 ${facts.limits.max_attempts}：${next.last_failure ?? trigger}` }, 'attempts');
    }
  }
  if (trigger === 'run_interrupted' && (next.interruptions ?? 0) >= MAX_INTERRUPTIONS) {
    effective = 'blocked'; blocked(next, { ...facts, reason: `会话已连续中断 ${next.interruptions} 次：${facts.reason ?? ''}` }, 'dispatcher');
  }
  if (trigger === 'run_timeout' && (next.timeouts ?? 0) > (facts.limits.max_continuations ?? DEFAULT_MAX_CONTINUATIONS)) {
    effective = 'blocked'; blocked(next, { ...facts, reason: `运行已超时 ${next.timeouts} 次：${facts.reason ?? ''}` }, 'attempts');
  }
  if (task.status === 'blocked' && effective !== 'blocked') { next.blocked_by = null; next.blocked_reason = null; }
  next.status = effective;
  return { ok: true, task: next, to: effective, rule };
}

// —— 阶段状态机 ——
export type StageTrigger = 'submit_gate' | 'gate_failed' | 'gate_passed' | 'gate_exhausted' | 'gate_rerun' | 'accept' | 'approve' | 'reject' | 'abort';
interface StageRule {
  from: readonly StageStatus[]; to: StageStatus; trigger: StageTrigger;
  humanOnly?: boolean; check?: (f: StageFacts) => string[];
}
export interface StageFacts { actor: string; /** 该阶段是否需要人工签收 */ needs_human?: boolean; reason?: string }
export const STAGE_TRANSITIONS: readonly StageRule[] = [
  { from: ['active'], to: 'awaiting_gate', trigger: 'submit_gate' },
  { from: ['awaiting_gate'], to: 'active', trigger: 'gate_failed', check: reasonRequired },
  { from: ['awaiting_gate'], to: 'awaiting_human', trigger: 'gate_passed', check: (f) => need(f.needs_human === true, '该阶段不需要人工批准') },
  { from: ['awaiting_gate'], to: 'done', trigger: 'gate_passed', check: (f) => need(f.needs_human === false, '该阶段需要人工批准') },
  { from: ['awaiting_gate'], to: 'needs_human', trigger: 'gate_exhausted', check: reasonRequired },
  { from: ['needs_human'], to: 'awaiting_human', trigger: 'accept', humanOnly: true },
  { from: ['needs_human'], to: 'awaiting_gate', trigger: 'gate_rerun', humanOnly: true },
  { from: ['awaiting_human'], to: 'done', trigger: 'approve', humanOnly: true },
  { from: ['awaiting_human', 'needs_human'], to: 'active', trigger: 'reject', humanOnly: true, check: reasonRequired },
  { from: ['active', 'awaiting_gate', 'awaiting_human', 'needs_human'], to: 'aborted', trigger: 'abort', humanOnly: true },
];
export function planStageTransition(from: StageStatus, to: StageStatus, trigger: StageTrigger, facts: StageFacts): string[] {
  const rule = STAGE_TRANSITIONS.find((r) => r.trigger === trigger && r.to === to && r.from.includes(from));
  if (!rule) return [`非法的阶段转移：${from} -> ${to}（触发 ${trigger}）`];
  if (rule.humanOnly && facts.actor !== 'human') return ['阶段操作只能由用户执行，agent 无权审批'];
  return rule.check?.(facts) ?? [];
}
