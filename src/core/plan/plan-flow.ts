// P1 契约与计划：读取并校验 architect 的产物、计划提案、doc 预检、P1 闸门、批准时落地。
// 校验本身是纯函数（contract-check、plan、spec）；这里只负责从分支或 worktree 取文件、调用它们、经 StateStore 写入。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { FlowFile, PlanFile, TaskFile } from '../state/schemas.ts';
import type { StateStore, TaskInput } from '../state/state-store.ts';
import { git, gitOk } from '../state/git.ts';
import { contractFilesAt, contractFilesInDir, parseContracts } from './contract-check.ts';
import { checkPlan, deriveTasks, formatPlanReport, nextPlanTaskId, parsePlan, PLAN_PATH, type PlanCheck } from './plan.ts';
import { acTexts, effectiveSpec, type SpecFiles } from '../spec/spec.ts';
import { SPEC_PATHS } from '../spec/spec-flow.ts';
import { isSettled } from '../state/state-machine.ts';
import { COMMANDS_FILE, commandsProblems } from '../state/project-commands.ts';
import { escalationPolicy } from '../insight/cost-control.ts';

export const P1_STAGE = 'P1';
/** 由程序派发 architect 的阶段：P1 契约与计划 */
export const isArchitectStage = (stage: string): boolean => stage === P1_STAGE;

/** 从 git 引用（分支）或目录（worktree，含未提交的改动）读取文件 */
export type Source = { root: string; ref: string } | { dir: string };

export function readRel(src: Source, rel: string): string | null {
  if ('dir' in src) {
    const abs = path.join(src.dir, rel);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
  }
  return gitOk(src.root, ['cat-file', '-e', `${src.ref}:${rel}`]) ? git(src.root, ['show', `${src.ref}:${rel}`]) : null;
}

export function readSpecFrom(src: Source): { files: SpecFiles } | string {
  const files: Partial<SpecFiles> = {};
  for (const name of SPEC_PATHS) {
    const text = readRel(src, `docs/spec/${name}.md`);
    if (text === null) return `缺少规格文件 docs/spec/${name}.md`;
    files[name] = text;
  }
  return { files: files as SpecFiles };
}

export const planHash = (text: string) => createHash('sha256').update(text).digest('hex');

