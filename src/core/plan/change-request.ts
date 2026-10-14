// 变更请求的修订推导（规格第 5、12.3 节）：把 architect 修订后的 plan.yaml 与当前计划、流程里的 task 对比，
// 得出要落地的动作，并校验修订是否合规。全部是纯函数，不做 IO；落地由 StateStore.applyChange 在一个事务里完成。
//
// 规则（程序判断，不靠提示词）：
// - 新增 task：只能在当前阶段或之后的阶段；
// - 调整 task：只能调整还没开始（pending、ready）的 task，阶段只能改到当前阶段或之后；
// - 取消 task：只能取消还没开始的 task（从计划里删除即取消）；
// - 已开始或已完成的 task 不能直接修改、删除：新增一个带 modifies 的修改 task，程序让它硬依赖原 task（followup）；
// - 阶段：已完成的阶段与当前阶段的目标不能改（当前阶段的 exit 只能追加），之后的阶段可以新增、调整、删除。
import type { ChangeActionSummary, ChangeFile, Dependency, FlowFile, PlanFile, TaskFile } from '../state/schemas.ts';
import { deriveTasks, S0_EXTRA_WRITES } from './plan.ts';
import { ownAcceptanceGlob } from '../state/paths.ts';
import type { ChangeOps } from '../state/state-store.ts';

export type PlanTask = PlanFile['tasks'][number];
export type PlanStageDef = PlanFile['stages'][number];
/** 当前计划：只需要阶段、task 与模式 */
export type CurrentPlan = Pick<PlanFile, 'stages' | 'tasks'>;
type FlowView = Pick<FlowFile, 'stage'> & Partial<Pick<FlowFile, 's_stages'>>;

export type ChangeAction =
  | { kind: 'add'; task: PlanTask; deps: Dependency[] }
  | { kind: 'adjust'; id: string; fields: string[]; patch: Record<string, unknown> }
  | { kind: 'cancel'; id: string; title: string; also: string[] }
  | { kind: 'followup'; of: string; task: PlanTask; deps: Dependency[]; originalStatus: TaskFile['status'] }
  | { kind: 'stages'; stages: PlanStageDef[]; added: string[]; adjusted: string[]; removed: string[] };

export interface RevisionDiff { errors: string[]; actions: ChangeAction[] }

export interface DiffOptions {
  /** 修订后计划的依赖边（checkPlan 的 deps）；不给时不比较、不调整依赖 */
  deps?: ReadonlyMap<string, Dependency[]>;
}

const NOT_STARTED = ['pending', 'ready'];
export const isNotStarted = (t: Pick<TaskFile, 'status'>) => NOT_STARTED.includes(t.status);
const TASK_FIELDS = ['stage', 'module', 'title', 'size', 'layers', 'ac', 'writes', 'shared', 'produces', 'requires', 'test_interface', 'manual_checks', 'review', 'risk'] as const;
const OPTIONAL_LISTS = new Set(['shared', 'manual_checks']);

const norm = (field: string, v: unknown): string => JSON.stringify(Array.isArray(v) && !v.length && OPTIONAL_LISTS.has(field) ? undefined : v ?? null);
const changedFields = (a: PlanTask, b: PlanTask): string[] =>
  TASK_FIELDS.filter((f) => norm(f, (a as Record<string, unknown>)[f]) !== norm(f, (b as Record<string, unknown>)[f]));
const depKey = (d: readonly Dependency[]) => JSON.stringify(d.map((x) => `${x.task}:${x.type}`).sort());
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const stageDefEq = (a: PlanStageDef, b: PlanStageDef) => a.goal === b.goal && sameSet(a.exit, b.exit);

/** 计划里的 task 字段 → TaskFile 的字段（用于调整未开始的 task）；writes 保留它自己的验收目录 */
function taskPatch(t: PlanTask, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (t as Record<string, unknown>)[f];
    if (f === 'writes') out['writes'] = [...new Set([...t.writes, ...(t.stage === 'S0' ? S0_EXTRA_WRITES : []), ownAcceptanceGlob(t.id)])];
    else if (OPTIONAL_LISTS.has(f) && Array.isArray(v) && !v.length) out[f] = undefined;
    else out[f] = structuredClone(v);
  }
  return out;
}

/**
 * 修订后的计划相对当前计划的动作与错误。oldPlan 是当前生效的计划（上一次批准的版本），tasks 是流程里的全部 task。
 * 返回的 errors 非空时 actions 只作参考，不能落地。
 */
