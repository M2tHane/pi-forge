// 阶段闸门（gate）：all_tasks_done、S1/F1 必须有任务提案、在集成分支 HEAD 上执行 auto 命令并保存 evidence。
// 通过后：需要人工 → awaiting_human；否则 → done。最后一个阶段一律需要人工（之后合入主分支）。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import { isSettled } from '../state/state-machine.ts';
import type { StateStore } from '../state/state-store.ts';
import type { FlowEvent } from '../state/schemas.ts';
import { git } from '../state/git.ts';
import { failingFiles } from '../workspace/scope-hint.ts';
import { worktreesRoot, removeWorktree } from '../workspace/worktree.ts';
import { evidenceText, failureSummary, noteToolMissing, runShell } from '../workspace/verify-runner.ts';
import { prepareWorkspaceRecorded } from '../workspace/workspace.ts';
import { resourceOptions, withResources } from '../workspace/resources.ts';

import type { StageDeps } from './stages.ts';
import { isLightFlow, type TaskFile } from '../state/schemas.ts';
import { headSha } from '../workspace/worktree.ts';
import { recordVerified, reusableRuns, reuseText, treeOfCommit } from '../verify/verify-cache.ts';
import { failingAcceptanceDirs } from '../acceptance/acceptance-flow.ts';
import { createStageFixTasks, type StageIssue } from '../acceptance/stage-fix.ts';
import { stageCoverage, writeCoverageReport, type CoverageResult } from '../acceptance/coverage.ts';

/** failed：失败的闸门命令与输出；引擎据此生成有限轮次的修复任务。 */
export interface GateOutcome { stage: string; passed: boolean; needsHuman: boolean; reasons: string[]; failed?: { command: string; output: string } }

/** 阶段门禁：各阶段共用 implementation_gate，auto 里 commands 没定义的命令跳过 */
export function stageDef(config: FlowConfig, stage: string) {
  const gate = config.raw.implementation_gate;
  return { id: stage, gate: {
    auto: (gate?.auto ?? []).filter((name) => !!config.commands[name]?.trim()),
    human: gate?.human ?? true,
  } };
}

export async function runStageGate(root: string, store: StateStore, config: FlowConfig, flowId: string, timeoutMs?: number): Promise<GateOutcome> {
  const flow = store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_gate') throw new Error(`阶段 ${flow.stage} 不在 awaiting_gate 状态`);
  if (isLightFlow(flow)) throw new Error('修复与小改动流程不使用阶段闸门');
  const def = stageDef(config, flow.stage);
  const isLast = flow.stage === flow.stages.at(-1);
  // S0 与最后一个阶段批准时要合入主分支，一律人工
  const needsHuman = !!def.gate.human || isLast || flow.stage === 'S0';
  const reasons: string[] = [];
  let failed: GateOutcome['failed'];

  const open = store.listTasks(flowId).filter((t) => t.stage === flow.stage && !isSettled(t));
  if (open.length) reasons.push(`本阶段还有未完成的任务：${open.map((t) => `${t.id}（${t.status}）`).join('、')}`);
  else {
    const checks = await runImplementationChecks(root, store, config, flowId, timeoutMs);
    reasons.push(...checks.reasons);
    failed = checks.failed;
  }

  const passed = reasons.length === 0;
  if (passed) {
    await store.transitionStage(flowId, { to: needsHuman ? 'awaiting_human' : 'done', trigger: 'gate_passed', actor: 'gate', needs_human: needsHuman });
  } else if ((flow.gate_rounds ?? []).filter((r) => r.stage === flow.stage).length >= MAX_GATE_ROUNDS) {
    await store.transitionStage(flowId, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'gate', reason: reasons.join('；') });
  } else {
    await store.transitionStage(flowId, { to: 'active', trigger: 'gate_failed', actor: 'gate', reason: reasons.join('；') });
  }
  return { stage: flow.stage, passed, needsHuman, reasons, ...(failed ? { failed } : {}) };
}

export interface ImplementationChecks {
  stage: string;
  passed: boolean;
  reasons: string[];
  failed?: { command: string; output: string };
  /** 命令都通过、gate.coverage 开启、且计划里有本阶段时才有 */
  coverage?: CoverageResult;
  /** 写完覆盖报告之后的集成分支 HEAD */
  head: string;
}

