// 架构阶段 S0：程序派 architect 的 task、提交时检查必需文件与 docs/plan.md、批准页、批准时按计划生成批次阶段与任务。
// 解析与校验是纯函数（batches.ts、spec/prd.ts）；这里只负责从分支或 worktree 取文件、调用它们、经 StateStore 写入。
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { TaskFile } from '../state/schemas.ts';
import type { StateStore, TaskInput } from '../state/state-store.ts';
import { git, gitOk } from '../state/git.ts';
import { isSettled } from '../state/state-machine.ts';
import { COMMANDS_FILE, commandsProblems } from '../state/project-commands.ts';
import { ownAcceptanceGlob } from '../state/paths.ts';
import { checkPrd, parsePrd, PRD_PATH } from '../spec/prd.ts';
import { nextPlanTaskId } from './plan.ts';
import { ARCH_REQUIRED_FILES, PLAN_MD, S0_EXTRA_WRITES, checkBatchPlan, deriveBatchTasks, parseBatchPlan, risksSection, splitPlan, type BatchPlan } from './batches.ts';

export const ARCH_STAGE = 'S0';
/** 由程序派发 architect 的阶段：S0 架构 */
export const isArchitectStage = (stage: string): boolean => stage === ARCH_STAGE;
/** S0 里 architect 自己做的 task（不含审查、修复） */
export const isArchitectTask = (t: Pick<TaskFile, 'stage' | 'kind' | 'role'>): boolean => isArchitectStage(t.stage) && t.kind === 'impl' && t.role === 'architect';

/** 从 git 引用（分支）或目录（worktree，含未提交的改动）读取文件 */
export type Source = { root: string; ref: string } | { dir: string };

export function readRel(src: Source, rel: string): string | null {
  if ('dir' in src) {
    const abs = path.join(src.dir, rel);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
  }
  return gitOk(src.root, ['cat-file', '-e', `${src.ref}:${rel}`]) ? git(src.root, ['show', `${src.ref}:${rel}`]) : null;
}

/**
 * 规划时已经用掉的 task 编号：本流程的 task，加上此前各流程的 task 与主分支 tests/acceptance/ 下的目录名。
 * 验收测试目录全仓库共用，编号不能和以前的流程重复；只取 T-xxx 的主编号。
 */
export function usedTaskIds(root: string, store: StateStore, flowId: string, config: FlowConfig): string[] {
  const ids = new Set(store.listTasks(flowId).map((t) => t.id));
  for (const f of store.listFlows()) if (f !== flowId) for (const t of store.listTasks(f)) ids.add(t.id.split('.')[0]!);
  try {
    for (const d of git(root, ['ls-tree', '-d', '--name-only', `${config.raw.main_branch}:tests/acceptance`]).split('\n')) if (/^T-\d+$/.test(d.trim())) ids.add(d.trim());
  } catch { /* 主分支上还没有验收目录 */ }
  return [...ids];
}

export interface ArchitectureCheck { errors: string[]; warnings: string[]; plan: BatchPlan | null }

/** 必需文件、commands.yaml、docs/plan.md 的 yaml 区块：errors 不为空时提交退回；warnings 只提醒（含 PRD 的检查） */
export function checkArchitecture(src: Source): ArchitectureCheck {
  const errors = ARCH_REQUIRED_FILES.filter((f) => f !== COMMANDS_FILE && readRel(src, f) === null).map((f) => `缺少 ${f}`);
  errors.push(...commandsProblems(readRel(src, COMMANDS_FILE), ''));
  const prdText = readRel(src, PRD_PATH);
  const prd = parsePrd(prdText ?? '');
  const warnings = prdText === null ? [] : checkPrd(prd, (rel) => readRel(src, rel) !== null).map((w) => `PRD：${w}`);
  const planText = readRel(src, PLAN_MD);
  if (planText === null) return { errors, warnings, plan: null };
  const parsed = parseBatchPlan(planText);
  warnings.push(...parsed.warnings);
  if (!parsed.plan) return { errors: [...errors, ...parsed.errors], warnings, plan: null };
  const check = checkBatchPlan(parsed.plan, prd);
  return { errors: [...errors, ...check.errors], warnings: [...warnings, ...check.warnings], plan: check.errors.length ? null : parsed.plan };
}

/** architect task 的说明 */
export function architectBrief(rework?: string): string {
  return [
    '# S0 架构',
    `按角色提示的顺序完成技术栈、骨架、公共规范、domain 划分、domain 间接口、API 契约、逐页核对原型与 ${PLAN_MD}。需求在 ${PRD_PATH}，原型在 docs/prototype/。`,
    `提交前这些文件必须存在：${ARCH_REQUIRED_FILES.join('、')}；${PLAN_MD} 的「## 程序读取的部分」要能解析。缺文件或解析不过时 forge_submit 会退回并列出原因，其余问题只提醒。`,
    '必需的命令要真的能跑，冒烟测试要通过：合入后程序在集成分支上跑门禁命令，通过后等用户批准。',
    ...(rework ? ['', '## 需要返工', rework, '只改上面提到的地方，其余保持不变。'] : []),
  ].join('\n');
}

/**
 * S0 为 active 且计划还没落地时，保证有一个进行中的 architect task：还没有，或用户打回需要返工时新建一个。
 * 返工的 task 接着上一个 architect task 的会话（fork）。返回新建的 task，没有新建时返回 null。
 */