export function diffPlanRevision(oldPlan: CurrentPlan, newPlan: PlanFile, tasks: readonly TaskFile[], flow: FlowView, opts: DiffOptions = {}): RevisionDiff {
  const errors: string[] = [];
  const actions: ChangeAction[] = [];
  const liveStages = flow.s_stages ?? oldPlan.stages;
  const cur = liveStages.findIndex((s) => s.id === flow.stage);
  if (cur < 0) return { errors: [`当前阶段 ${flow.stage} 不是实施阶段，变更请求只能在 S 阶段里使用`], actions };
  const newIdx = new Map(newPlan.stages.map((s, i) => [s.id, i]));
  const oldIdx = new Map(oldPlan.stages.map((s, i) => [s.id, i]));
  const live = new Map(tasks.map((t) => [t.id, t]));
  const oldTasks = new Map(oldPlan.tasks.map((t) => [t.id, t]));
  const newTasks = new Map(newPlan.tasks.map((t) => [t.id, t]));
  const deps = opts.deps;
  const depsOf = (id: string) => deps?.get(id) ?? [];

  // —— 阶段 ——
  const added: string[] = [];
  const adjusted: string[] = [];
  const removed: string[] = [];
  oldPlan.stages.forEach((old, i) => {
    const now = newPlan.stages.find((s) => s.id === old.id);
    if (i < cur) {
      if (!now) errors.push(`不能删除已完成的阶段 ${old.id}`);
      else if (!stageDefEq(old, now)) errors.push(`不能修改已完成的阶段 ${old.id}`);
      else if (newIdx.get(old.id) !== i) errors.push(`不能调整已完成的阶段 ${old.id} 的顺序`);
    } else if (i === cur) {
      if (!now) errors.push(`不能删除当前阶段 ${old.id}`);
      else {
        if (now.goal !== old.goal) errors.push(`不能修改当前阶段 ${old.id} 的目标`);
        const dropped = old.exit.filter((e) => !now.exit.includes(e));
        if (dropped.length) errors.push(`当前阶段 ${old.id} 的 exit 只能追加，不能去掉：${dropped.join('、')}`);
        if (newIdx.get(old.id) !== i) errors.push(`不能调整当前阶段 ${old.id} 的顺序`);
        if (!now.exit.every((e) => old.exit.includes(e))) adjusted.push(old.id);
      }
    } else if (!now) removed.push(old.id);
    else if (!stageDefEq(old, now)) adjusted.push(old.id);
  });
  for (const s of newPlan.stages) if (!oldIdx.has(s.id)) {
    added.push(s.id);
    if ((newIdx.get(s.id) ?? 0) <= cur) errors.push(`新增的阶段 ${s.id} 在当前阶段 ${flow.stage} 之前，只能加在当前阶段之后`);
  }
  if (added.length || adjusted.length || removed.length) actions.push({ kind: 'stages', stages: structuredClone(newPlan.stages), added, adjusted, removed });

  const stageOk = (stage: string) => (newIdx.get(stage) ?? -1) >= cur;

  // —— 修订后计划里的 task ——
  for (const t of newPlan.tasks) {
    const old = oldTasks.get(t.id);
    const l = live.get(t.id);
    if (old) {
      if (t.modifies) errors.push(`${t.id} 是计划里已有的 task，不能加 modifies；修改 task 要用新的编号`);
      if (!l) { errors.push(`${t.id} 在计划里，但流程里没有这个 task`); continue; }
      if (l.status === 'cancelled') { errors.push(`${t.id} 已被取消，不能继续出现在计划里（要重新做请新增 task）`); continue; }
      const fields = changedFields(old, t);
      const newDeps = depsOf(t.id);
      const depsChanged = !!deps && isNotStarted(l) && depKey(newDeps) !== depKey(l.depends_on);
      if (!fields.length && !depsChanged) continue;
      if (!isNotStarted(l)) {
        if (fields.length) errors.push(`${t.id} 已${l.status === 'done' ? '完成' : `开始（${l.status}）`}，不能直接修改（改了：${fields.join('、')}）；请新增一个 task 并写 modifies: ${t.id}，程序让它排在 ${t.id} 之后`);
        continue;
      }
      if (!stageOk(t.stage)) { errors.push(`${t.id} 的阶段 ${t.stage} 在当前阶段 ${flow.stage} 之前或不存在，只能调整到当前阶段或之后`); continue; }
      if ((oldIdx.get(old.stage) ?? -1) < cur) { errors.push(`${t.id} 属于已完成的阶段 ${old.stage}，不能调整`); continue; }
      const patch = taskPatch(t, fields);
      if (depsChanged) patch['depends_on'] = newDeps.map((d) => ({ ...d }));
      actions.push({ kind: 'adjust', id: t.id, fields: [...fields, ...(depsChanged ? ['depends_on'] : [])], patch });
      continue;
    }
    // 计划里新增的 task
    if (l) { errors.push(`${t.id} 的编号已被流程里的 task 使用，请换新的编号`); continue; }
    if (!stageOk(t.stage)) { errors.push(`${t.id} 的阶段 ${t.stage} 在当前阶段 ${flow.stage} 之前或不存在，只能新增到当前阶段或之后`); continue; }
    if (t.modifies) {
      const target = live.get(t.modifies);
      const targetOld = oldTasks.get(t.modifies);
      if (!target || !targetOld) { errors.push(`${t.id} 的 modifies ${t.modifies} 不是已有的 task`); continue; }
      if (!newTasks.has(t.modifies)) { errors.push(`${t.id} 修改的 ${t.modifies} 不能同时从计划里删除`); continue; }
      if (target.status === 'cancelled') { errors.push(`${t.id} 修改的 ${t.modifies} 已被取消`); continue; }
      if (isNotStarted(target)) { errors.push(`${t.modifies} 还没开始，直接调整它即可，不需要 modifies 的修改 task`); continue; }
      if ((newIdx.get(t.stage) ?? 0) < (newIdx.get(newTasks.get(t.modifies)!.stage) ?? 0)) { errors.push(`${t.id} 的阶段不能早于它修改的 ${t.modifies}`); continue; }
      actions.push({ kind: 'followup', of: t.modifies, task: structuredClone(t), deps: depsOf(t.id).map((d) => ({ ...d })), originalStatus: target.status });
      continue;
    }
    actions.push({ kind: 'add', task: structuredClone(t), deps: depsOf(t.id).map((d) => ({ ...d })) });
  }

  // —— 从计划里删除的 task ——
  for (const old of oldPlan.tasks) {
    if (newTasks.has(old.id)) continue;
    const l = live.get(old.id);
    if (!l) continue;
    if (l.status === 'cancelled') continue;
    if (!isNotStarted(l)) { errors.push(`${old.id} 已${l.status === 'done' ? '完成' : `开始（${l.status}）`}，不能取消或从计划里删除；让它做完，再新增带 modifies 的修改 task`); continue; }
    if ((oldIdx.get(old.stage) ?? -1) < cur) { errors.push(`${old.id} 属于已完成的阶段 ${old.stage}，不能取消`); continue; }
    actions.push({ kind: 'cancel', id: old.id, title: l.title, also: [] });
  }
  return { errors, actions };
}

