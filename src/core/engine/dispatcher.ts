// 来源：pi-flow src/core/dispatcher.ts @ 31f3f15
// 引擎：派发（建 worktree、颁发 token、取得租约、组装提示、拉起子进程）与程序步骤（推进阶段、验收、合并、重新派发）。
// 调度与推进全部由代码决定；LLM 只通过 forge_* 工具提交申请。
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import { isFinished, type StateStore } from '../state/state-store.ts';
import { isLightFlow, type RoleSettingsFile, type TaskFile, type ThinkingLevel } from '../state/schemas.ts';
import type { RunOutcome, SubagentHandle, SubagentLauncher, SubagentSpec } from './launcher.ts';
import { hashToken, isSettled } from '../state/state-machine.ts';
import { resolveRoleModel } from '../insight/role-settings.ts';
import { loadAgent } from './agents.ts';
import { assemblePrompt, ruleFilesFor } from './prompt-assembler.ts';
import { formatEntry, selectKnowledge } from './knowledge.ts';
import { findSessionFile, sessionDirOf } from './session-log.ts';
import { seedTaskNotes } from './notes.ts';
import { taskNotesRel } from '../state/state-store.ts';
import { budgetState, escalationModel, escalationPolicy, fallbackModel, hardFanout, resolveModelRef } from '../insight/cost-control.ts';
import { computeReady } from '../state/dag.ts';
import { selectDispatchable } from './scheduler.ts';
import { createTaskWorktree, ensureLocalExcludes, scratchDir, worktreePath as worktreePathOf, worktreesRoot } from '../workspace/worktree.ts';
import { git } from '../state/git.ts';
import { RUN_ENV_KEYS } from '../../tools/subagent-tools.ts';
import { MergeQueue, type MergeHooks, type MergeResult, type SyncResult } from './merge-queue.ts';
import { runStageGate, gateFailedWithoutChange, runImplementationChecks, type GateOutcome } from '../stage/gates.ts';
import { afterChecks, stageStep } from '../stage/stage-acceptance.ts';
import { syncTaskInputs } from '../../tools/module-tools.ts';
import { existsSync, readFileSync } from 'node:fs';
import { killStrays } from '../workspace/strays.ts';
import { activePause, clearPause, describePause, pauseActive, recordPause } from './model-pause.ts';
import { classifyRunFailure } from './failure-class.ts';
import { PostMergeTester } from './post-merge-test.ts';
import type { ModelPause } from '../state/schemas.ts';
import { autoTimeoutDecision, awaitingReview, graceMinutes, measureProgress, runBudgetMinutes, wrapUpMessage } from './run-budget.ts';
import { lineageExceeded } from './lineage.ts';
import { stallOf, stuckTasks } from '../insight/forge-watch.ts';
import { stopAllServices } from '../workspace/services.ts';
import { docPrecheck, ensureArchitectTask, isArchitectStage, P1_STAGE } from '../plan/plan-flow.ts';
import { changeDocPrecheck, changeOfTask, ensureChangeTask } from '../plan/change-flow.ts';
import { pausedByChange } from '../plan/change-request.ts';
import { allocateResources, releaseResources, resourceEnv, resourceOptions } from '../workspace/resources.ts';
import { prepareWorkspaceRecorded } from '../workspace/workspace.ts';
import { readSharedEnv, sharedEnvDir, syncSharedEnv } from '../workspace/shared-env.ts';
import { runPrecheck } from './precheck.ts';
import { waitsOn } from '../state/waits.ts';
import { REVIEW_INPUT, decideReview, readReviewEvidence, resolveReviews, reviewWorktreeOf, type ReviewInputFile } from '../stage/review-flow.ts';
import { QA_INPUT, stageWorktreeFor } from '../stage/stage-qa.ts';
import { isStageLevelTask } from '../workspace/stage-worktree.ts';
import { fixStep } from '../../modes/fix.ts';
import { DEFAULT_CHECKPOINT_MINUTES, createCheckpoint, dropCheckpoint, listCheckpoints } from '../state/checkpoints.ts';

const tasksHas = (store: StateStore, flowId: string, id: string) => { try { store.readTask(flowId, id); return true; } catch { return false; } };
/**
 * 等待输入（第 8.1 节 awaiting_inputs → checking）：软依赖的生产方都已 done 时，把集成分支同步进任务分支；
 * 有冲突时交回 worker（sync_conflict）。返回进入 checking 的 task。
 */
export async function advanceInputs(store: StateStore, flowId: string): Promise<string[]> {
  const out: string[] = [];
  const tasks = store.listTasks(flowId);
  for (const listed of tasks) {
    const t = store.readTask(flowId, listed.id);
    if (t.status !== 'awaiting_inputs') continue;
    if (waitsOn(t, store.listTasks(flowId)).length) continue;
    const synced = await syncTaskInputs(store, flowId, t);
    if (synced.conflicts.length) {
      await store.transitionTask(flowId, t.id, { to: 'in_progress', trigger: 'sync_conflict', actor: 'engine', facts: { conflict_files: synced.conflicts } });
      continue;
    }
    await store.transitionTask(flowId, t.id, { to: 'checking', trigger: 'inputs_ready', actor: 'engine', facts: { inputs_synced: true } });
    out.push(t.id);
  }
  return out;
}

/**
 * 会话文件超过这个大小就不再接着（上下文太长，每轮重发的成本超过重新读代码）。
 * 真实冒烟：一次 175 轮的实施会话约 0.5 MB，接着它返工的两次运行缓存读合计上千万 token；1.5 MB → 400 KB。
 */
export const MAX_FORK_BYTES = 400_000;

/** 派发前的检查把任务交给了用户（同样的失败重复出现、模块谱系超出预算）：next 与 pump 静默跳过 */
export class HandedToUser extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandedToUser';
  }
}

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

export interface EngineDeps {
  root: string;
  store: StateStore;
  config: FlowConfig;
  roleSettings: () => RoleSettingsFile;
  launcher: SubagentLauncher;
  packageAgentsDir: string;
  /** 子进程中 pi-forge 的 subagent 扩展；总是最后加载（guard 必须最后执行） */
  subagentExtension: string;
  /** 额外扩展（第三方插件、测试用假模型 provider），在 subagentExtension 之前加载 */
  extraExtensions?: (role: string) => string[];
  now?: () => Date;
  verifyTimeoutMs?: number;
  /** 程序步骤出错时的回调（例如通知用户）；默认忽略 */
  onError?: (e: unknown) => void;
  mergeHooks?: MergeHooks;
  /** 每次合并处理完成的回调 */
  onMerge?: (r: MergeResult) => void;
  /** 技能目录（skills/<name>/SKILL.md）；子进程以 --no-skills 运行，技能由提示注入 */
  packageSkillsDir?: string;
  onGate?: (r: GateOutcome) => void;
  /** 子进程结束后结束它留在 worktree 里的进程（默认开；测试可关） */
  killStrayProcesses?: boolean;
  /** 主分支同步完成的回调 */
  onSync?: (flowId: string, r: SyncResult) => void;
}

export interface Dispatched { run_id: string; task: string; role: string; model: string }

/** deadline：时间预算到期时刻（毫秒）；warned：已插话提醒收尾；timedOut：宽限期也过了，正在结束 */
interface ActiveRun { flow: string; task: string; role: string; handle: SubagentHandle; minutes: number; deadline: number; warned: boolean; timedOut: boolean }

/** 一次派发会用的角色与模型（失败升级之后） */
interface ModelPlan {
  role: string; model: string; thinking: ThinkingLevel | null; escalated: boolean; fallback: boolean;
  /** 同样的原因连续失败，可换的模型都用过了 */
  exhausted: boolean;
  /** 可换的模型（升级模型、兜底模型），交出去时说明原因用 */
  alternatives: string[];
  /** 改用兜底模型的原因（记事件） */
  note?: string;
}

export class Engine {
  private readonly d: EngineDeps;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();

