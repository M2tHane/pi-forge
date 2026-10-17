// fix 模式。
// 一个 worker 定位并修复（加回归测试）→ 合并队列跑全量测试后直接合入主分支 → 独立 stage-qa 在主分支 HEAD 的临时 worktree 复现确认 →
// 修复日志。每一步由程序推进，不建 DAG、不跑阶段门禁；stage-qa 发现 must 时交回 worker 的会话修复（最多 2 轮），仍不过转"需要你处理"。
// 流程只有一个阶段 X1。X1 的状态：active（修复、合并、复现确认都在这里）→ done；轮数用尽或任务阻塞时 needs_human，由 /forge accept 放行。
// 小改动模式（用户决定）：同一套推进（fixStep）也服务小改动（change，见 change.ts）：impl 由 startChange 预建（不再建 T-001），全部 done 后程序建
// "更新架构图与契约"doc 任务，之后同样是 stage-qa 确认 → 日志。按 flow.mode 区分文案；日志仍写在 .forge/fixes/。
import { existsSync, readFileSync } from 'node:fs';
import type { FlowConfig } from '../core/state/config.ts';
import { isLightFlow, type FlowEvent, type FlowFile, type ReviewFinding, type TaskFile } from '../core/state/schemas.ts';
import type { StateStore, TaskInput } from '../core/state/state-store.ts';
import { git } from '../core/state/git.ts';
import { costReport, formatRow, type CostReport } from '../core/insight/cost.ts';
import { headSha } from '../core/workspace/worktree.ts';
import { isDocsUpdateTask, isSettled } from '../core/state/state-machine.ts';
import { isStageLevelTask } from '../core/workspace/stage-worktree.ts';
import { qaEnabled as qaEnabledOf } from '../core/stage/stage-acceptance.ts';
import { QA_FILES, QA_INPUT, buildQaBrief, nextQaId, qaRoundOf, qaTasksOf, resolveQa, stageBaseFor, stageDiffStat } from '../core/stage/stage-qa.ts';
import { unresolvedIn } from '../core/stage/stage-rounds.ts';
import { readReviewEvidence, type ReviewInputFile } from '../core/stage/review-flow.ts';
import { serviceCommands } from '../core/workspace/services.ts';
import { createDocsUpdateTask, docsUpdateTaskOf } from './change.ts';

export { fixRefusal } from './refusal.ts';

export interface FixContext {
  root: string;
  store: StateStore;
  config: FlowConfig;
  dispatch(flowId: string, taskId: string): Promise<unknown>;
  promote(flowId: string): Promise<unknown>;
  now?: () => Date;
}

export type FixDeps = Pick<FixContext, 'root' | 'store' | 'config' | 'now'>;

export const FIX_ROLE = 'worker';
export const FIX_STAGE = 'X1';
export const FIX_TASK = 'T-001';

/** 修复日志的事件说明（StateStore.writeFixLog 写入的 note） */
const FIX_LOG_REASON = 'fix 日志';

// —— 纯函数 ——

/** 修复所处的步骤，供 /forge-status 显示（纯函数） */
export type FixPhase = 'fixing' | 'docs' | 'merging' | 'confirming' | 'needs_human' | 'done';
export const FIX_PHASE_LABEL: Record<FixPhase, string> = { fixing: '修复中', docs: '更新文档', merging: '合并', confirming: '复现确认', needs_human: '需要你处理', done: '完成' };
/** 小改动（change）的步骤名 */
export const CHANGE_PHASE_LABEL: Record<FixPhase, string> = { fixing: '实施中', docs: '更新架构图与契约', merging: '审查与合并', confirming: '变更确认', needs_human: '需要你处理', done: '完成' };
type LightFlowLike = Pick<FlowFile, 'stage_status' | 'stage' | 'stages'> & { mode?: FlowFile['mode'] };
export const phaseLabelOf = (flow: Pick<FlowFile, 'mode'> | { mode?: FlowFile['mode'] }, phase: FixPhase): string => (flow.mode === 'change' ? CHANGE_PHASE_LABEL : FIX_PHASE_LABEL)[phase];

const MERGING = new Set(['checking', 'in_review', 'queued_merge', 'merging', 'disputed']);