/** 动作摘要（存进变更请求，批准时重新推导并核对）：不含状态等会变化的内容 */
export function summarizeActions(actions: readonly ChangeAction[]): ChangeActionSummary[] {
  return actions.map((a): ChangeActionSummary => {
    switch (a.kind) {
      case 'add': return { kind: 'add', task: a.task.id, stage: a.task.stage, detail: a.task.title };
      case 'adjust': return { kind: 'adjust', task: a.id, fields: [...a.fields] };
      case 'cancel': return { kind: 'cancel', task: a.id, detail: a.title };
      case 'followup': return { kind: 'followup', task: a.task.id, of: a.of, stage: a.task.stage, detail: a.task.title };
      case 'stages': return { kind: 'stages', fields: [...a.added.map((s) => `新增 ${s}`), ...a.adjusted.map((s) => `调整 ${s}`), ...a.removed.map((s) => `删除 ${s}`)] };
    }
  });
}

/** 等待批准期间不派发的 task：要调整或取消的未开始 task */
export function changeTouched(actions: readonly ChangeAction[]): string[] {
  const out = new Set<string>();
  for (const a of actions) {
    if (a.kind === 'adjust') out.add(a.id);
    else if (a.kind === 'cancel') { out.add(a.id); for (const x of a.also) out.add(x); }
  }
  return [...out].sort();
}

/** 变更请求等待批准期间，这个 task 是否不能派发（纯函数） */
export const pausedByChange = (changes: readonly Pick<ChangeFile, 'status' | 'touched'>[], taskId: string): boolean =>
  changes.some((c) => c.status === 'proposed' && c.touched.includes(taskId));

/** 变更请求是否还没结束（起草中、等待批准、被打回等待返工） */
export const isOpenChange = (c: Pick<ChangeFile, 'status'>) => c.status === 'drafting' || c.status === 'proposed' || c.status === 'rejected';

