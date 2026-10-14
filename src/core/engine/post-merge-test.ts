// 合并后回归测试：每次有 task 合入集成分支后，在后台对最新的集成分支跑一遍门禁命令（不阻塞合并队列，连续合并时只测最新提交）。
//  - 通过：记下这棵代码树上通过的命令（阶段门禁在同一棵树上直接沿用）。
//  - 失败：同一提交重跑一次，通过就记为不稳定，不归到任何 task；仍失败就在"上一次通过"到这次之间的任务合并里二分，
//    找到第一个变红的合并（每次合并是一个 squash 提交，对应一个 task），给它建修复任务（.fx-n），附上失败输出。
//  - 检查进行中时阶段门禁先等它（引擎），这样阶段最后一个合并引入的回归也能定位到 task；门禁随后沿用通过的结果。
//  - 阶段不在进行中、已有未完成的回归修复、或者定位不到 task 时只记录，交给阶段门禁。
// limits.post_merge_test: false 关闭。修复与小改动流程不跑。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import { isLightFlow, type FlowEvent, type TaskFile } from '../state/schemas.ts';
import { isSettled } from '../state/state-machine.ts';
import { git } from '../state/git.ts';
import { headSha, removeWorktree, worktreesRoot } from '../workspace/worktree.ts';
import { evidenceText, failureSummary, noteToolMissing, runShell } from '../workspace/verify-runner.ts';
import { prepareWorkspaceRecorded } from '../workspace/workspace.ts';
import { resourceOptions, withResources } from '../workspace/resources.ts';
import { recordVerified, treeOfCommit } from '../verify/verify-cache.ts';
import { createStageFixTasks, mergedFilesByTask } from '../acceptance/stage-fix.ts';
import { stageDef } from '../stage/gates.ts';

/** 事件 data.kind */
export const POST_MERGE = 'post_merge_test';

/** 同一个 task 最多因合并后回归测试建几次修复 */
export const MAX_REGRESSION_FIXES = 2;

export const postMergeEnabled = (config: FlowConfig) => config.raw.limits.post_merge_test !== false;

export interface SuiteResult { ok: boolean; failed?: { command: string; output: string } }

/** 集成分支上的任务合并：提交 → task（来自 merge 事件的 data.to） */
export function mergeCommits(events: readonly Pick<FlowEvent, 'flow' | 'type' | 'task' | 'data'>[], flowId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) if (e.flow === flowId && e.type === 'merge' && e.task && typeof e.data?.['to'] === 'string') out.set(e.data['to'], e.task);
  return out;
}

/** 最近一次合并后回归测试通过的提交 */
export function lastGreen(events: readonly Pick<FlowEvent, 'flow' | 'type' | 'data'>[], flowId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.flow === flowId && e.type === 'note' && e.data?.['kind'] === POST_MERGE && e.data['ok'] === true && typeof e.data['head'] === 'string') return e.data['head'];
  }
  return null;
}

/** 这个提交是否已经测过（结果记在事件里） */
const checkedHead = (events: readonly Pick<FlowEvent, 'flow' | 'type' | 'data'>[], flowId: string, head: string) =>
  events.some((e) => e.flow === flowId && e.type === 'note' && e.data?.['kind'] === POST_MERGE && e.data['head'] === head);

/**
 * 二分（纯逻辑）：已知 passes(-1)（基线）通过、passes(n-1) 失败，找第一个失败的下标。passes 只对中间的下标调用。
 */
export async function firstFailing(n: number, passes: (i: number) => Promise<boolean>): Promise<number> {
  let lo = -1; let hi = n - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await passes(mid)) lo = mid; else hi = mid;
  }
  return hi;
}

/** 回归归到哪个 impl：修复任务归原 task，merge-fix 归被它解决冲突的 task */
export function implOf(taskId: string, tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'merge_fix_for'>[]): string | null {
  let t = tasks.find((x) => x.id === taskId);
  for (let i = 0; t && i < 5; i++) {
    if (t.kind === 'impl') return t.id;
    const next = t.kind === 'fix' ? t.for_task : t.kind === 'merge-fix' ? t.merge_fix_for : undefined;
    t = next ? tasks.find((x) => x.id === next) : undefined;
  }
  return null;
}

/** 还没完成的回归修复（上一次定位后建的 .fx） */
function openRegressionFix(store: StateStore, flowId: string): string | null {
  const tasks = store.listTasks(flowId);
  for (const e of [...store.readEvents()].reverse()) {
    if (e.flow !== flowId || e.type !== 'note' || e.data?.['kind'] !== POST_MERGE || !Array.isArray(e.data['fix'])) continue;
    const open = (e.data['fix'] as string[]).find((id) => { const t = tasks.find((x) => x.id === id); return t && !isSettled(t); });
    return open ?? null;
  }
  return null;
}

