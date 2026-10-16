// 逐任务审查的纯函数部分：是否审查、问题编号、第二轮的确认校验、reviewer 的输入组装（10.2）。
// 第二轮只确认、must 必须有出处。不依赖 Pi，不读写 .forge。
import type { FlowConfig } from '../state/config.ts';
import type { ReviewFinding, TaskFile } from '../state/schemas.ts';
import { escalationPolicy, hardFanout } from '../insight/cost-control.ts';
import type { AcceptanceAudit, ReviewTestPlan } from './review-tests.ts';

export type ReviewMode = 'skip' | 'auto' | 'strong';

/** 审查输入的上限（diff 最多 2 万字） */
export const REVIEW_DIFF_MAX = 20_000;
export const CONTRACT_SNIPPET_MAX = 8_000;
export const GLOSSARY_MAX = 4_000;

// —— 10.1 什么时候审查 ——

export interface ReviewPolicy {
  /** escalation.critical_fanout：被这么多 task 硬依赖视为底座；0 关闭 */
  criticalFanout: number;
  /** review.max_rounds：审查轮数上限（第 1 轮出清单，之后各轮只确认） */
  maxRounds: number;
}

export function reviewPolicy(config: FlowConfig): ReviewPolicy {
  return {
    criticalFanout: escalationPolicy(config).criticalFanout,
    maxRounds: config.raw.review?.max_rounds ?? 2,
  };
}

/** 这些类型的 task 不做逐任务审查：fix（.fx-n，审查任务编号 T-001.fx-1.rv 不符合编号规则，回归由阶段门禁和 stage-qa 的确认轮核对）、doc 不是实施代码，review/qa 本身是审查 */
const NO_REVIEW_KINDS: readonly string[] = ['fix', 'merge-fix', 'doc', 'review', 'qa'];

/**
 * 推导一个 impl task 的审查强度（预检不再运行命令，所以 impl 一律审查，审查者读 diff 并运行本 task 自己的测试，不能关掉）。
 * task.review 写了 strong 以它为准；否则：底座（被 critical_fanout 个 task 硬依赖）、layers 含 auth、risk=high → strong；其余 auto。
 */
export function reviewMode(task: Pick<TaskFile, 'id' | 'kind' | 'review' | 'risk' | 'size' | 'layers' | 'depends_on'>, tasks: readonly TaskFile[], policy: ReviewPolicy): ReviewMode {
  if (NO_REVIEW_KINDS.includes(task.kind)) return 'skip';
  if (task.review && task.review !== 'skip') return task.review;
  const fanout = hardFanout(task as TaskFile, tasks);
  if ((policy.criticalFanout > 0 && fanout >= policy.criticalFanout) || (task.layers ?? []).includes('auth') || task.risk === 'high') return 'strong';
  return 'auto';
}

// —— reviewer 的输出：问题与出处 ——

export interface ReviewIssueInput {
  level: 'must' | 'suggest';
  basis: string;
  files: readonly string[];
  location: string;
  problem: string;
  expected: string;
}
/** 给问题编号 R-<start>…。级别与出处照 reviewer 写的保存，程序不校验出处 */
export function classifyIssues(inputs: readonly ReviewIssueInput[], start = 1): ReviewFinding[] {
  return inputs.map((i, n): ReviewFinding => ({
    id: `R-${start + n}`, level: i.level, basis: i.basis.trim() || '（未写出处）', files: [...i.files],
    location: i.location.trim(), problem: i.problem.trim(), expected: i.expected.trim(),
  }));
}

export const mustOf = (issues: readonly ReviewFinding[]): ReviewFinding[] => issues.filter((i) => i.level === 'must');