export interface P1Result {
  errors: string[];
  warnings: string[];
  plan: PlanFile | null;
  planText: string | null;
  check: PlanCheck | null;
  spec: ReturnType<typeof effectiveSpec> | null;
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

/** 契约检查 + plan 校验；errors 为空才算通过 */
export function checkP1(root: string, src: Source, flow: FlowFile, existingTaskIds: readonly string[], config: FlowConfig): P1Result {
  const errors: string[] = [];
  const warnings: string[] = [];
  const specFiles = readSpecFrom(src);
  if (typeof specFiles === 'string') return { errors: [specFiles], warnings, plan: null, planText: null, check: null, spec: null };
  const spec = effectiveSpec(specFiles.files);

  const contractFiles = 'dir' in src ? contractFilesInDir(src.dir) : contractFilesAt(src.root, src.ref);
  const contracts = parseContracts(contractFiles);
  errors.push(...contracts.errors.map((e) => `契约 ${e.file}：${e.message}`));
  warnings.push(...contracts.warnings.map((e) => `契约 ${e.file}：${e.message}`));

  const planText = readRel(src, PLAN_PATH);
  if (planText === null) return { errors: [...errors, `缺少 ${PLAN_PATH}`], warnings, plan: null, planText, check: null, spec };
  const parsed = parsePlan(planText);
  if (!parsed.plan) return { errors: [...errors, ...parsed.errors], warnings, plan: null, planText, check: null, spec };
  const check = checkPlan(parsed.plan, {
    catalog: contracts.catalog, spec, existingTaskIds,
    limits: { max_parallel: config.limits.max_parallel, max_task_files: config.limits.max_task_files, critical_fanout: escalationPolicy(config).criticalFanout },
  });
  return { errors: [...errors, ...check.errors], warnings: [...warnings, ...check.warnings], plan: parsed.plan, planText, check, spec };
}

/** architect task 的说明：worker 用的模型决定粒度，task 编号从哪里起 */
export function architectBrief(_config: FlowConfig, existingTaskIds: readonly string[], workerModel: string | null, rework?: string): string {
  return [
    '# P1 契约与计划',
    '按角色提示的顺序产出：docs/arch/overview.md、契约（docs/contracts/）、术语表追加、项目命令（commands.yaml）、AGENTS.md、docs/plan/plan.yaml。',
    `worker 使用的模型：${workerModel ?? '尚未设置（按强模型估计粒度）'}；粒度按技能 plan-dag 的说明跟模型走。`,
    `plan.yaml 的 task 编号从 ${nextPlanTaskId(existingTaskIds)} 起（流程里已有 ${existingTaskIds.join('、') || '无'}）。`,
    '写完后用 forge_propose_plan 提交（附 assumptions 与 extras），按返回的错误修改（提醒自己判断要不要改），通过后 forge_submit。',
    ...(rework ? ['', '## 需要返工', rework, '只改上面提到的地方，其余保持不变。'] : []),
  ].join('\n');
}

/**
 * P1 为 active 时保证有一个进行中的 architect task：还没有 P1 task，或 P1 需要返工（打回、闸门未通过）时新建一个。
 * 返工的 task 接着上一个 architect task 的会话（fork）。返回新建的 task，没有新建时返回 null。
 */
export async function ensureArchitectTask(store: StateStore, config: FlowConfig, flowId: string, workerModel: string | null): Promise<TaskFile | null> {
  const root = store.root;
  const flow = store.readFlow(flowId);
  if (!isArchitectStage(flow.stage) || flow.stage_status !== 'active') return null;
  const all = store.listTasks(flowId);
  const p1 = all.filter((t) => t.stage === flow.stage);
  if (p1.some((t) => !isSettled(t))) return null;
  if (p1.length && !flow.plan_rework) return null;
  const ids = usedTaskIds(root, store, flowId, config);
  const id = nextPlanTaskId(ids);
  const prev = p1.filter((t) => t.status === 'done').at(-1);
  const input: TaskInput = {
    id, stage: flow.stage, kind: 'doc', role: 'architect', title: `契约与计划${p1.length ? '（返工）' : ''}`,
    // 只用 plan scope：architect 在 S0 另有 code scope，P1 的 doc task 不能因此获得全部可写范围
    scopes: ['plan'], depends_on: [], inputs: [], writes: [...(config.scopeWrites()['plan'] ?? [])], verify: [],
    ...(prev ? { fork_from_task: prev.id } : {}),
  };
  const [task] = await store.addTasks(flowId, [input], 'engine');
  await store.appendHandoff(flowId, id, architectBrief(config, [...ids, id], workerModel, flow.plan_rework?.reason), 'engine');
  if (flow.plan_rework) await store.setPlanRework(flowId, null, 'engine');
  return task!;
}

const proposalProblem = (store: StateStore, flowId: string, planText: string | null): string | null => {
  const p = store.readPlanProposal(flowId);
  if (!p) return '还没有用 forge_propose_plan 提交计划';
  if (planText !== null && p.plan_hash !== planHash(planText)) return 'docs/plan/plan.yaml 在 forge_propose_plan 之后又改过，请重新提交计划';
  return null;
};

/** P1 的 doc task 预检（v3.2 ：契约检查与计划校验接进 doc 的预检）；通过返回 null，否则返回失败原因 */
export function docPrecheck(root: string, store: StateStore, config: FlowConfig, flowId: string, task: TaskFile): string | null {
  if (task.kind !== 'doc' || task.stage !== P1_STAGE || !task.branch) return null;
  const flow = store.readFlow(flowId);
  const r = checkP1(root, { root, ref: task.branch }, flow, usedTaskIds(root, store, flowId, config), config);
  const problems = [...r.errors, ...commandsProblems(readRel({ root, ref: task.branch }, COMMANDS_FILE), '')];
  const proposal = proposalProblem(store, flowId, r.planText);
  if (proposal) problems.push(proposal);
  return problems.length ? `P1 预检未通过：\n${problems.map((p) => `- ${p}`).join('\n')}` : null;
}

/** P1 闸门：集成分支上的契约、计划、commands.yaml 都要通过，并且提交过计划提案 */
export function p1GateProblems(root: string, store: StateStore, config: FlowConfig, flowId: string): string[] {
  const flow = store.readFlow(flowId);
  const r = checkP1(root, { root, ref: flow.integration_branch }, flow, usedTaskIds(root, store, flowId, config), config);
  const problems = [...r.errors, ...commandsProblems(readRel({ root, ref: flow.integration_branch }, COMMANDS_FILE), '')];
  const proposal = proposalProblem(store, flowId, r.planText);
  if (proposal) problems.push(proposal);
  return problems;
}

/** 批准页：计划报告、assumptions、extras、项目命令（给出 root 时列出集成分支上的 commands.yaml） */
export function planApprovalSummary(store: StateStore, flowId: string, root?: string): string {
  const p = store.readPlanProposal(flowId);
  if (!p) return '还没有计划提案。';
  const commandsText = root ? readRel({ root, ref: store.readFlow(flowId).integration_branch }, COMMANDS_FILE) : null;
  return [
    p.report,
    p.assumptions.length ? `assumptions（architect 默认的处理，请逐条确认）：\n${p.assumptions.map((a, i) => `${i + 1}. ${a.question} → ${a.decision}`).join('\n')}` : 'assumptions：无',
    p.extras.length ? `extras（超出需求的设计，请确认）：\n${p.extras.map((x, i) => `${i + 1}. ${x.what}：${x.why}`).join('\n')}` : 'extras：无',
    ...(commandsText !== null ? [`项目命令（${COMMANDS_FILE}，程序只执行 install、test、acceptance、serve 等，其余给 agent 参考）：\n${commandsText.trim()}`] : []),
    '批准后：生成 S 阶段与 task，契约锁定（之后只能追加），进入 S0（由 architect 搭骨架、写 rules/，按需修正 commands.yaml）。',
  ].join('\n\n');
}

/** 每个 impl task 的初始笔记：负责的 AC 原文（notes 小改） */
export function initialNotes(tasks: readonly TaskInput[], spec: ReturnType<typeof effectiveSpec>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of tasks) {
    const texts = acTexts(spec, t.ac ?? []);
    const goal = (t.ac ?? []).map((ac) => `${ac}：${texts[ac] ?? '（规格中找不到原文）'}`);
    if (t.manual_checks?.length) goal.push(`需要用户查看（manual）：${t.manual_checks.join('；')}`);
    if (goal.length) out[t.id] = goal;
  }
  return out;
}