export interface PostMergeDeps { root: string; store: StateStore; config: FlowConfig; timeoutMs?: number }

/** 在某个提交上跑本阶段的门禁命令（临时 detached worktree，用完即删），遇到第一个失败就停 */
export async function runSuiteAt(d: PostMergeDeps, flowId: string, sha: string): Promise<SuiteResult> {
  const { root, store, config } = d;
  const flow = store.readFlow(flowId);
  const plan = (stageDef(config, flow.stage).gate.auto ?? []).filter((n) => config.commands[n]?.trim()).map((name) => ({ name, shell: config.commands[name]!.replace('{files}', '').trim() }));
  if (!plan.length) return { ok: true };
  const wt = path.join(worktreesRoot(root), `${flowId}-pm-${sha.slice(0, 10)}`);
  mkdirSync(path.dirname(wt), { recursive: true });
  removeWorktree(root, wt);
  git(root, ['worktree', 'add', '-q', '--detach', wt, sha]);
  try {
    const prep = await prepareWorkspaceRecorded(store, root, config, wt, 'readonly', { flow: flowId, actor: 'post-merge' }, d.timeoutMs);
    if (!prep.ok) return { ok: false, failed: { command: 'install', output: prep.reason ?? '' } };
    return await withResources(root, `pm-${flowId}-${sha.slice(0, 8)}`, resourceOptions(config), async (env) => {
      const passed: { name: string; shell: string; evidence: string }[] = [];
      let failed: SuiteResult['failed'];
      for (const { name, shell } of plan) {
        const r = { command: name, ...(await runShell(shell, wt, d.timeoutMs, env)) };
        if (await noteToolMissing(store, r, { flow: flowId, stage: flow.stage, actor: 'post-merge' })) continue;
        if (r.exit_code !== 0) { failed = { command: name, output: r.output }; break; }
        passed.push({ name, shell, evidence: await store.saveStageEvidence(flowId, flow.stage, `post-merge-${sha.slice(0, 8)}-${name}.log`, evidenceText(r, shell), 'post-merge') });
      }
      // 通过的命令记下来：阶段门禁在同一棵代码树上沿用
      await recordVerified(store, flowId, treeOfCommit(root, sha), passed, { stage: flow.stage, actor: 'post-merge' });
      return failed ? { ok: false, failed } : { ok: true };
    });
  } finally {
    removeWorktree(root, wt);
  }
}

const record = (store: StateStore, flowId: string, reason: string, data: Record<string, unknown>) =>
  store.recordEvent({ flow: flowId, actor: 'post-merge', type: 'note', reason, data: { kind: POST_MERGE, ...data } });

/**
 * 测一次集成分支最新提交；失败时定位并建修复任务。返回新建的修复任务（调用方据此推进派发）。
 * suite 可替换（测试用）。
 */
