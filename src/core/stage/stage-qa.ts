// stage-qa（规格第 11 节第 3 步）：阶段门禁与覆盖率之后，由 stage-qa 在集成分支 HEAD 的临时 worktree 里实际运行、核对 exit。
// 第 1 轮（S1.qa）出问题清单（forge_qa_report），之后各轮（S1.qa-2…）只确认上一轮的 must（forge_qa_confirm，规则同 reviewer）。
// 这里是纯函数（编号、轮次、任务说明）与流程（创建 .qa、处理结论）。轮次处理与阶段审查共用 stage-rounds.ts。
// 引擎的编排（什么时候创建、什么时候调用 resolveQa）由 dispatcher 的 advanceStage 负责。
import type { FlowConfig } from '../state/config.ts';
import type { ReviewFinding, TaskFile } from '../state/schemas.ts';
import type { StateStore, TaskInput } from '../state/state-store.ts';
import { git, gitOk } from '../state/git.ts';
import { readSpec } from '../spec/spec-flow.ts';
import { effectiveSpec } from '../spec/spec.ts';
import { formatMust } from './review.ts';
import { readReviewEvidence, type ReviewInputFile } from './review-flow.ts';
import { resolveRounds, unresolvedIn, type RoundSpec, type StageRoundOutcome } from './stage-rounds.ts';
import { serviceCommands } from '../engine/services.ts';
import { createStageTempWorktree, stageBaseOf } from '../workspace/stage-worktree.ts';
import type { TaskWorktree } from '../workspace/worktree.ts';

export const QA_INPUT = 'qa-input.json';
export const QA_REPORT = 'qa-report.json';
export const QA_CONFIRM = 'qa-confirm.json';
export const QA_FILES = { input: QA_INPUT, report: QA_REPORT, confirm: QA_CONFIRM } as const;
export const QA_MATRIX_MAX = 8_000;
export const QA_STAT_MAX = 4_000;
export const DEFAULT_QA_MAX_ROUNDS = 2;

// —— 编号与轮次（纯函数） ——

/** S1.qa → 1，S1.qa-2 → 2；不是 qa 任务返回 0 */
export function qaRoundOf(id: string): number {
  const m = /\.qa(?:-(\d+))?$/.exec(id);
  return m ? Number(m[1] ?? 1) : 0;
}

const isQaOf = (t: Pick<TaskFile, 'id' | 'kind'>, stage: string) => t.kind === 'qa' && (t.id === `${stage}.qa` || t.id.startsWith(`${stage}.qa-`));

/** 本阶段的 qa task（忽略已取消的），按轮次升序 */
export function qaTasksOf<T extends Pick<TaskFile, 'id' | 'kind' | 'status'>>(tasks: readonly T[], stage: string): T[] {
  return tasks.filter((t) => isQaOf(t, stage) && t.status !== 'cancelled').sort((a, b) => qaRoundOf(a.id) - qaRoundOf(b.id));
}

/** 已经进行的 stage-qa 轮数（忽略已取消的） */
export const qaRounds = (tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'status'>[], stage: string): number => qaTasksOf(tasks, stage).length;

/** 下一轮的编号：S1.qa → S1.qa-2 → S1.qa-3（取消的轮次也占编号） */
export function nextQaId(tasks: readonly Pick<TaskFile, 'id' | 'kind'>[], stage: string): string {
  const rounds = tasks.filter((t) => isQaOf(t, stage)).map((t) => qaRoundOf(t.id));
  const next = Math.max(0, ...rounds) + 1;
  return next === 1 ? `${stage}.qa` : `${stage}.qa-${next}`;
}

// —— 阶段上下文（stage-qa 与阶段审查共用） ——

export interface ExitReq { req: string; title: string; acs: { id: string; text: string; manual: boolean }[] }

/** exit 中的 REQ 与它们的 AC 原文（纯函数）；规格里找不到的 REQ 只列编号 */
export function exitReqsOf(spec: ReturnType<typeof effectiveSpec>, exit: readonly string[]): ExitReq[] {
  return exit.map((id) => {
    const req = spec.reqs.find((r) => r.id === id);
    return { req: id, title: req?.title ?? '（规格里找不到）', acs: (req?.acs ?? []).map((a) => ({ id: `${id}.${a.id}`, text: a.text, manual: !!a.manual })) };
  });
}

