// 精简模式（lean，规格第 7.6 节）的阶段审查：不做逐任务审查，阶段的 impl 全部合并后、门禁之前，reviewer 对整个阶段的 diff 审查一次（S1.rv）；
// 有 must 时生成 fix task（T-003.fx-n，fork 原 worker），修好后由 S1.rv-2 只确认；仍未解决的转阶段 needs_human。
// 机制与逐任务审查相同（出处校验与降级、第二轮只确认），工具仍是 forge_review_report / forge_review_confirm，evidence 文件名也相同（review-*.json）。
//
// 引擎的调用约定（advanceStage 编排；返回值见 stage-rounds.ts 的 StageRoundOutcome）：
//   1. 阶段的 impl 等 task 全部 settled，且还没有 .rv（resolveStageReview → none）：createStageReview(…, head) 创建 S1.rv；
//   2. resolveStageReview → running：等待；blocked / exhausted：阶段转 needs_human（reason 给用户）；
//   3. → pass：继续门禁；
//   4. → fix：fix task 已生成（幂等），等它们合并；
//   5. → fix-done：fix task 都完成。重新 settled 之后再 createStageReview(…, head) 创建 S1.rv-2（确认轮，带上一轮未解决的 must），回到第 2 步。
// 阶段级 .rv 用集成分支 HEAD 的临时 worktree（stage-worktree.ts），任务 done 后由 resolveStageReview 清理。
import type { FlowConfig } from './config.ts';
import type { TaskFile } from './schemas.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import { git } from './git.ts';
import { GLOSSARY_MAX, buildReviewBrief, reviewPolicy, stripAcceptanceDiff, truncateDiff } from './review.ts';
import { REVIEW_FILES, REVIEW_INPUT, readReviewEvidence, type ReviewInputFile } from './review-flow.ts';
import { readSpec } from './spec-flow.ts';
import { readStageExit, stageBaseFor } from './stage-qa.ts';
import { resolveRounds, unresolvedIn, type RoundSpec, type StageRoundOutcome } from './stage-rounds.ts';
import { STAGE_RV_ID } from './stage-worktree.ts';

/** S1.rv → 1，S1.rv-2 → 2；不是阶段级审查返回 0 */
export function stageReviewRoundOf(id: string): number {
  const m = /^[A-Za-z][A-Za-z0-9_]*\.rv(?:-(\d+))?$/.exec(id);
  return m ? Number(m[1] ?? 1) : 0;
}

const isStageRvOf = (t: Pick<TaskFile, 'id' | 'kind' | 'for_task'>, stage: string) =>
  t.kind === 'review' && !t.for_task && STAGE_RV_ID.test(t.id) && (t.id === `${stage}.rv` || t.id.startsWith(`${stage}.rv-`));

/** 本阶段的阶段级审查 task（忽略已取消的），按轮次升序 */
export function stageReviewsOf<T extends Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status'>>(tasks: readonly T[], stage: string): T[] {
  return tasks.filter((t) => isStageRvOf(t, stage) && t.status !== 'cancelled').sort((a, b) => stageReviewRoundOf(a.id) - stageReviewRoundOf(b.id));
}

/** 下一轮的编号：S1.rv → S1.rv-2 → S1.rv-3（取消的轮次也占编号） */
export function nextStageReviewId(tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'for_task'>[], stage: string): string {
  const rounds = tasks.filter((t) => isStageRvOf(t, stage)).map((t) => stageReviewRoundOf(t.id));
  const next = Math.max(0, ...rounds) + 1;
  return next === 1 ? `${stage}.rv` : `${stage}.rv-${next}`;
}

/** 已进行的阶段审查轮数（忽略已取消的） */
export const stageReviewRounds = (tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status'>[], stage: string): number => stageReviewsOf(tasks, stage).length;

/**
 * 创建下一轮阶段审查（S1.rv / S1.rv-k）：整个阶段的 diff（阶段基线到 head，去掉 tests/acceptance/**，截断同逐任务审查）；
 * 确认轮只带上一轮的 must 与上一轮之后的增量 diff。reviewer 角色，kind review，没有 for_task。
 */
export async function createStageReview(root: string, store: StateStore, config: FlowConfig, flowId: string, stage: string, head: string, actor = 'engine'): Promise<TaskFile> {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const prev = stageReviewsOf(tasks, stage).at(-1);
  const priorMust = prev && prev.status === 'done' ? unresolvedIn(store, flowId, prev.id, REVIEW_FILES) ?? [] : [];
  const prevInput = prev ? readReviewEvidence<ReviewInputFile>(store, flowId, prev.id, REVIEW_INPUT) : null;
  const confirm = priorMust.length > 0;
  const id = nextStageReviewId(tasks, stage);
  const base = stageBaseFor(root, tasks, stage, flow.base_sha);
  const from = confirm ? prevInput?.head ?? base : base;
  const raw = git(root, ['diff', '--no-color', '--no-ext-diff', from, head, '--', '.', ':(exclude)tests/acceptance']);
  const diff = truncateDiff(stripAcceptanceDiff(raw));

  const { goal, exit } = readStageExit(root, store, flowId, stage);
  let glossary = '';
  if (!confirm) { try { glossary = readSpec(root, flow.integration_branch).files.glossary.slice(0, GLOSSARY_MAX); } catch { /* 读不到时不给 */ } }
  const acTexts: Record<string, string> = {};
  for (const r of exit) for (const a of r.acs) acTexts[a.id] = a.text;
  const deviations = [...new Set(tasks.filter((t) => t.stage === stage).flatMap((t) => (t.deviations ?? []).map((d) => `${t.id}：${d}`)))];
  const brief = buildReviewBrief({
    taskId: stage, title: `阶段整体审查（${goal}）`, reviewId: id, acIds: exit.flatMap((r) => r.acs.map((a) => a.id)), acTexts,
    contracts: { shown: [], omitted: [] }, glossary, deviations, range: { from, to: head }, diff, priorMust,
  });
  const input: TaskInput = {
    id, stage, kind: 'review', role: 'reviewer', title: `阶段审查：${stage}（第 ${stageReviewRoundOf(id)} 轮）`, scopes: [...config.role('reviewer').scopes],
    depends_on: [], inputs: [], writes: [], verify: [], review: 'auto',
  };
  const [rv] = await store.addTasks(flowId, [input], actor);
  const file: ReviewInputFile = { round: stageReviewRoundOf(id), base: from, head, prior_must: priorMust };
  await store.saveEvidence(flowId, id, REVIEW_INPUT, JSON.stringify(file, null, 2), actor);
  await store.appendHandoff(flowId, id, brief, actor);
  return rv!;
}

export const stageReviewSpec = (config: FlowConfig): RoundSpec => ({
  source: 'review', rounds: (tasks, stage) => stageReviewsOf(tasks as TaskFile[], stage), roundOf: stageReviewRoundOf, files: REVIEW_FILES,
  maxRounds: reviewPolicy(config).maxRounds, label: '阶段审查',
});

/** 处理阶段审查的结论；返回值的含义与调用顺序见文件头 */
export function resolveStageReview(root: string, store: StateStore, config: FlowConfig, flowId: string, stage: string): Promise<StageRoundOutcome> {
  return resolveRounds(root, store, flowId, stage, stageReviewSpec(config));
}
