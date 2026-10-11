// 变更请求的流程（规格第 12.3、13.2、13.5 节）：创建（forge_change_request 与规格修订）、architect 起草与提交、
// doc 预检、批准时落地、打回返工。推导与落地内容是纯函数（change-request.ts），写状态只经 StateStore。
import { createHash } from 'node:crypto';
import type { FlowConfig } from '../state/config.ts';
import type { ChangeFile, FlowFile, PlanFile, TaskFile } from '../state/schemas.ts';
import type { StateStore, TaskInput } from '../state/state-store.ts';
import { git, gitOk } from '../state/git.ts';
import { contractFilesAt, contractFilesInDir, parseContracts } from './contract-check.ts';
import { checkPlan, nextPlanTaskId, parsePlan, PLAN_PATH, type PlanCheck } from './plan.ts';
import { effectiveSpec, glossaryTerms } from '../spec/spec.ts';
import { initialNotes, readRel, readSpecFrom, type Source } from './plan-flow.ts';
import { changeSummary, changeTouched, diffPlanRevision, isOpenChange, materializeChange, summarizeActions, type ChangeAction, type CurrentPlan } from './change-request.ts';

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export class ChangeError extends Error {}

/** 变更请求的 architect 只能写这些路径（契约可以修改，不只追加） */
export const CHANGE_WRITES = ['docs/contracts/**', 'docs/arch/**', 'docs/plan/**', 'docs/spec/glossary.md'] as const;

/** 当前生效的计划：最近一次批准的变更请求保存的 plan.yaml；还没有变更时是 P1 批准时（契约锁定点）的 plan.yaml */
export function currentPlan(root: string, store: StateStore, flowId: string): { plan: CurrentPlan; text: string } | string {
  const flow = store.readFlow(flowId);
  const approved = store.listChanges(flowId).filter((c) => c.status === 'approved' && c.plan_text).at(-1);
  let text: string | null = approved?.plan_text ?? null;
  if (text === null && flow.contracts_base && gitOk(root, ['cat-file', '-e', `${flow.contracts_base}:${PLAN_PATH}`])) text = git(root, ['show', `${flow.contracts_base}:${PLAN_PATH}`]);
  if (text === null) return '找不到当前生效的计划（P1 批准时的 docs/plan/plan.yaml）';
  const parsed = parsePlan(text);
  if (!parsed.plan) return `当前计划无法解析：${parsed.errors.join('；')}`;
  return { plan: parsed.plan, text };
}

export interface ChangeCheck {
  errors: string[];
  warnings: string[];
  plan: PlanFile | null;
  planText: string | null;
  check: PlanCheck | null;
  actions: ChangeAction[];
  spec: ReturnType<typeof effectiveSpec> | null;
}

/**
 * 检查修订：契约结构、术语表只追加（给了 glossaryBase 时）、修订后计划的符号与 DAG（允许 modifies）、
 * 与当前计划的差异是否合规。契约可以修改，不做"只能追加"检查（那是 impl/fix 的约束）。
 */
