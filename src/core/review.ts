// 逐任务审查的纯函数部分（规格第 10 节）：是否审查（10.1）、问题的出处校验与降级、第二轮的确认校验、reviewer 的输入组装（10.2）。
// 设计参考 pi-flow 5100d6b^:src/core/stage-review.ts（第二轮只确认、must 必须有出处）。不依赖 Pi，不读写 .forge。
import type { FlowConfig } from './config.ts';
import type { ReviewFinding, TaskFile } from './schemas.ts';
import { escalationPolicy, hardFanout } from './cost-control.ts';

export type ReviewMode = 'skip' | 'auto' | 'strong';

/** 审查输入的上限（第 10.2 节：diff 最多 2 万字） */
export const REVIEW_DIFF_MAX = 20_000;
export const CONTRACT_SNIPPET_MAX = 8_000;
export const GLOSSARY_MAX = 4_000;

// —— 10.1 什么时候审查 ——

export interface ReviewPolicy {
  /** review.per_task：false 时不做逐任务审查（精简模式） */
  perTask: boolean;
  /** review.skip_sizes：size 在其中且没有追加契约的 task 不审查 */
  skipSizes: readonly string[];
  /** escalation.critical_fanout：被这么多 task 硬依赖视为底座；0 关闭 */
  criticalFanout: number;
  /** review.max_rounds：审查轮数上限（第 1 轮出清单，之后各轮只确认） */
  maxRounds: number;
}

export function reviewPolicy(config: FlowConfig): ReviewPolicy {
  return {
    perTask: config.raw.review?.per_task ?? true,
    skipSizes: config.raw.review?.skip_sizes ?? ['S'],
    criticalFanout: escalationPolicy(config).criticalFanout,
    maxRounds: config.raw.review?.max_rounds ?? 2,
  };
}

/** 这些类型的 task 不做逐任务审查：fix 由 stage-qa 的确认轮核对，doc/acctest 不是实施代码，review/qa 本身是审查 */
const NO_REVIEW_KINDS: readonly string[] = ['fix', 'merge-fix', 'doc', 'acctest', 'review', 'qa'];

/**
 * 推导一个 task 的审查强度（第 10.1 节）。task.review 有值以它为准（per_task=false 与不审查的类型除外）；
 * 否则：底座（被 critical_fanout 个 task 硬依赖）、layers 含 auth、risk=high → strong；size 在 skip_sizes 且没有追加契约 → skip；其余 auto。
 * appendedContract：这个 task 的 diff 里有没有 docs/contracts/** 的改动，由调用方根据 diff 判断。
 */
export function reviewMode(task: Pick<TaskFile, 'id' | 'kind' | 'review' | 'risk' | 'size' | 'layers' | 'depends_on'>, tasks: readonly TaskFile[], policy: ReviewPolicy, appendedContract: boolean): ReviewMode {
  if (!policy.perTask || NO_REVIEW_KINDS.includes(task.kind)) return 'skip';
  if (task.review) return task.review;
  const fanout = hardFanout(task as TaskFile, tasks);
  if ((policy.criticalFanout > 0 && fanout >= policy.criticalFanout) || (task.layers ?? []).includes('auth') || task.risk === 'high') return 'strong';
  if (task.size && policy.skipSizes.includes(task.size) && !appendedContract) return 'skip';
  return 'auto';
}

// —— reviewer 的输出：问题与出处 ——

/** must 的 basis 只能以这四种开头，冒号后必须有内容 */
const MUST_BASIS = /^(rule|ac|contract|defect):\s*\S/;
export const isValidMustBasis = (basis: string): boolean => MUST_BASIS.test(basis.trim());

export interface ReviewIssueInput {
  level: 'must' | 'suggest';
  basis: string;
  files: readonly string[];
  location: string;
  problem: string;
  expected: string;
}
export interface Downgraded { id: string; basis: string }

/** 给问题编号 R-<start>…；没有合格出处的 must 降为 suggest（返回被降级的编号，供回复说明） */
export function classifyIssues(inputs: readonly ReviewIssueInput[], start = 1): { issues: ReviewFinding[]; downgraded: Downgraded[] } {
  const downgraded: Downgraded[] = [];
  const issues = inputs.map((i, n): ReviewFinding => {
    const id = `R-${start + n}`;
    const basis = i.basis.trim();
    let level = i.level;
    if (level === 'must' && !isValidMustBasis(basis)) { level = 'suggest'; downgraded.push({ id, basis }); }
    return { id, level, basis: basis || '（未写出处）', files: [...i.files], location: i.location.trim(), problem: i.problem.trim(), expected: i.expected.trim() };
  });
  return { issues, downgraded };
}

export const mustOf = (issues: readonly ReviewFinding[]): ReviewFinding[] => issues.filter((i) => i.level === 'must');

/** 最终结论由程序按降级后的问题决定：没有 must 就是 pass（即使 reviewer 写了 changes）；有 must 就是 changes（即使写了 pass） */
export const effectiveVerdict = (issues: readonly ReviewFinding[]): 'pass' | 'changes' => (mustOf(issues).length ? 'changes' : 'pass');