/**
 * 实施阶段的程序检查：在集成分支 HEAD 的临时 worktree 里跑 auto 命令（带资源、保存 evidence），
 * 通过后计算覆盖率，把报告存成阶段 evidence（coverage.md）并提交到集成分支的 docs/qa/<stage>.md。覆盖率只报告（签收时给用户看），缺口不拦门禁。
 * 不迁移阶段状态：由调用方（主会话的编排）决定。命令失败时不算覆盖率。
 */
export async function runImplementationChecks(root: string, store: StateStore, config: FlowConfig, flowId: string, timeoutMs?: number): Promise<ImplementationChecks> {
  const flow = store.readFlow(flowId);
  if (isLightFlow(flow)) throw new Error('修复与小改动流程不使用阶段闸门');
  const def = stageDef(config, flow.stage);
  const reasons: string[] = [];
  let failed: ImplementationChecks['failed'];
  const startHead = headSha(root, flow.integration_branch);

  // 同一棵代码树上、命令内容相同、已经通过的命令（通常是最后一次合并验证跑过的）沿用结果，并写沿用记录
  const tree = treeOfCommit(root, startHead);
  const full = (def.gate.auto ?? []).map((name) => ({ name, shell: config.commands[name]!.replace('{files}', '').trim() }));
  const reused = reusableRuns(store.readEvents(), flowId, tree, full);
  if (reused.size) await store.saveStageEvidence(flowId, flow.stage, 'gate-reused.txt', reuseText(tree!, reused), 'gate');
  const plan = full.filter((c) => !reused.has(c.name));
  if (plan.length) {
    const wt = path.join(worktreesRoot(root), `${flowId}-gate-${flow.stage}`);
    mkdirSync(path.dirname(wt), { recursive: true });
    removeWorktree(root, wt);
    git(root, ['worktree', 'add', '-q', '--detach', wt, startHead]);
    try {
      // F1：新 worktree 里没有依赖，先准备（readonly，走缓存）。失败不设 failed：不是某个 task 的问题，交给人
      const prep = await prepareWorkspaceRecorded(store, root, config, wt, 'readonly', { flow: flowId, actor: 'gate' }, timeoutMs);
      if (!prep.ok) reasons.push(`工作区准备失败：${prep.reason ?? ''}`);
      else await withResources(root, `gate-${flowId}-${flow.stage}`, resourceOptions(config), async (env) => {
        const passed: { name: string; shell: string; evidence: string }[] = [];
        for (const { name, shell } of plan) {
          const r = { command: name, ...(await runShell(shell, wt, timeoutMs, env)) };
          const ev = await store.saveStageEvidence(flowId, flow.stage, `gate-${name}.log`, evidenceText(r, shell), 'gate');
          if (await noteToolMissing(store, r, { flow: flowId, stage: flow.stage, actor: 'gate' })) continue;
          if (r.exit_code === 0) passed.push({ name, shell, evidence: ev });
          if (r.exit_code !== 0) {
            reasons.push(`闸门命令 ${name} 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1200)}`);
            failed = { command: name, output: r.output };
            break;
          }
        }
        await recordVerified(store, flowId, tree, passed, { stage: flow.stage, actor: 'gate' });
      });
    } finally {
      removeWorktree(root, wt);
    }
  }

  let coverage: CoverageResult | undefined;
  let head = startHead;
  if (!reasons.length && config.raw.implementation_gate?.coverage !== false && (flow.s_stages ?? []).some((s) => s.id === flow.stage)) {
    try {
      coverage = stageCoverage(root, store, config, flowId, flow.stage, startHead);
      await store.saveStageEvidence(flowId, flow.stage, 'coverage.md', coverage.markdown, 'gate');
      head = await writeCoverageReport(root, store, flowId, flow.stage, coverage.markdown);
    } catch (e) {
      reasons.push(`覆盖率无法计算：${(e as Error).message}`);
    }
  }
  return { stage: flow.stage, passed: reasons.length === 0, reasons, ...(failed ? { failed } : {}), ...(coverage ? { coverage } : {}), head };
}

