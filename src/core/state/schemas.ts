// 来源：pi-flow src/core/schemas.ts @ 31f3f15
// .forge/ 下所有持久化结构的唯一定义（schema-first）。
// 类型由 schema 派生；schemas/*.json 由 scripts/gen-schemas.ts 从这里生成。
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const IsoTime = Type.String({ minLength: 1 });
const FlowId = Type.String({ pattern: '^[BFX]-[0-9]{3,}$' });
/** T-003、T-003.at-2、T-003.rv、T-003.fx-1；阶段级的审查与验收挂在阶段上：S1.rv、S1.rv-2、S1.qa、S1.qa-2（第 7.6、11 节） */
const TaskId = Type.String({ pattern: '^(T-\\d{3,}(\\.(at|rv|fx)(-\\d+)?)?|[A-Za-z][A-Za-z0-9_]*\\.(rv|qa)(-\\d+)?)$' });

export const TASK_STATUSES = [
  'pending', 'ready', 'in_progress', 'awaiting_inputs', 'checking', 'in_review', 'disputed',
  'queued_merge', 'merging', 'done', 'blocked', 'cancelled',
] as const;
export const TaskStatus = Type.Enum(TASK_STATUSES);
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 实现、文档、验收测试、审查、阶段验收、修复与合并冲突修复 */
export const TASK_KINDS = ['impl', 'doc', 'acctest', 'review', 'qa', 'fix', 'merge-fix'] as const;
export const TaskKind = Type.Enum(TASK_KINDS);
export type TaskKind = (typeof TASK_KINDS)[number];

/** 任务大小（规划时标注）：决定每次运行的时间预算，S 减半、L 加倍，默认 M */
export const TASK_SIZES = ['S', 'M', 'L'] as const;
export const TaskSize = Type.Enum(TASK_SIZES);
export type TaskSize = (typeof TASK_SIZES)[number];

/** 要用户自己打开应用查看的检查项：agent 不启动桌面应用与浏览器，程序不派人验证，模块验收通过后列给用户 */
const ManualChecks = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 });

/** 运行超时、等主会话复核：主会话决定接着原会话做（continue）、换个思路从头做（restart），或交给用户（转 blocked） */
export const TimeoutReview = Type.Object({
  run: Type.String({ minLength: 1 }),
  at: IsoTime,
  minutes: Type.Integer({ minimum: 1 }),
  /** 子进程最后一段回复（截断） */
  last_text: Type.Optional(Type.String()),
  decision: Type.Optional(Type.Union([Type.Literal('continue'), Type.Literal('restart')])),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false });
export type TimeoutReview = Static<typeof TimeoutReview>;

export const STAGE_STATUSES = ['active', 'awaiting_gate', 'needs_human', 'awaiting_human', 'done', 'aborted'] as const;
export const StageStatus = Type.Enum(STAGE_STATUSES);
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const EVENT_TYPES = [
  'transition', 'violation', 'note', 'dispatch', 'lease_expired', 'approval',
  'gate_result', 'merge', 'merge_conflict', 'integrity_error', 'stages_planned', 'stages_revised', 'stage_reopened',
] as const;
export const EventType = Type.Enum(EVENT_TYPES);
export type EventType = (typeof EVENT_TYPES)[number];

export const StateFile = Type.Object({
  schema_version: Type.Integer({ minimum: 1 }),
  version: Type.Integer({ minimum: 0 }),
  active_flow: Nullable(FlowId),
  events_head: Type.String(),
}, { additionalProperties: false });
export type StateFile = Static<typeof StateFile>;

export const Approval = Type.Object({ by: Type.Literal('human'), at: IsoTime, note: Type.Optional(Type.String()) },
  { additionalProperties: false });

