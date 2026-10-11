// P1 契约与计划（规格第 5、7、13 节）：读取并校验 architect 的产物、计划提案、doc 预检、P1 闸门、批准时落地。
// 校验本身是纯函数（contract-check、plan、spec）；这里只负责从分支或 worktree 取文件、调用它们、经 StateStore 写入。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { FlowFile, PlanFile, TaskFile } from '../state/schemas.ts';
import type { StateStore, TaskInput } from '../state/state-store.ts';
import { git, gitOk } from '../state/git.ts';
import { contractFilesAt, contractFilesInDir, parseContracts } from './contract-check.ts';
import { checkPlan, deriveTasks, formatPlanReport, nextPlanTaskId, parsePlan, PLAN_PATH, type PlanCheck } from './plan.ts';
import { acTexts, effectiveSpec, glossaryTerms, type SpecFeature, type SpecFiles } from '../spec/spec.ts';
import { SPEC_PATHS } from '../spec/spec-flow.ts';
import { isSettled } from '../state/state-machine.ts';
import { applyDrafts, commandsDraftProblems, formatDrafts, listDrafts } from './rules-draft.ts';
import { ADOPT_STAGE, ADOPT_WRITES, adoptBrief, adoptPrecheck, adoptScope } from './adopt.ts';
import { hasContracts, lockedContractProblems, readSpecAt, scopeSpecToFeature } from './feature-spec.ts';

export const P1_STAGE = 'P1';
/** 由程序派发 architect 的阶段：P1 契约与计划，以及 --adopt 的 ADOPT */
export const isArchitectStage = (stage: string): boolean => stage === P1_STAGE || stage === ADOPT_STAGE;

/** 从 git 引用（分支）或目录（worktree，含未提交的改动）读取文件 */
export type Source = { root: string; ref: string } | { dir: string };

export function readRel(src: Source, rel: string): string | null {
  if ('dir' in src) {
    const abs = path.join(src.dir, rel);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
  }
  return gitOk(src.root, ['cat-file', '-e', `${src.ref}:${rel}`]) ? git(src.root, ['show', `${src.ref}:${rel}`]) : null;
}

function listRel(src: Source, dir: string): string[] {
  if ('dir' in src) {
    const abs = path.join(src.dir, dir);
    return existsSync(abs) ? readdirSync(abs).filter((f) => statSync(path.join(abs, f)).isFile()).map((f) => `${dir}/${f}`).sort() : [];
  }
  return git(src.root, ['ls-tree', '--name-only', src.ref, '--', `${dir}/`]).split('\n').filter(Boolean).sort();
}

export function readSpecFrom(src: Source): { files: SpecFiles; features: SpecFeature[] } | string {
  const files: Partial<SpecFiles> = {};
  for (const name of SPEC_PATHS) {
    const text = readRel(src, `docs/spec/${name}.md`);
    if (text === null) return `缺少规格文件 docs/spec/${name}.md`;
    files[name] = text;
  }
  const features = listRel(src, 'docs/spec/features').filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: path.posix.basename(f), content: readRel(src, f)! }));
  return { files: files as SpecFiles, features };
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

/** 契约检查 + plan 校验 + 术语表只能追加；errors 为空才算通过 */
/**
 * 规划时已经用掉的 task 编号：本流程的 task，加上此前各流程的 task 与主分支 tests/acceptance/ 下的目录名。
 * 验收测试目录全仓库共用，feature 流程的编号不能和以前的流程重复（偏离 89）；只取 T-xxx 的主编号。
 */
export function usedTaskIds(root: string, store: StateStore, flowId: string, config: FlowConfig): string[] {
  const ids = new Set(store.listTasks(flowId).map((t) => t.id));
  for (const f of store.listFlows()) if (f !== flowId) for (const t of store.listTasks(f)) ids.add(t.id.split('.')[0]!);
  try {
    for (const d of git(root, ['ls-tree', '-d', '--name-only', `${config.raw.main_branch}:tests/acceptance`]).split('\n')) if (/^T-\d+$/.test(d.trim())) ids.add(d.trim());
  } catch { /* 主分支上还没有验收目录 */ }
  return [...ids];
}