/** 读取本阶段的目标、exit 与其 AC 原文；规格或计划缺失时降级（只给阶段编号） */
export function readStageExit(root: string, store: StateStore, flowId: string, stage: string): { goal: string; exit: ExitReq[] } {
  const flow = store.readFlow(flowId);
  const def = flow.s_stages?.find((s) => s.id === stage);
  let exit: ExitReq[] = (def?.exit ?? []).map((req) => ({ req, title: '（规格读取失败）', acs: [] }));
  try {
    const spec = readSpec(root, flow.integration_branch);
    exit = exitReqsOf(effectiveSpec(spec.files, spec.features), def?.exit ?? []);
  } catch { /* 规格读不到时只给 REQ 编号 */ }
  return { goal: def?.goal ?? stage, exit };
}

/** 阶段 diff 的范围：基线用 stageBaseOf，找不到时回退到流程的 base_sha */
export function stageDiffStat(root: string, from: string, to: string): string {
  try { return git(root, ['diff', '--stat', '--no-color', '--no-ext-diff', from, to, '--', '.', ':(exclude)tests/acceptance']).trim(); } catch { return ''; }
}

export function readMatrix(root: string, branch: string, stage: string): string | null {
  const ref = `refs/heads/${branch}`;
  const rel = `docs/qa/${stage}.md`;
  return gitOk(root, ['cat-file', '-e', `${ref}:${rel}`]) ? git(root, ['show', `${ref}:${rel}`]) : null;
}

// —— 任务说明（纯函数） ——

export interface QaBriefInput {
  stage: string;
  goal: string;
  qaId: string;
  round: number;
  exit: readonly ExitReq[];
  /** docs/qa/<阶段>.md 的内容；没有时为 null */
  matrix: string | null;
  range: { from: string; to: string };
  stat: string;
  /** commands 里 serve 或 serve_* 命名的命令名 */
  serves: readonly string[];
  priorMust: readonly ReviewFinding[];
}

export function buildQaBrief(i: QaBriefInput): string {
  const range = `${i.range.from.slice(0, 8)}..${i.range.to.slice(0, 8)}`;
  if (i.priorMust.length > 0) {
    return [
      `# 阶段验收确认（第 ${i.round} 轮）：${i.stage}（${i.qaId}）`,
      '这是确认轮。修复已合入集成分支，门禁与覆盖率已重跑。**只能核对下面这些编号是否已经解决，用 forge_qa_confirm 逐条回答 `{id, resolved, note}`，必须覆盖全部编号。**',
      '不能提出新问题（forge_qa_confirm 没有新增问题的字段）；清单之外的发现写进某条的 note，交给人工签收。',
      `## 上一轮的问题清单\n${i.priorMust.map(formatMust).join('\n')}`,
      `## 修复之后的改动（${range}）\n${i.stat.trim() ? '```\n' + i.stat.slice(0, QA_STAT_MAX) + '\n```' : '（没有改动）'}`,
      i.serves.length ? `需要运行服务时用 forge_service 启动：${i.serves.join('、')}。` : '',
    ].filter(Boolean).join('\n\n');
  }
  const exit = i.exit.length
    ? i.exit.map((r) => `### ${r.req} ${r.title}\n${r.acs.map((a) => `- ${a.id}${a.manual ? '（manual）' : ''}：${a.text}`).join('\n') || '（没有 AC）'}`).join('\n\n')
    : '（本阶段没有 exit）';
  const serve = i.serves.length
    ? `项目定义了服务命令：${i.serves.join('、')}。需要运行服务检查权限、页面状态时，**用 forge_service 启动**（不要用 bash 的 & 放到后台）；工作目录是 HEAD 的临时 worktree，不是主工作区。`
    : '项目没有 serve 或 serve_* 命令；只能读代码和运行 commands 里已有的命令做检查。';
  const matrix = i.matrix === null
    ? '（docs/qa 里还没有这个阶段的覆盖率矩阵）'
    : i.matrix.length > QA_MATRIX_MAX ? `${i.matrix.slice(0, QA_MATRIX_MAX)}\n…（已截断，完整内容见 docs/qa/${i.stage}.md）` : i.matrix;
  return [
    `# 阶段验收：${i.stage}（${i.qaId}，第 ${i.round} 轮）`,
    `这是第一轮。门禁与覆盖率已经通过。按技能 stage-qa 的顺序：核对跨模块一致性、页面状态、测试是否形同虚设、exit 是否真正达成，最后调用 forge_qa_report 一次提交全部问题（没有问题提交空列表）。must 必须写出处（rule:/ac:/contract:/defect:），写不出出处的是 suggest；规则同 reviewer。`,
    `## 阶段目标\n${i.goal}`,
    `## exit 中的需求与 AC 原文\n${exit}`,
    `## 覆盖率矩阵（docs/qa/${i.stage}.md）\n${matrix}`,
    `## 阶段改动统计（阶段基线 ${range}，不含 tests/acceptance/**）\n${i.stat.trim() ? '```\n' + i.stat.slice(0, QA_STAT_MAX) + '\n```' : '（没有改动）'}`,
    `阶段基线取本阶段 impl、fix、doc 任务中最早的 base_sha。需要看具体改动时自己读文件或运行 git diff。`,
    `## 服务\n${serve}`,
  ].join('\n\n');
}

