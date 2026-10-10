// 逐任务审查的流程部分（规格第 10 节）：决定是否审查、创建 .rv / .rv-n、处理审查结论（通过、打回、轮数用尽）、把 suggest 记入集成分支。
// 结论存为 .rv task 的 evidence（review-input.json、review-report.json、review-confirm.json），不新增 schema；状态只经 StateStore 写入。
// 机制参考 pi-flow 5100d6b^:src/core/stage-review.ts（第二轮只确认）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { ReviewFinding, TaskFile } from './schemas.ts';
import { evidenceRel, type StateStore, type TaskInput } from './state-store.ts';
import { git, gitOk } from './git.ts';
import { commitFilesToBranch } from './intake.ts';
import { headSha } from './worktree.ts';
import { readSpec } from './spec-flow.ts';
import { acTexts, effectiveSpec } from './spec.ts';
import {
  CONTRACT_SNIPPET_MAX, GLOSSARY_MAX, buildReviewBrief, contractFilesFor, fitSnippets, mustHandoff, mustOf, nextReviewId, reviewMode, reviewPolicy,
  reviewRoundOf, reviewTasksOf, stripAcceptanceDiff, suggestionLine, touchesContracts, truncateDiff,
  type ConfirmItem, type Downgraded, type ReviewMode,
} from './review.ts';

export const REVIEW_INPUT = 'review-input.json';
export const REVIEW_REPORT = 'review-report.json';
export const REVIEW_CONFIRM = 'review-confirm.json';
export const REVIEW_FILES = { input: REVIEW_INPUT, report: REVIEW_REPORT, confirm: REVIEW_CONFIRM } as const;
export const SUGGESTIONS_PATH = 'docs/review/suggestions.md';

/** 创建 .rv 时存下的输入：确认轮的上一轮 must 清单，以及这一轮审查的提交范围 */
export interface ReviewInputFile { round: number; base: string; head: string; prior_must: ReviewFinding[] }
export interface ReviewReportFile { round: number; requested: 'pass' | 'changes'; verdict: 'pass' | 'changes'; issues: ReviewFinding[]; downgraded: Downgraded[]; head: string }
export interface ReviewConfirmFile { round: number; items: ConfirmItem[]; unresolved: string[]; head: string }

export function readReviewEvidence<T>(store: StateStore, flowId: string, taskId: string, name: string): T | null {
  const abs = store.abs(`${evidenceRel(flowId, taskId)}/${name}`);
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, 'utf8')) as T; } catch { return null; }
}

export const readReviewInput = (store: StateStore, flowId: string, rvId: string) => readReviewEvidence<ReviewInputFile>(store, flowId, rvId, REVIEW_INPUT);

/** 一个已结束的审查 task 留下的、尚未解决的 must；没有结论时返回 null */
export function unresolvedAfter(store: StateStore, flowId: string, rvId: string): ReviewFinding[] | null {
  const report = readReviewEvidence<ReviewReportFile>(store, flowId, rvId, REVIEW_REPORT);
  if (report) return mustOf(report.issues);
  const confirm = readReviewEvidence<ReviewConfirmFile>(store, flowId, rvId, REVIEW_CONFIRM);
  const input = readReviewInput(store, flowId, rvId);
  if (confirm && input) return input.prior_must.filter((m) => confirm.unresolved.includes(m.id));
  return null;
}

/** 这个 task 的改动（相对任务基线）是否追加了契约 */
function appendedContracts(t: TaskFile): boolean {
  if (!t.worktree || !t.base_sha) return false;
  try { return touchesContracts(git(t.worktree, ['diff', '--name-only', t.base_sha, 'HEAD', '--', 'docs/contracts']).split('\n').filter(Boolean)); } catch { return false; }
}

/**
 * 预检通过后是否需要审查，以及强度。已有审查记录时：上一轮通过了（例如合并验证失败后返工）不再审查；上一轮有未解决的 must 则继续确认轮（沿用强度）。
 * 没有记录时按第 10.1 节推导。
 */