  private readonly mergeQueue: MergeQueue;
  private readonly postMerge: PostMergeTester;

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.mergeQueue = new MergeQueue(deps.root, deps.store, deps.config, { ...deps.mergeHooks, ...(deps.verifyTimeoutMs ? { verifyTimeoutMs: deps.verifyTimeoutMs } : {}) });
    this.postMerge = new PostMergeTester({ root: deps.root, store: deps.store, config: deps.config, ...(deps.verifyTimeoutMs ? { timeoutMs: deps.verifyTimeoutMs } : {}) },
      async (flowId) => { await this.promote(flowId); this.notify(); await this.pump(flowId); }, (e) => (this.d.onError ?? (() => {}))(e));
  }

  /** 合并后回归测试是否在运行（状态显示用） */
  postMergeRunning(flowId: string): boolean { return this.postMerge.isRunning(flowId); }

  private now(): Date { return this.d.now?.() ?? new Date(); }

  /** ready 任务是否由引擎自动派发（workflow.yaml 的 limits.auto_dispatch，默认 true） */
  get autoDispatch(): boolean { return this.d.config.limits.auto_dispatch !== false; }

  /** 没有运行中的子进程、验证、合并等程序步骤 */
  isIdle(): boolean { return this.runs.size === 0 && this.pending.size === 0 && this.pumping === 0; }

  activeRuns(): { run_id: string; flow: string; task: string; role: string; pid: number | undefined }[] {
    return [...this.runs].map(([run_id, r]) => ({ run_id, flow: r.flow, task: r.task, role: r.role, pid: r.handle.pid }));
  }

  /**
   * 共享构建环境：S0 结束、S1 开始派发之前建立（此时 S0 的骨架已合入集成分支，上一阶段的任务都结束了，没有 worktree 在用依赖目录）；
   * 之后每个 S 阶段开始时对齐一次（合入的任务追加或改了依赖时刷新）。同一阶段只检查一次；有运行中的任务时不刷新；失败只记事件，worktree 回到各自 install。
   */
  private readonly sharedEnvChecked = new Set<string>();
  private async ensureSharedEnv(flowId: string): Promise<void> {
    const { store, root, config } = this.d;
    const flow = store.readFlow(flowId);
    if (isLightFlow(flow) || !/^S[1-9]\d*$/.test(flow.stage) || flow.stage_status !== 'active') return;
    const tag = `${flowId}:${flow.stage}`;
    if (this.sharedEnvChecked.has(tag)) return;
    const cur = readSharedEnv(root);
    if (cur?.synced === tag || cur && [...this.runs.values()].some((r) => r.flow === flowId)) { this.sharedEnvChecked.add(tag); return; }
    this.sharedEnvChecked.add(tag);
    try {
      const r = await syncSharedEnv(root, config, flow.integration_branch, tag, this.d.verifyTimeoutMs ? { timeoutMs: this.d.verifyTimeoutMs } : {});
      if (r.status === 'skipped' || r.status === 'unchanged') return;
      await store.recordEvent({
        flow: flowId, actor: 'dispatcher', type: 'note', reason: `共享构建环境：${r.status === 'failed' ? `失败，worktree 各自安装依赖（${(r.reason ?? '').split('\n')[0]}）` : r.status === 'built' ? '已建立' : '已刷新'}，${r.ms}ms`,
        data: { kind: 'shared_env', status: r.status, ms: r.ms, ...(r.status === 'failed' ? { needs_human: true } : {}) },
      });
      this.notify();
    } catch (e) { this.d.onError?.(e); }
  }

  /** pending → ready（硬依赖已完成且属于当前活动阶段） */
  async promote(flowId: string): Promise<string[]> {
    const flow = this.d.store.readFlow(flowId);
    if (flow.stage_status !== 'active' && flow.stage_status !== 'awaiting_gate') return [];
    // 门禁进行中只有 stage-qa 可以就绪（第 11 节第 3 步）
    const ids = computeReady(this.d.store.listTasks(flowId), flow.stage)
      .filter((id) => flow.stage_status === 'active' || this.d.store.readTask(flowId, id).kind === 'qa');
    for (const id of ids) await this.d.store.transitionTask(flowId, id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    return ids;
  }

  /** /forge next：由程序选择 ready 任务并派发，不经 LLM 决策 */
  async next(flowId: string): Promise<Dispatched[]> {
    await this.promote(flowId);
    await this.ensureSharedEnv(flowId);
    const flow = this.d.store.readFlow(flowId);
    if (flow.sync?.status === 'conflict') return [];
    if (budgetState(this.d.store, this.d.config, flow, this.now())?.exceeded) return [];
    const changes = this.d.store.listChanges(flowId);
    const ids = selectDispatchable(this.d.store.listTasks(flowId).filter((t) => !this.pausedFor(flowId, t) && !pausedByChange(changes, t.id)), flow.stage, this.d.config.limits.max_parallel, this.d.config.limits.max_parallel_aux);
    const out: Dispatched[] = [];
    for (const id of ids) {
      try { out.push(await this.dispatch(flowId, id)); } catch (e) { if (!(e instanceof HandedToUser)) throw e; }
    }
    return out;
  }

  /**
   * 派发前检查（第六轮 B3、B4）：同样的原因连续失败，升级模型与兜底模型都用过（或都没有）时交出去；
   * 模块连同派生任务超出谱系预算也交出去。返回原因。
   */
  private handOffReason(flowId: string, task: TaskFile, plan: ModelPlan): string | null {
    if (plan.exhausted) {
      const tried = plan.alternatives.length ? `（换过${plan.alternatives.join('、')}，仍然一样）` : '（没有可升级的模型，也没有设置兜底模型）';
      return `同样的原因连续失败 ${task.same_failures} 次${tried}，再用同一个模型重试多半还是一样：${(task.last_failure ?? '').replace(/\s+/g, ' ').slice(0, 300)}。处理后 /forge unblock ${task.id}`;
    }
    return lineageExceeded(this.d.store, this.d.config, flowId, task, this.now());
  }

  /** 派发一个任务：ready → 开工；in_progress 无租约 → 重新派发（接着原会话）。立即返回 run_id。 */
  async dispatch(flowId: string, taskId: string): Promise<Dispatched> {
    const { store, root } = this.d;
    ensureLocalExcludes(root);
    const flow = store.readFlow(flowId);
    let task = store.readTask(flowId, taskId);
    if (task.status === 'ready' && pausedByChange(store.listChanges(flowId), taskId)) throw new DispatchError(`任务 ${taskId} 被等待批准的变更请求暂停（修订要调整或取消它），批准或打回后再派发`);
    const plan = this.planModel(flowId, task);
    const { role, model, thinking, escalated, fallback } = plan;
    const paused = activePause(store, model, this.now());
    if (paused) throw new DispatchError(`${describePause(paused, this.now())}。恢复：/forge models resume ${paused.model}，或用 /forge-config 给 ${role} 换模型，或用 /forge-config fallback <模型> 设置兜底模型`);
    if (!task.lease && (task.status === 'ready' || task.status === 'in_progress')) {
      const why = this.handOffReason(flowId, task, plan);
      if (why) {
        await store.transitionTask(flowId, taskId, { to: 'blocked', trigger: 'block', actor: 'dispatcher', facts: { reason: why } });
        await store.recordEvent({ flow: flowId, task: taskId, actor: 'dispatcher', type: 'note', reason: `需要你处理：${why}`, data: { needs_human: true } });
        this.notify();
        throw new HandedToUser(why);
      }
    }
    const runId = `r-${this.now().getTime().toString(36)}${randomBytes(3).toString('hex')}`;
    const token = randomBytes(24).toString('base64url');
    const lease = {
      run_id: runId, role, token_hash: hashToken(token), acquired_at: this.now().toISOString(),
      expires_at: new Date(this.now().getTime() + this.d.config.limits.lease_minutes * 60_000).toISOString(),
    };

    let fork: { run_id: string; session_file: string; task: string } | null = null;
    let timeout: TaskFile['timeout_review'] | null = null;
    if (task.status === 'ready' && task.kind !== 'merge-fix' && flow.sync?.status === 'conflict') {
      throw new DispatchError(`同步 ${this.d.config.raw.main_branch} 到集成分支时冲突，需要你先处理（${flow.sync.reason ?? ''}），处理后执行 /forge sync`);
    }
    if (task.status === 'ready' && task.kind !== 'merge-fix' && budgetState(store, this.d.config, flow, this.now())?.exceeded) {
      throw new DispatchError('本流程的预算已用完，暂停派发新任务：用 /forge budget 提高预算后继续');
    }
    if (task.status === 'ready') {
      // merge-fix 任务的 worktree 由合并队列预先准备（含冲突标记），直接复用
      // 审查者只读，直接用被审查任务的 worktree（不新建也不删除；guard 拦写操作）
      const wt = isStageLevelTask(task)
          ? stageWorktreeFor(root, store, flowId, task, flow.integration_branch)
        : task.kind === 'review'
          ? (reviewWorktreeOf(store, flowId, task) ?? (() => { throw new DispatchError(`审查任务 ${taskId} 找不到被审查任务 ${task.for_task ?? ''} 的 worktree`); })())
        : task.worktree && task.branch && task.base_sha
          ? { path: task.worktree, branch: task.branch, base_sha: task.base_sha }
          : createTaskWorktree(root, flowId, taskId, flow.integration_branch, flow.integration_branch);
      await this.prepareDeps(flowId, task, wt.path);
      // 修复任务接着写过这些代码的任务的对话继续（第四轮后续）
      const forkFrom = task.fork_from_task ?? null;
      if (forkFrom && tasksHas(store, flowId, forkFrom)) fork = this.forkSource(flowId, store.readTask(flowId, forkFrom), role, model);
      task = await store.transitionTask(flowId, taskId, {
        to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher',
        patch: { lease, worktree: wt.path, branch: wt.branch, base_sha: wt.base_sha },
      });
    } else if (task.status === 'in_progress' && !task.lease) {
      if (!task.worktree) throw new DispatchError(`任务 ${taskId} 没有 worktree，无法继续`);
      if (awaitingReview(task)) throw new DispatchError(`任务 ${taskId} 运行超时，等主会话复核（forge_resolve_timeout）后才能继续`);
      timeout = task.timeout_review ?? null;
      // 返工：接着同一角色上一次提交时的对话继续（第三轮后续 2）；超时后主会话决定从头做时不接着
      fork = timeout?.decision === 'restart' ? null : this.forkSource(flowId, task, role, model);
      task = await store.acquireLease(flowId, taskId, lease, 'dispatcher');
    } else {
      throw new DispatchError(`任务 ${taskId} 当前是 ${task.status}${task.lease ? `（run ${task.lease.run_id} 运行中）` : ''}，不能派发`);
    }

    // 任务第一次运行前填入初始笔记（第五轮）：目标是任务说明与验收标准，待完成是验收标准逐条
    if (!store.readNotes(taskNotesRel(flowId, taskId))) {
      const seed = seedTaskNotes(task);
      await store.writeNotes(taskNotesRel(flowId, taskId), (n) => { n.goal = seed.goal; n.todo = seed.todo; }, { actor: 'dispatcher', flow: flowId, task: taskId, reason: '初始笔记' });
    }

    const sessionDir = sessionDirOf(root, runId);
    mkdirSync(sessionDir, { recursive: true });
    const minutes = runBudgetMinutes(this.d.config, task);
    const deadline = this.now().getTime() + minutes * 60_000;
    await store.createRun({
      ...(fork ? { forked_from: fork.run_id } : {}),
      deadline_at: new Date(deadline).toISOString(),
      run_id: runId, flow: flowId, task: taskId, role, model, started_at: this.now().toISOString(), ended_at: null,
      tokens: { input: null, output: null, cache_read: null, cache_write: null }, outcome: null, token_hash: lease.token_hash, violations: 0,
      session_dir: sessionDir, ...(escalated ? { escalated: true } : {}), ...(fallback ? { fallback: true } : {}),
    });
    if (plan.note) await store.recordEvent({ flow: flowId, task: taskId, actor: 'dispatcher', type: 'note', reason: plan.note, data: { run: runId, fallback_model: model } });

    let handle: SubagentHandle;
    try {
      // 第 4.1 节：本次运行专用的端口段、数据库名与临时目录，经环境变量传给子进程（bash 与 forge_service 都继承）；
      // 有共享构建环境时再带 FORGE_SHARED_ENV（审查者在链接了共享依赖的 worktree 里用自己的端口与库跑本 task 的测试）
      const res = await allocateResources(root, runId, resourceOptions(this.d.config));
      const spec = this.buildSpec(flowId, task, role, runId, token, model, thinking, fork, timeout ? { ...timeout, budget: minutes } : null);
      const shared: Record<string, string> = readSharedEnv(root) ? { FORGE_SHARED_ENV: sharedEnvDir(root) } : {};
      handle = this.d.launcher.launch({ ...spec, env: { ...spec.env, ...resourceEnv(res), ...shared }, sessionDir, ...(fork ? { forkFrom: fork.session_file } : {}) });
    } catch (e) {
      await releaseResources(root, runId, this.d.config.commands).catch(() => null);
      await this.failRun(flowId, taskId, runId, `子进程启动失败：${(e as Error).message}`);
      throw new DispatchError(`子进程启动失败：${(e as Error).message}`);
    }
    this.runs.set(runId, { flow: flowId, task: taskId, role, handle, minutes, deadline, warned: false, timedOut: false });
    if (handle.pid) await store.updateRun(runId, { pid: handle.pid }, 'dispatcher', '记录子进程');
    this.track(handle.done.then((r) => this.onExit(runId, r), (e) => this.onExit(runId, {
      exitCode: null, stderrTail: String(e), tokens: { input: null, output: null, cache_read: null, cache_write: null },
      model: null, turns: 0, stopReason: null, error: String(e), lastText: '',
    })));
    this.notify();
    return { run_id: runId, task: taskId, role, model };
  }

  /**
   * 新建的工作区准备依赖（F1）：任务 worktree 可写（直接 install，失败写进 handoff 让 worker 自己修）；
   * 阶段级只读任务（stage-qa）的临时 worktree 直接 install，失败只记事件。其余（含 merge-fix、.fx-n、审查者共用的 worktree）在创建处或不需要，这里不处理。
   */
  private async prepareDeps(flowId: string, task: TaskFile, wt: string): Promise<void> {
    const { store, root, config } = this.d;
    const stageLevel = isStageLevelTask(task);
    if (task.kind === 'review' && !stageLevel) return;
    if (!stageLevel && task.worktree && task.branch && task.base_sha) return;
    // stage-qa 的 bash 是 full 档，可能原地改依赖目录里的文件，硬链接会污染共享缓存，直接 install
    const mode = 'writable';
    const r = await prepareWorkspaceRecorded(store, root, config, wt, mode, { flow: flowId, task: task.id, actor: 'dispatcher' });
    // 有 install 命令却跳过：工作区里还没有包清单（S0 骨架之前），告诉 worker 建好清单后自己装
    const install = config.commands['install']?.trim();
    if (r.skipped && install && !stageLevel) await store.appendHandoff(flowId, task.id, `项目还没有依赖清单（包清单与锁文件），程序没有安装依赖。建好依赖清单后自己运行 install（\`${install}\`），再跑测试。`, 'dispatcher');
    if (!r.ok && !stageLevel) await store.appendHandoff(flowId, task.id, `依赖准备失败（程序在创建工作区后运行 install 的结果）：${r.reason ?? ''}\n需要依赖的命令在修好之前都会失败；请检查包清单与 install 命令，必要时自己运行 install。`, 'dispatcher');
  }

  /**
   * 派发这个任务会用的角色与模型：同一任务失败达到次数后（或被很多任务依赖的底座），实施换成升级模型；
   * 没有可升级的模型时，失败后改用兜底模型；原模型被暂停（服务中断、额度用完）时也改用兜底模型。
   * 同样的原因连续失败时，依次换升级模型、兜底模型，这一串失败里都用过了就 exhausted（交出去）。
   */
  private planModel(flowId: string, task: TaskFile): ModelPlan {
    const role = task.role;
    const base = this.modelFor(role);
    const settings = this.d.roleSettings();
    const fb = fallbackModel(this.d.config, settings);
    let model = base.model;
    let escalated = false;
    let fallback = false;
    let exhausted = false;
    let note: string | undefined;
    const esc = escalationPolicy(this.d.config);
    const up = esc.enabled ? escalationModel(this.d.config, settings, role, model) : null;
    const critical = esc.criticalFanout > 0 && hardFanout(task, this.d.store.listTasks(flowId)) >= esc.criticalFanout;
    const failures = task.attempts + (task.precheck_failures ?? 0) + (task.merge_failures ?? 0) + (task.review_rounds ?? 0);
    // 第 10.1 节：strong 审查（底座、auth、高风险）用升级模型
    const strongReview = task.kind === 'review' && task.review === 'strong';
    const same = task.same_failures ?? 0;
    if (same >= 2 && task.status === 'in_progress' && !task.timeout_review) {
      // 同样的原因再次失败（第六轮 B3）：不等失败次数，下一次就换模型；这一串失败用过的模型不再用
      const tried = new Set(this.endedRuns(flowId, task.id).slice(-same).map((r) => r.model));
      const next = [up, fb].find((m): m is string => !!m && !tried.has(m));
      if (next) {
        model = next;
        if (next === up) escalated = true;
        else { fallback = true; note = `同样的原因连续失败 ${same} 次，改用兜底模型 ${next}`; }
      } else exhausted = true;
    } else if (up && (failures >= esc.afterFailures || critical || strongReview || same >= 2)) {
      model = up; escalated = true;
    } else if (!up && fb && fb !== model && failures >= esc.afterFailures) {
      // 没有可升级的模型：失败多次后用兜底模型代替升级
      model = fb; fallback = true; note = `失败 ${failures} 次且没有可升级的模型，改用兜底模型 ${fb}`;
    }
    // 要用的模型被暂停：换兜底模型继续，原模型恢复后下一次派发自动换回
    if (fb && fb !== model && activePause(this.d.store, model, this.now()) && !activePause(this.d.store, fb, this.now())) {
      note = `模型 ${model} 暂停中，改用兜底模型 ${fb}`;
      model = fb; fallback = true; escalated = false;
    }
    return { role, model, thinking: base.thinking, escalated, fallback, exhausted, ...(note ? { note } : {}), alternatives: [...(up ? ['升级模型'] : []), ...(fb && fb !== up ? ['兜底模型'] : [])] };
  }

  private endedRuns(flowId: string, taskId: string) {
    return this.d.store.listRuns().filter((r) => r.flow === flowId && r.task === taskId && r.ended_at).sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  /** 任务下一次派发要用的模型正被暂停时返回暂停记录（没设置模型等其他问题交给 dispatch 报错） */
  pausedFor(flowId: string, task: TaskFile): ModelPause | null {
    if (task.lease || !['ready', 'in_progress'].includes(task.status)) return null;
    if (!this.d.store.readModelPauses().pauses.some((p) => pauseActive(p, this.now()))) return null;
    try {
      return activePause(this.d.store, this.planModel(flowId, task).model, this.now());
    } catch {
      return null;
    }
  }

  /** worker 当前使用的模型（architect 据此决定粒度）；没有设置时为 null */
  private workerModel(): string | null {
    try { return this.modelFor('worker').model; } catch { return null; }
  }

  private modelFor(role: string): { model: string; thinking: ThinkingLevel | null } {
    const r = resolveRoleModel(this.d.config, this.d.roleSettings(), role);
    if (!r.model) throw new DispatchError(`角色 ${role} 没有设置模型：请执行 /forge-config 为它选择模型，或在 workflow.yaml 的 models 中填写档位`);
    return { model: r.model, thinking: r.thinking };
  }

  /**
   * 返工时可以接着的上一次对话：同一任务、同一角色、同一模型最近一次正常提交的 run，会话文件还在且不太大。
   * 换了模型（例如失败升级）、关闭 limits.continue_session、或任务重新开工（ready）时从头开始。
   */
  private forkSource(flowId: string, task: TaskFile, role: string, model: string): { run_id: string; session_file: string; task: string } | null {
    if (this.d.config.limits.continue_session === false) return null;
    const prev = this.d.store.listRuns().filter((r) => r.flow === flowId && r.task === task.id && r.role === role && r.ended_at)
      .sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
    // 正常提交过的会话，或超时被结束的会话（主会话复核后决定接着做）
    if (!prev || !(prev.outcome === 'submitted' || prev.outcome === 'timeout') || prev.model !== model || !prev.session_file) return null;
    try {
      if (statSync(prev.session_file).size > MAX_FORK_BYTES) return null;
    } catch { return null; }
    return { run_id: prev.run_id, session_file: prev.session_file, task: task.id };
  }

  private buildSpec(flowId: string, task: TaskFile, role: string, runId: string, token: string, model: string, thinking: ThinkingLevel | null, fork: { run_id: string; task: string } | null = null,
    timeout: (NonNullable<TaskFile['timeout_review']> & { budget: number }) | null = null): SubagentSpec {
    const { root, config, store } = this.d;
    const agent = loadAgent(role, root, this.d.packageAgentsDir);
    const { rules } = ruleFilesFor(config, root, task.scopes, task.layers ?? [], task.worktree ?? undefined);
    const mode = ['review', 'qa'].includes(task.kind) ? 'review' : 'impl';
    const flow = store.readFlow(flowId);
    // 重新派发时告诉实施者 worktree 里已有的改动（含未提交的），避免重做或覆盖
    let existingWork: string | undefined;
    if (mode === 'impl' && task.worktree && task.base_sha) {
      const status = git(task.worktree, ['status', '--porcelain', '-uall']).trim();
      const stat = git(task.worktree, ['diff', '--stat', task.base_sha]).trim();
      if (status || stat) existingWork = [stat, status && `未提交：\n${status}`].filter(Boolean).join('\n\n');
    }
    // worker 自己写验收测试（带上 acceptance-tests），reviewer 审查这些测试（同一份技能当检查依据）
    const s0Architect = role === 'architect' && task.stage === 'S0' && (task.kind === 'impl' || task.kind === 'fix');
    const skillNames = [...new Set([...(s0Architect ? ['write-rules', 'tdd', 'simplicity', 'receiving-feedback', 'acceptance-tests'] : role === 'architect' ? (task.stage === 'X1' ? ['design-contract', 'domain-modeling'] : ['design-contract', 'plan-dag', 'domain-modeling', 'write-rules', ...(task.stage !== P1_STAGE ? ['change-request'] : [])]) : role === 'reviewer' ? ['code-review', 'tdd', 'simplicity', 'acceptance-tests'] : role === 'stage-qa' ? ['stage-qa'] : ['tdd', 'simplicity', 'receiving-feedback', 'acceptance-tests']), ...(config.role(role).writes.length ? ['write-handoff'] : [])])];
    const skills = skillNames.map((n) => {
      const f = this.d.packageSkillsDir ? path.join(this.d.packageSkillsDir, n, 'SKILL.md') : '';
      return f && existsSync(f) ? { path: `skills/${n}`, content: readFileSync(f, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim() } : null;
    }).filter((x): x is { path: string; content: string } => !!x);
    const tasks = store.listTasks(flowId);
    // 实施类角色的临时目录（项目与 worktree 之外）：做实验、建临时文件，run 结束后删除
    const scratch = mode === 'impl' && (config.role(role).writes.length || config.role(role).bash === 'full') ? scratchDir(root, runId) : undefined;
    if (scratch) mkdirSync(scratch, { recursive: true });
    // 审查 task 的 handoff 就是审查输入（完整放进提示，不按 handoff 的长度截断）
    const reviewBrief = task.kind === 'review' || task.kind === 'qa' ? store.readHandoff(flowId, task.id).replace(/^\s*## \d{4}-[^\n]*\n+/, '') : '';
    const confirmRound = (task.kind === 'review' || task.kind === 'qa') && (readReviewEvidence<ReviewInputFile>(store, flowId, task.id, task.kind === 'qa' ? QA_INPUT : REVIEW_INPUT)?.prior_must.length ?? 0) > 0;
    const prompt = assemblePrompt({
      agent, rules, skills, task, flowId, flowTasks: tasks, handoff: reviewBrief ? '' : store.readHandoff(flowId, task.id), mode,
      ...(reviewBrief ? { reviewBrief, confirmRound } : {}), commands: config.commands,
      knowledge: selectKnowledge(store.readKnowledge(), task).map(formatEntry),
      ...(scratch ? { scratchDir: scratch } : {}),
      upstream: task.depends_on.flatMap((d) => {
        const u = tasks.find((x) => x.id === d.task);
        return u ? [{ id: u.id, title: u.title, type: d.type, status: u.status === 'done' ? '已完成' : `未完成：${u.status}`, handoff: store.readHandoff(flowId, u.id) }] : [];
      }),
      ...(fork && mode === 'impl' && fork.task === task.id && !timeout ? { continuation: { run: fork.run_id } } : {}),
      ...(timeout ? { timeoutResume: { run: timeout.run, minutes: timeout.minutes, budget: timeout.budget, forked: !!fork && fork.task === task.id, ...(timeout.decision ? { decision: timeout.decision } : {}), ...(timeout.note ? { note: timeout.note } : {}) } } : {}),
      ...(fork && mode === 'impl' && fork.task !== task.id ? { priorTask: { id: fork.task, title: store.readTask(flowId, fork.task).title, run: fork.run_id } } : {}),
      ...(existingWork ? { existingWork } : {}),
    });
    const runDir = path.join(worktreesRoot(root), '.runs', runId);
    mkdirSync(runDir, { recursive: true });
    const systemFile = path.join(runDir, 'system.md');
    writeFileSync(systemFile, prompt.system);
    const r = config.role(role);
    return {
      cwd: task.worktree!,
      model,
      thinking: thinking ?? agent.thinking,
      tools: config.activeTools(role),
      extensions: [...(this.d.extraExtensions?.(role) ?? []), this.d.subagentExtension],
      appendSystemPromptFiles: [systemFile],
      prompt: prompt.user,
      env: {
        ...r.env,
        [RUN_ENV_KEYS.root]: root, [RUN_ENV_KEYS.flow]: flowId, [RUN_ENV_KEYS.task]: task.id,
        [RUN_ENV_KEYS.run]: runId, [RUN_ENV_KEYS.token]: token, [RUN_ENV_KEYS.role]: role,
      },
    };
  }

  private async failRun(flowId: string, taskId: string, runId: string, reason: string): Promise<void> {
    const t = this.d.store.readTask(flowId, taskId);
    if (t.lease?.run_id === runId && t.status === 'in_progress') {
      await this.d.store.transitionTask(flowId, taskId, { to: t.status, trigger: 'run_failed', actor: 'dispatcher', facts: { reason } });
    }
  }

  private async onExit(runId: string, r: RunOutcome): Promise<void> {
    const active = this.runs.get(runId);
    this.runs.delete(runId);
    // forge_service 启动的服务（第六轮 D2）：按临时目录里的记录结束整个进程组
    const services = stopAllServices(scratchDir(this.d.root, runId));
    if (active && services.length) await this.d.store.recordEvent({ flow: active.flow, task: active.task, actor: 'dispatcher', type: 'note', reason: `结束 ${runId} 启动的服务：${services.join('、')}`, data: { run: runId } }).catch(() => {});
    // 子进程结束后，结束它在 worktree 或临时目录里留下的进程（例如被放到后台、没人等的测试）
    if (active && this.d.killStrayProcesses !== false) {
      const wt = this.d.store.readTask(active.flow, active.task).worktree ?? worktreePathOf(this.d.root, active.flow, active.task);
      // 其他仍在运行的 run（审查、修复常与原任务共用 worktree）的进程组不能动
      const keepGroups = [...this.runs.values()].flatMap((x) => (x.handle.pid ? [x.handle.pid] : []));
      const killed = killStrays([wt, scratchDir(this.d.root, runId)], { keepGroups });
      if (killed.length) await this.d.store.recordEvent({ flow: active.flow, task: active.task, actor: 'dispatcher', type: 'note', reason: `结束 ${runId} 留下的 ${killed.length} 个残留进程`, data: { run: runId, pids: killed } }).catch(() => {});
    }
    rmSync(scratchDir(this.d.root, runId), { recursive: true, force: true });
    await releaseResources(this.d.root, runId, this.d.config.commands).catch((e) => this.d.onError?.(e));
    if (!active) return;
    const { store } = this.d;
    const prev = store.readRun(runId);
    const leaseHeld = store.readTask(active.flow, active.task).lease?.run_id === runId;
    const timedOut = leaseHeld && prev.outcome === 'timeout';
    // 没有提交就结束：按错误信息分类决定恢复动作。模型额度、限流、配置错误不是任务的问题，暂停这个模型而不是计失败
    const failure = leaseHeld && !timedOut ? classifyRunFailure(r) : null;
    const unavailable = failure?.recovery === 'pause_model' ? failure.pause! : null;
    const outcome = prev.outcome ?? (leaseHeld ? (unavailable ? 'unavailable' : 'failed') : null);
    await store.updateRun(runId, {
      ended_at: this.now().toISOString(), tokens: r.tokens, model: r.model ?? prev.model, ...(outcome ? { outcome } : {}),
      ...(failure ? { failure_kind: failure.kind } : {}),
      ...(r.cost !== undefined ? { cost: r.cost } : {}), turns: r.turns,
      ...(prev.session_dir ? { session_file: findSessionFile(prev.session_dir) } : {}),
    }, 'dispatcher', 'run 结束');
    if (unavailable && prev.model) {
      const pause = await recordPause(store, { model: prev.model, role: active.role, flow: active.flow, task: active.task, u: unavailable, now: this.now() });
      const t = store.readTask(active.flow, active.task);
      if (t.lease?.run_id === runId && t.status === 'in_progress') {
        await store.transitionTask(active.flow, active.task, { to: t.status, trigger: 'run_paused', actor: 'dispatcher', facts: { reason: describePause(pause, this.now()) } });
      }
    } else if (prev.model && r.turns > 0 && !r.error) {
      // 模型正常响应过：清除它残留的暂停记录（自动恢复后的第一次成功，连续暂停次数归零）
      const p = store.readModelPauses().pauses.find((x) => x.model === prev.model);
      if (p && !pauseActive(p, this.now())) await clearPause(store, prev.model, 'dispatcher', '恢复后已正常响应');
    }
    if (timedOut) {
      // 超过时间预算被结束：不计失败，等主会话复核（接着做、从头做或交给用户）
      const t = store.readTask(active.flow, active.task);
      if (t.lease?.run_id === runId && t.status === 'in_progress') {
        await store.transitionTask(active.flow, active.task, {
          to: t.status, trigger: 'run_timeout', actor: 'dispatcher',
          patch: { timeout_review: { run: runId, at: this.now().toISOString(), minutes: active.minutes, ...(r.lastText?.trim() ? { last_text: r.lastText.trim().slice(-1500) } : {}) } },
          facts: { reason: `运行超过时间预算 ${active.minutes} 分钟（宽限 ${graceMinutes(this.d.config)} 分钟后结束）` },
        });
        if (this.d.config.limits.timeout_review !== 'orchestrator') await this.autoReviewTimeout(active.flow, active.task);
      }
    } else if (failure?.recovery === 'hand_to_user') {
      const t = store.readTask(active.flow, active.task);
      if (t.lease?.run_id === runId && t.status === 'in_progress') {
        await store.transitionTask(active.flow, active.task, { to: 'blocked', trigger: 'block', actor: 'dispatcher', facts: { reason: failure.reason } });
        await store.recordEvent({ flow: active.flow, task: active.task, actor: 'dispatcher', type: 'note', reason: `需要你处理：${failure.reason}`, data: { needs_human: true, run: runId } });
      }
    } else if (failure && !unavailable) {
      await this.failRun(active.flow, active.task, runId, failure.reason);
    }
    this.notify();
    await this.pump(active.flow);
  }

  /** 超时复核的默认策略（第六轮 C1）：按工作区的进展决定；只读任务没有工作区，判断不了，留给主会话 */
  private async autoReviewTimeout(flowId: string, taskId: string): Promise<void> {
    const { store } = this.d;
    const t = store.readTask(flowId, taskId);
    if (!awaitingReview(t)) return;
    const progress = measureProgress(t);
    if (!progress) return;
    const d = autoTimeoutDecision(t, progress);
    if (d.decision === 'block') {
      await store.transitionTask(flowId, taskId, { to: 'blocked', trigger: 'block', actor: 'dispatcher', facts: { reason: `运行超时：${d.note}` } });
      return;
    }
    await store.updateTask(flowId, taskId, { timeout_review: { ...t.timeout_review!, decision: d.decision, note: d.note }, timeout_progress: { ...progress, decision: d.decision } },
      { actor: 'dispatcher', type: 'note', reason: `超时复核（程序）：${d.decision === 'continue' ? '接着原会话继续' : '从头换个思路'}`, data: { decision: d.decision, ...progress } });
  }

  /** 程序步骤：promote、推进阶段与验收、合并、重新派发失败或被退回的任务。 */
  private pumpChain: Promise<void> = Promise.resolve();

  /** 程序步骤按流程串行执行：多个 run 同时结束时，避免并发地重复执行同一步骤 */
  pump(flowId: string): Promise<void> {
    this.pumping++;
    const next = this.pumpChain.then(() => this.pumpOnce(flowId), () => this.pumpOnce(flowId)).finally(() => { this.pumping--; });
    this.pumpChain = next.catch(() => {});
    return next;
  }

  /** 排队或执行中的程序步骤数（pump） */
  private pumping = 0;

  private async pumpOnce(flowId: string): Promise<void> {
    const report = this.d.onError ?? (() => {});
    // 阶段边界：本阶段还没同步过主分支时先同步（与合并互斥；合并进行中则下次再试）
    try {
      const flow = this.d.store.readFlow(flowId);
      if (!isLightFlow(flow) && flow.stage_status === 'active' && flow.sync?.stage !== flow.stage) await this.sync(flowId);
    } catch (e) { report(e); }
    // 审查结论先处理：新建的 .rv 要在随后的 promote 中变为 ready
    try { await resolveReviews(this.d.root, this.d.store, this.d.config, flowId); } catch (e) { report(e); }
    // 被打回的变更请求：新建 architect task 返工（要在 promote 之前，新 task 才能就绪）
    try { await ensureChangeTask(this.d.root, this.d.store, this.d.config, flowId); } catch (e) { report(e); }
    try {
      await this.promote(flowId);
    } catch (e) { report(e); }
    try { await advanceInputs(this.d.store, flowId); } catch (e) { report(e); }
    try { this.startPrechecks(flowId); } catch (e) { report(e); }
    for (const listed of this.d.store.listTasks(flowId)) {
      try {
        // 循环中有 await，列表可能已过时：以最新状态为准。失败或被打回、没有租约的任务重新派发（接着原会话）
        const t = this.d.store.readTask(flowId, listed.id);
        if (t.lease) continue;
        if (t.status === 'in_progress' && !this.pausedFor(flowId, t) && !awaitingReview(t)) await this.dispatch(flowId, t.id);
      } catch (e) { if (!(e instanceof HandedToUser)) report(e); }
    }
    // merge-fix 是合并流程的一部分（原任务挂起等待它），P1 的 architect 由程序驱动（主会话只等待）：都由程序直接派发；仍受并发与互斥约束
    try { await this.dispatchProgramDriven(flowId); } catch (e) { report(e); }
    // merge-fix 最终失败：挂起的原任务一并转 blocked（第 10 节 merging → blocked）
    try {
      for (const s of this.d.store.readMergeQueue().suspended ?? []) {
        if (s.flow !== flowId) continue;
        const fix = this.d.store.readTask(flowId, s.merge_fix);
        if (fix.status === 'blocked') {
          await this.d.store.transitionTask(flowId, s.task, { to: 'blocked', trigger: 'merge_blocked', actor: 'merge-queue',
            facts: { reason: `merge-fix ${fix.id} 失败：${fix.blocked_reason ?? ''}` } });
        }
      }
    } catch (e) { report(e); }
    await this.advanceStage(flowId, report);
    // 自动派发（第三轮后续 5）：ready 任务由程序直接派发，由程序推进
    if (this.autoDispatch) {
      try {
        const flow = this.d.store.readFlow(flowId);
        if (!isLightFlow(flow) && flow.stage_status === 'active') await this.next(flowId);
      } catch (e) { report(e); }
    }
    // 串行合并：合并名额空闲且队首就绪时处理
    const mq = this.d.store.readMergeQueue();
    if (!mq.merging && mq.queue.some((e) => e.flow === flowId)) {
      this.track(this.mergeQueue.processNext(flowId).then((r) => {
        if (r) this.d.onMerge?.(r);
        // 有 task 合入：后台跑一次合并后回归测试（不阻塞合并队列）
        if (r?.kind === 'merged') { const pm = this.postMerge.schedule(flowId); if (pm) this.track(pm); }
        this.notify();
        return r ? this.pump(flowId) : undefined;
      }));
    }
    this.notify();
  }

  /** 正在预检的 task（flow/task）；同一 task 不会并发预检 */
  private readonly prechecking = new Set<string>();

  /** 为 checking 状态的 impl、fix、doc、merge-fix 启动预检（后台运行，结束后推进状态并 pump） */
  private startPrechecks(flowId: string): void {
    for (const t of this.d.store.listTasks(flowId)) {
      const key = `${flowId}/${t.id}`;
      if (t.status !== 'checking' || this.prechecking.has(key) || !['impl', 'fix', 'doc', 'merge-fix'].includes(t.kind)) continue;
      this.prechecking.add(key);
      this.track(this.precheckOne(flowId, t.id).catch((e) => this.d.onError?.(e)).finally(() => {
        this.prechecking.delete(key);
        this.notify();
        return this.pump(flowId);
      }));
    }
  }

  private async precheckOne(flowId: string, taskId: string): Promise<void> {
    const { store, root, config } = this.d;
    const t = store.readTask(flowId, taskId);
    if (t.status !== 'checking') return;
    let failure: string | null;
    if (t.kind === 'doc') failure = changeOfTask(store, flowId, t.id) ? changeDocPrecheck(root, store, config, flowId, t) : docPrecheck(root, store, config, flowId, t);
    else {
      const r = await runPrecheck(root, store, config, flowId, t);
      failure = r.ok ? null : r.reason;
    }
    if (store.readTask(flowId, taskId).status !== 'checking') return;
    if (failure) {
      await store.appendHandoff(flowId, taskId, failure, 'engine');
      await store.transitionTask(flowId, taskId, { to: 'in_progress', trigger: 'precheck_fail', actor: 'engine', facts: { precheck_ok: false, reason: failure.slice(0, 4000) } });
      return;
    }
    // 第 10.1 节：按 task.review 或推导决定是否审查；需要时进入 in_review，.rv / .rv-n 由 resolveReviews 创建（pump 串行，不会重复创建）
    if (decideReview(store, config, flowId, store.readTask(flowId, taskId)) === 'skip') {
      await store.transitionTask(flowId, taskId, { to: 'queued_merge', trigger: 'precheck_pass_skip', actor: 'engine', facts: { precheck_ok: true, review_required: false } });
    } else {
      await store.transitionTask(flowId, taskId, { to: 'in_review', trigger: 'precheck_pass', actor: 'engine', facts: { precheck_ok: true, review_required: true } });
    }
  }

  /** 推进等待输入，并就地跑完 checking 的预检（不等其他运行结束；测试用） */
  async precheck(flowId: string): Promise<void> {
    await advanceInputs(this.d.store, flowId);
    for (const t of this.d.store.listTasks(flowId)) {
      const key = `${flowId}/${t.id}`;
      if (t.status !== 'checking' || this.prechecking.has(key) || !['impl', 'fix', 'doc', 'merge-fix'].includes(t.kind)) continue;
      this.prechecking.add(key);
      try { await this.precheckOne(flowId, t.id); } finally { this.prechecking.delete(key); }
    }
    await resolveReviews(this.d.root, this.d.store, this.d.config, flowId);
  }

  /** 不经主会话、由程序直接派发的 ready 任务：merge-fix、逐任务审查（.rv）与 P1 的 architect task */
  private async dispatchProgramDriven(flowId: string): Promise<void> {
    const flow = this.d.store.readFlow(flowId);
    const tasks = this.d.store.listTasks(flowId);
    const ids = selectDispatchable(tasks, flow.stage, this.d.config.limits.max_parallel, this.d.config.limits.max_parallel_aux).filter((id) => {
      const t = tasks.find((x) => x.id === id);
      return !!t && (t.kind === 'merge-fix' || t.kind === 'review' || t.kind === 'qa' || t.kind === 'doc') && !this.pausedFor(flowId, t);
    });
    for (const id of ids) {
      // 循环里有 await，别的推进（子进程退出回调）可能已经派发了它：以最新状态为准
      if (this.d.store.readTask(flowId, id).status !== 'ready') continue;
      try { await this.dispatch(flowId, id); } catch (e) { if (!(e instanceof HandedToUser)) throw e; }
    }
  }

  private readonly gating = new Set<string>();

  /** 阶段推进：设计阶段生成任务；本阶段任务全部完成时执行闸门；无需人工的闸门通过后进入下一阶段 */
  private async advanceStage(flowId: string, report: (e: unknown) => void, force = false): Promise<void> {
    try {
      const flow = this.d.store.readFlow(flowId);
      // 修复与小改动流程（第 13.4 节）：由 fixStep 逐步推进，不跑阶段门禁
      if (isLightFlow(flow)) {
        await fixStep({ root: this.d.root, store: this.d.store, config: this.d.config,
          dispatch: (f, t) => { const task = this.d.store.readTask(f, t); return this.pausedFor(f, task) || awaitingReview(task) ? Promise.resolve(null) : this.dispatch(f, t).catch((e) => { if (!(e instanceof HandedToUser)) throw e; }); },
          promote: (f) => this.promote(f), ...(this.d.now ? { now: this.d.now } : {}) }, flowId);
        return;
      }
      if (this.gating.has(flowId)) return;
      // P1：保证有一个进行中的 architect task（首次进入、打回或闸门未通过后返工）
      if (isArchitectStage(flow.stage) && flow.stage_status === 'active' && await ensureArchitectTask(this.d.store, this.d.config, flowId, this.workerModel())) {
        await this.promote(flowId);
        await this.dispatchProgramDriven(flowId);
        return;
      }
      // P0 只处理已提交后的闸门（包括崩溃恢复）
      if (flow.stage === 'P0') {
        if (flow.stage_status !== 'awaiting_gate') {
          if (!force || flow.stage_status !== 'active' || !flow.spec) return;
          await this.d.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
        }
        this.gating.add(flowId);
        try {
          const result = await runStageGate(this.d.root, this.d.store, this.d.config, flowId);
          this.d.onGate?.(result);
        }
        finally { this.gating.delete(flowId); this.notify(); }
        return;
      }
      // P1：architect 的任务都结束后跑 P1 闸门；未通过时返工
      if (isArchitectStage(flow.stage)) {
        if (force && flow.stage_status === 'needs_human') await this.d.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'gate_rerun', actor: 'human' });
        else {
          if (flow.stage_status !== 'active') return;
          if (!this.d.store.listTasks(flowId).filter((t) => t.stage === flow.stage).every(isSettled)) return;
          if (!force && gateFailedWithoutChange(this.d.store, flowId, flow.stage)) return;
          await this.d.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
        }
        this.gating.add(flowId);
        this.notify();
        this.track(runStageGate(this.d.root, this.d.store, this.d.config, flowId, this.d.verifyTimeoutMs)
          .then(async (g) => {
            this.d.onGate?.(g);
            if (!g.passed) await this.d.store.setPlanRework(flowId, `${flow.stage === P1_STAGE ? 'P1 ' : '纳管'}闸门未通过：\n${g.reasons.join('\n')}`.slice(0, 4000), 'gate');
          })
          .finally(() => this.gating.delete(flowId))
          .then(() => { this.notify(); return this.pump(flowId); }));
        return;
      }
      // 实施阶段（第 7.6、11 节）：门禁与覆盖率 → stage-qa → 修复 → 只确认 → 签收；编排见 stage-acceptance.ts
      // 合并后回归测试还在跑：先等它（它可能定位到 task 建修复；通过的结果门禁直接沿用），结束后会再推进
      if (!force && flow.stage_status === 'active' && this.postMerge.isRunning(flowId)) return;
      const deps = { root: this.d.root, store: this.d.store, config: this.d.config };
      const step = await stageStep(deps, flowId, { force, gateFailedWithoutChange: () => gateFailedWithoutChange(this.d.store, flowId, flow.stage) });
      if (step === 'done') { await this.d.store.advanceStage(flowId, 'gate'); this.notify(); return; }
      if (step === 'changed') { await this.promote(flowId); await this.dispatchProgramDriven(flowId); this.notify(); return; }
      if (step !== 'gate') return;
      this.gating.add(flowId);
      this.notify();
      this.track(runImplementationChecks(this.d.root, this.d.store, this.d.config, flowId, this.d.verifyTimeoutMs)
        .then(async (g) => {
          const r = await afterChecks(deps, flowId, g);
          const after = this.d.store.readFlow(flowId);
          this.d.onGate?.({ stage: g.stage, passed: g.passed, needsHuman: after.stage_status === 'awaiting_human' || after.stage_status === 'needs_human', reasons: r.note ? [...g.reasons, r.note] : g.reasons, ...(g.failed ? { failed: g.failed } : {}) });
          if (r.done) await this.d.store.advanceStage(flowId, 'gate');
        })
        .finally(() => this.gating.delete(flowId))
        .then(async () => { await this.promote(flowId); await this.dispatchProgramDriven(flowId); this.notify(); return this.pump(flowId); }));
    } catch (e) { report(e); }
  }

  /** 把主分支同步进集成分支（阶段边界自动执行；/forge sync 手动执行）。合并进行中返回 null。 */
  async sync(flowId: string): Promise<SyncResult | null> {
    const r = await this.mergeQueue.syncMain(flowId);
    if (r) {
      this.d.onSync?.(flowId, r);
      if (r.kind === 'merge_fix') await this.promote(flowId);
      this.notify();
    }
    return r;
  }

  /** /forge gate：闸门失败后由用户手动重跑 */
  async rerunGate(flowId: string): Promise<void> {
    await this.advanceStage(flowId, this.d.onError ?? (() => {}), true);
    await this.idle();
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e) => (this.d.onError ?? (() => {}))(e)).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** 租约到期仍在运行的 run：终止子进程，退出处理会按 run_failed 计一次失败。返回被终止的 run。 */
  checkLeases(): string[] {
    const killed: string[] = [];
    for (const [runId, r] of this.runs) {
      let t: TaskFile;
      try { t = this.d.store.readTask(r.flow, r.task); } catch { continue; }
      if (t.lease?.run_id === runId && this.now().getTime() >= Date.parse(t.lease.expires_at)) {
        r.handle.kill();
        killed.push(runId);
      }
    }
    return killed;
  }

  /**
   * 时间预算：到期的运行先插话提醒收尾，宽限期后结束（记为 timeout，退出处理转为等主会话复核）。
   * 不支持插话的子进程直接等宽限期结束。返回本次结束的 run。
   */
  async checkDeadlines(): Promise<string[]> {
    const killed: string[] = [];
    const now = this.now().getTime();
    const grace = graceMinutes(this.d.config);
    for (const [runId, r] of this.runs) {
      if (r.timedOut || now < r.deadline) continue;
      if (now >= r.deadline + grace * 60_000) {
        // 宽限期内已经提交（租约已交出）的不算超时，等它自己退出
        let t: TaskFile;
        try { t = this.d.store.readTask(r.flow, r.task); } catch { continue; }
        if (t.lease?.run_id !== runId) continue;
        r.timedOut = true;
        await this.d.store.updateRun(runId, { outcome: 'timeout' }, 'dispatcher', `超过时间预算 ${r.minutes} 分钟，结束运行`).catch(() => {});
        r.handle.kill();
        killed.push(runId);
      } else if (!r.warned) {
        r.warned = true;
        const sent = r.handle.steer?.(wrapUpMessage(r.minutes, grace)) ?? false;
        await this.d.store.updateRun(runId, { warned_at: new Date(now).toISOString() }, 'dispatcher', `时间预算 ${r.minutes} 分钟已到，${sent ? '提醒收尾' : '无法插话，宽限期后结束'}`).catch(() => {});
      }
    }
    return killed;
  }

  private watchTimer: NodeJS.Timeout | null = null;
  /** 已处理过的自动恢复（模型@恢复时间），避免同一次到期重复推进 */
  private readonly resumed = new Set<string>();

  /** 暂停到期的模型：推进受影响的流程（派发等它恢复的任务）。返回到期的模型。 */
  checkPauses(): string[] {
    const due = this.d.store.readModelPauses().pauses.filter((p) => p.retry_after && !pauseActive(p, this.now()) && !this.resumed.has(`${p.model}@${p.retry_after}`));
    for (const p of due) {
      this.resumed.add(`${p.model}@${p.retry_after}`);
      this.pumpFlowsOf(p);
    }
    return due.map((p) => p.model);
  }

  /** 用户恢复模型（/forge models resume）：删除暂停记录并推进受影响的流程 */
  async resumeModel(model: string): Promise<ModelPause | null> {
    const p = await clearPause(this.d.store, model, 'human', '用户恢复');
    if (p) this.pumpFlowsOf(p);
    this.notify();
    return p;
  }

  /** 角色模型改动后（/forge-config）：推进等待暂停模型的流程，换了模型的任务立即继续 */
  retryPaused(): void {
    for (const p of this.d.store.readModelPauses().pauses) this.pumpFlowsOf(p);
  }

  private pumpFlowsOf(p: ModelPause): void {
    const flows = new Set(p.tasks.map((k) => k.split('/')[0]!));
    for (const f of flows) {
      let flow;
      try { flow = this.d.store.readFlow(f); } catch { continue; }
      // 轻流程（修复、小改动）由 pump 推进；其他流程的 ready 任务由程序直接派发（与 /forge budget 提高预算后相同）
      const light = isLightFlow(flow);
      this.track(this.pump(f).then(() => (!light && this.d.store.readFlow(f).stage_status === 'active' ? this.next(f) : undefined)));
    }
  }

  /** 周期性检查租约（不阻止进程退出） */
  startLeaseWatch(intervalMs = 30_000): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      this.checkLeases();
      this.checkDeadlines().catch((e) => (this.d.onError ?? (() => {}))(e));
      try { this.checkPauses(); } catch (e) { (this.d.onError ?? (() => {}))(e); }
      try { this.checkWatch(); } catch (e) { (this.d.onError ?? (() => {}))(e); }
      try { this.checkCheckpoints(); } catch (e) { (this.d.onError ?? (() => {}))(e); }
    }, intervalMs);
    this.watchTimer.unref();
  }

  /** 每个运行上一次拍检查点的时刻（毫秒） */
  private readonly checkpointAt = new Map<string, number>();

  /**
   * 自动检查点（第六轮 7.4）：运行中每 limits.checkpoint_minutes 给任务工作区拍快照；已结束任务的检查点删除。
   * 返回本次拍了检查点的任务。
   */
  checkCheckpoints(): string[] {
    const { store, root, config } = this.d;
    const every = (config.limits.checkpoint_minutes ?? DEFAULT_CHECKPOINT_MINUTES) * 60_000;
    const now = this.now().getTime();
    const made: string[] = [];
    for (const [runId, r] of this.runs) {
      const since = this.checkpointAt.get(runId) ?? r.deadline - r.minutes * 60_000;
      if (now - since < every) continue;
      this.checkpointAt.set(runId, now);
      let t: TaskFile;
      try { t = store.readTask(r.flow, r.task); } catch { continue; }
      if (!t.worktree || !existsSync(t.worktree) || t.lease?.run_id !== runId) continue;
      try { if (createCheckpoint(root, t.worktree, r.flow, r.task, this.now())) made.push(r.task); } catch { /* 拍快照失败不影响运行 */ }
    }
    for (const c of listCheckpoints(root)) {
      let status: string;
      try { status = store.readTask(c.flow, c.task).status; } catch { status = 'cancelled'; }
      if (status === 'done' || status === 'cancelled') dropCheckpoint(root, c.flow, c.task);
    }
    for (const id of this.checkpointAt.keys()) if (!this.runs.has(id)) this.checkpointAt.delete(id);
    return made;
  }

  /** 已通知过的停滞、卡住、超出时间预算（第六轮 B6），同一情况只通知一次 */
  private readonly watched = new Set<string>();

  /**
   * 流程看守：停滞、卡住、时间预算用完都不会产生状态变化，由定时检查发现后触发一次变化通知（主会话据此提醒用户）。
   * 返回本次新发现的情况。
   */
  checkWatch(): string[] {
    const { store, config } = this.d;
    const now = this.now();
    const found: string[] = [];
    for (const flow of store.listFlows().map((id) => store.readFlow(id)).filter((f) => !isFinished(f))) {
      const tasks = store.listTasks(flow.id);
      const stuck = stuckTasks(flow, tasks);
      if (stuck?.length) found.push(`${flow.id}:stuck:${stuck.map((t) => `${t.id}@${t.version}`).join(',')}`);
      const stall = stallOf(store, config, flow, now);
      if (stall) found.push(`${flow.id}:stall:${stall.seq}`);
      if (budgetState(store, config, flow, now)?.exceeded) found.push(`${flow.id}:budget`);
    }
    const fresh = found.filter((k) => !this.watched.has(k));
    for (const k of fresh) this.watched.add(k);
    if (fresh.length) this.notify();
    return fresh;
  }

  /** 订阅状态变化（用于主动通知）；返回取消订阅函数 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 等待任何状态变化（或超时）；用于 forge_wait */
  waitForChange(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (changed: boolean) => { clearTimeout(timer); this.listeners.delete(onChange); resolve(changed); };
      const onChange = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.listeners.add(onChange);
    });
  }

  /** 等到没有运行中的子进程与程序步骤（测试与关闭时使用） */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** 运行中插话（/forge-add）：送到这个任务正在运行的子进程；没有运行中的子进程或不支持时返回 false */
  steer(flowId: string, taskId: string, message: string): boolean {
    for (const r of this.runs.values()) if (r.flow === flowId && r.task === taskId) return r.handle.steer?.(message) ?? false;
    return false;
  }

  kill(runId: string): void {
    this.runs.get(runId)?.handle.kill();
  }

  killAll(): void {
    for (const r of this.runs.values()) r.handle.kill();
  }
}