export function checkP1(root: string, src: Source, flow: FlowFile, existingTaskIds: readonly string[], config: FlowConfig): P1Result {
  const errors: string[] = [];
  const warnings: string[] = [];
  const specFiles = readSpecFrom(src);
  if (typeof specFiles === 'string') return { errors: [specFiles], warnings, plan: null, planText: null, check: null, spec: null };
  let spec = effectiveSpec(specFiles.files, specFiles.features);
  // feature 流程：计划只需要覆盖本次新增或修改的 AC，已有需求早已实现
  const baseSpec = flow.mode === 'feature' && flow.base_sha ? readSpecAt(root, flow.base_sha) : null;
  if (baseSpec) spec = scopeSpecToFeature(spec, effectiveSpec(baseSpec.files, baseSpec.features));

  const contractFiles = 'dir' in src ? contractFilesInDir(src.dir) : contractFilesAt(src.root, src.ref);
  const contracts = parseContracts(contractFiles);
  errors.push(...contracts.errors.map((e) => `契约 ${e.file}：${e.message}`));
  warnings.push(...contracts.warnings.map((e) => `契约 ${e.file}：${e.message}`));
  // feature 流程：流程起点时主分支上已有的契约从一开始就锁定，P1 只能追加（第 13.3 节）
  if (flow.mode === 'feature') errors.push(...lockedContractProblems(root, flow.base_sha, contractFiles));

  // 术语表：P1 起只能追加条目，已有条目改动走规格修订（第 13.5 节）
  if (flow.spec?.sha && gitOk(root, ['cat-file', '-e', `${flow.spec.sha}:docs/spec/glossary.md`])) {
    const before = glossaryTerms(git(root, ['show', `${flow.spec.sha}:docs/spec/glossary.md`]));
    const after = new Map(glossaryTerms(specFiles.files.glossary).map((t) => [t.name, t]));
    for (const t of before) {
      const now = after.get(t.name);
      if (!now) errors.push(`术语表：已有条目「${t.name}」被删除或改名；P1 起只能追加，修改请写进 assumptions，由用户通过规格修订确认`);
      else if (now.english !== t.english || now.definition !== t.definition || now.aliases.join('、') !== t.aliases.join('、')) {
        errors.push(`术语表：已有条目「${t.name}」被修改；P1 起只能追加新条目`);
      }
    }
  }

  const planText = readRel(src, PLAN_PATH);
  if (planText === null) return { errors: [...errors, `缺少 ${PLAN_PATH}`], warnings, plan: null, planText, check: null, spec };
  const parsed = parsePlan(planText);
  if (!parsed.plan) return { errors: [...errors, ...parsed.errors], warnings, plan: null, planText, check: null, spec };
  const check = checkPlan(parsed.plan, {
    catalog: contracts.catalog, spec, existingTaskIds, mode: flow.mode === 'feature' ? 'feature' : 'build',
    limits: { max_parallel: config.limits.max_parallel, max_task_files: config.limits.max_task_files, lean_below_loc: config.limits.lean_below_loc ?? 6000 },
  });
  return { errors: [...errors, ...check.errors], warnings: [...warnings, ...check.warnings], plan: parsed.plan, planText, check, spec };
}

/** feature 模式的 P1 补充说明（第 13.3 节） */
export const FEATURE_BRIEF: readonly string[] = [
  '',
  '## feature 模式：只写增量',
  '- 这是在已有项目上加功能。主分支上现有的 docs/contracts/ 是**基线，已锁定，只能追加**（新增路径、字段、错误码、表、模块），修改或删除已有条目会被程序拒绝；docs/arch/overview.md 已有时只追加本次相关的部分。',
  '- 只为本次 feature（docs/spec/features/ 里本流程新增的文件）新增或修改的需求写契约和计划；plan.yaml 里的阶段与 task 只覆盖这些 AC，已有需求不要重复分配。',
  '- 计划用到的**已有**契约符号（接口、表、错误码、函数）列入 plan.yaml 的 baseline，例如 baseline: [api:GET /api/users/me]；baseline 中的符号必须能在现有契约里找到。不要用 baseline 绕过"缺少生产方"：本次要新增的符号由某个 task 的 produces 声明。',
  '- S0 仍然是第一个阶段且只有一个 task：这里是已有项目，不要重建骨架，用它放最薄的一条能跑通本次功能的链路（新表迁移、新接口桩等）。',
  '- 先用 codegraph、serena 读懂相关现有代码，新增的契约要和现有风格、命名一致。',
];