/** 批准页：动作清单（中文） */
export function summarizeText(actions: readonly ChangeActionSummary[]): string {
  const lines = actions.map((a) => {
    switch (a.kind) {
      case 'add': return `新增 task ${a.task}（${a.stage}）：${a.detail ?? ''}`;
      case 'adjust': return `调整未开始的 ${a.task}：${(a.fields ?? []).join('、')}`;
      case 'cancel': return `取消未开始的 ${a.task}：${a.detail ?? ''}`;
      case 'followup': return `为 ${a.of} 新增修改 task ${a.task}（${a.stage}，硬依赖 ${a.of}）：${a.detail ?? ''}`;
      case 'stages': return `阶段：${(a.fields ?? []).join('、')}`;
    }
  });
  return lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- 没有任何 task 或阶段的变化（只改了契约或文档）';
}

/** 批准页的完整文本：来源、内容、影响、动作清单、architect 的假设与额外设计 */
export function changeSummary(c: Pick<ChangeFile, 'id' | 'status' | 'what' | 'why' | 'impact' | 'source' | 'actions' | 'assumptions' | 'extras' | 'warnings' | 'feedback' | 'rounds'>): string {
  return [
    `change:${c.id}（${c.status}，来源 ${c.source}${c.rounds > 1 ? `，第 ${c.rounds} 轮` : ''}）`,
    `变更内容：${c.what}`, `原因：${c.why}`, `影响：${c.impact}`,
    ...(c.actions ? [`批准后程序会一次性落地：\n${summarizeText(c.actions)}`] : ['architect 还没有提交修订。']),
    ...(c.assumptions?.length ? [`assumptions（请逐条确认）：\n${c.assumptions.map((a, i) => `${i + 1}. ${a.question} → ${a.decision}`).join('\n')}`] : []),
    ...(c.extras?.length ? [`extras（超出需求的设计）：\n${c.extras.map((x, i) => `${i + 1}. ${x.what}：${x.why}`).join('\n')}`] : []),
    ...(c.warnings?.length ? [`提醒：\n${c.warnings.map((w) => `! ${w}`).join('\n')}`] : []),
    ...(c.feedback ? [`上次的意见：${c.feedback}`] : []),
    '契约的修改在 architect 的分支合并时已进入集成分支；批准前，被调整或取消的未开始 task 不会派发。',
  ].join('\n');
}

export interface MaterializeContext {
  flowStage: string;
  scopes: { worker: string[] };
  verify: string[];
  changeId: string;
}

/**
 * 把推导出的动作变成要落地的内容（task 输入、字段调整、取消、阶段）。纯函数；
 * 初始笔记由调用方按规格补充（notes 留空）。
 */
export function materializeChange(actions: readonly ChangeAction[], newPlan: PlanFile, tasks: readonly TaskFile[], ctx: MaterializeContext): ChangeOps {
  const ops: ChangeOps = { add: [], notes: {}, handoffs: {}, patches: [], cancels: [] };
  const depsMap = new Map<string, Dependency[]>();
  const sub = (list: PlanTask[]): PlanFile => ({ ...newPlan, tasks: list });
  const addedPlan: PlanTask[] = [];
  for (const a of actions) {
    if (a.kind === 'add') { addedPlan.push(a.task); depsMap.set(a.task.id, a.deps); }
  }
  if (addedPlan.length) {
    ops.add.push(...deriveTasks(sub(addedPlan), depsMap, ctx.scopes, { verify: ctx.verify }));
    for (const t of addedPlan) ops.handoffs[t.id] = `由变更请求 ${ctx.changeId} 新增。`;
  }
  for (const a of actions) {
    switch (a.kind) {
      case 'followup': {
        const m = new Map<string, Dependency[]>([[a.task.id, a.deps]]);
        const [impl] = deriveTasks(sub([a.task]), m, ctx.scopes, { verify: ctx.verify });
        const i = impl!;
        if (!i.depends_on.some((d) => d.task === a.of && d.type === 'hard')) i.depends_on = [...i.depends_on.filter((d) => d.task !== a.of), { task: a.of, type: 'hard', reason: `变更请求 ${ctx.changeId}：修改 ${a.of}` }];
        ops.add.push(i);
        const original = tasks.find((t) => t.id === a.of);
        ops.handoffs[i.id] = `这是对 ${a.of}「${original?.title ?? ''}」的修改 task（变更请求 ${ctx.changeId}）。${a.of} ${a.originalStatus === 'done' ? '已经完成并合并' : `${a.originalStatus}，做完后才会开始本任务`}；在它的基础上做本任务要求的修改，不要重写。`;
        break;
      }
      case 'adjust': ops.patches.push({ id: a.id, patch: a.patch }); break;
      case 'cancel':
        for (const id of [a.id, ...a.also]) ops.cancels.push({ id, reason: `变更请求 ${ctx.changeId}：计划已删除 ${a.id}` });
        break;
      case 'stages': ops.stages = { stages: structuredClone(a.stages) }; break;
      case 'add': break;
    }
  }
  return ops;
}