/** 最终结论由程序按问题决定：没有 must 就是 pass（即使 reviewer 写了 changes）；有 must 就是 changes（即使写了 pass） */
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
  /** 审查者要运行的本 task 自己的测试；不给表示不要求运行（阶段审查等） */
  tests?: ReviewTestPlan;
  /** worker 自己写的验收测试的 AC 覆盖扫描；不给表示验收测试不是 worker 写的 */
  acceptance?: AcceptanceAudit;
  /** diff 里是否含 tests/acceptance/**（worker 自己写验收测试时含，审查者要读） */
  withAcceptance?: boolean;
  /** 本 task 用到的其他 task 的产物（软依赖）：生产方与用到的接口 */
  uses?: readonly { task: string; refs: readonly string[] }[];
  /** diff 里落在其他 task 负责范围（writes）内的文件 */
  othersFiles?: readonly { file: string; owners: readonly string[] }[];
}

/** 跨 task 的两类问题单个 diff 里看不出来，提醒审查者专门看一眼（stock run-02：采购、销售各自留了一份 changeStock 替身；T-013 给商品页加导出按钮让整页打不开） */
function crossTaskSection(i: ReviewBriefInput): string[] {
  const out: string[] = [];
  if (i.uses?.length) out.push(`## 用到的其他 task 的产物\n${i.uses.map((u) => `- ${u.task}：${u.refs.join('、')}`).join('\n')}\n这些已在集成分支上（或合并前会先合入）。检查本 task 用的是它们的正式实现：没有留下替身、mock、复制的第二份实现，也没有"合入后再换"的 TODO；有就是 must（出处 contract: 或 defect:）。`);
  if (i.othersFiles?.length) out.push(`## 改了其他 task 负责的文件\n${i.othersFiles.map((f) => `- ${f.file}（${f.owners.join('、')}）`).join('\n')}\n这些文件原来的功能要照常可用：看改动有没有破坏它们（页面能不能打开、原来的按钮和接口是否还在），需要时运行相关的测试。`);
  return out;
}

const FENCE = '`'.repeat(3);
const fence = (s: string, lang = '') => `${FENCE}${lang}\n${s.replaceAll(FENCE, "'''")}\n${FENCE}`;

export function formatMust(m: ReviewFinding): string {
  return `- ${m.id}　出处：${m.basis}\n  位置：${m.files.join('、')}${m.location ? `（${m.location}）` : ''}\n  问题：${m.problem}\n  期望：${m.expected}`;
}

/** 任务说明里“先运行这些测试”一节：失败即 must，出处写 defect: */
function testsSection(tests: ReviewTestPlan, confirm: boolean): string {
  const cmds = tests.run.length
    ? tests.run.map((c) => `- ${c.name}：\`${c.shell}\``).join('\n')
    : '（本 task 没有需要运行的测试）';
  const skipped = tests.skipped.length ? `\n\n未运行：\n${tests.skipped.map((s) => `- ${s}`).join('\n')}` : '';
  const how = confirm
    ? '确认轮也先运行这些命令。测试仍失败，或者新失败：把与失败相关的条目（找不到相关条目就用第一条）标 resolved=false，note 里写命令与失败摘要。'
    : '先运行这些命令再读 diff。测试失败是阻塞问题：提交 must，basis 写 `defect:<命令> 失败：<失败的用例与原因>`，file 写出错的源文件，expected 写“该命令通过”。区分环境问题（依赖缺失、端口被占用等）与代码问题，环境问题用 forge_block 说明，不要当成代码缺陷。';
  return `## 先运行本 task 自己的测试（预检不再运行命令；全量测试与全部验收测试在阶段门禁）\n${cmds}${skipped}\n\n${how}只运行上面列出的命令，不要运行别的测试命令。`;
}

/** 验收测试审查一节：程序算出的 AC 覆盖 + 要核对的三件事 */
function acceptanceSection(a: AcceptanceAudit): string {
  const rows = a.rows.map((r) => `- ${r.ac}：${r.files.length ? r.files.join('、') : '**没有带该编号的测试**'}`).join('\n');
  return [
    '## 审查本 task 的验收测试（worker 自己写的，没有 test-author；diff 里含 tests/acceptance/**）',
    `程序扫描的 AC 覆盖（测试名里带 [REQ-xxx.ACn] 的文件）：\n${rows}`,
    a.missing.length ? `**以下 AC 没有测试：${a.missing.join('、')}。每条都是 must，basis 写 \`ac:<编号>\`，expected 写“补上带该编号的测试”。**` : '每条 AC 都有测试。',
    '再逐条核对（技能 acceptance-tests）：(1) 测试是否真的走了 AC 的 Given/When/Then，并且从公开入口（HTTP 接口、页面、跨模块函数）验证，不直接调内部函数或查数据库；(2) 断言有没有被弱化（只查状态码、断言过宽、什么都没断言、被跳过或删除的用例）；(3) 有没有依赖实现细节、断言了规格没规定的东西。缺失或形同虚设的测试是 must，basis 写对应的 `ac:<编号>`；写法上的小问题是 suggest。',
  ].join('\n\n');
}