export function checkChange(root: string, src: Source, flowId: string, store: StateStore, config: FlowConfig, change: Pick<ChangeFile, 'changed_acs'>, glossaryBase?: string): ChangeCheck {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const none = (errors: string[], over: Partial<ChangeCheck> = {}): ChangeCheck => ({ errors, warnings: [], plan: null, planText: null, check: null, actions: [], spec: null, ...over });
  const cur = currentPlan(root, store, flowId);
  if (typeof cur === 'string') return none([cur]);
  const specFiles = readSpecFrom(src);
  if (typeof specFiles === 'string') return none([specFiles]);
  const spec = effectiveSpec(specFiles.files, specFiles.features);
  const errors: string[] = [];
  const warnings: string[] = [];
  const contracts = parseContracts('dir' in src ? contractFilesInDir(src.dir) : contractFilesAt(src.root, src.ref));
  errors.push(...contracts.errors.map((e) => `契约 ${e.file}：${e.message}`));
  warnings.push(...contracts.warnings.map((e) => `契约 ${e.file}：${e.message}`));
  if (glossaryBase && gitOk(root, ['cat-file', '-e', `${glossaryBase}:docs/spec/glossary.md`])) {
    const after = new Map(glossaryTerms(specFiles.files.glossary).map((t) => [t.name, t]));
    for (const t of glossaryTerms(git(root, ['show', `${glossaryBase}:docs/spec/glossary.md`]))) {
      const now = after.get(t.name);
      if (!now) errors.push(`术语表：已有条目「${t.name}」被删除或改名；只能追加新条目`);
      else if (now.english !== t.english || now.definition !== t.definition || now.aliases.join('、') !== t.aliases.join('、')) errors.push(`术语表：已有条目「${t.name}」被修改；只能追加新条目`);
    }
  }
  const planText = readRel(src, PLAN_PATH);
  if (planText === null) return none([...errors, `缺少 ${PLAN_PATH}`], { warnings, spec });
  const parsed = parsePlan(planText);
  if (!parsed.plan) return none([...errors, ...parsed.errors], { warnings, planText, spec });
  // 流程里已有的 task 编号里，当前计划自己的 task 可以原样出现在修订里，其余（派生、修复、architect 的 doc task）不能复用
  const planIds = new Set(cur.plan.tasks.map((t) => t.id));
  const check = checkPlan(parsed.plan, {
    catalog: contracts.catalog, spec, existingTaskIds: tasks.map((t) => t.id).filter((id) => !planIds.has(id)), allowModifies: true,
    mode: flow.mode === 'feature' ? 'feature' : 'build',
    limits: { max_parallel: config.limits.max_parallel, max_task_files: config.limits.max_task_files, lean_below_loc: config.limits.lean_below_loc ?? 6000 },
  });
  errors.push(...check.errors);
  warnings.push(...check.warnings);
  if (check.errors.length) return { errors, warnings, plan: parsed.plan, planText, check, actions: [], spec };
  const diff = diffPlanRevision(cur.plan, parsed.plan, tasks, flow, { deps: check.deps, changedAcs: change.changed_acs });
  errors.push(...diff.errors);
  return { errors, warnings, plan: parsed.plan, planText, check, actions: diff.actions, spec };
}

const STATUS_ORDER = ['in_progress', 'blocked', 'ready', 'pending', 'done'];
function taskTable(tasks: readonly TaskFile[], plan: CurrentPlan): string {
  const ids = new Set(plan.tasks.map((t) => t.id));
  return tasks.filter((t) => ids.has(t.id)).sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.id.localeCompare(b.id))
    .map((t) => `- ${t.id}（${t.stage}，${t.status}）${t.title}`).join('\n');
}

/** architect 的任务说明：变更内容、可以做什么、当前计划与 task 状态、下一个可用的 task 编号 */
export function changeBrief(change: Pick<ChangeFile, 'id' | 'what' | 'why' | 'impact' | 'source' | 'changed_acs' | 'feedback'>, flow: FlowFile, tasks: readonly TaskFile[], cur: { plan: CurrentPlan; text: string } | string, nextId: string): string {
  return [
    `# 变更请求 ${change.id}`,
    `来源：${change.source}`, `变更内容：${change.what}`, `原因：${change.why}`, `提出者写的影响：${change.impact}`,
    ...(change.changed_acs.length ? [`规格修订变化的验收标准：${change.changed_acs.join('、')}（规格已更新，见 docs/spec/）`] : []),
    ...(change.feedback ? ['', '## 需要返工', `用户打回的意见：${change.feedback}`, '在上一次的修订基础上，只改意见提到的地方。'] : []),
    '',
    '## 做法（技能 change-request）',
    `当前阶段 ${flow.stage}。先写影响分析（受影响的契约条目、task、验收测试），再提交完整的修订后计划：`,
    '1. 契约可以修改（不只追加）；能追加解决的就追加，改得越少越好。',
    `2. docs/plan/plan.yaml 写**修订后的完整计划**（不是增量）。新增 task 的编号从 ${nextId} 起；已有 task 保持原编号。`,
    `3. 新增 task 和阶段只能放在当前阶段（${flow.stage}）或之后；当前阶段与已完成阶段的目标不能改（当前阶段的 exit 只能追加）；之后的阶段可以新增、调整、删除。`,
    '4. 还没开始（pending、ready）的 task 可以调整字段，或从计划里删除（即取消）。',
    '5. 已开始或已完成的 task **不能改、也不能删**。要改它的行为：新增一个 task，写 `modifies: <原 task 编号>`，程序让它硬依赖原 task；它的 ac 可以重复列出原 task 的 AC。',
    '6. 验收测试：AC 变化的 task，程序会自动处理它的 .at / .at-n；你在 impact 里写明哪些测试要改、为什么。',
    '7. 写完用 forge_propose_plan 提交（可附 assumptions 与 extras）。程序校验修订后的完整任务图和差异，返回错误或动作清单；通过后用 forge_note 写 handoff，再 forge_submit。plan.yaml 提交后再改要重新提交。',
    '',
    '## 当前计划里 task 的状态',
    typeof cur === 'string' ? cur : taskTable(tasks, cur.plan) || '（无）',
    '',
    '## 当前生效的 plan.yaml',
    typeof cur === 'string' ? '（无）' : `你的工作区里的 docs/plan/plan.yaml 可能不是它（例如上一份修订被打回）；以这份为准，在它的基础上修改：\n\n\`\`\`yaml\n${cur.text.trim()}\n\`\`\``,
  ].join('\n');
}