const PlanMode = Type.Enum(['standard', 'lean']);
const TaskReview = Type.Enum(['skip', 'auto', 'strong']);
const TaskRisk = Type.Enum(['low', 'normal', 'high']);
const PlanStage = Type.Object({
  id: Type.String({ minLength: 1 }),
  goal: Type.String({ minLength: 1 }),
  exit: Type.Array(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
const StringList = Type.Array(Type.String({ minLength: 1 }));
const BlockedBy = Type.Enum([
  'dispute', 'review_exhausted', 'precheck_exhausted', 'merge_exhausted', 'attempts',
  'agent', 'dispatcher', 'user', 'integration_broken',
]);

export const FlowFile = Type.Object({
  id: FlowId,
  mode: Type.Union([Type.Literal('build'), Type.Literal('feature'), Type.Literal('fix')]),
  title: Type.String(),
  stages: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  stage: Type.String({ minLength: 1 }),
  stage_status: StageStatus,
  integration_branch: Type.String({ minLength: 1 }),
  base_sha: Nullable(Type.String()),
  approvals: Type.Record(Type.String(), Approval),
  created_at: IsoTime,
  /** 本流程的预算（/forge budget 设置，覆盖 workflow.yaml 的 budget） */
  budget: Type.Optional(Type.Object({
    tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    cost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    minutes: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false })),
  /** 最近一次把主分支同步进集成分支（阶段边界或 /forge sync）：ok 已同步；fixing 由 merge-fix 任务解决冲突；conflict 需要用户处理 */
  sync: Type.Optional(Type.Object({
    stage: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal('ok'), Type.Literal('fixing'), Type.Literal('conflict')]),
    main_sha: Type.String({ minLength: 1 }),
    at: IsoTime,
    task: Type.Optional(TaskId),
    files: Type.Optional(Type.Array(Type.String())),
    reason: Type.Optional(Type.String()),
  }, { additionalProperties: false })),
  /** 实施阶段闸门的全量测试失败后自动生成的修复（第五轮，最多两轮） */
  gate_rounds: Type.Optional(Type.Array(Type.Object({
    stage: Type.String({ minLength: 1 }), command: Type.String(), tasks: Type.Array(TaskId), at: IsoTime,
  }, { additionalProperties: false }))),
  /** P1 批准时由程序写入的有序实施阶段 */
  s_stages: Type.Optional(Type.Array(PlanStage)),
  plan_mode: Type.Optional(PlanMode),
  /** P1 批准时集成分支的提交：此后契约只能追加（M5 判定） */
  contracts_base: Type.Optional(Type.String({ minLength: 1 })),
  /** P1 被打回或闸门未通过：引擎据此新建 architect task，原因写进它的 handoff */
  plan_rework: Type.Optional(Type.Object({ reason: Type.String({ minLength: 1 }), at: IsoTime }, { additionalProperties: false })),
  /** PRD 与可选原型原件的位置及恢复会话所需的文件清单 */
  intake: Type.Optional(Type.Object({
    /** 需求文档在集成分支上的位置；只给了原型时没有 */
    prd: Type.Optional(Type.String({ minLength: 1 })),
    prototype_path: Type.Optional(Type.String({ minLength: 1 })),
    files: Type.Array(Type.Object({ path: Type.String({ minLength: 1 }), size: Type.Integer({ minimum: 0 }), type: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  }, { additionalProperties: false })),
  /** 最近一次规格提交或检查结果；打回保留检查记录并标为未提交 */
  spec: Type.Optional(Type.Object({
    submitted: Type.Boolean(),
    errors: Type.Array(Type.String()),
    warnings: Type.Array(Type.String()),
    feedback: Type.Optional(Type.String()),
    sha: Type.Optional(Type.String()),
    /** feature 流程：权限矩阵的新增与修改行（批准页单独列出） */
    permission_changes: Type.Optional(Type.Array(Type.String())),
  }, { additionalProperties: false })),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type FlowFile = Static<typeof FlowFile>;

export const Dependency = Type.Object({
  task: TaskId,
  type: Type.Union([Type.Literal('hard'), Type.Literal('soft')]),
  reason: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type Dependency = Static<typeof Dependency>;

export const Lease = Type.Object({
  run_id: Type.String({ minLength: 1 }),
  role: Type.String({ minLength: 1 }),
  token_hash: Type.String({ minLength: 64, maxLength: 64 }),
  acquired_at: IsoTime,
  expires_at: IsoTime,
}, { additionalProperties: false });
export type Lease = Static<typeof Lease>;

export const TaskFile = Type.Object({
  id: TaskId,
  stage: Type.String({ minLength: 1 }),
  kind: TaskKind,
  title: Type.String({ minLength: 1 }),
  role: Type.String({ minLength: 1 }),
  scopes: Type.Array(Type.String()),
  depends_on: Type.Array(Dependency),
  inputs: Type.Array(Type.String()),
  writes: Type.Array(Type.String()),
  module: Type.Optional(Type.String({ minLength: 1 })),
  ac: Type.Optional(StringList),
  layers: Type.Optional(StringList),
  produces: Type.Optional(StringList),
  requires: Type.Optional(StringList),
  test_interface: Type.Optional(StringList),
  review: Type.Optional(TaskReview),
  risk: Type.Optional(TaskRisk),
  /** 派生任务所属的原任务 */
  for_task: Type.Optional(TaskId),
  /** 阶段审查或 stage-qa 的哪一轮生成了这个 fix（task 是该轮的 .rv-n / .qa-n）；标题只负责展示，认轮次看这个字段 */
  source_round: Type.Optional(Type.Object({ task: TaskId, round: Type.Integer({ minimum: 1 }) })),
  /** 验收测试的返工轮次（.at-n，第 9.3–9.5 节）：争议、被别的 task 的契约追加破坏、用户裁决改测试 */
  acctest_round: Type.Optional(Type.Object({
    kind: Type.Enum(['dispute', 'foreign', 'decide', 'coverage', 'change', 'legacy']),
    /** 争议的测试标识 */
    test: Type.Optional(Type.String()),
    /** 引发这一轮的 task（争议的 worker 或破坏测试的 task） */
    from_task: Type.Optional(TaskId),
  })),
  /** acctest 提交时是否改动了测试（争议裁决：改了 → dispute_fixed，没改 → dispute_upheld） */
  changed_tests: Type.Optional(Type.Boolean()),
  /** 在等别的 task 的 .at-n 修好被破坏的验收测试（第 9.4 节），这些 task done 后才能继续预检 */
  waits_for: Type.Optional(Type.Array(TaskId)),
  /** worker 提交的偏离说明，供审查与签收使用 */
  deviations: Type.Optional(StringList),
  verify: Type.Array(Type.String()),
  status: TaskStatus,
  attempts: Type.Integer({ minimum: 0 }),
  precheck_failures: Type.Optional(Type.Integer({ minimum: 0 })),
  review_rounds: Type.Optional(Type.Integer({ minimum: 0 })),
  merge_failures: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 每个测试分别累计的争议次数 */
  disputes: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
  blocked_by: Type.Optional(Nullable(BlockedBy)),
  violations: Type.Integer({ minimum: 0 }),
  lease_expirations: Type.Integer({ minimum: 0 }),
  /** 会话中断（pi 崩溃、被强杀、用户关闭）导致 run 丢失的次数；不计入 attempts */
  interruptions: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 连续以同样的原因失败的次数（失败原因归一化后的签名相同，第六轮 B3）：达到 2 时立刻升级模型，没有可升级的就交给用户 */
  same_failures: Type.Optional(Type.Integer({ minimum: 0 })),
  failure_sig: Type.Optional(Type.String()),
  /** 运行超过时间预算被结束的次数；同时计入 attempts，超过 limits.max_continuations 转 blocked */
  timeouts: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 超时后等主会话复核（有 decision 后由程序按决定重新派发） */
  timeout_review: Type.Optional(TimeoutReview),
  /** 上一次超时时的进展（第六轮 C1：程序比较两次超时之间有没有进展来决定接着做、从头做或交给用户） */
  timeout_progress: Type.Optional(Type.Object({
    commits: Type.Integer({ minimum: 0 }), lines: Type.Integer({ minimum: 0 }),
    decision: Type.Union([Type.Literal('continue'), Type.Literal('restart')]),
  }, { additionalProperties: false })),
  /** 运行中追加的可写范围（第六轮 D3）：不与其他未完成任务重叠的由程序批准，重叠的由主会话决定；路径已并入 writes */
  scope_grants: Type.Optional(Type.Array(Type.Object({
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    reason: Type.String(),
    by: Type.Union([Type.Literal('program'), Type.Literal('orchestrator'), Type.Literal('human')]),
    at: IsoTime,
    run: Type.Optional(Type.String()),
  }, { additionalProperties: false }))),
  /** 等主会话决定的范围申请（与其他未完成任务的范围重叠） */
  scope_request: Type.Optional(Type.Object({
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    reason: Type.String(),
    conflicts: Type.Array(Type.String()),
    run: Type.String(),
    at: IsoTime,
  }, { additionalProperties: false })),
  size: Type.Optional(TaskSize),
  manual_checks: Type.Optional(ManualChecks),
  lease: Nullable(Lease),
  impl_run: Nullable(Type.String()),
  branch: Nullable(Type.String()),
  worktree: Nullable(Type.String()),
  base_sha: Nullable(Type.String()),
  blocked_reason: Nullable(Type.String()),
  last_failure: Nullable(Type.String()),
  // merge-fix 专用：被挂起的原任务与冲突文件
  merge_fix_for: Type.Optional(TaskId),
  conflict_files: Type.Optional(Type.Array(Type.String())),
  /** 同步主分支的冲突修复任务：合并的主分支提交（worktree 是含冲突标记的合并提交） */
  sync_main: Type.Optional(Type.String({ minLength: 1 })),
  /** 修复任务接着写过这些代码的任务的对话继续（第四轮后续）：同角色、同模型、会话不太大时 fork 它最后一次提交的会话 */
  fork_from_task: Type.Optional(TaskId),
  /** 最近一次提交修改过的、writes 之外的已有测试文件（第四轮后续，testing.adjust_tests） */
  test_adjustments: Type.Optional(Type.Array(Type.String())),
  /** 模块登记的公共文件（第五轮：路由注册、菜单、迁移目录、文案等）：可以写，但不算进互斥，并行模块都可能改 */
  shared: Type.Optional(Type.Array(Type.String())),
  created_by: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type TaskFile = Static<typeof TaskFile>;

export const FlowEvent = Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  ts: IsoTime,
  flow: Nullable(Type.String()),
  actor: Type.String({ minLength: 1 }),
  type: EventType,
  task: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  trigger: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // 本事件所在事务写入的文件（相对 .forge/）及其内容哈希，用于完整性校验
  entities: Type.Optional(Type.Record(Type.String(), Type.String())),
  // 本事件所在事务修改了 state.active_flow 时记录新值，用于校验 state.json
  active_flow: Type.Optional(Nullable(FlowId)),
  prev_hash: Type.String({ minLength: 64, maxLength: 64 }),
  hash: Type.String({ minLength: 64, maxLength: 64 }),
}, { additionalProperties: false });
export type FlowEvent = Static<typeof FlowEvent>;

export const Tokens = Type.Object({
  input: Nullable(Type.Integer({ minimum: 0 })),
  output: Nullable(Type.Integer({ minimum: 0 })),
  cache_read: Nullable(Type.Integer({ minimum: 0 })),
  cache_write: Nullable(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export const RunFile = Type.Object({
  run_id: Type.String({ minLength: 1 }),
  flow: Nullable(Type.String()),
  task: Nullable(Type.String()),
  role: Type.String({ minLength: 1 }),
  model: Nullable(Type.String()),
  started_at: IsoTime,
  ended_at: Nullable(IsoTime),
  tokens: Tokens,
  outcome: Nullable(Type.Union([
    Type.Literal('submitted'), Type.Literal('approved'), Type.Literal('rejected'), Type.Literal('blocked'),
    Type.Literal('failed'), Type.Literal('killed'), Type.Literal('lease_expired'), Type.Literal('noted'),
    /** 模型服务不可用（额度用完、限流等）：不计失败，模型暂停 */
    Type.Literal('unavailable'),
    /** 超过时间预算被结束：计入运行失败，等主会话复核 */
    Type.Literal('timeout'),
  ])),
  token_hash: Type.String({ minLength: 64, maxLength: 64 }),
  violations: Type.Integer({ minimum: 0 }),
  /** 子进程 pid（进程组 id）；用于恢复时清理残留进程 */
  pid: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
  /** Pi 报告的金额（usage.cost.total 累加）；拿不到时为 null */
  cost: Type.Optional(Nullable(Type.Number({ minimum: 0 }))),
  /** 失败后升级模型派发的 run */
  escalated: Type.Optional(Type.Boolean()),
  /** 模型回复的轮数（assistant 消息数；fork 的 run 只计本次） */
  turns: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 接着哪次 run 的对话继续（返工时 fork 上一次的会话） */
  forked_from: Type.Optional(Type.String()),
  /** 时间预算到期的时刻（到期先提醒收尾，宽限期后结束） */
  deadline_at: Type.Optional(IsoTime),
  warned_at: Type.Optional(IsoTime),
  /** 子进程会话留档目录（<项目>.worktrees/.sessions/<run>/）与结束后找到的会话文件 */
  session_dir: Type.Optional(Type.String()),
  session_file: Type.Optional(Nullable(Type.String())),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type RunFile = Static<typeof RunFile>;

export const MergeQueueEntry = Type.Object({ flow: Type.String(), task: TaskId, enqueued_at: IsoTime },
  { additionalProperties: false });
export const MergeQueueFile = Type.Object({
  queue: Type.Array(MergeQueueEntry),
  merging: Nullable(Type.Object({ flow: Type.String(), task: TaskId, started_at: IsoTime },
    { additionalProperties: false })),
  // 文本冲突在 writes 内：原任务保持 merging 但让出合并名额，等待 merge-fix 任务（偏离，见 NOTES）
  suspended: Type.Optional(Type.Array(Type.Object({ flow: Type.String(), task: TaskId, merge_fix: TaskId, since: IsoTime },
    { additionalProperties: false }))),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type MergeQueueFile = Static<typeof MergeQueueFile>;

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ThinkingLevel = Type.Enum(THINKING_LEVELS);
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// —— workflow.yaml ——

const Gate = Type.Object({
  human: Type.Optional(Type.Boolean()),
  auto: Type.Optional(Type.Array(Type.String())),
  all_tasks_done: Type.Optional(Type.Boolean()),
  coverage: Type.Optional(Type.Boolean()),
  qa: Type.Optional(Type.Boolean()),
  test_author: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

/** 高层阶段：规格 → 契约与计划 → 实施；交付由最后一个 S 阶段的批准表示 */
export const PHASES = ['spec', 'plan', 'implementation'] as const;
export type Phase = (typeof PHASES)[number];

const StageDef = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  /** 可选：该阶段在 /forge-status 中归入哪个高层阶段；缺省按阶段 id 推断 */
  phase: Type.Optional(Type.Enum(PHASES)),
  gate: Gate,
}, { additionalProperties: false });

const ModeDef = Type.Object({ stages: Type.Array(StageDef, { minItems: 1 }) }, { additionalProperties: false });

const PosInt = Type.Integer({ minimum: 1 });

export const WorkflowFile = Type.Object({
  version: Type.Literal(1),
  project: Type.String({ minLength: 1 }),
  main_branch: Type.String({ minLength: 1 }),
  commands: Type.Record(Type.String(), Type.String({ minLength: 1 })),
  limits: Type.Object({
    max_parallel: PosInt,
    max_parallel_aux: Type.Optional(PosInt),
    max_attempts: PosInt,
    max_precheck_failures: Type.Optional(Type.Integer({ minimum: 1, default: 3 })),
    max_merge_failures: Type.Optional(Type.Integer({ minimum: 1, default: 2 })),
    lean_below_loc: Type.Optional(PosInt),
    port_block: Type.Optional(PosInt),
    lease_minutes: PosInt,
    max_violations_per_run: PosInt,
    max_task_files: PosInt,
    fix_max_files: PosInt,
    /** 子进程会话留档的保留天数（/forge doctor --fix 清理），默认 14 */
    session_retention_days: Type.Optional(PosInt),
    /** 返工时接着上一次的对话继续（pi --fork），默认 true（第三轮后续 2） */
    continue_session: Type.Optional(Type.Boolean()),
    /** 子进程 bash 命令的超时上限（秒），默认 300：没给或超过时由 pi-forge 改成上限 */
    bash_timeout_s: Type.Optional(PosInt),
    /** ready 任务由引擎自动派发（默认 true）；false 时由用户 /forge next 派发 */
    auto_dispatch: Type.Optional(Type.Boolean()),
    /** 批量合并（第四轮后续）：不逐任务审查时，合并队列里最多这么多个任务一起 rebase、只跑一次全量测试，默认 3；1 关闭 */
    merge_batch: Type.Optional(PosInt),
    /** 每次运行的时间预算（分钟，M 号实现任务），默认 30：只读任务（验收、修订）减半，S 号减半、L 号加倍 */
    run_minutes: Type.Optional(PosInt),
    /** 预算到期提醒收尾后的宽限（分钟），默认 5；仍没结束就结束运行 */
    run_grace_minutes: Type.Optional(PosInt),
    /** 同一任务超时后可以接着做的次数，默认 2；再超时转 blocked 交给用户 */
    max_continuations: Type.Optional(Type.Integer({ minimum: 0 })),
    /** 一个模块连同它派生的任务（合并冲突、验收修复、审查修复、闸门修复）最多运行的次数，默认 8（第六轮 B4） */
    module_runs: Type.Optional(PosInt),
    /** 一个模块连同派生任务累计运行的分钟数上限，默认是该模块单次运行预算的 4 倍（第六轮 B4） */
    module_minutes: Type.Optional(PosInt),
    /** 流程不在等你、也没有任何运行，却这么多分钟没有任何状态变化时提醒你（第六轮 B6），默认 20 */
    stall_minutes: Type.Optional(PosInt),
    /** 运行超时后的复核：auto 由程序按进展决定（默认），orchestrator 交给主会话（第六轮 C1） */
    timeout_review: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('orchestrator')])),
    /** 运行中每隔这么多分钟给工作区拍一次快照（不动索引与工作区），默认 10；0 关闭（第六轮 7.4） */
    checkpoint_minutes: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false }),
  /** 会打开桌面应用或浏览器窗口的项目命令（前缀匹配，例如 "pnpm dev:desktop"）：agent 不能运行，要看效果时交给用户 */
  gui_commands: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  models: Type.Record(Type.String(), Type.String({ minLength: 1 })),
  modes: Type.Object({ build: Type.Optional(ModeDef), feature: Type.Optional(ModeDef) }, { additionalProperties: false }),
  /** 动态 S 阶段共用闸门；auto 中未在 commands 配置的命令跳过 */
  implementation_gate: Type.Optional(Gate),
  generated_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  acctest_workspace: Type.Optional(Type.Object({
    include: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    cache: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }, { additionalProperties: false })),
  scopes: Type.Record(Type.String(), Type.Object({
    rules: Type.Optional(Type.Array(Type.String())),
    writes: Type.Array(Type.String()),
  }, { additionalProperties: false })),
  tool_groups: Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }))),
  roles: Type.Record(Type.String(), Type.Object({
    model: Type.String({ minLength: 1 }),
    thinking: Type.Optional(ThinkingLevel),
    scopes: Type.Optional(Type.Array(Type.String())),
    tools: Type.Array(Type.String({ minLength: 1 })),
    bash: Type.Optional(Type.Enum(['full', 'readonly', 'allowlist'])),
    bash_allow: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    read_paths: Type.Optional(Type.Array(Type.String())),
    writes: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** 失败后升级用的模型：档位名或 provider/model；不填时取上一档（cheap → medium → strong） */
    escalate_model: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false })),
  /** 失败后升级模型（第二轮 I）：同一任务失败 after_failures 次后，下一次派发换成升级模型 */
  escalation: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    after_failures: Type.Optional(PosInt),
    /** 被至少这么多任务硬依赖的实施任务（底座）第一次就用升级模型，默认 3；0 关闭（第三轮后续：底座任务对弱模型太大） */
    critical_fanout: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false })),
  /** 模板保留 adjust_tests；max_disputes 按单个测试限制争议次数 */
  testing: Type.Optional(Type.Object({
    adjust_tests: Type.Optional(Type.Boolean()),
    max_disputes: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false })),
  qa: Type.Optional(Type.Object({ max_rounds: Type.Optional(PosInt) }, { additionalProperties: false })),
  /** 项目知识库：auto_candidates 为 true 时，合并后验证失败会提炼为知识候选（默认关闭：真实冒烟中这些候选多是一次性细节） */
  knowledge: Type.Optional(Type.Object({ auto_candidates: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
  /** 逐任务审查策略；第二轮只确认，skip_sizes 供计划推导使用 */
  review: Type.Optional(Type.Object({
    per_task: Type.Optional(Type.Boolean()),
    max_rounds: Type.Optional(PosInt),
    skip_sizes: Type.Optional(Type.Array(TaskSize)),
  }, { additionalProperties: false })),
  /** 外部通知（第六轮 7.5）：需要你处理的新事项、流程完成时运行的 shell 命令，事件 JSON 从标准输入传入 */
  notify: Type.Optional(Type.Object({ command: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false })),
  /** 上下文管理（第五轮）：compact_at 为触发压缩的上下文占比（默认 0.7）；压缩后靠 notes 与 history 延续 */
  context: Type.Optional(Type.Object({ compact_at: Type.Optional(Type.Number({ minimum: 0.3, maximum: 0.95 })) }, { additionalProperties: false })),
  /** 每个流程的成本预算（第二轮 I）：tokens 计输入 + 输出；cost 为 Pi 报告的金额；minutes 为流程墙钟（第六轮 B6，不含等用户的时间）。超出后暂停派发新任务 */
  budget: Type.Optional(Type.Object({
    tokens: Type.Optional(PosInt),
    cost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    minutes: Type.Optional(PosInt),
    warn_ratio: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type WorkflowFile = Static<typeof WorkflowFile>;

// —— plan.yaml：只校验形状；符号、DAG、覆盖率与阶段顺序由 M3 校验 ——

export const PlanFile = Type.Object({
  size_estimate: Type.Object({
    loc: Type.Integer({ minimum: 0 }),
    modules: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  mode: PlanMode,
  stages: Type.Array(PlanStage, { minItems: 1 }),
  baseline: Type.Optional(StringList),
  tasks: Type.Array(Type.Object({
    id: TaskId,
    stage: Type.String({ minLength: 1 }),
    module: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    size: TaskSize,
    layers: StringList,
    ac: StringList,
    writes: StringList,
    shared: Type.Optional(StringList),
    produces: StringList,
    requires: StringList,
    test_interface: StringList,
    manual_checks: Type.Optional(ManualChecks),
    review: Type.Optional(TaskReview),
    risk: Type.Optional(TaskRisk),
    /** 只在变更请求的修订里使用：这是对已开始或已完成的 task 的修改 task，程序让它硬依赖原 task（第 12.3 节） */
    modifies: Type.Optional(Type.String({ pattern: '^T-\\d{3,}$' })),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });
export type PlanFile = Static<typeof PlanFile>;

// —— 项目级知识库（.forge/knowledge.json）：跨流程积累的约定、坑、决策；只由程序写入 ——

export const KNOWLEDGE_CATEGORIES = ['convention', 'pitfall', 'decision', 'environment', 'dependency'] as const;
export const KnowledgeCategory = Type.Enum(KNOWLEDGE_CATEGORIES);
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];
export const KNOWLEDGE_STATUSES = ['candidate', 'active', 'retired', 'promoted'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KnowledgeEntry = Type.Object({
  id: Type.String({ pattern: '^K-[0-9]{3,}$' }),
  category: KnowledgeCategory,
  content: Type.String({ minLength: 1, maxLength: 500 }),
  /** 适用的 scope；与 paths 都为空表示全局 */
  scopes: Type.Array(Type.String({ minLength: 1 })),
  /** 适用的路径 glob（相对仓库根） */
  paths: Type.Array(Type.String({ minLength: 1 })),
  source: Type.Object({
    /** agent：forge_learn 提交；review：审查打回提炼；merge：合并后验证失败提炼；human：用户 */
    kind: Type.Union([Type.Literal('agent'), Type.Literal('review'), Type.Literal('merge'), Type.Literal('human')]),
    flow: Nullable(Type.String()),
    task: Nullable(Type.String()),
    run: Nullable(Type.String()),
    role: Nullable(Type.String()),
  }, { additionalProperties: false }),
  status: Type.Enum(KNOWLEDGE_STATUSES),
  /** 已提升为规则草案时的草案文件 */
  draft: Type.Optional(Type.String()),
  status_reason: Type.Optional(Type.String({ maxLength: 500 })),
  created_at: IsoTime,
  updated_at: IsoTime,
}, { additionalProperties: false });
export type KnowledgeEntry = Static<typeof KnowledgeEntry>;

export const KnowledgeFile = Type.Object({
  entries: Type.Array(KnowledgeEntry),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type KnowledgeFile = Static<typeof KnowledgeFile>;

// —— 项目级模型暂停（.forge/model-pauses.json）：模型额度用完、限流、服务不可用时暂停派发；只由程序写入 ——

export const MODEL_PAUSE_KINDS = ['quota', 'unavailable'] as const;
export type ModelPauseKind = (typeof MODEL_PAUSE_KINDS)[number];

export const ModelPause = Type.Object({
  /** provider/id */
  model: Type.String({ minLength: 1 }),
  /** quota：额度用完；unavailable：限流、过载、服务或网络不可用 */
  kind: Type.Enum(MODEL_PAUSE_KINDS),
  reason: Type.String(),
  since: IsoTime,
  /** 自动恢复时间；没有时等用户 /forge models resume */
  retry_after: Type.Optional(IsoTime),
  /** 连续暂停次数（自动恢复后又失败时退避加倍） */
  strikes: Type.Integer({ minimum: 1 }),
  roles: Type.Array(Type.String()),
  /** 受影响的任务：<流程>/<任务> */
  tasks: Type.Array(Type.String()),
}, { additionalProperties: false });
export type ModelPause = Static<typeof ModelPause>;

export const ModelPausesFile = Type.Object({
  pauses: Type.Array(ModelPause),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type ModelPausesFile = Static<typeof ModelPausesFile>;

// —— 审查问题：供 M5 的 reviewer 使用 ——

export const REVIEW_LEVELS = ['must', 'suggest'] as const;
export const ReviewFinding = Type.Object({
  id: Type.String({ pattern: '^R-[0-9]+$' }),
  /** must：必须改（违反成文规范或明确的缺陷，自动交给负责的模块修复）；suggest：建议（用户挑选要修的） */
  level: Type.Enum(REVIEW_LEVELS),
  /** 依据：规范出处（文件 + 哪一条）或坏味道名称 */
  basis: Type.String({ minLength: 1, maxLength: 500 }),
  files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
  /** 位置：函数名或行号范围 */
  location: Type.String({ maxLength: 500 }),
  problem: Type.String({ minLength: 1, maxLength: 2000 }),
  expected: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });
export type ReviewFinding = Static<typeof ReviewFinding>;
// —— 结构化笔记（.forge/flows/<流程>/notes/<任务>.json、.forge/notes/main.json）：agent 用 notes 工具维护，每次请求原样放回上下文 ——

export const NOTE_SECTIONS = ['goal', 'done', 'todo', 'current', 'decisions', 'pitfalls'] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];
export const NOTE_ITEM_MAX = 1000;
export const NOTE_SECTION_MAX_ITEMS = 60;

const NoteItems = Type.Array(Type.String({ minLength: 1, maxLength: NOTE_ITEM_MAX }), { maxItems: NOTE_SECTION_MAX_ITEMS });
export const NotesFile = Type.Object({
  goal: NoteItems,
  done: NoteItems,
  todo: NoteItems,
  current: NoteItems,
  decisions: NoteItems,
  pitfalls: NoteItems,
  updated_at: IsoTime,
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type NotesFile = Static<typeof NotesFile>;

// —— ~/.pi/agent/pi-forge.json：用户通过 /forge-config 设置的角色模型与思考级别 ——

export const RoleSettingsFile = Type.Object({
  version: Type.Literal(1),
  roles: Type.Record(Type.String(), Type.Object({
    model: Type.Optional(Type.String({ pattern: '^[^/\\s]+/\\S+$' })),
    thinking: Type.Optional(ThinkingLevel),
    /** 失败后升级用的模型（/forge-config 设置，优先于 workflow.yaml 的 escalate_model） */
    escalate_model: Type.Optional(Type.String({ pattern: '^[^/\\s]+/\\S+$' })),
  }, { additionalProperties: false })),
  updated_at: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type RoleSettingsFile = Static<typeof RoleSettingsFile>;

export const AmendFile = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  id: Type.String({ pattern: '^A-[0-9]{3,}$' }),
  name: Type.String({ minLength: 1 }),
  path: Type.String({ pattern: '^docs/spec/features/[^/]+\\.md$' }),
  content: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
  status: Type.Enum(['proposed', 'approved', 'rejected']),
  diff: Type.Object({ added: StringList, changed: StringList, removed: StringList }, { additionalProperties: false }),
  affected_tasks: Type.Array(TaskId),
  base_sha: Type.String({ minLength: 1 }),
  created_at: IsoTime,
  decided_at: Type.Optional(IsoTime),
  feedback: Type.Optional(Type.String()),
  sha: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type AmendFile = Static<typeof AmendFile>;

// —— P1 计划提案（.forge/flows/<流程>/plan-proposal.json）：architect 经 forge_propose_plan 提交，只由程序写入 ——

export const PlanProposalFile = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  task: TaskId,
  /** 提交时 docs/plan/plan.yaml 的 sha256；预检与闸门核对它与分支上的计划一致 */
  plan_hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  /** architect 默认的处理：规格没说清时采用的方案，用户批准时逐条确认 */
  assumptions: Type.Array(Type.Object({ question: Type.String({ minLength: 1 }), decision: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  /** 超出需求但不得不做的设计（安全、数据完整性） */
  extras: Type.Array(Type.Object({ what: Type.String({ minLength: 1 }), why: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  /** 程序生成的报告（阶段、task 数、关键路径、互斥、提醒） */
  report: Type.String(),
  warnings: Type.Array(Type.String()),
  created_at: IsoTime,
}, { additionalProperties: false });
export type PlanProposalFile = Static<typeof PlanProposalFile>;

// —— 变更请求（.forge/flows/<流程>/changes/C-001.json，第 12.3 节）：architect 起草修订，用户批准后在一个事务里落地 ——

export const CHANGE_STATUSES = ['drafting', 'proposed', 'approved', 'rejected', 'cancelled'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export const CHANGE_ACTION_KINDS = ['add', 'adjust', 'cancel', 'followup', 'acctest', 'stages'] as const;
/** 修订里的一项动作（摘要；落地时程序按当时的状态重新推导并与它核对） */
export const ChangeActionSummary = Type.Object({
  kind: Type.Enum(CHANGE_ACTION_KINDS),
  /** add、adjust、cancel：计划里的 task；followup：新的修改 task（计划里的编号）；acctest：被改测试的 impl */
  task: Type.Optional(Type.String({ minLength: 1 })),
  /** followup：被修改的原 task */
  of: Type.Optional(Type.String({ minLength: 1 })),
  stage: Type.Optional(Type.String({ minLength: 1 })),
  /** adjust：改动的字段；stages：新增/调整/删除的阶段 */
  fields: Type.Optional(Type.Array(Type.String())),
  /** acctest：patch 改还没开始的 .at，round 新建 .at-n */
  mode: Type.Optional(Type.Enum(['patch', 'round'])),
  detail: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type ChangeActionSummary = Static<typeof ChangeActionSummary>;

export const ChangeFile = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  id: Type.String({ pattern: '^C-[0-9]{3,}$' }),
  what: Type.String({ minLength: 1 }),
  why: Type.String({ minLength: 1 }),
  impact: Type.String({ minLength: 1 }),
  /** worker:<task>、main、amend:<A-id> */
  source: Type.String({ pattern: '^(main|worker:T-[0-9]{3,}(\\.(at|rv|fx)(-[0-9]+)?)?|amend:A-[0-9]{3,})$' }),
  status: Type.Enum(CHANGE_STATUSES),
  /** 当前起草修订的 architect task（打回返工时换成新的） */
  task: TaskId,
  /** 来自规格修订时：变化的 AC，其负责 task 的验收测试要跟着改 */
  changed_acs: StringList,
  /** forge_propose_plan 通过时保存：修订后的 plan.yaml（批准时按它落地，也是下一次变更的"当前计划"） */
  plan_hash: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  plan_text: Type.Optional(Type.String()),
  assumptions: Type.Optional(Type.Array(Type.Object({ question: Type.String({ minLength: 1 }), decision: Type.String({ minLength: 1 }) }, { additionalProperties: false }))),
  extras: Type.Optional(Type.Array(Type.Object({ what: Type.String({ minLength: 1 }), why: Type.String({ minLength: 1 }) }, { additionalProperties: false }))),
  summary: Type.Optional(Type.String()),
  actions: Type.Optional(Type.Array(ChangeActionSummary)),
  /** 等待批准期间不派发的 task：修订要调整或取消的未开始 task（及其验收测试） */
  touched: Type.Array(TaskId),
  warnings: Type.Optional(Type.Array(Type.String())),
  /** architect 起草的轮数（打回一次加 1） */
  rounds: Type.Integer({ minimum: 1 }),
  created_at: IsoTime,
  decided_at: Type.Optional(IsoTime),
  feedback: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type ChangeFile = Static<typeof ChangeFile>;

export const SCHEMAS = {
  amend: AmendFile,
  change: ChangeFile,
  'plan-proposal': PlanProposalFile,
  state: StateFile,
  flow: FlowFile,
  task: TaskFile,
  event: FlowEvent,
  run: RunFile,
  'merge-queue': MergeQueueFile,
  workflow: WorkflowFile,
  'role-settings': RoleSettingsFile,
  plan: PlanFile,
  knowledge: KnowledgeFile,
  'model-pauses': ModelPausesFile,
  notes: NotesFile,
} as const;
export type SchemaKind = keyof typeof SCHEMAS;

/** 校验并返回中文错误列表；空数组表示通过。 */
export function validate(kind: SchemaKind, value: unknown): string[] {
  const schema = SCHEMAS[kind];
  if (Value.Check(schema, value)) return [];
  return Value.Errors(schema, value).map((e) => `${kind}${e.instancePath || '/'}: ${e.message}`);
}