export function fixPhase(flow: LightFlowLike, tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'stage' | 'status' | 'for_task'>[]): FixPhase {
  if (flow.stage_status === 'done') return 'done';
  if (flow.stage_status === 'needs_human' || flow.stage_status === 'awaiting_human' || flow.stage_status === 'aborted') return 'needs_human';
  const work = tasks.filter((t) => !isStageLevelTask(t) && t.status !== 'cancelled');
  if (work.some((t) => t.status === 'blocked')) return 'needs_human';
  if (work.some((t) => MERGING.has(t.status))) return 'merging';
  // 小改动：实现都做完、更新文档的任务还没完成（含它还没建出来的瞬间）
  if (flow.mode === 'change' && work.some((t) => t.kind === 'impl') && work.filter((t) => t.kind === 'impl').every((t) => t.status === 'done') && !work.some((t) => isDocsUpdateTask(t) && t.status === 'done')) return 'docs';
  if (work.length && work.every((t) => t.status === 'done')) {
    // 有 stage-qa 提出的 .fx 任务在做时回到"修复中"，其余是复现确认（含刚合并完、qa 任务还没建好的瞬间）
    return 'confirming';
  }
  return 'fixing';
}

/** 一行状态（纯函数）：步骤名与 stage-qa 轮次 */
export function fixStatusLine(flow: LightFlowLike, tasks: readonly TaskFile[]): string {
  const phase = fixPhase(flow, tasks);
  const qa = qaTasksOf(tasks, FIX_STAGE);
  const n = qa.length ? qaRoundOf(qa.at(-1)!.id) : 0;
  const fixes = tasks.filter((t) => t.kind === 'fix' && t.status !== 'cancelled').length;
  const rework = fixes ? `，验收返修 ${fixes} 个任务` : '';
  return `${flow.mode === 'change' ? '变更' : '修复'}步骤：${phaseLabelOf(flow, phase)}${n && phase === 'confirming' ? `（第 ${n} 轮）` : n && phase === 'needs_human' ? `（已复现确认 ${n} 轮）` : ''}${rework}`;
}

/** 超过这个文件数的改动应改用 /forge-build --feature */
export const fixMaxFiles = (config: FlowConfig) => config.limits.fix_max_files;

/** T-001 的交接说明（纯函数） */
export function buildFixHandoff(problem: string, maxFiles: number): string {
  return [
    '## 用户报告的问题', problem.trim(), '',
    '## 要求',
    '1. 先定位根因（读代码、复现问题），不要凭猜测改动。',
    '2. 修复根因，只改与这个问题相关的代码。',
    '3. 新增回归测试：修复前失败、修复后通过；全量测试通过。',
    `4. 改动较大（超过 ${maxFiles} 个文件）或需要修改模块之间的接口时，用 forge_block 说明原因，建议改用 /forge-build --feature。`,
  ].join('\n');
}

export interface FixQaBriefInput {
  /** 缺省是修复；change 是小改动（problem 是变更说明与任务清单） */
  mode?: 'fix' | 'change';
  qaId: string;
  round: number;
  problem: string;
  range: { from: string; to: string };
  stat: string;
  serves: readonly string[];
  priorMust: readonly ReviewFinding[];
}