const architectInput = (config: FlowConfig, stage: string, id: string, title: string, fork?: string): TaskInput => {
  const role = config.role('architect');
  return {
    id, stage, kind: 'doc', role: 'architect', title, scopes: [...role.scopes], depends_on: [], inputs: [],
    writes: [...CHANGE_WRITES], verify: [],
    ...(fork ? { fork_from_task: fork } : {}),
  };
};

/**
 * forge_change_request：创建变更请求并在当前阶段新增 architect 的 doc task（接收者是 architect，说明里带着请求与当前计划）。
 * 同一时间只允许一个未结束的变更请求，第二个直接拒绝（提示等待批准或打回）。发起者自己的 task 不受影响。
 */
export async function requestChange(root: string, store: StateStore, config: FlowConfig, flowId: string,
  input: { what: string; why: string; impact: string }, source: ChangeFile['source'], changedAcs: readonly string[] = []): Promise<{ change: ChangeFile; task: TaskFile }> {
  const flow = store.readFlow(flowId);
  if (flow.mode === 'fix') throw new ChangeError('修复流程不使用变更请求。');
  if (!flow.s_stages?.length) throw new ChangeError('计划还没有批准（P1），不需要变更请求：契约和计划还在起草中，直接让 architect 修改。');
  if (!flow.s_stages.some((s) => s.id === flow.stage)) throw new ChangeError(`当前阶段 ${flow.stage} 不是实施阶段，变更请求只能在 S 阶段里提出。`);
  if (flow.stage_status !== 'active') throw new ChangeError(`阶段 ${flow.stage} 当前是 ${flow.stage_status}，不是进行中；等阶段闸门处理完（或被打回）后再提出变更请求。`);
  for (const [k, v] of Object.entries(input)) if (!v.trim()) throw new ChangeError(`变更请求的 ${k} 不能为空。`);
  const open = store.listChanges(flowId).find(isOpenChange);
  if (open) throw new ChangeError(`已有变更请求 ${open.id} 在处理（${open.status}），同一时间只能有一个。等用户批准或打回它之后再提出；已提出的内容见 forge_status。`);
  const tasks = store.listTasks(flowId);
  const id = nextPlanTaskId(tasks.map((t) => t.id));
  const cur = currentPlan(root, store, flowId);
  const next = nextPlanTaskId([...tasks.map((t) => t.id), id]);
  const brief = (changeId: string) => changeBrief({ id: changeId, ...input, source, changed_acs: [...changedAcs] }, flow, tasks, cur, next);
  return store.createChange(flowId, { ...input, source, changed_acs: [...changedAcs] }, architectInput(config, flow.stage, id, `变更请求：${input.what}`.slice(0, 120)), brief, source === 'main' || source.startsWith('amend:') ? 'orchestrator' : source);
}

