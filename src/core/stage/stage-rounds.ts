// 阶段级审查（lean 的 .rv）与 stage-qa（.qa）共用的"轮次处理"：读取最新一轮的结论，决定通过、生成 fix task、等待修复、或轮数用尽。
// 纯业务逻辑，不依赖 Pi；状态只经 StateStore 写入。两者的差别只在 evidence 文件名、轮数上限和 fix 来源，由 RoundSpec 描述。
import type { TaskFile, ReviewFinding } from '../state/schemas.ts';
import type { StateStore } from '../state/state-store.ts';
import type { ReviewConfirmFile, ReviewInputFile, ReviewReportFile } from './review-flow.ts';
import { appendSuggestions, readReviewEvidence } from './review-flow.ts';
import { formatMust, mustOf } from './review.ts';
import { createStageFixTasks, type StageFixSource } from '../acceptance/stage-fix.ts';
import { cleanupStageWorktrees } from '../workspace/stage-worktree.ts';

/**
 * resolve 的返回值（resolveQa 与 resolveStageReview 相同）：
 * - none：这个阶段还没有这类 task，调用 createXxx 创建第一轮；
 * - running：最新一轮还没结束（含 ready、in_progress、等待 token 等），什么都不用做；
 * - blocked：最新一轮被 forge_block，或已结束但没留下结论；reason 给用户，阶段转 needs_human；
 * - pass：最新一轮没有未解决的 must，可以继续下一步；
 * - fix：有未解决的 must 且轮数没用完：已生成（或之前已生成）fix task（tasks）；其中还有没做完的，等它们合并，不要重复调用 createXxx；
 * - fix-done：fix task 全部 done（或被取消）。调用方在门禁、覆盖率重跑通过后调用 createXxx 开下一轮（只确认）；
 * - exhausted：轮数用尽仍有 must，或问题涉及的文件找不到负责的 task（无法生成 fix）；阶段转 needs_human。
 * 重复调用是幂等的：fix task 靠 source_round（轮次的 task 与序号）识别，不会重复生成；suggest 按 [task R-n] 去重，只追加一次。
 */
export type StageRoundOutcome =
  | { kind: 'none' }
  | { kind: 'running' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'pass' }
  | { kind: 'fix'; tasks: string[]; round: number; unowned: string[] }
  | { kind: 'fix-done'; tasks: string[]; round: number }
  | { kind: 'exhausted'; reason: string };

export interface RoundSpec {
  source: Extract<StageFixSource, 'qa' | 'review'>;
  /** 本阶段这一类 task（按轮次升序，不含已取消的） */
  rounds: (tasks: readonly TaskFile[], stage: string) => TaskFile[];
  roundOf: (id: string) => number;
  files: { input: string; report: string; confirm: string };
  maxRounds: number;
  /** 提示用的名字 */
  label: string;
}

/** 一轮结束后尚未解决的 must；还没有结论时返回 null（纯读取） */
export function unresolvedIn(store: StateStore, flowId: string, id: string, files: RoundSpec['files']): ReviewFinding[] | null {
  const report = readReviewEvidence<ReviewReportFile>(store, flowId, id, files.report);
  if (report) return mustOf(report.issues);
  const confirm = readReviewEvidence<ReviewConfirmFile>(store, flowId, id, files.confirm);
  const input = readReviewEvidence<ReviewInputFile>(store, flowId, id, files.input);
  if (confirm && input) return input.prior_must.filter((m) => confirm.unresolved.includes(m.id));
  return null;
}

/** 轮次的展示名（写进 fix 的标题与说明；认轮次不看它） */
export const roundLabel = (taskId: string, round: number) => `${taskId} 第 ${round} 轮`;
/** 这一轮对应的 fix task（纯函数）：按 fix 的 source_round 字段认，标题被改写也不影响 */
export const fixTasksOfRound = (tasks: readonly TaskFile[], taskId: string, round: number): TaskFile[] =>
  tasks.filter((t) => t.kind === 'fix' && t.source_round?.task === taskId && t.source_round.round === round);

export async function resolveRounds(root: string, store: StateStore, flowId: string, stage: string, spec: RoundSpec): Promise<StageRoundOutcome> {
  const tasks = store.listTasks(flowId);
  const rounds = spec.rounds(tasks, stage);
  const latest = rounds.at(-1);
  if (!latest) return { kind: 'none' };
  if (latest.status === 'blocked') return { kind: 'blocked', reason: `${spec.label} ${latest.id} 无法继续：${latest.blocked_reason ?? '（未写原因）'}` };
  if (latest.status !== 'done') return { kind: 'running' };
  cleanupStageWorktrees(root, store, flowId);
  const left = unresolvedIn(store, flowId, latest.id, spec.files);
  if (left === null) return { kind: 'blocked', reason: `${spec.label} ${latest.id} 已结束但没有留下结论，请检查后重新派发` };
  const report = readReviewEvidence<ReviewReportFile>(store, flowId, latest.id, spec.files.report);
  if (report) appendSuggestions(root, store.readFlow(flowId).integration_branch, latest.id, stage, report.issues.filter((i) => i.level === 'suggest'));
  if (!left.length) return { kind: 'pass' };

  const round = spec.roundOf(latest.id);
  const label = roundLabel(latest.id, round);
  let fixes = fixTasksOfRound(tasks, latest.id, round);
  let unowned: string[] = [];
  if (!fixes.length) {
    if (rounds.length >= spec.maxRounds) {
      return { kind: 'exhausted', reason: `${spec.label}共 ${rounds.length} 轮（上限 ${spec.maxRounds}）后仍有 ${left.length} 条 must 未解决：${left.map((m) => `${m.id} ${m.problem.replace(/\s+/g, ' ').slice(0, 100)}`).join('；')}`.slice(0, 1500) };
    }
    const created = await createStageFixTasks(store, flowId, spec.source, left.map((m) => ({ files: m.files, text: formatMust(m) })), label, 'engine', { task: latest.id, round });
    unowned = created.unowned;
    if (!created.tasks.length) {
      return { kind: 'exhausted', reason: `${spec.label} ${latest.id} 的 ${left.length} 条 must 涉及的文件找不到负责的 task（${created.unowned.slice(0, 10).join('、') || '未列出文件'}），无法生成修复任务，需要你处理` };
    }
    fixes = store.listTasks(flowId).filter((t) => created.tasks.includes(t.id));
  }
  const ids = fixes.map((t) => t.id);
  return fixes.every((t) => t.status === 'done' || t.status === 'cancelled')
    ? { kind: 'fix-done', tasks: ids, round }
    : { kind: 'fix', tasks: ids, round, unowned };
}