/** stage-qa 复现确认的任务说明（纯函数）。确认轮复用阶段 QA 的确认说明 */
export function buildFixQaBrief(i: FixQaBriefInput): string {
  const change = i.mode === 'change';
  if (i.priorMust.length > 0) {
    return buildQaBrief({ stage: FIX_STAGE, goal: change ? '小改动' : '修复缺陷', qaId: i.qaId, round: i.round, exit: [], matrix: null, range: i.range, stat: i.stat, serves: i.serves, priorMust: i.priorMust });
  }
  const range = `${i.range.from.slice(0, 8)}..${i.range.to.slice(0, 8)}`;
  if (change) {
    return [
      `# 变更确认：${i.qaId}（第 ${i.round} 轮）`,
      '这是一次小改动（在已完成的项目上加小功能）。各 task 已审查并合入主分支，“更新架构图与契约”任务已完成。你在主分支 HEAD 的只读临时 worktree 里工作：**逐条核对这次变更是否做到位**，最后调用 forge_qa_report 一次提交结论（没有问题提交空列表）。',
      `## 变更说明与任务清单\n${i.problem.trim()}`,
      `## 已合入的改动（${range}）\n${i.stat.trim() ? '```\n' + i.stat.slice(0, 4000) + '\n```' : '（没有改动）'}`,
      '## 要核对的事',
      '- 任务清单里每个 task 的验收标准是否达成：读代码与对应测试，需要时实际运行，不能只看测试名。',
      '- 全量测试已跑：自己运行 commands 里的 typecheck、lint、test（有哪些运行哪些），确认全部通过。',
      '- docs/arch/overview.md 与 docs/contracts/ 与代码一致：这次新增或变化的模块、数据流、接口都有对应的描述，没有已不存在的内容。',
      '- 没有破坏相邻行为，也没有顺手改无关代码。',
      '某条验收标准没达成、全量测试失败、文档与代码不一致、或引入新的缺陷，才算 must；must 必须写出处（defect:<说明>、rule:、ac:、contract:），写不出出处的是 suggest。',
      i.serves.length ? `需要运行服务时用 forge_service 启动：${i.serves.join('、')}。` : '项目没有 serve 命令；只能读代码和运行 commands 里已有的命令。',
    ].join('\n\n');
  }
  return [
    `# 修复确认：${i.qaId}（第 ${i.round} 轮）`,
    '这是一次缺陷修复。修复已经合入主分支，全量测试已通过。你在主分支 HEAD 的只读临时 worktree 里工作：**独立复现所报告的问题，确认它已经修好**，最后调用 forge_qa_report 一次提交结论（没有问题提交空列表）。',
    `## 用户报告的问题\n${i.problem.trim()}`,
    `## 已合入的改动（${range}）\n${i.stat.trim() ? '```\n' + i.stat.slice(0, 4000) + '\n```' : '（没有改动）'}`,
    '## 要核对的事',
    '- 按报告里的现象与步骤实际复现：运行命令或服务，核对输出与 exit，确认问题不再出现。',
    '- 新增的回归测试确实覆盖这个问题（读测试，判断它在修复之前会失败），而不是形同虚设。',
    '- 修复针对根因，没有破坏相邻行为，也没有顺手改无关代码。',
    '问题仍然存在、没有回归测试、或修复引入新的缺陷，才算 must；must 必须写出处（defect:<说明>、rule:、ac:、contract:），写不出出处的是 suggest。',
    i.serves.length ? `需要运行服务时用 forge_service 启动：${i.serves.join('、')}。` : '项目没有 serve 命令；只能读代码和运行 commands 里已有的命令。',
  ].join('\n\n');
}