export function decideReview(store: StateStore, config: FlowConfig, flowId: string, t: TaskFile): ReviewMode {
  const tasks = store.listTasks(flowId);
  const prior = reviewTasksOf(tasks, t.id).at(-1);
  if (prior) {
    if (prior.status !== 'done') return prior.review ?? 'auto';
    const left = unresolvedAfter(store, flowId, prior.id);
    return left && left.length === 0 ? 'skip' : prior.review ?? 'auto';
  }
  // 精简模式不做逐任务审查，改为阶段审查（第 7.6 节；workflow.yaml 的 review.per_task 注释"精简模式自动为 false"，偏离 84）
  const policy = store.readFlow(flowId).plan_mode === 'lean' ? { ...reviewPolicy(config), perTask: false } : reviewPolicy(config);
  return reviewMode(t, tasks, policy, appendedContracts(t));
}

function showAt(wt: string, rel: string): string {
  try { return git(wt, ['show', `HEAD:${rel}`]); } catch { return ''; }
}

/** 创建下一轮审查 task（.rv / .rv-n）：只读，工作目录指向原 task 的 worktree（dispatch 时设置），输入写进 handoff，提交范围存为 evidence */
export async function createReviewTask(root: string, store: StateStore, config: FlowConfig, flowId: string, orig: TaskFile, mode: Exclude<ReviewMode, 'skip'>, actor = 'engine'): Promise<TaskFile> {
  if (!orig.worktree || !orig.base_sha) throw new Error(`任务 ${orig.id} 没有 worktree，无法审查`);
  const wt = orig.worktree;
  const tasks = store.listTasks(flowId);
  const prev = reviewTasksOf(tasks, orig.id).at(-1);
  const priorMust = prev ? unresolvedAfter(store, flowId, prev.id) ?? [] : [];
  const prevInput = prev ? readReviewInput(store, flowId, prev.id) : null;
  const confirm = priorMust.length > 0;
  const id = nextReviewId(tasks, orig.id);
  const head = headSha(wt);
  const from = confirm ? prevInput?.head ?? orig.base_sha : orig.base_sha;
  // 确认轮的增量 diff 只含本 task 自己的改动：worker 返工前同步过集成分支，上一轮之后合入的别人的文件（包括 docs/review/suggestions.md）不算
  const names = (a: string) => git(wt, ['diff', '--name-only', '-z', a, head]).split('\0').filter(Boolean);
  const own = confirm ? new Set(names(orig.base_sha)) : null;
  const files = own ? names(from).filter((f) => own.has(f)) : null;
  const raw = files && !files.length ? '' : git(wt, ['diff', '--no-color', '--no-ext-diff', from, head, '--', ...(files ?? ['.']), ':(exclude)tests/acceptance']);
  const diff = truncateDiff(stripAcceptanceDiff(raw));

  let acText: Record<string, string> = {};
  let glossary = '';
  let contracts: ReturnType<typeof fitSnippets> = { shown: [], omitted: [] };
  if (!confirm) {
    try {
      const spec = readSpec(root, store.readFlow(flowId).integration_branch);
      acText = acTexts(effectiveSpec(spec.files, spec.features), orig.ac ?? []);
      glossary = spec.files.glossary.slice(0, GLOSSARY_MAX);
    } catch { /* 规格读不到时只给 AC 编号 */ }
    const all = git(wt, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/contracts']).split('\n').filter(Boolean);
    const touched = git(wt, ['diff', '--name-only', orig.base_sha, head, '--', 'docs/contracts']).split('\n').filter(Boolean);
    contracts = fitSnippets(contractFilesFor(orig.module, all, touched).map((p) => ({ path: p, content: showAt(wt, p) })).filter((f) => f.content), CONTRACT_SNIPPET_MAX);
  }
  const brief = buildReviewBrief({
    taskId: orig.id, title: orig.title, reviewId: id, acIds: orig.ac ?? [], acTexts: acText, contracts, glossary, deviations: orig.deviations ?? [],
    range: { from, to: head }, diff, priorMust,
  });
  const input: TaskInput = {
    id, stage: orig.stage, kind: 'review', role: 'reviewer', title: `审查：${orig.title}`, scopes: [...config.role('reviewer').scopes],
    depends_on: [], inputs: [], writes: [], verify: [], for_task: orig.id, ac: [...(orig.ac ?? [])],
    ...(orig.module ? { module: orig.module } : {}),
    ...(orig.layers?.length ? { layers: [...orig.layers] } : {}),
    // 标记：strong 在派发时使用升级模型（dispatcher.planModel）
    review: mode,
  };
  const [rv] = await store.addTasks(flowId, [input], actor);
  const file: ReviewInputFile = { round: reviewRoundOf(id), base: from, head, prior_must: priorMust };
  await store.saveEvidence(flowId, id, REVIEW_INPUT, JSON.stringify(file, null, 2), actor);
  await store.appendHandoff(flowId, id, brief, actor);
  return rv!;
}

/** 把 suggest 追加到集成分支的 docs/review/suggestions.md（每条带 task 与 R 编号；同一条不重复追加）。与合并并发时重试。 */
export function appendSuggestions(root: string, branch: string, rvId: string, taskId: string, suggestions: readonly ReviewFinding[]): boolean {
  if (!suggestions.length) return false;
  const ref = `refs/heads/${branch}`;
  for (let attempt = 0; ; attempt++) {
    const old = gitOk(root, ['cat-file', '-e', `${ref}:${SUGGESTIONS_PATH}`])
      ? git(root, ['show', `${ref}:${SUGGESTIONS_PATH}`])
      : '# 审查建议（suggest）\n\n不阻塞合并，阶段签收时列给用户挑选；每条带审查 task 与 R 编号。\n';
    const fresh = suggestions.filter((s) => !old.includes(`[${rvId} ${s.id}]`));
    if (!fresh.length) return false;
    const text = `${old.replace(/\n*$/, '\n')}\n## ${taskId}（${rvId}）\n\n${fresh.map((s) => suggestionLine(rvId, taskId, s)).join('\n')}\n`;
    try {
      return commitFilesToBranch(root, branch, [{ rel: SUGGESTIONS_PATH, content: text }], `pi-forge: 记录 ${taskId} 的审查建议（${rvId}）`) !== null;
    } catch (e) {
      if (attempt >= 4) throw e;
    }
  }
}

/** 某一轮审查的结论是否已经被处理：.rv 提交结论（report）之后，原 task 有过 review_changes 或 review_pass（转移本身就是标记，崩溃后不会重复处理） */
export function reviewResolved(store: StateStore, flowId: string, taskId: string, rvId: string): boolean {
  const events = store.readEvents().filter((e) => e.flow === flowId);
  const reported = events.findLast((e) => e.task === rvId && e.type === 'transition' && e.trigger === 'report');
  if (!reported) return false;
  return events.some((e) => e.seq > reported.seq && e.task === taskId && e.type === 'transition' && (e.trigger === 'review_changes' || e.trigger === 'review_pass'));
}

const brief1 =(m: ReviewFinding) => `${m.id} ${m.problem.replace(/\s+/g, ' ').slice(0, 120)}`;

/**
 * 处理审查结论（pump 的一步，类似 resolveDisputes）。对每个 in_review 的 task：
 * - 还没有审查 task（刚预检通过，或崩溃恢复）：创建 .rv 或 .rv-n；
 * - 最新的审查 task done：没有未解决的 must → review_pass（→ queued_merge）；有 → review_changes（→ in_progress，must 清单写进 handoff，
 *   worker 接着原会话改）；review_rounds 达到 review.max_rounds 时状态机自动转 blocked（blocked_by = review_exhausted，用户可 /forge accept）；
 * - 审查者 forge_block：原 task 一并 blocked。
 * 轮数的计法：第 k 轮审查（.rv 是第 1 轮，.rv-k 是第 k 轮）结束时仍有 must，则 review_rounds = k；k < max_rounds 打回，k = max_rounds 用尽。
 */
export async function resolveReviews(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string[]> {
  const out: string[] = [];
  const branch = store.readFlow(flowId).integration_branch;
  for (const listed of store.listTasks(flowId)) {
    if (listed.status !== 'in_review') continue;
    const t = store.readTask(flowId, listed.id);
    if (t.status !== 'in_review') continue;
    const latest = reviewTasksOf(store.listTasks(flowId), t.id).at(-1);
    // 没有审查 task，或最新一轮的结论已经处理过（原 task 返工后再次预检通过，重新回到 in_review）：创建下一轮
    if (!latest || (latest.status === 'done' && reviewResolved(store, flowId, t.id, latest.id))) {
      const mode = decideReview(store, config, flowId, t);
      await createReviewTask(root, store, config, flowId, t, mode === 'skip' ? 'auto' : mode);
      out.push(t.id);
      continue;
    }
    if (latest.status === 'blocked') {
      await store.transitionTask(flowId, t.id, { to: 'blocked', trigger: 'block', actor: 'engine', facts: { reason: `审查者 ${latest.id} 无法继续：${latest.blocked_reason ?? '（未写原因）'}` } });
      out.push(t.id);
      continue;
    }
    if (latest.status !== 'done') continue;
    const left = unresolvedAfter(store, flowId, latest.id);
    if (left === null) {
      await store.transitionTask(flowId, t.id, { to: 'blocked', trigger: 'block', actor: 'engine', facts: { reason: `审查 ${latest.id} 已结束但没有留下结论，请检查后 /forge unblock ${t.id}` } });
      out.push(t.id);
      continue;
    }
    const report = readReviewEvidence<ReviewReportFile>(store, flowId, latest.id, REVIEW_REPORT);
    if (report) appendSuggestions(root, branch, latest.id, t.id, report.issues.filter((i) => i.level === 'suggest'));
    if (!left.length) {
      await store.transitionTask(flowId, t.id, { to: 'queued_merge', trigger: 'review_pass', actor: 'engine', facts: { unresolved_must: 0 } });
    } else {
      const round = reviewRoundOf(latest.id);
      const confirm = readReviewEvidence<ReviewConfirmFile>(store, flowId, latest.id, REVIEW_CONFIRM);
      const reason = `审查第 ${round} 轮（${latest.id}）仍有 ${left.length} 条 must 未解决：${left.map(brief1).join('；')}`.slice(0, 1500);
      const after = await store.transitionTask(flowId, t.id, { to: 'in_progress', trigger: 'review_changes', actor: 'engine', facts: { unresolved_must: left.length, reason } });
      const notes = (confirm?.items ?? []).filter((i) => !i.resolved && i.note?.trim()).map((i) => `- ${i.id}：${i.note!.trim()}`);
      await store.appendHandoff(flowId, t.id, [mustHandoff(round, left, after.status === 'blocked'), ...(notes.length ? [`审查者对未解决条目的说明：\n${notes.join('\n')}`] : [])].join('\n\n'), 'engine');
    }
    out.push(t.id);
  }
  return out;
}

export const reviewWorktreeOf = (store: StateStore, flowId: string, rv: Pick<TaskFile, 'for_task'>): { path: string; branch: string; base_sha: string } | null => {
  if (!rv.for_task) return null;
  const orig = store.readTask(flowId, rv.for_task);
  if (!orig.worktree || !orig.branch || !orig.base_sha || !existsSync(path.resolve(orig.worktree))) return null;
  return { path: orig.worktree, branch: orig.branch, base_sha: orig.base_sha };
};
