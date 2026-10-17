// 纯函数：只根据程序推导的 facts 判断，不做 IO，也不修改入参。
import { createHash } from 'node:crypto';
import type { Lease, StageStatus, TaskFile, TaskStatus } from './schemas.ts';
import { isProtectedFor, matchesAny, openWriteAllowed, opensWrites } from './paths.ts';
import { failureSignature } from './failure-signature.ts';

export type Trigger =
  | 'schedule' | 'dispatch' | 'submit'
  | 'review_changes' | 'review_pass' | 'review_exhausted'
  | 'merge_start' | 'merge_done' | 'merge_verify_fail' | 'merge_conflict' | 'merge_blocked' | 'merge_requeue'
  | 'accept' | 'block' | 'unblock' | 'lease_expired'
  | 'run_failed' | 'run_interrupted' | 'run_paused' | 'run_timeout' | 'report' | 'cancel' | 'hand_to_user'
  | 'ask' | 'answered';

export const MAX_INTERRUPTIONS = 5;
/** 同一个任务主会话最多决定几次（放行、重试、取消）；之后再阻塞直接交给用户，避免主会话与子进程来回打转 */
export const MAX_ORCHESTRATOR_DECISIONS = 2;
export const DEFAULT_MAX_CONTINUATIONS = 2;

export interface Facts {
  now: Date;
  limits: {
    max_attempts: number; max_parallel: number; max_continuations?: number;
    max_parallel_aux?: number; max_parallel_backend?: number; max_merge_failures?: number;
    review_max_rounds?: number;
  };
  /** 发起者：human、orchestrator、engine、dispatcher、run:<id> 等 */
  actor: string;
  /** 任务所在阶段是否 active */
  stage_active?: boolean;
  /** 依赖任务的真实状态，只认 done */
  status_of?: ReadonlyMap<string, string>;
  /** 与本任务同一个池（poolOf）里正在运行的任务数 */
  running_count?: number;
  /** 是否已有其他任务占用合并名额 */
  merging_other?: string | null;
  /** 是否是队列里第一个合格任务，保留原字段名供运行时集成 */
  queue_head?: boolean;
  /** 合并冲突的文件 */
  conflict_files?: string[];
  /** 提交时推导的审查要求（review-flow.decideReview） */
  review_required?: boolean;
  /** 最近一轮审查尚未解决的 must 数量 */
  unresolved_must?: number;
  /** 只读辅助任务是否已提交通过形状校验的结构化结论 */
  structured_report?: boolean;
  /** 程序验证为只改已有测试的文件；验收目录仍不能放行 */
  test_adjustments?: string[];
  /** 合并时任务分支相对集成分支没有改动（多半已被别的任务做了）：阻塞原因记为 no_changes，确认后可以直接视为完成 */
  no_changes?: boolean;
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
  counter?: 'review_rounds' | 'merge_failures';
}
/** 辅助池（review、qa、架构师咨询）的任务种类；并发上限用 limits.max_parallel_aux，与实施池分开计数（咨询另由 consult.ts 保证串行） */
export const isAuxKind = (kind: string): boolean => kind === 'review' || kind === 'qa' || kind === 'consult';
/**
 * 调度池：backend（max_parallel_backend）、frontend（固定 1 个，前端按页面顺序做）、aux（审查、验收与咨询，max_parallel_aux），
 * 其余（架构阶段的 architect、轻流程的 worker）用 max_parallel。fix、merge-fix 跟着角色进对应的池。
 */
export type Pool = 'impl' | 'backend' | 'frontend' | 'aux';
export const poolOf = (t: Pick<TaskFile, 'kind' | 'role'>): Pool =>
  isAuxKind(t.kind) ? 'aux' : t.role === 'backend' ? 'backend' : t.role === 'frontend' ? 'frontend' : 'impl';