export async function checkIntegration(d: PostMergeDeps, flowId: string, suite: (sha: string) => Promise<SuiteResult> = (sha) => runSuiteAt(d, flowId, sha)): Promise<string[]> {
  const { root, store } = d;
  const flow = store.readFlow(flowId);
  if (isLightFlow(flow)) return [];
  const head = headSha(root, flow.integration_branch);
  if (checkedHead(store.readEvents(), flowId, head)) return [];
  const r = await suite(head);
  if (r.ok) { await record(store, flowId, `合并后回归测试通过（${head.slice(0, 8)}）`, { head, ok: true }); return []; }
  // 同一提交重跑一次：通过就是不稳定的测试，不归到任何 task
  const again = await suite(head);
  if (again.ok) {
    await record(store, flowId, `合并后回归测试在 ${head.slice(0, 8)} 上第一次失败、重跑通过：${r.failed!.command} 可能不稳定`, { head, ok: true, flaky: r.failed!.command });
    return [];
  }
  const failed = again.failed!;
  const red = { head, ok: false, command: failed.command };
  const tail = failureSummary(failed.output, 2000);
  const latest = store.readFlow(flowId);
  if (latest.stage_status !== 'active') { await record(store, flowId, `合并后回归测试失败（${head.slice(0, 8)}，${failed.command}），阶段不在进行中，交给阶段检查`, red); return []; }
  const open = openRegressionFix(store, flowId);
  if (open) { await record(store, flowId, `合并后回归测试仍失败（${head.slice(0, 8)}，${failed.command}），等回归修复 ${open} 合入`, red); return []; }

  // 上一次通过到这次之间的任务合并，按时间顺序
  const commits = mergeCommits(store.readEvents(), flowId);
  let base = lastGreen(store.readEvents(), flowId);
  if (!base) {
    // 还没有通过的记录：拿本流程第一次合并之前的提交当基线，先确认它通过
    const first = store.readEvents().find((e) => e.flow === flowId && e.type === 'merge' && typeof e.data?.['from'] === 'string');
    const candidate = first ? String(first.data!['from']) : null;
    if (candidate && candidate !== head && (await suite(candidate)).ok) {
      await record(store, flowId, `合并后回归测试的基线 ${candidate.slice(0, 8)} 通过`, { head: candidate, ok: true });
      base = candidate;
    }
  }
  const range = base ? git(root, ['rev-list', '--first-parent', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean) : [];
  const merges = range.filter((sha) => commits.has(sha));
  if (!base || !merges.length) { await record(store, flowId, `合并后回归测试失败（${head.slice(0, 8)}，${failed.command}）：${base ? '这段提交里没有任务合并' : '没有通过的基线'}，交给阶段检查`, red); return []; }
  const idx = merges.length === 1 ? 0 : await firstFailing(merges.length, async (i) => (await suite(merges[i]!)).ok);
  const culpritSha = merges[idx]!;
  const culpritTask = commits.get(culpritSha)!;
  const tasks = store.listTasks(flowId);
  const impl = implOf(culpritTask, tasks);
  if (!impl) { await record(store, flowId, `合并后回归测试失败，定位到 ${culpritTask} 的合并（${culpritSha.slice(0, 8)}），但找不到负责的实施任务，交给阶段检查`, { ...red, culprit: culpritTask }); return []; }
  // 同一个 task 已经因回归修过 MAX_REGRESSION_FIXES 次仍定位到它：不再建修复，交给阶段门禁（它的修复轮数有上限）
  const fixedBefore = store.readEvents().filter((e) => e.flow === flowId && e.type === 'note' && e.data?.['kind'] === POST_MERGE && e.data['impl'] === impl && Array.isArray(e.data['fix']) && (e.data['fix'] as unknown[]).length).length;
  if (fixedBefore >= MAX_REGRESSION_FIXES) { await record(store, flowId, `合并后回归测试失败，定位到 ${culpritTask}，它已因回归修过 ${fixedBefore} 次，交给阶段检查`, { ...red, culprit: culpritTask, impl }); return []; }
  const files = mergedFilesByTask(store, flowId).get(culpritTask) ?? [];
  const prev = idx > 0 ? merges[idx - 1]! : base;
  const text = [
    `合并后的全量检查在 ${culpritTask} 合入（${culpritSha.slice(0, 8)}）后失败，之前的提交（${prev.slice(0, 8)}）通过：多半是这次合并引入了回归，也可能是它与先合入的改动冲突。`,
    `失败的命令：${failed.command}`, '```', tail, '```',
  ].join('\n');
  const { tasks: fix } = await createStageFixTasks(store, flowId, 'post_merge', [{ files, text, owner: impl }], `合并 ${culpritSha.slice(0, 8)}`, 'post-merge');
  await record(store, flowId, `合并后回归测试失败（${failed.command}），二分定位到 ${culpritTask} 的合并${fix.length ? `，已建修复 ${fix.join('、')}` : ''}`, { ...red, culprit: culpritTask, impl, fix });
  return fix;
}

/** 引擎内的调度：同一流程同时只跑一次；跑的期间又有合并，结束后再测最新的提交 */
export class PostMergeTester {
  private readonly d: PostMergeDeps;
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly onDone: (flowId: string) => Promise<void> | void;
  private readonly onError: (e: unknown) => void;

  /** onDone：一轮检查结束（可能建了修复任务）后推进流程；阶段门禁在检查进行中时等它 */
  constructor(d: PostMergeDeps, onDone: (flowId: string) => Promise<void> | void, onError: (e: unknown) => void) {
    this.d = d;
    this.onDone = onDone;
    this.onError = onError;
  }

  /** 有合并时调用；返回这次（或正在进行的）检查，调用方可以跟踪它 */
  schedule(flowId: string): Promise<void> | null {
    if (!postMergeEnabled(this.d.config)) return null;
    const cur = this.running.get(flowId);
    if (cur) { this.again.add(flowId); return cur; }
    const p = (async () => {
      try {
        do {
          this.again.delete(flowId);
          await checkIntegration(this.d, flowId);
        } while (this.again.has(flowId));
      } catch (e) { this.onError(e); } finally { this.running.delete(flowId); }
      await this.onDone(flowId);
    })();
    this.running.set(flowId, p);
    return p;
  }

  isRunning(flowId: string): boolean { return this.running.has(flowId); }
}

/** 状态里的一行：最近一次合并后回归测试的结果 */
export function postMergeStatus(store: StateStore, flowId: string, running: boolean): string | null {
  const e = [...store.readEvents()].reverse().find((x) => x.flow === flowId && x.type === 'note' && x.data?.['kind'] === POST_MERGE);
  if (!e && !running) return null;
  return `合并后回归测试：${running ? '运行中' : ''}${running && e ? '；上一次 ' : ''}${e ? e.reason ?? '' : ''}`;
}