/** architect task 的说明：worker 用的模型决定粒度，lean 阈值，task 编号从哪里起（第 7.5、7.6 节） */
export function architectBrief(config: FlowConfig, existingTaskIds: readonly string[], workerModel: string | null, rework?: string, mode: FlowFile['mode'] = 'build'): string {
  return [
    mode === 'feature' ? '# P1 增量契约与计划（feature 模式）' : '# P1 契约与计划',
    '按角色提示的顺序产出：docs/arch/overview.md、契约（docs/contracts/）、术语表追加、规则与命令草案（docs/rules-draft/）、AGENTS.md、docs/plan/plan.yaml。',
    `worker 使用的模型：${workerModel ?? '尚未设置（按强模型估计粒度）'}；粒度按技能 plan-dag 的说明跟模型走。`,
    `size_estimate.loc 低于 ${config.limits.lean_below_loc ?? 6000} 时选 mode: lean（每个阶段一个 task）。`,
    `plan.yaml 的 task 编号从 ${nextPlanTaskId(existingTaskIds)} 起（流程里已有 ${existingTaskIds.join('、') || '无'}）。`,
    ...(mode === 'feature' ? FEATURE_BRIEF : []),
    '写完后用 forge_propose_plan 提交（附 assumptions 与 extras），按返回的错误或提醒修改，通过后用 forge_note 写 handoff，再 forge_submit。',
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
  const adopt = flow.stage === ADOPT_STAGE;
  const all = store.listTasks(flowId);
  const p1 = all.filter((t) => t.stage === flow.stage);
  if (p1.some((t) => !isSettled(t))) return null;
  if (p1.length && !flow.plan_rework) return null;
  const ids = usedTaskIds(root, store, flowId, config);
  const id = nextPlanTaskId(ids);
  const role = config.role('architect');
  const prev = p1.filter((t) => t.status === 'done').at(-1);
  const input: TaskInput = {
    id, stage: flow.stage, kind: 'doc', role: 'architect', title: `${adopt ? '纳管契约' : '契约与计划'}${p1.length ? '（返工）' : ''}`,
    scopes: [...role.scopes], depends_on: [], inputs: [], writes: adopt ? [...ADOPT_WRITES] : [...role.writes], verify: [],
    ...(prev ? { fork_from_task: prev.id } : {}),
  };
  const [task] = await store.addTasks(flowId, [input], 'engine');
  await store.appendHandoff(flowId, id, adopt
    ? adoptBrief(adoptScope(flow.title), { existingContracts: hasContracts(root, flow.base_sha ?? config.raw.main_branch), rework: flow.plan_rework?.reason })
    : architectBrief(config, [...ids, id], workerModel, flow.plan_rework?.reason, flow.mode), 'engine');
  if (flow.plan_rework) await store.setPlanRework(flowId, null, 'engine');
  return task!;
}

const proposalProblem = (store: StateStore, flowId: string, planText: string | null): string | null => {
  const p = store.readPlanProposal(flowId);
  if (!p) return '还没有用 forge_propose_plan 提交计划';
  if (planText !== null && p.plan_hash !== planHash(planText)) return 'docs/plan/plan.yaml 在 forge_propose_plan 之后又改过，请重新提交计划';
  return null;
};

/** P1 的 doc task 预检（v3.2 第 8.1 节：契约检查与计划校验接进 doc 的预检）；通过返回 null，否则返回失败原因 */
export function docPrecheck(root: string, store: StateStore, config: FlowConfig, flowId: string, task: TaskFile): string | null {
  if (task.kind === 'doc' && task.stage === ADOPT_STAGE) return adoptPrecheck(root, store.readFlow(flowId), task);
  if (task.kind !== 'doc' || task.stage !== P1_STAGE || !task.branch) return null;
  const flow = store.readFlow(flowId);
  const r = checkP1(root, { root, ref: task.branch }, flow, usedTaskIds(root, store, flowId, config), config);
  const problems = [...r.errors, ...commandsDraftProblems(root, task.branch)];
  const proposal = proposalProblem(store, flowId, r.planText);
  if (proposal) problems.push(proposal);
  return problems.length ? `P1 预检未通过：\n${problems.map((p) => `- ${p}`).join('\n')}` : null;
}

/** P1 闸门：集成分支上的契约、计划、草案都要通过，并且提交过计划提案 */
export function p1GateProblems(root: string, store: StateStore, config: FlowConfig, flowId: string): string[] {
  const flow = store.readFlow(flowId);
  const r = checkP1(root, { root, ref: flow.integration_branch }, flow, usedTaskIds(root, store, flowId, config), config);
  const problems = [...r.errors, ...commandsDraftProblems(root, flow.integration_branch)];
  const proposal = proposalProblem(store, flowId, r.planText);
  if (proposal) problems.push(proposal);
  return problems;
}

/** 批准页：计划报告、assumptions、extras、规则与命令草案（给出 root 时列出草案） */
export function planApprovalSummary(store: StateStore, flowId: string, root?: string): string {
  const p = store.readPlanProposal(flowId);
  if (!p) return '还没有计划提案。';
  const drafts = root ? listDrafts(root, store.readFlow(flowId).integration_branch) : [];
  return [
    p.report,
    p.assumptions.length ? `assumptions（architect 默认的处理，请逐条确认）：\n${p.assumptions.map((a, i) => `${i + 1}. ${a.question} → ${a.decision}`).join('\n')}` : 'assumptions：无',
    p.extras.length ? `extras（超出需求的设计，请确认）：\n${p.extras.map((x, i) => `${i + 1}. ${x.what}：${x.why}`).join('\n')}` : 'extras：无',
    ...(root ? [drafts.length ? `批准时应用的规则与命令草案：\n${formatDrafts(drafts)}` : '没有规则与命令草案的变化'] : []),
    '批准后：生成 S 阶段与 task，契约锁定（之后只能追加），应用上面的草案，进入 S0。',
  ].join('\n\n');
}

/** 每个 impl task 的初始笔记：负责的 AC 原文（第 16 节 notes 小改） */
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
 * 批准 P1 时落地计划：再校验一次集成分支，应用规则与命令草案（提交到主分支），
 * 然后在一个事务里写入 S 阶段、task、初始笔记与契约锁定点。已经落地过的流程直接跳过（批准中途崩溃后重试）。
 */
export async function materializePlan(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string[]> {
  const flow = store.readFlow(flowId);
  if (flow.s_stages?.length) return [];
  const r = checkP1(root, { root, ref: flow.integration_branch }, flow, usedTaskIds(root, store, flowId, config), config);
  const problems = [...r.errors, ...commandsDraftProblems(root, flow.integration_branch)];
  const proposal = proposalProblem(store, flowId, r.planText);
  if (proposal) problems.push(proposal);
  if (problems.length || !r.plan || !r.check || !r.spec) throw new Error(`计划未通过校验，不能批准：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  const tasks = deriveTasks(r.plan, r.check.deps, { worker: config.role('worker').scopes, testAuthor: config.role('test-author').scopes }, { acctest: config.testAuthorFor({ plan_mode: r.plan.mode }), selfTest: !config.testAuthorFor({ plan_mode: r.plan.mode }), verify: ['typecheck', 'lint', 'test'].filter((c) => config.commands[c]?.trim()) });
  const drafts = listDrafts(root, flow.integration_branch);
  const applied = applyDrafts(root, drafts, flowId);
  if (applied.commands) Object.assign(config.raw.commands, applied.commands);
  if (applied.acctestWorkspace) config.raw.acctest_workspace = applied.acctestWorkspace;
  const contractsBase = git(root, ['rev-parse', `refs/heads/${flow.integration_branch}`]).trim();
  await store.materializePlan(flowId, { stages: r.plan.stages, mode: r.plan.mode, tasks, notes: initialNotes(tasks, r.spec), contractsBase });
  return [
    `已生成 ${r.plan.stages.length} 个 S 阶段（${r.plan.stages.map((s) => s.id).join('、')}，${r.plan.mode === 'lean' ? '精简模式' : '标准模式'}）与 ${tasks.length} 个 task。`,
    `契约已锁定（${contractsBase.slice(0, 8)}），之后只能追加。`,
    ...(applied.applied.length ? [`已应用规则与命令草案：${applied.applied.join('、')}（子进程提示的稳定前缀变化，提示缓存会失效一次）。`] : []),
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
  return { ok: true, text: `计划已通过校验并保存。\n\n${report}\n\n${r.warnings.length ? '有提醒时优先按提醒调整后重新提交；' : ''}确认无误后用 forge_note 写 handoff，再 forge_submit。plan.yaml 之后再改动需要重新 forge_propose_plan。` };
}
type PlanProposalInput = { assumptions: { question: string; decision: string }[]; extras: { what: string; why: string }[] };

/** 状态视图与 forge_status 的 P1 摘要 */
export function planStatus(store: StateStore, flowId: string): string {
  const flow = store.readFlow(flowId);
  if (flow.stage === ADOPT_STAGE) {
    const state = flow.stage_status === 'awaiting_human' ? '契约已通过检查，等你批准（批准后合入主分支成为基线）' : flow.stage_status === 'done' ? '已完成，契约已合入主分支' : flow.plan_rework ? `architect 返工中：${flow.plan_rework.reason.split('\n')[0]}` : 'architect 正在从现有代码整理契约';
    return `纳管：${adoptScope(flow.title)}；${state}`;
  }
  if (flow.stage !== P1_STAGE && !flow.s_stages?.length) return '';
  if (flow.s_stages?.length) return `计划：${flow.s_stages.length} 个 S 阶段（${flow.plan_mode === 'lean' ? '精简模式' : '标准模式'}），契约锁定于 ${flow.contracts_base?.slice(0, 8) ?? '-'}`;
  const p = store.readPlanProposal(flowId);
  return [`计划：${p ? '已提交提案' : 'architect 起草中'}`, ...(p ? [p.report.split('\n')[0]!] : []), ...(flow.plan_rework ? [`返工：${flow.plan_rework.reason}`] : [])].join('\n');
}