/** 被打回的变更请求：新建 architect task 接着上一个会话返工；阶段不是 active 时等到 active。返回新建的 task */
export async function ensureChangeTask(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<TaskFile | null> {
  const flow = store.readFlow(flowId);
  if (flow.mode === 'fix' || flow.stage_status !== 'active') return null;
  const c = store.listChanges(flowId).find((x) => x.status === 'rejected');
  if (!c) return null;
  const tasks = store.listTasks(flowId);
  const id = nextPlanTaskId(tasks.map((t) => t.id));
  const brief = changeBrief(c, flow, tasks, currentPlan(root, store, flowId), nextPlanTaskId([...tasks.map((t) => t.id), id]));
  const prev = tasks.find((t) => t.id === c.task && t.status === 'done') ? c.task : undefined;
  return (await store.reopenChange(flowId, c.id, architectInput(config, flow.stage, id, `变更请求（返工）：${c.what}`.slice(0, 120), prev), brief, 'engine')).task;
}

/** 这个 task 是不是某个未结束变更请求的 architect task */
export const changeOfTask = (store: StateStore, flowId: string, taskId: string): ChangeFile | undefined =>
  store.listChanges(flowId).find((c) => c.task === taskId);

/** forge_propose_plan 在变更请求的 architect task 里：在 worktree 上检查，通过后保存修订并把变更请求标为 proposed */
export async function proposeChange(root: string, store: StateStore, config: FlowConfig, flowId: string, task: TaskFile,
  input: { assumptions: NonNullable<ChangeFile['assumptions']>; extras: NonNullable<ChangeFile['extras']> }, actor: string): Promise<{ ok: boolean; text: string }> {
  const change = changeOfTask(store, flowId, task.id);
  if (!change || (change.status !== 'drafting' && change.status !== 'proposed') || !task.worktree) return { ok: false, text: '这个 task 不是进行中的变更请求起草任务，不能提交修订。' };
  const r = checkChange(root, { dir: task.worktree }, flowId, store, config, change, task.base_sha ?? undefined);
  if (r.errors.length || !r.plan || r.planText === null) {
    return { ok: false, text: `修订未通过校验（共 ${r.errors.length} 处），改了再提交：\n${r.errors.map((e) => `- ${e}`).join('\n')}${r.warnings.length ? `\n\n提醒：\n${r.warnings.map((w) => `- ${w}`).join('\n')}` : ''}` };
  }
  const actions = summarizeActions(r.actions);
  const saved = await store.saveChangeProposal(flowId, change.id, { task: task.id, plan_hash: hashText(r.planText), plan_text: r.planText, assumptions: input.assumptions, extras: input.extras,
    summary: changeSummary({ ...change, actions }), actions, touched: changeTouched(r.actions), warnings: r.warnings }, actor);
  return { ok: true, text: `修订已通过校验并保存，等待用户批准 change:${change.id}。\n\n${changeSummary(saved)}\n\n确认无误后用 forge_note 写 handoff，再 forge_submit。plan.yaml 之后再改动需要重新 forge_propose_plan。` };
}

/** 变更请求 architect task 的 doc 预检：修订与计划提案一致、契约与计划仍然通过检查；通过返回 null */
export function changeDocPrecheck(root: string, store: StateStore, config: FlowConfig, flowId: string, task: TaskFile): string | null {
  const change = changeOfTask(store, flowId, task.id);
  if (!change || !task.branch) return null;
  const problems: string[] = [];
  if (change.status !== 'proposed' || change.task !== task.id || !change.plan_hash) problems.push('还没有用 forge_propose_plan 提交修订');
  else {
    const r = checkChange(root, { root, ref: task.branch }, flowId, store, config, change, task.base_sha ?? undefined);
    problems.push(...r.errors);
    if (r.planText !== null && hashText(r.planText) !== change.plan_hash) problems.push('docs/plan/plan.yaml 在 forge_propose_plan 之后又改过，请重新提交修订');
  }
  return problems.length ? `变更请求预检未通过：\n${problems.map((p) => `- ${p}`).join('\n')}` : null;
}

/** 等待用户批准的变更请求：起草的 architect task 已经合并（done） */
export function pendingChanges(store: StateStore, flowId: string): ChangeFile[] {
  return store.listChanges(flowId).filter((c) => c.status === 'proposed' && store.readTask(flowId, c.task).status === 'done');
}

/** 批准页文本（给 /forge-approve 的对象清单与状态） */
export function changeApprovalText(c: ChangeFile): string {
  return c.summary ?? changeSummary(c);
}

/**
 * /forge-approve change:<id>：核对 → 在一个事务里落地（新增 task 与 .at、调整或取消未开始的 task、跟进 task 与 .at-n、
 * 阶段修订 stages_revised、变更请求 approved、approval 事件）。
 */
export async function approveChange(root: string, store: StateStore, config: FlowConfig, flowId: string, id: string): Promise<string> {
  const c = store.readChange(flowId, id);
  if (c.status !== 'proposed' || !c.plan_text || !c.plan_hash || !c.actions) throw new ChangeError(`变更请求 ${id} 没有等待批准（${c.status}）。`);
  const taskState = store.readTask(flowId, c.task);
  if (taskState.status !== 'done') throw new ChangeError(`architect 的任务 ${c.task} 还没有合并（${taskState.status}），等它完成后再批准。`);
  const flow = store.readFlow(flowId);
  if (flow.stage_status !== 'active') throw new ChangeError(`阶段 ${flow.stage} 当前是 ${flow.stage_status}，不是进行中，不能落地变更。`);
  const onBranch = readRel({ root, ref: flow.integration_branch }, PLAN_PATH);
  if (onBranch === null || hashText(onBranch) !== c.plan_hash) throw new ChangeError('集成分支上的 docs/plan/plan.yaml 与提交的修订不一致，请打回让 architect 重新提交。');
  const r = checkChange(root, { root, ref: flow.integration_branch }, flowId, store, config, c);
  if (r.errors.length || !r.plan || !r.spec) throw new ChangeError(`修订未通过批准前的检查：\n${r.errors.map((e) => `- ${e}`).join('\n')}`);
  if (JSON.stringify(summarizeActions(r.actions)) !== JSON.stringify(c.actions)) throw new ChangeError('task 的状态在提交修订之后发生了变化，原来的动作清单已不适用，请打回让 architect 重新提交。');
  const tasks = store.listTasks(flowId);
  const verify = ['typecheck', 'lint', 'test'].filter((x) => config.commands[x]?.trim());
  const ops = materializeChange(r.actions, r.plan, tasks, { flowStage: flow.stage, scopes: { worker: config.role('worker').scopes, testAuthor: config.role('test-author').scopes }, verify, changeId: id, selfTest: !config.testAuthorFor(flow) });
  ops.notes = initialNotes(ops.add.filter((t) => t.kind === 'impl'), r.spec);
  await store.applyChange(flowId, id, ops, 'human');
  const lines = [
    `已批准 change:${id}。`,
    ops.add.length ? `新增 task：${ops.add.map((t) => t.id).join('、')}。` : '',
    ops.patches.length ? `调整：${ops.patches.map((p) => p.id).join('、')}。` : '',
    ops.cancels.length ? `取消：${ops.cancels.map((p) => p.id).join('、')}。` : '',
    ops.stages ? `阶段已修订（${ops.stages.stages.map((s) => s.id).join('、')}）。` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/** /forge-reject change:<id> "<意见>"：记下意见，立即新建 architect task 返工（阶段不是 active 时等到 active） */
export async function rejectChange(root: string, store: StateStore, config: FlowConfig, flowId: string, id: string, feedback: string): Promise<string> {
  if (!feedback.trim()) throw new ChangeError('打回必须写明意见：/forge-reject change:<id> "<意见>"');
  await store.rejectChange(flowId, id, feedback.trim());
  const t = await ensureChangeTask(root, store, config, flowId);
  return t ? `已打回 change:${id}，程序已派 architect（${t.id}）按意见返工。` : `已打回 change:${id}，意见已记录；阶段回到进行中后程序会派 architect 返工。`;
}

/** 状态里的变更请求摘要（forge_status、/forge-status） */
export function changeStatus(store: StateStore, flowId: string): string {
  const open = store.listChanges(flowId).filter((c) => isOpenChange(c));
  return open.map((c) => {
    const waiting = c.status === 'proposed' && store.readTask(flowId, c.task).status === 'done';
    return `变更请求 ${c.id}（${c.source}）${waiting ? '等待批准' : c.status === 'proposed' ? '修订已提交，architect 任务合并中' : c.status === 'rejected' ? '被打回，等待返工' : `architect（${c.task}）起草中`}：${c.what}${waiting ? `\n→ /forge-approve change:${c.id} 或 /forge-reject change:${c.id} "<意见>"` : ''}`;
  }).join('\n');
}