export async function ensureArchitectTask(store: StateStore, config: FlowConfig, flowId: string): Promise<TaskFile | null> {
  const root = store.root;
  const flow = store.readFlow(flowId);
  if (!isArchitectStage(flow.stage) || flow.stage_status !== 'active' || flow.s_stages?.length) return null;
  const all = store.listTasks(flowId);
  const stageTasks = all.filter((t) => t.stage === flow.stage);
  if (stageTasks.some((t) => !isSettled(t))) return null;
  const own = stageTasks.filter(isArchitectTask);
  if (own.length && !flow.plan_rework) return null;
  const id = nextPlanTaskId(usedTaskIds(root, store, flowId, config));
  const prev = own.filter((t) => t.status === 'done').at(-1);
  const input: TaskInput = {
    id, stage: flow.stage, kind: 'impl', role: 'architect', title: `架构：技术栈、骨架、契约与计划${own.length ? '（返工）' : ''}`,
    scopes: ['code'], depends_on: [], inputs: [], writes: ['**', ...S0_EXTRA_WRITES, ownAcceptanceGlob(id)],
    verify: config.commands['test']?.trim() ? ['test'] : [],
    ...(prev ? { fork_from_task: prev.id } : {}),
  };
  const [task] = await store.addTasks(flowId, [input], 'engine');
  await store.appendHandoff(flowId, id, architectBrief(flow.plan_rework?.reason), 'engine');
  if (flow.plan_rework) await store.setPlanRework(flowId, null, 'engine');
  return task!;
}

const APPROVAL_PROSE_MAX = 6000;

/** 批准页：plan.md 的说明部分（过长截断）、风险与假设、PRD 检查的警告、计划的提醒、项目命令 */
export function planApprovalSummary(root: string, store: StateStore, flowId: string): string {
  const ref = store.readFlow(flowId).integration_branch;
  const text = readRel({ root, ref }, PLAN_MD);
  if (text === null) return `集成分支上还没有 ${PLAN_MD}。`;
  const { prose } = splitPlan(text);
  const check = checkArchitecture({ root, ref });
  const plan = check.plan;
  const risks = risksSection(prose);
  const commands = readRel({ root, ref }, COMMANDS_FILE);
  return [
    plan ? `计划：${plan.batches.length} 个批次（${plan.batches.map((b) => `${b.id}${b.title ? ` ${b.title}` : ''}：后端 ${b.backend.length} 个 domain、页面 ${b.frontend.length} 个`).join('；')}）` : '计划：yaml 区块未通过校验',
    `## ${PLAN_MD} 的说明部分\n${prose.length > APPROVAL_PROSE_MAX ? `${prose.slice(0, APPROVAL_PROSE_MAX)}\n…（已截断，完整内容用 forge_read 读 ${PLAN_MD}）` : prose || '（没有）'}`,
    `## 风险与假设\n${risks || '（plan.md 里没有这一节）'}`,
    ...(check.errors.length ? [`## 不能批准的问题\n${check.errors.map((e) => `- ${e}`).join('\n')}`] : []),
    `## 提醒（PRD 检查与计划检查，不影响批准）\n${check.warnings.length ? check.warnings.map((w) => `- ${w}`).join('\n') : '（无）'}`,
    ...(commands !== null ? [`## 项目命令（${COMMANDS_FILE}）\n${commands.trim()}`] : []),
    '批准后：集成分支合入主分支，按计划生成批次阶段与任务，开始第 1 批。',
  ].join('\n\n');
}

/**
 * 批准 S0 时落地计划：再校验一次集成分支，换成集成分支上的 commands.yaml，
 * 然后在一个事务里写入批次阶段与任务。已经落地过的流程直接跳过（批准中途崩溃后重试）。
 */
export async function materializePlan(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string[]> {
  const flow = store.readFlow(flowId);
  if (flow.s_stages?.length) return [];
  const ref = flow.integration_branch;
  const check = checkArchitecture({ root, ref });
  if (check.errors.length || !check.plan) throw new Error(`架构产出未通过校验，不能批准：\n${check.errors.map((p) => `- ${p}`).join('\n')}`);
  config.syncCommands(root, ref);
  const first = Number(nextPlanTaskId(usedTaskIds(root, store, flowId, config)).slice(2));
  const prd = parsePrd(readRel({ root, ref }, PRD_PATH) ?? '');
  const { stages, tasks } = deriveBatchTasks(check.plan, prd, first, { verify: ['test'].filter((c) => config.commands[c]?.trim()) });
  const contractsBase = git(root, ['rev-parse', `refs/heads/${ref}`]).trim();
  await store.materializePlan(flowId, { stages, tasks, notes: {}, contractsBase, ...(check.plan.max_parallel_backend ? { maxParallelBackend: check.plan.max_parallel_backend } : {}) });
  return [`已生成 ${stages.length} 个批次阶段（${stages.map((s) => s.id).join('、')}）与 ${tasks.length} 个 task。`];
}

/** 状态视图与 forge_status 的计划摘要 */
export function planStatus(store: StateStore, flowId: string): string {
  const flow = store.readFlow(flowId);
  if (flow.s_stages?.length) return `计划：${flow.s_stages.length} 个批次`;
  return isArchitectStage(flow.stage) && flow.plan_rework ? `返工：${flow.plan_rework.reason}` : '';
}