export interface ConfirmItem { id: string; resolved: boolean; note?: string }

/** 第二轮的确认校验：每个编号必须是上一轮的 must，不能重复，必须覆盖全部；返回错误列表（空表示通过） */
export function validateConfirm(items: readonly ConfirmItem[], priorIds: readonly string[]): string[] {
  const errors: string[] = [];
  const prior = new Set(priorIds);
  const seen = new Set<string>();
  const unknown = items.map((i) => i.id).filter((id) => !prior.has(id));
  if (unknown.length) errors.push(`这些编号不在上一轮的清单里（第二轮不能提出新问题）：${[...new Set(unknown)].join('、')}`);
  for (const i of items) {
    if (seen.has(i.id) && prior.has(i.id)) errors.push(`编号 ${i.id} 重复了`);
    seen.add(i.id);
  }
  const missing = priorIds.filter((id) => !seen.has(id));
  if (missing.length) errors.push(`还没有回答这些编号：${missing.join('、')}`);
  return errors;
}

// —— 轮次与编号 ——

/** T-003.rv → 1，T-003.rv-2 → 2；不是审查 task 返回 0 */
export function reviewRoundOf(id: string): number {
  const m = /\.rv(?:-(\d+))?$/.exec(id);
  return m ? Number(m[1] ?? 1) : 0;
}

/** 某个 task 的审查 task（忽略已取消的），按轮次排序 */
export function reviewTasksOf<T extends Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status'>>(tasks: readonly T[], taskId: string): T[] {
  return tasks.filter((t) => t.kind === 'review' && t.for_task === taskId && t.status !== 'cancelled').sort((a, b) => reviewRoundOf(a.id) - reviewRoundOf(b.id));
}

/** 下一轮审查的编号：T-003.rv → T-003.rv-2 → T-003.rv-3（取消的轮次也占编号） */
export function nextReviewId(tasks: readonly Pick<TaskFile, 'id'>[], taskId: string): string {
  const rounds = tasks.filter((t) => t.id === `${taskId}.rv` || t.id.startsWith(`${taskId}.rv-`)).map((t) => reviewRoundOf(t.id));
  const next = Math.max(0, ...rounds) + 1;
  return next === 1 ? `${taskId}.rv` : `${taskId}.rv-${next}`;
}

// —— 10.2 输入：diff ——

/** 去掉 tests/acceptance/** 的文件段（验收测试由 test-author 负责，不进审查） */
export function stripAcceptanceDiff(diff: string): string {
  if (!diff) return '';
  const sections = diff.split(/^(?=diff --git )/m);
  return sections.filter((s) => {
    const m = /^diff --git a\/(.+?) b\//.exec(s);
    return !(m && m[1]!.startsWith('tests/acceptance/'));
  }).join('');
}

/** 超过上限时在行边界截断并注明（reviewer 需要看全文时自己读文件） */
export function truncateDiff(diff: string, max = REVIEW_DIFF_MAX): { text: string; truncated: boolean } {
  if (diff.length <= max) return { text: diff, truncated: false };
  const cut = diff.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  const kept = nl > max / 2 ? cut.slice(0, nl) : cut;
  return { text: `${kept}\n…（diff 共 ${diff.length} 字，已截断到前 ${kept.length} 字；后面的改动请直接读文件）`, truncated: true };
}

/** 这个 diff 是否追加了契约（docs/contracts/** 有改动的文件） */
export const touchesContracts = (files: readonly string[]): boolean => files.some((f) => f.startsWith('docs/contracts/'));

// —— 10.2 输入：契约片段 ——

const baseNoExt = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');

/** 要给 reviewer 的契约文件：diff 里改到的在前，然后是本模块的契约文件（文件名与模块名相同，如 paths/<module>.yaml、modules/<module>.md） */
export function contractFilesFor(module: string | undefined, all: readonly string[], touched: readonly string[]): string[] {
  const contracts = all.filter((f) => f.startsWith('docs/contracts/'));
  const own = module ? contracts.filter((f) => baseNoExt(f) === module) : [];
  return [...new Set([...touched.filter((f) => f.startsWith('docs/contracts/') && contracts.includes(f)), ...own])];
}

/** 按总长上限收集契约片段；放不下的文件整份省略并列出名字 */
export function fitSnippets(files: readonly { path: string; content: string }[], max = CONTRACT_SNIPPET_MAX): { shown: { path: string; content: string }[]; omitted: string[] } {
  const shown: { path: string; content: string }[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const f of files) {
    const room = max - used;
    if (room <= 200) { omitted.push(f.path); continue; }
    if (f.content.length <= room) { shown.push(f); used += f.content.length; continue; }
    shown.push({ path: f.path, content: `${f.content.slice(0, room)}\n…（已截断）` });
    used = max;
  }
  return { shown, omitted };
}

// —— 10.2 输入：任务说明 ——