/** reviewer 的任务说明（写进 .rv 的 handoff）；第一轮给完整输入，确认轮只给上一轮的 must 清单与增量 diff */
export function buildReviewBrief(i: ReviewBriefInput): string {
  const confirm = i.priorMust.length > 0;
  const diffSection = [
    `## ${confirm ? '这一轮的增量 diff' : 'diff'}（${i.range.from.slice(0, 8)}..${i.range.to.slice(0, 8)}，${i.withAcceptance ? '含' : '不含'} tests/acceptance/**）`,
    i.diff.text.trim() ? fence(i.diff.text, 'diff') : '（没有改动）',
    ...(i.diff.truncated ? [`diff 已按 ${REVIEW_DIFF_MAX} 字截断；被截掉的文件请直接读（工作目录就是被审查任务的工作区，改动已在其中；guard 不允许带版本参数的 git 命令）。`] : ['需要更多上下文时可以直接读相关代码，不要通读整个仓库。']),
  ].join('\n\n');
  if (confirm) {
    return [
      `# 审查确认（第二轮及以后）：${i.taskId}「${i.title}」`,
      '这是确认轮。worker 已按上一轮的 must 清单修改。**只能核对下面这些编号是否已经解决，用 forge_review_confirm 逐条回答 `{id, resolved, note}`，必须覆盖全部编号。**',
      '不能提出新问题（forge_review_confirm 没有新增问题的字段），也不要重新审查上一轮已审过且没有改动的代码。清单之外的发现写进某条的 note，交给阶段验收。',
      `## 上一轮的问题清单\n${i.priorMust.map(formatMust).join('\n')}`,
      ...(i.tests ? [testsSection(i.tests, true)] : []),
      diffSection,
    ].join('\n\n');
  }
  const ac = i.acIds.length ? i.acIds.map((id) => `- ${id}：${i.acTexts[id] ?? '（规格里找不到原文）'}`).join('\n') : '（无）';
  const contracts = i.contracts.shown.length
    ? [...i.contracts.shown.map((c) => `### ${c.path}\n${fence(c.content)}`), ...(i.contracts.omitted.length ? [`（因长度限制省略：${i.contracts.omitted.join('、')}，需要时自己读）`] : [])].join('\n\n')
    : '（没有相关的契约文件）';
  return [
    `# 审查：${i.taskId}「${i.title}」（${i.reviewId}）`,
    '这是第一轮审查。程序没有预先运行测试：先运行下面列出的、本 task 自己的测试，再按角色提示的顺序检查；最后调用 forge_review_report 一次提交全部问题。must 必须写出处（rule:/ac:/contract:/defect:），写不出出处的是 suggest。',
    `## 本 task 的验收标准（AC 原文）\n${ac}`,
    `## 相关契约\n${contracts}`,
    `## 术语表\n${i.glossary.trim() ? i.glossary.trim() : '（无）'}`,
    `## worker 声明的偏离（已声明并且合理的不算问题）\n${i.deviations.length ? i.deviations.map((d) => `- ${d}`).join('\n') : '（无）'}`,
    ...crossTaskSection(i),
    `本 task 涉及的 rules/<layer>.md（每个文件末尾有审查清单）已在系统提示的规则部分。`,
    ...(i.tests ? [testsSection(i.tests, false)] : []),
    ...(i.acceptance ? [acceptanceSection(i.acceptance)] : []),
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