/** 本阶段最近一次闸门失败之后，是否还没有任何任务状态变化（避免对同样的结果反复跑闸门） */
/**
 * 最近一次门禁失败或用户打回之后，本阶段还没有任何任务状态变化：返回那次事件，否则 null。
 * 用户打回也算：task 都已完成时引擎会立刻重新提交门禁，打回就白费了（stock 实验：打回 6 秒后又回到等签收，主会话来不及提变更请求）。
 */
function stopWithoutChange(store: StateStore, flowId: string, stage: string): FlowEvent | null {
  const events = store.readEvents().filter((e) => e.flow === flowId);
  const last = [...events].reverse().find((e) => e.to === 'active' && e.data?.['stage'] === stage && (e.type === 'gate_result' || e.trigger === 'reject'));
  if (!last) return null;
  const stageTasks = new Set(store.listTasks(flowId).filter((t) => t.stage === stage).map((t) => t.id));
  return events.some((e) => e.seq > last.seq && e.type === 'transition' && e.task && stageTasks.has(e.task)) ? null : last;
}
export const gateFailedWithoutChange = (store: StateStore, flowId: string, stage: string): boolean => !!stopWithoutChange(store, flowId, stage);
/** 用户打回了本阶段、还没有新的任务变化时返回打回意见 */
export function pendingRejection(store: StateStore, flowId: string, stage: string): string | null {
  const e = stopWithoutChange(store, flowId, stage);
  return e?.trigger === 'reject' ? e.reason ?? '' : null;
}

// M6 由 stage-qa 取代：暂时保留 HEAD 的有限门禁修复。
export const MAX_GATE_ROUNDS = 2;
function safeGit(cwd: string, args: string[]): string {
  try { return git(cwd, args).trim(); } catch { return ''; }
}

/**
 * 闸门命令失败的输出 → 问题清单（纯函数）：
 * 日志里的 tests/acceptance/<T-xxx>/ 归该 impl task，可写范围用 impl 自己的 writes（worker 不能写测试）；
 * 其他仓库文件按 writes 归属（stage-fix 的 ownerOf）。
 */
export function gateIssues(failed: { command: string; output: string }, tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'writes'>[], tracked: ReadonlySet<string>): StageIssue[] {
  const tail = failed.output.trim().split('\n').slice(-60).join('\n').slice(-4000);
  const text = `实施阶段的全量 ${failed.command} 失败（程序生成）。\n命令：${failed.command}\n输出（最后部分）：\n\`\`\`\n${tail}\n\`\`\``;
  const issues: StageIssue[] = [];
  for (const dir of failingAcceptanceDirs(failed.output)) {
    const impl = tasks.find((t) => t.id === dir && t.kind === 'impl');
    if (impl) issues.push({ files: [], text, owner: impl.id, writes: impl.writes });
  }
  const files = failingFiles(failed.output, tracked).filter((f) => !f.startsWith('tests/acceptance/'));
  if (files.length) issues.push({ files, text });
  return issues;
}

/**
 * 闸门的全量测试失败：问题按负责的 task 分组，为每个 task 建 .fx-n 修复任务，并记一轮 gate_rounds。
 * 返回生成的任务 id；已修 MAX_GATE_ROUNDS 轮或定位不到负责 task 时返回空数组并给出原因（由调用方提示用户）。
 */
export async function gateFailed(d: StageDeps, flowId: string, failed: { command: string; output: string }): Promise<{ tasks: string[]; reason?: string }> {
  const { store } = d;
  const flow = store.readFlow(flowId);
  const rounds = (flow.gate_rounds ?? []).filter((r) => r.stage === flow.stage);
  if (rounds.length >= MAX_GATE_ROUNDS) return { tasks: [], reason: `全量 ${failed.command} 自动修复 ${MAX_GATE_ROUNDS} 轮后仍失败` };
  const tracked = new Set(safeGit(d.root, ['ls-tree', '-r', '--name-only', flow.integration_branch]).split('\n').filter(Boolean));
  const issues = gateIssues(failed, store.listTasks(flowId), tracked);
  const { tasks } = issues.length ? await createStageFixTasks(store, flowId, 'gate', issues, `第 ${rounds.length + 1} 轮`) : { tasks: [] };
  if (!tasks.length) return { tasks: [], reason: `全量 ${failed.command} 失败，但无法从日志定位负责的 task` };
  await store.addGateRound(flowId, { stage: flow.stage, command: failed.command, tasks, at: new Date().toISOString() }, [], {});
  return { tasks };
}