export interface FixLogInput {
  flow: Pick<FlowFile, 'id' | 'title'>;
  /** 缺省是修复 */
  mode?: 'fix' | 'change';
  date: string;
  mainBranch: string;
  problem: string;
  commits: readonly { sha: string; subject: string }[];
  files: readonly string[];
  qa: { rounds: number; conclusion: 'confirmed' | 'skipped' | 'accepted'; must: number; note?: string };
  rework: { merge_fail: number; run_failed: number; fix_tasks: number };
  cost: string[];
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;
/** 变更文件里的测试文件（回归测试）；纯函数 */
export const regressionTestsOf = (files: readonly string[]) => files.filter((f) => TEST_PATH.test(f));

const QA_LABEL = { confirmed: '已确认修复', skipped: '未运行（配置关闭了 stage-qa）', accepted: '未通过确认，由你人工放行' } as const;

/** 修复日志（纯函数）：问题、合入主分支的提交、回归测试、QA 结论、返工次数、成本 */
export function renderFixLog(i: FixLogInput): string {
  const tests = regressionTestsOf(i.files);
  const change = i.mode === 'change';
  return [
    `# ${change ? '变更' : '修复'} ${i.flow.id}：${i.flow.title}`,
    '',
    `- 日期：${i.date}`,
    `- 合入：${i.mainBranch}`,
    '',
    change ? '## 变更内容' : '## 问题', i.problem.trim() || i.flow.title, '',
    '## 合入主分支的提交', ...(i.commits.length ? i.commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.subject}`) : ['- （无）']), '',
    '## 改动文件', ...(i.files.length ? i.files.map((f) => `- ${f}`) : ['- （无）']), '',
    '## 回归测试', ...(tests.length ? tests.map((f) => `- ${f}`) : ['- （改动中没有识别出测试文件）']), '',
    change ? '## 变更确认（stage-qa）' : '## 复现确认（stage-qa）',
    `- 结论：${change ? QA_LABEL[i.qa.conclusion].replace('已确认修复', '已确认变更') : QA_LABEL[i.qa.conclusion]}`,
    `- 轮数：${i.qa.rounds}；发现 must ${i.qa.must} 条${i.qa.note ? `；说明：${i.qa.note}` : ''}`, '',
    '## 返工',
    `- 合并时全量测试失败 ${i.rework.merge_fail} 次，运行失败 ${i.rework.run_failed} 次，验收返修任务 ${i.rework.fix_tasks} 个`, '',
    '## 成本', ...i.cost.map((c) => `- ${c}`), '',
  ].join('\n');
}

/** 日志文件名：<日期>-<序号>.md（纯函数） */
export function fixLogName(date: string, existing: readonly string[]): string {
  return `${date}-${String(existing.filter((x) => x.startsWith(date)).length + 1).padStart(3, '0')}.md`;
}

/** 轮数用尽或任务阻塞时给用户看的原因（纯函数） */
export const fixHelpHint = (flowId: string, mode: FlowFile['mode'] = 'fix') => `${mode === 'change' ? '小改动' : '修复'} ${flowId} 需要你处理。已合入主分支的提交保留；确认没问题时 /forge accept --note "<说明>" 放行并结束，需要放弃时 /forge abort。`;

// —— 流程 ——

const hasLog = (store: StateStore, flowId: string) => store.readEvents().some((e) => e.flow === flowId && e.type === 'note' && e.reason === FIX_LOG_REASON);

/** 轻流程（fix、change）的下一步（引擎 pump 时调用；只依据持久化状态，重入结果相同） */
export async function fixStep(c: FixContext, flowId: string): Promise<void> {
  const { store } = c;
  const flow = store.readFlow(flowId);
  if (!isLightFlow(flow)) return;
  if (flow.stage_status === 'awaiting_gate') { await finish(c, flowId, 'confirmed'); return; }
  if (flow.stage_status !== 'active') return;

  // fix：T-001 由这里建；change：全部 impl 已由 startChange 预建
  if (flow.mode === 'fix' && !store.listTasks(flowId).some((t) => t.kind === 'impl')) await createFixTask(c, flowId);
  await promoteAndDispatch(c, flowId);

  const tasks = store.listTasks(flowId);
  const work = tasks.filter((t) => !isStageLevelTask(t));
  if (!work.every(isSettled) || work.some((t) => t.status === 'blocked')) return;
  if (!work.some((t) => t.kind === 'impl' && t.status === 'done')) return;

  // change：实现都合入后，结束前程序强制建一个"更新架构图与契约"任务；它完成（合并或确认无需更新）后才进入变更确认
  if (flow.mode === 'change' && !docsUpdateTaskOf(tasks)) {
    await createDocsUpdateTask(c, flowId);
    await promoteAndDispatch(c, flowId);
    return;
  }

  if (!qaEnabledOf(c.config, flow.stage)) { await finish(c, flowId, 'skipped'); return; }
  const r = await resolveQa(c.root, store, c.config, flowId, FIX_STAGE);
  switch (r.kind) {
    case 'running': case 'fix': return;
    case 'none': case 'fix-done': {
      const qa = await createFixQaTask(c.root, store, c.config, flowId, headSha(c.root, flow.integration_branch));
      await store.transitionTask(flowId, qa.id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
      await c.dispatch(flowId, qa.id);
      return;
    }
    case 'pass': await finish(c, flowId, 'confirmed'); return;
    case 'blocked': case 'exhausted': await toNeedsHuman(store, flowId, `复现确认：${r.reason}`); return;
  }
}

async function promoteAndDispatch(c: FixContext, flowId: string): Promise<void> {
  await c.promote(flowId);
  for (const t of c.store.listTasks(flowId)) {
    if (t.status === 'ready') await c.dispatch(flowId, t.id);
  }
}

/** 创建 T-001：worker 定位根因、修复并加回归测试 */
export async function createFixTask(c: Pick<FixContext, 'store' | 'config'>, flowId: string): Promise<TaskFile> {
  const flow = c.store.readFlow(flowId);
  const problem = c.store.readFlowBrief(flowId).trim() || flow.title;
  const r = c.config.role(FIX_ROLE);
  const input: TaskInput = {
    id: FIX_TASK, stage: flow.stage, kind: 'impl', title: `修复：${flow.title}`.slice(0, 200), role: FIX_ROLE, scopes: [...r.scopes],
    depends_on: [], inputs: [], writes: ['**'], verify: c.config.commands['test'] ? ['test'] : [],
    ac: ['所报告的问题不再出现：写明复现步骤与修复后的结果', '新增回归测试覆盖这个问题（修复前失败、修复后通过）', '只改与这个问题相关的代码，全量测试通过'],
  };
  const [t] = await c.store.addTasks(flowId, [input], 'engine');
  await c.store.appendHandoff(flowId, FIX_TASK, buildFixHandoff(problem, fixMaxFiles(c.config)), 'engine');
  return t!;
}

/** 下一轮复现确认：X1.qa / X1.qa-k。上一轮有未解决的 must 时是确认轮 */
export async function createFixQaTask(root: string, store: StateStore, config: FlowConfig, flowId: string, head: string, actor = 'engine'): Promise<TaskFile> {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const prev = qaTasksOf(tasks, FIX_STAGE).at(-1);
  const priorMust = prev && prev.status === 'done' ? unresolvedIn(store, flowId, prev.id, QA_FILES) ?? [] : [];
  const prevInput = prev ? readReviewEvidence<ReviewInputFile>(store, flowId, prev.id, QA_INPUT) : null;
  const id = nextQaId(tasks, FIX_STAGE);
  const base = stageBaseFor(root, tasks, FIX_STAGE, flow.base_sha);
  const from = priorMust.length > 0 ? prevInput?.head ?? base : base;
  const brief = buildFixQaBrief({
    mode: flow.mode === 'change' ? 'change' : 'fix', qaId: id, round: qaRoundOf(id), problem: store.readFlowBrief(flowId).trim() || flow.title, range: { from, to: head },
    stat: stageDiffStat(root, from, head), serves: serviceCommands(config.commands), priorMust,
  });
  const input: TaskInput = {
    id, stage: FIX_STAGE, kind: 'qa', role: 'stage-qa', title: `${flow.mode === 'change' ? '变更确认' : '修复确认'}：${flow.title}（第 ${qaRoundOf(id)} 轮）`.slice(0, 200), scopes: ['qa'],
    depends_on: [], inputs: [], writes: [], verify: [],
  };
  const [qa] = await store.addTasks(flowId, [input], actor);
  const file: ReviewInputFile = { round: qaRoundOf(id), base: from, head, prior_must: priorMust };
  await store.saveEvidence(flowId, id, QA_INPUT, JSON.stringify(file, null, 2), actor);
  await store.appendHandoff(flowId, id, brief, actor);
  return qa!;
}

async function toNeedsHuman(store: StateStore, flowId: string, reason: string): Promise<void> {
  if (store.readFlow(flowId).stage_status === 'active') await store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  await store.transitionStage(flowId, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'gate', reason: reason.slice(0, 4000) });
}

/** 写日志并结束流程：active/awaiting_gate → done，流程 finished */
async function finish(c: FixContext, flowId: string, conclusion: 'confirmed' | 'skipped', note?: string): Promise<void> {
  const { store } = c;
  if (!hasLog(store, flowId)) await writeFixLog(c, flowId, conclusion, note);
  if (store.readFlow(flowId).stage_status === 'active') await store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  await store.transitionStage(flowId, { to: 'done', trigger: 'gate_passed', actor: 'engine', needs_human: false });
  await store.advanceStage(flowId, 'engine');
}

/** /forge accept：用户放行 needs_human 的修复。已合入主分支的改动保留，写日志后结束 */
export async function acceptFix(c: FixDeps, flowId: string, note: string): Promise<string> {
  const { store } = c;
  const flow = store.readFlow(flowId);
  if (!isLightFlow(flow)) throw new Error(`${flowId} 不是修复或小改动流程`);
  const what = flow.mode === 'change' ? '小改动' : '修复';
  if (flow.stage_status !== 'needs_human') throw new Error(`${what} ${flowId} 当前不是"需要你处理"状态（${flow.stage_status}），不能人工放行。`);
  const tasks = store.listTasks(flowId);
  if (!tasks.some((t) => t.kind === 'impl' && t.status === 'done')) throw new Error(`${what}任务还没有合入主分支，没有可放行的内容。继续处理阻塞（/forge unblock）或 /forge abort。`);
  await writeFixLog(c, flowId, 'accepted', note);
  await store.transitionStage(flowId, { to: 'awaiting_human', trigger: 'accept', actor: 'human', reason: note });
  await store.transitionStage(flowId, { to: 'done', trigger: 'approve', actor: 'human', reason: note });
  await store.advanceStage(flowId, 'human');
  return `已放行${what} ${flowId}（${note}）。日志：.forge/fixes/${store.listFixLogs().at(-1)}`;
}

function mergeEvents(events: readonly FlowEvent[], flowId: string): FlowEvent[] {
  return events.filter((e) => e.flow === flowId && e.type === 'merge' && e.evidence);
}

async function writeFixLog(c: FixDeps, flowId: string, conclusion: FixLogInput['qa']['conclusion'], note?: string): Promise<void> {
  const { store, root } = c;
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const merges = mergeEvents(store.readEvents(), flowId);
  const commits = merges.map((e) => {
    let subject = '';
    try { subject = git(root, ['log', '-1', '--format=%s', e.evidence!]).trim(); } catch { /* 提交已不可读时只留编号 */ }
    return { sha: e.evidence!, subject };
  });
  const from = typeof merges[0]?.data?.['from'] === 'string' ? String(merges[0]!.data!['from']) : '';
  const to = merges.at(-1)?.evidence ?? '';
  let files: string[] = [];
  if (to) {
    try { files = git(root, from ? ['diff', '--name-only', from, to] : ['show', '--name-only', '--format=', to]).split('\n').filter(Boolean); } catch { /* 读不到则留空 */ }
  }
  const qaTasks = qaTasksOf(tasks, FIX_STAGE);
  let must = 0;
  for (const q of qaTasks) {
    if (q.status !== 'done') continue;
    const rep = readReviewEvidence<{ issues: ReviewFinding[] }>(store, flowId, q.id, QA_FILES.report);
    must += rep ? rep.issues.filter((x) => x.level === 'must').length : 0;
  }
  const cost: CostReport = costReport(store, { flow: flowId });
  const date = (c.now?.() ?? new Date()).toISOString().slice(0, 10);
  const content = renderFixLog({
    flow, mode: flow.mode === 'change' ? 'change' : 'fix', date, mainBranch: flow.integration_branch, problem: store.readFlowBrief(flowId).trim() || flow.title, commits, files,
    qa: { rounds: qaTasks.length, conclusion, must, ...(note ? { note } : {}) },
    rework: {
      merge_fail: cost.rework.reduce((n, w) => n + w.merge_fail, 0), run_failed: cost.rework.reduce((n, w) => n + w.run_failed, 0),
      fix_tasks: tasks.filter((t) => t.kind === 'fix' && t.status !== 'cancelled').length,
    },
    cost: [formatRow(cost.total), ...cost.byRole.map(formatRow)],
  });
  await store.writeFixLog(fixLogName(date, store.listFixLogs()), content, flowId);
}

/** 流程的修复日志文本（完成后 /forge-status 显示）；没有时返回 null */
export function readFixLog(store: StateStore, flowId: string): string | null {
  const ev = [...store.readEvents()].reverse().find((e) => e.flow === flowId && e.type === 'note' && e.reason === FIX_LOG_REASON && e.evidence);
  if (!ev?.evidence) return null;
  const abs = store.abs(ev.evidence);
  try { return existsSync(abs) ? readFileSync(abs, 'utf8') : null; } catch { return null; }
}