export type PoolLimits = Pick<Facts['limits'], 'max_parallel' | 'max_parallel_aux' | 'max_parallel_backend'>;
export function poolLimit(pool: Pool, l: PoolLimits): number {
  switch (pool) {
    case 'aux': return l.max_parallel_aux ?? l.max_parallel;
    case 'backend': return l.max_parallel_backend ?? l.max_parallel;
    case 'frontend': return 1;
    case 'impl': return l.max_parallel;
  }
}
/** 流程的并发上限：docs/plan.md 写了 max_parallel_backend 时覆盖 workflow.yaml */
export const flowLimits = <L extends PoolLimits>(l: L, flow: { max_parallel_backend?: number | undefined }): L =>
  flow.max_parallel_backend ? { ...l, max_parallel_backend: flow.max_parallel_backend } : l;
export const IN_FLIGHT: readonly TaskStatus[] = ['in_progress', 'in_review', 'queued_merge', 'merging'];
export const isSettled = (t: { status: TaskStatus }) => t.status === 'done' || t.status === 'cancelled';
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const need = (cond: boolean | undefined, msg: string): string[] => cond ? [] : [msg];
const reasonRequired = (f: { reason?: string }) => need(!!f.reason?.trim(), '必须写明原因');
const humanOnly = (f: Facts) => need(f.actor === 'human', '只有用户可以执行此操作');
/** 阻塞交给主会话决定时，主会话也可以执行（用户始终可以） */
const humanOrDelegate = (t: TaskFile, f: Facts) =>
  need(f.actor === 'human' || (f.actor === 'orchestrator' && t.blocked_owner === 'orchestrator'), '只有用户（或被交付决定的主会话）可以执行此操作');
/** 主会话做的决定计数 */
const countDecision = (t: TaskFile, f: Facts) => { if (f.actor === 'orchestrator') t.decisions = (t.decisions ?? 0) + 1; };
/** 小改动（change）流程结束前由程序建的"更新架构图与契约"任务：X1 阶段的 doc 任务（轻流程只有它是 doc） */
export const isDocsUpdateTask = (t: Pick<TaskFile, 'kind' | 'stage'>) => t.kind === 'doc' && t.stage === 'X1';
const workerKind = (t: TaskFile) => ['impl', 'fix', 'doc', 'merge-fix', 'consult'].includes(t.kind);
/** 没有改动也可以提交、直接视为完成的任务（要做的已在集成分支上，或文档无需更新，或咨询只需回答）；merge-fix 没有改动说明冲突没解决 */
export const canFinishWithoutChanges = (t: Pick<TaskFile, 'kind'>) => ['impl', 'fix', 'doc', 'consult'].includes(t.kind);
const pipelineOnly = (t: TaskFile) => need(workerKind(t), '只有实现、修复、文档、合并修复或咨询任务可以走此流水线');
const mergeOnly = pipelineOnly;
const started = (t: TaskFile) => !!(t.worktree || t.branch);

function leaseValid(lease: Lease | null, f: Facts, what: string): string[] {
  if (!lease) return [`${what}：任务没有有效租约`];
  if (!f.token) return [`${what}：缺少 run token，请确认在 pi-forge 派发的子进程中调用`];
  if (hashToken(f.token) !== lease.token_hash) return [`${what}：run token 无效`];
  if (!Number.isFinite(Date.parse(lease.expires_at)) || f.now.getTime() >= Date.parse(lease.expires_at)) return [`${what}：租约已过期，请联系用户执行 /forge-resume`];
  return [];
}