/**
 * 批准 P1 时落地计划：再校验一次集成分支，换成集成分支上的 commands.yaml，
 * 然后在一个事务里写入 S 阶段、task、初始笔记与契约锁定点。已经落地过的流程直接跳过（批准中途崩溃后重试）。
 */
export async function materializePlan(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string[]> {
  const flow = store.readFlow(flowId);
  if (flow.s_stages?.length) return [];
  const r = checkP1(root, { root, ref: flow.integration_branch }, flow, usedTaskIds(root, store, flowId, config), config);
  const problems = [...r.errors, ...commandsProblems(readRel({ root, ref: flow.integration_branch }, COMMANDS_FILE), '')];
  const proposal = proposalProblem(store, flowId, r.planText);
  if (proposal) problems.push(proposal);
  if (problems.length || !r.plan || !r.check || !r.spec) throw new Error(`计划未通过校验，不能批准：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  config.syncCommands(root, flow.integration_branch);
  // task 只登记全量测试；typecheck、lint 等是参考命令，worker 与审查者按 commands.yaml 自己决定
  const tasks = deriveTasks(r.plan, r.check.deps, { worker: config.role('worker').scopes }, { verify: ['test'].filter((c) => config.commands[c]?.trim()) });
  const contractsBase = git(root, ['rev-parse', `refs/heads/${flow.integration_branch}`]).trim();
  await store.materializePlan(flowId, { stages: r.plan.stages, tasks, notes: initialNotes(tasks, r.spec), contractsBase });
  return [
    `已生成 ${r.plan.stages.length} 个 S 阶段（${r.plan.stages.map((s) => s.id).join('、')}）与 ${tasks.length} 个 task。`,
    `契约已锁定（${contractsBase.slice(0, 8)}），之后只能追加。`,
  ];
}

/** forge_propose_plan：在 architect 的 worktree 上校验，通过后保存提案 */
export async function proposePlan(root: string, store: StateStore, config: FlowConfig, flowId: string, task: TaskFile,
  input: { assumptions: PlanProposalInput['assumptions']; extras: PlanProposalInput['extras'] }, actor: string): Promise<{ ok: boolean; text: string }> {
  if (task.kind !== 'doc' || task.stage !== P1_STAGE || !task.worktree) return { ok: false, text: '只有 P1 的 architect task 可以提交计划。' };
  const flow = store.readFlow(flowId);
  const r = checkP1(root, { dir: task.worktree }, flow, usedTaskIds(root, store, flowId, config), config);
  if (r.errors.length || !r.check?.report || r.planText === null) {
    return { ok: false, text: `计划未通过校验（共 ${r.errors.length} 处），改了再提交：\n${r.errors.map((e) => `- ${e}`).join('\n')}${r.warnings.length ? `\n\n提醒：\n${r.warnings.map((w) => `- ${w}`).join('\n')}` : ''}` };
  }
  const report = formatPlanReport(r.check.report, r.warnings);
  await store.savePlanProposal(flowId, { task: task.id, plan_hash: planHash(r.planText), assumptions: input.assumptions, extras: input.extras, report, warnings: r.warnings }, actor);
  return { ok: true, text: `计划已通过校验并保存。\n\n${report}\n\n${r.warnings.length ? '提醒看过再决定要不要改；' : ''}确认无误后 forge_submit。plan.yaml 之后再改动需要重新 forge_propose_plan。` };
}
type PlanProposalInput = { assumptions: { question: string; decision: string }[]; extras: { what: string; why: string }[] };

/** 状态视图与 forge_status 的 P1 摘要 */
export function planStatus(store: StateStore, flowId: string): string {
  const flow = store.readFlow(flowId);
  if (flow.stage !== P1_STAGE && !flow.s_stages?.length) return '';
  if (flow.s_stages?.length) return `计划：${flow.s_stages.length} 个 S 阶段，契约锁定于 ${flow.contracts_base?.slice(0, 8) ?? '-'}`;
  const p = store.readPlanProposal(flowId);
  return [`计划：${p ? '已提交提案' : 'architect 起草中'}`, ...(p ? [p.report.split('\n')[0]!] : []), ...(flow.plan_rework ? [`返工：${flow.plan_rework.reason}`] : [])].join('\n');
}