export interface ReviewBriefInput {
  taskId: string;
  title: string;
  /** 这一轮的审查 task 编号 */
  reviewId: string;
  /** AC 编号 → 原文（规格里找不到的编号没有原文） */
  acIds: readonly string[];
  acTexts: Record<string, string>;
  contracts: { shown: { path: string; content: string }[]; omitted: string[] };
  glossary: string;
  deviations: readonly string[];
  /** 比较范围：<from>..<to>（第一轮是任务基线到提交，之后是上一轮审查之后的增量） */
  range: { from: string; to: string };
  diff: { text: string; truncated: boolean };
  /** 上一轮没有解决的 must；非空表示这是确认轮 */
  priorMust: readonly ReviewFinding[];
}

const FENCE = '`'.repeat(3);
const fence = (s: string, lang = '') => `${FENCE}${lang}\n${s.replaceAll(FENCE, "'''")}\n${FENCE}`;

export function formatMust(m: ReviewFinding): string {
  return `- ${m.id}　出处：${m.basis}\n  位置：${m.files.join('、')}${m.location ? `（${m.location}）` : ''}\n  问题：${m.problem}\n  期望：${m.expected}`;
}

/** reviewer 的任务说明（写进 .rv 的 handoff）；第一轮给完整输入，确认轮只给上一轮的 must 清单与增量 diff */
export function buildReviewBrief(i: ReviewBriefInput): string {
  const confirm = i.priorMust.length > 0;
  const diffSection = [
    `## ${confirm ? '这一轮的增量 diff' : 'diff'}（${i.range.from.slice(0, 8)}..${i.range.to.slice(0, 8)}，不含 tests/acceptance/**）`,
    i.diff.text.trim() ? fence(i.diff.text, 'diff') : '（没有改动）',
    ...(i.diff.truncated ? [`diff 已按 ${REVIEW_DIFF_MAX} 字截断；被截掉的文件请直接读（工作目录就是被审查任务的工作区，改动已在其中；guard 不允许带版本参数的 git 命令）。`] : ['需要更多上下文时可以直接读相关代码，不要通读整个仓库。']),
  ].join('\n\n');
  if (confirm) {
    return [
      `# 审查确认（第二轮及以后）：${i.taskId}「${i.title}」`,
      '这是确认轮。worker 已按上一轮的 must 清单修改。**只能核对下面这些编号是否已经解决，用 forge_review_confirm 逐条回答 `{id, resolved, note}`，必须覆盖全部编号。**',
      '不能提出新问题（forge_review_confirm 没有新增问题的字段），也不要重新审查上一轮已审过且没有改动的代码。清单之外的发现写进某条的 note，交给阶段验收。',
      `## 上一轮的问题清单\n${i.priorMust.map(formatMust).join('\n')}`,
      diffSection,
    ].join('\n\n');
  }
  const ac = i.acIds.length ? i.acIds.map((id) => `- ${id}：${i.acTexts[id] ?? '（规格里找不到原文）'}`).join('\n') : '（无）';
  const contracts = i.contracts.shown.length
    ? [...i.contracts.shown.map((c) => `### ${c.path}\n${fence(c.content)}`), ...(i.contracts.omitted.length ? [`（因长度限制省略：${i.contracts.omitted.join('、')}，需要时自己读）`] : [])].join('\n\n')
    : '（没有相关的契约文件）';
  return [
    `# 审查：${i.taskId}「${i.title}」（${i.reviewId}）`,
    '这是第一轮审查。预检已经通过（编译、单元测试、本 task 的验收测试）；按角色提示的顺序检查测试看不出来的问题，最后调用 forge_review_report 一次提交全部问题。must 必须写出处（rule:/ac:/contract:/defect:），写不出出处的是 suggest。',
    `## 本 task 的验收标准（AC 原文）\n${ac}`,
    `## 相关契约\n${contracts}`,
    `## 术语表\n${i.glossary.trim() ? i.glossary.trim() : '（无）'}`,
    `## worker 声明的偏离（已声明并且合理的不算问题）\n${i.deviations.length ? i.deviations.map((d) => `- ${d}`).join('\n') : '（无）'}`,
    `本 task 涉及的 rules/<layer>.md（每个文件末尾有审查清单）已在系统提示的规则部分。`,
    diffSection,
  ].join('\n\n');
}

/** 把 must 清单写成给 worker 的返工说明（追加到原 task 的 handoff） */
export function mustHandoff(round: number, must: readonly ReviewFinding[], final: boolean): string {
  return [
    `## 审查意见（第 ${round} 轮）：必须修改 ${must.length} 条`,
    must.map(formatMust).join('\n'),
    final ? '审查轮数已用完，仍有以上问题未解决，任务已阻塞，等待用户处理。' : '逐条修改后重新 forge_submit。下一轮审查者只会核对这些编号是否已解决，不会提出新问题；认为某条不成立时在 forge_note 里写明理由。',
  ].join('\n\n');
}

/** suggestions.md 中的一条（带 task 与 R 编号，作为去重标记） */
export function suggestionLine(reviewId: string, taskId: string, s: ReviewFinding): string {
  return `- [${reviewId} ${s.id}] ${taskId}：${s.problem}（出处：${s.basis}；${s.files.join('、')}${s.location ? ` ${s.location}` : ''}）→ ${s.expected}`;
}