function submitErrors(t: TaskFile, f: Facts): string[] {
  const errors = leaseValid(t.lease, f, '提交被拒');
  const diff = f.diff_files;
  if (!diff) errors.push('缺少 worktree diff');
  else if (!diff.length) errors.push('worktree 没有改动，无可提交内容');
  else {
    // S0 的 architect 写 rules/：task 的 writes 显式包含 rules/** 时放行；backend、frontend 另有架构师负责的路径
    const protectedFiles = diff.filter((p) => isProtectedFor(p, t.writes, t.role));
    if (protectedFiles.length) errors.push(`diff 含受保护路径：${protectedFiles.join('、')}`);
    const allowed = [...t.writes, ...(t.shared ?? [])];
    const adjusted = new Set(f.test_adjustments ?? []);
    // impl / fix 不受 writes 限制（只有 PRD、原型与受保护路径除外）
    const inAllowed = (p: string) => opensWrites(t) ? openWriteAllowed(p) : matchesAny(p, allowed);
    const outside = diff.filter((p) => !inAllowed(p) && !adjusted.has(p));
    if (outside.length) errors.push(`diff 越出任务 writes：${outside.join('、')}`);
  }
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
  // 程序或子进程造成的阻塞先交给主会话决定；主会话自己交出来的、或主会话已决定过多次的，直接等用户
  if (f.actor !== 'human' && f.actor !== 'orchestrator' && (t.decisions ?? 0) < MAX_ORCHESTRATOR_DECISIONS) t.blocked_owner = 'orchestrator';
  else delete t.blocked_owner;
}
function clearRun(t: TaskFile): void { t.lease = null; }
function unblockEffect(t: TaskFile, f: Facts): void {
  if (f.reset) {
    switch (t.blocked_by) {
      case 'attempts':
        t.attempts = f.attempts ?? 0;
        t.lease_expirations = 0;
        delete t.timeouts;
        break;
      case 'review_exhausted': t.review_rounds = 0; break;
      case 'merge_exhausted': t.merge_failures = 0; break;
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
      const limit = poolLimit(poolOf(t), f.limits);
      return [
        ...need((f.running_count ?? Infinity) < limit, `并发已达上限 ${limit}`),
        ...need(!!t.worktree && !!t.branch, '尚未建立 worktree 与任务分支'),
        ...need(!!t.base_sha, '尚未记录 base_sha'), ...need(!!t.lease, '尚未颁发 token 与租约'),
        ...need(!!t.lease && Date.parse(t.lease.expires_at) > f.now.getTime(), '颁发的租约已过期'),
      ];
    },
  },
  // 提交：程序已把集成分支同步进任务分支（forge_submit 里做，有冲突时不提交、交回原 agent），需要审查的进 in_review，不需要的直接排队合并
  {
    from: ['in_progress'], to: 'in_review', trigger: 'submit',
    check: (t, f) => [...pipelineOnly(t), ...submitErrors(t, f), ...need(f.review_required === true, '此任务不需要审查')], effect: submitted,
  },
  {
    from: ['in_progress'], to: 'queued_merge', trigger: 'submit',
    check: (t, f) => [...pipelineOnly(t), ...submitErrors(t, f), ...need(f.review_required === false, '此任务需要审查')], effect: submitted,
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
    check: (t, f) => [...mergeOnly(t), ...need(!f.merging_other, `已有任务在合并中：${f.merging_other}`), ...need(f.queue_head === true, '不是队列里第一个合格任务')],
  },
  {
    from: ['merging'], to: 'done', trigger: 'merge_done',
    check: (t, f) => [...mergeOnly(t), ...need(f.rebase_ok, 'rebase 未成功'), ...need(f.post_verify_ok, '合并后验证未通过'), ...need(f.fast_forwarded, '尚未快进到集成分支')],
    effect: (t) => { t.worktree = null; t.lease = null; },
  },
  {
    from: ['merging'], to: 'in_progress', trigger: 'merge_verify_fail', counter: 'merge_failures',
    check: (t, f) => [...pipelineOnly(t), ...need(f.post_verify_ok === false, '合并后验证并未失败'), ...reasonRequired(f)],
  },
  {
    // 合并时的文本冲突交回原任务的 worker；与 merge_verify_fail 共用 merge_failures（同属"合并把任务退回"，共用上限防止反复来回）
    from: ['merging'], to: 'in_progress', trigger: 'merge_conflict', counter: 'merge_failures',
    check: (t, f) => [...pipelineOnly(t), ...need(opensWrites(t), '只有 impl / fix 的合并冲突交回 worker'), ...need(!!f.conflict_files?.length, '没有冲突文件'), ...reasonRequired(f)],
  },
  {
    from: ['merging'], to: 'blocked', trigger: 'merge_blocked',
    check: (t, f) => [...mergeOnly(t), ...reasonRequired(f)],
    effect: (t, f) => blocked(t, f, f.no_changes ? 'no_changes' : 'dispatcher'),
  },
  { from: ['merging'], to: 'queued_merge', trigger: 'merge_requeue', check: (t) => mergeOnly(t) },
  {
    from: ['blocked'], to: 'queued_merge', trigger: 'accept',
    check: (t, f) => [...humanOrDelegate(t, f), ...need(t.blocked_by === 'review_exhausted', '只能放行因审查轮数用尽而阻塞的任务')],
    effect: (t, f) => { countDecision(t, f); clearRun(t); },
  },
  ...(['in_progress', 'ready'] as const).map((to): Rule => ({
    from: ['blocked'], to, trigger: 'unblock',
    check: (t, f) => [...humanOrDelegate(t, f), ...need(started(t) === (to === 'in_progress'), to === 'in_progress' ? '任务尚未开工，应回到 ready' : '任务已开工，应保留工作区回到 in_progress')],
    effect: (t, f) => { countDecision(t, f); unblockEffect(t, f); },
  })),
  {
    // 合并时没有改动：要做的已经在集成分支上（多半被别的任务做了），确认后视为完成，依赖它的任务照常推进
    from: ['blocked'], to: 'done', trigger: 'accept',
    check: (t, f) => [...humanOrDelegate(t, f), ...need(t.blocked_by === 'no_changes', '只有合并时没有改动的任务可以直接视为完成'), ...reasonRequired(f)],
    effect: (t, f) => { countDecision(t, f); t.worktree = null; t.lease = null; },
  },
  {
    // 主会话看过后交给用户：仍是 blocked，之后只有用户能处理
    from: ['blocked'], to: 'blocked', trigger: 'hand_to_user',
    check: (t, f) => [...need(f.actor === 'orchestrator' && t.blocked_owner === 'orchestrator', '只有被交付决定的主会话可以转交用户'), ...reasonRequired(f)],
    effect: (t, f) => { delete t.blocked_owner; t.blocked_reason = `${t.blocked_reason ?? ''}\n主会话：${f.reason}`.trim(); },
  },
  {
    from: ['ready'], to: 'blocked', trigger: 'block',
    check: (_t, f) => [...need(f.actor === 'dispatcher', '只有调度器可以阻塞还没开始的任务'), ...reasonRequired(f)], effect: (t, f) => blocked(t, f, 'dispatcher'),
  },
  {
    from: IN_FLIGHT, to: 'blocked', trigger: 'block', check: (_t, f) => reasonRequired(f),
    effect: (t, f) => blocked(t, f, f.actor === 'human' || f.actor === 'orchestrator' ? 'user' : f.actor.startsWith('run:') ? 'agent' : 'dispatcher'),
  },
  {
    // forge_ask_architect：子进程提问后结束本次运行，任务等架构师回答；不交给主会话决定
    from: ['in_progress'], to: 'blocked', trigger: 'ask',
    check: (t, f) => [...leaseValid(t.lease, f, '提问被拒'), ...reasonRequired(f)],
    effect: (t, f) => { blocked(t, f, 'architect'); delete t.blocked_owner; },
  },
  {
    // 咨询任务完成：程序把回答写进 handoff、同步集成分支后让提问的任务接着原会话继续
    from: ['blocked'], to: 'in_progress', trigger: 'answered',
    check: (t, f) => [...need(f.actor === 'engine', '只有程序可以在架构师回答后恢复任务'), ...need(t.blocked_by === 'architect', '任务不是在等架构师')],
    effect: (t) => { t.lease = null; },
  },
  {
    from: ['in_progress'], to: 'done', trigger: 'report',
    check: (t, f) => [
      ...leaseValid(t.lease, f, '提交被拒'), ...need(['review', 'qa'].includes(t.kind) || canFinishWithoutChanges(t), '只有 review、qa 与没有改动的实现、修复、文档、咨询任务可以直接完成'),
      ...need(!!f.diff_files && f.diff_files.length === 0, '直接完成的任务不得有改动，且必须提供 diff'),
      ...need(f.structured_report, '缺少结构化结论'),
    ], effect: (t) => {
      t.impl_run = t.lease!.run_id; t.lease = null; t.worktree = null;
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
    const limit = counter === 'merge_failures' ? facts.limits.max_merge_failures ?? 2 : facts.limits.review_max_rounds ?? 2;
    if (next[counter]! >= limit) {
      effective = 'blocked';
      blocked(next, { ...facts, reason: `次数达到上限 ${limit}：${facts.reason ?? trigger}` }, counter === 'merge_failures' ? 'merge_exhausted' : 'review_exhausted');
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
  if (task.status === 'blocked' && effective !== 'blocked') { next.blocked_by = null; next.blocked_reason = null; delete next.blocked_owner; }
  next.status = effective;
  return { ok: true, task: next, to: effective, rule };
}

// —— 阶段状态机 ——
export type StageTrigger = 'submit_gate' | 'gate_failed' | 'gate_passed' | 'gate_exhausted' | 'gate_rerun' | 'accept' | 'approve' | 'reject' | 'abort';
interface StageRule {
  from: readonly StageStatus[]; to: StageStatus; trigger: StageTrigger;
  humanOnly?: boolean; check?: (f: StageFacts) => string[];
  /** 交给主会话决定时，主会话也可以执行 */
  delegable?: boolean;
}
export interface StageFacts {
  actor: string; /** 该阶段是否需要人工签收 */ needs_human?: boolean; reason?: string;
  /** needs_human 交给主会话决定（程序按事件推导，见 engine/decisions.ts） */
  delegated?: boolean;
}
export const STAGE_TRANSITIONS: readonly StageRule[] = [
  // 等签收时也能重交：P0 规格提交后主会话还想修 spec-lint 的警告，原来只能请用户打回（stock run-02）
  { from: ['active', 'awaiting_human'], to: 'awaiting_gate', trigger: 'submit_gate' },
  { from: ['awaiting_gate'], to: 'active', trigger: 'gate_failed', check: reasonRequired },
  { from: ['awaiting_gate'], to: 'awaiting_human', trigger: 'gate_passed', check: (f) => need(f.needs_human === true, '该阶段不需要人工批准') },
  { from: ['awaiting_gate'], to: 'done', trigger: 'gate_passed', check: (f) => need(f.needs_human === false, '该阶段需要人工批准') },
  { from: ['awaiting_gate'], to: 'needs_human', trigger: 'gate_exhausted', check: reasonRequired },
  { from: ['needs_human'], to: 'awaiting_human', trigger: 'accept', humanOnly: true, delegable: true },
  { from: ['needs_human'], to: 'awaiting_gate', trigger: 'gate_rerun', humanOnly: true },
  { from: ['awaiting_human'], to: 'done', trigger: 'approve', humanOnly: true },
  { from: ['awaiting_human', 'needs_human'], to: 'active', trigger: 'reject', humanOnly: true, check: reasonRequired },
  { from: ['active', 'awaiting_gate', 'awaiting_human', 'needs_human'], to: 'aborted', trigger: 'abort', humanOnly: true },
];
export function planStageTransition(from: StageStatus, to: StageStatus, trigger: StageTrigger, facts: StageFacts): string[] {
  const rule = STAGE_TRANSITIONS.find((r) => r.trigger === trigger && r.to === to && r.from.includes(from));
  if (!rule) return [`非法的阶段转移：${from} -> ${to}（触发 ${trigger}）`];
  const delegate = rule.delegable && facts.actor === 'orchestrator' && facts.delegated === true;
  if (rule.humanOnly && facts.actor !== 'human' && !delegate) return ['阶段操作只能由用户执行，agent 无权审批'];
  return rule.check?.(facts) ?? [];
}