// —— 创建与处理 ——

/** 下一轮 stage-qa：S1.qa / S1.qa-k。上一轮有未解决的 must 时是确认轮（带上它们），否则是出清单的一轮 */
export async function createQaTask(root: string, store: StateStore, config: FlowConfig, flowId: string, stage: string, head: string, actor = 'engine'): Promise<TaskFile> {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const prev = qaTasksOf(tasks, stage).at(-1);
  const priorMust = prev && prev.status === 'done' ? unresolvedIn(store, flowId, prev.id, QA_FILES) ?? [] : [];
  const prevInput = prev ? readReviewEvidence<ReviewInputFile>(store, flowId, prev.id, QA_INPUT) : null;
  const id = nextQaId(tasks, stage);
  const confirm = priorMust.length > 0;
  const { goal, exit } = readStageExit(root, store, flowId, stage);
  const stageBase = stageBaseFor(root, tasks, stage, flow.base_sha);
  const from = confirm ? prevInput?.head ?? stageBase : stageBase;
  const brief = buildQaBrief({
    stage, goal, qaId: id, round: qaRoundOf(id), exit, matrix: readMatrix(root, flow.integration_branch, stage),
    range: { from, to: head }, stat: stageDiffStat(root, from, head), serves: serviceCommands(config.commands), priorMust,
  });
  const input: TaskInput = {
    id, stage, kind: 'qa', role: 'stage-qa', title: `阶段验收：${stage}（第 ${qaRoundOf(id)} 轮）`, scopes: ['qa'],
    depends_on: [], inputs: [], writes: [], verify: [],
  };
  const [qa] = await store.addTasks(flowId, [input], actor);
  const file: ReviewInputFile = { round: qaRoundOf(id), base: from, head, prior_must: priorMust };
  await store.saveEvidence(flowId, id, QA_INPUT, JSON.stringify(file, null, 2), actor);
  await store.appendHandoff(flowId, id, brief, actor);
  return qa!;
}

/** 阶段基线（见 stageBaseOf）；阶段里没有任务开过工时回退到流程的 base_sha，再不行用 HEAD（空 diff） */
export function stageBaseFor(root: string, tasks: readonly TaskFile[], stage: string, flowBase: string | null): string {
  return stageBaseOf(root, tasks, stage) ?? flowBase ?? git(root, ['rev-parse', 'HEAD']).trim();
}

export const qaRoundSpec = (config: FlowConfig): RoundSpec => ({
  source: 'qa', rounds: (tasks, stage) => qaTasksOf(tasks, stage), roundOf: qaRoundOf, files: QA_FILES,
  maxRounds: config.raw.qa?.max_rounds ?? DEFAULT_QA_MAX_ROUNDS, label: 'stage-qa',
});

/** 处理 stage-qa 的结论；返回值的含义见 stage-rounds.ts 的 StageRoundOutcome */
export function resolveQa(root: string, store: StateStore, config: FlowConfig, flowId: string, stage: string): Promise<StageRoundOutcome> {
  return resolveRounds(root, store, flowId, stage, qaRoundSpec(config));
}

/**
 * 阶段级任务（qa、阶段 .rv）派发时的 worktree：集成分支上、输入记录里的 head 处的 detached 临时 worktree（没有记录时用当前 HEAD）。
 * 任务 done 或 cancelled 后由 resolveQa / resolveStageReview（或 cleanupStageWorktrees）删除。
 */
export function stageWorktreeFor(root: string, store: StateStore, flowId: string, task: Pick<TaskFile, 'id' | 'kind'>, integrationBranch: string): TaskWorktree {
  const input = readReviewEvidence<ReviewInputFile>(store, flowId, task.id, task.kind === 'qa' ? QA_INPUT : 'review-input.json');
  return createStageTempWorktree(root, flowId, task.id, integrationBranch, input?.head);
}
