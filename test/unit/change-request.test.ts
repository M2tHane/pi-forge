// 变更请求（规格第 5、12.3 节）：修订差异的每条规则、批准页文本、暂停判断、一个事务里的落地、创建与流程。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { setupProject, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { commitToBranch, makeEngine } from '../helpers/engine.ts';
import { stageStep } from '../../src/core/stage/stage-acceptance.ts';
import { CONTRACTS, P1_SPEC, PLAN_YAML } from '../helpers/contracts.ts';
import { deriveTasks, checkPlan, parsePlan } from '../../src/core/plan/plan.ts';
import { parseContracts } from '../../src/core/plan/contract-check.ts';
import { effectiveSpec } from '../../src/core/spec/spec.ts';
import type { ChangeFile, PlanFile, TaskFile } from '../../src/core/state/schemas.ts';
import { changeSummary, changeTouched, diffPlanRevision, isOpenChange, materializeChange, pausedByChange, summarizeActions, summarizeText, type ChangeAction, type CurrentPlan } from '../../src/core/plan/change-request.ts';
import { approvalTargets, approveChange, changeDocPrecheck, currentPlan, ensureChangeTask, ChangeError, pendingChanges, proposeChange, rejectChange, requestChange } from '../../src/core/plan/change-flow.ts';
import { flowRel, taskRel } from '../../src/core/state/state-store.ts';
import { decide, pendingDecisions } from '../../src/core/engine/decisions.ts';
import { createTaskWorktree, snapshot } from '../../src/core/workspace/worktree.ts';

// —— 纯函数：diffPlanRevision ——

type PT = PlanFile['tasks'][number];
const pt = (id: string, stage: string, over: Partial<PT> = {}): PT => ({
  id, stage, module: 'm', title: `任务 ${id}`, size: 'M', layers: ['backend'], ac: [], writes: [`src/${id.toLowerCase()}/**`], produces: [], requires: [], test_interface: [], ...over,
});
const stages = (...ids: string[]): PlanFile['stages'] => ids.map((id) => ({ id, goal: `阶段 ${id}`, exit: [`REQ-${id}`] }));
const oldPlan = (tasks: PT[], st = stages('S0', 'S1', 'S2')): CurrentPlan => ({ stages: st, tasks });
const next = (old: CurrentPlan, edit: (p: PlanFile) => void): PlanFile => {
  const p = structuredClone({ size_estimate: { loc: 9000, modules: 2 }, ...old }) as PlanFile;
  edit(p);
  return p;
};
const flowAt = (stage: string, st = stages('S0', 'S1', 'S2')) => ({ stage, s_stages: st });
const live = (id: string, status: TaskFile['status'], over: Partial<TaskFile> = {}): TaskFile => mkTask(id, { status, stage: 'S1', title: `任务 ${id}`, ...over });
const kinds = (r: { actions: ChangeAction[] }) => r.actions.map((a) => `${a.kind}${'id' in a ? `:${a.id}` : 'task' in a ? `:${(a.task as PT).id}` : ''}`);
const errs = (r: { errors: string[] }) => r.errors.join('\n');

// 基线：S0 的 T-001 已完成；S1（当前阶段）的 T-002 进行中、T-003 未开始、T-004 已完成；S2 的 T-005 未开始
const OLD = oldPlan([pt('T-001', 'S0'), pt('T-002', 'S1'), pt('T-003', 'S1', { ac: ['REQ-1.AC1'] }), pt('T-004', 'S1'), pt('T-005', 'S2')]);
const TASKS = (): TaskFile[] => [
  live('T-001', 'done', { stage: 'S0' }), live('T-002', 'in_progress'), live('T-003', 'pending', { ac: ['REQ-1.AC1'] }), live('T-004', 'done'), live('T-005', 'pending', { stage: 'S2' }),
];
const diff = (edit: (p: PlanFile) => void, tasks = TASKS(), flow = flowAt('S1'), opts = {}) => diffPlanRevision(OLD, next(OLD, edit), tasks, flow, opts);

test('没有变化：没有动作也没有错误', () => {
  const r = diff(() => {});
  assert.deepEqual(r, { errors: [], actions: [] });
});

test('新增 task：当前阶段与之后的阶段可以；早于当前阶段、阶段不存在的拒绝', () => {
  assert.deepEqual(kinds(diff((p) => { p.tasks.push(pt('T-010', 'S1')); })), ['add:T-010']);
  assert.deepEqual(kinds(diff((p) => { p.tasks.push(pt('T-010', 'S2')); })), ['add:T-010']);
  assert.match(errs(diff((p) => { p.tasks.push(pt('T-010', 'S0')); })), /T-010 的阶段 S0 在当前阶段 S1 之前/);
  assert.match(errs(diff((p) => { p.tasks.push(pt('T-010', 'S9')); })), /T-010 的阶段 S9/);
  assert.match(errs(diff((p) => { p.tasks.push(pt('T-002.x', 'S1')); }, [...TASKS(), live('T-002.x', 'pending')])), /编号已被流程里的 task 使用/);
});

test('调整未开始的 task：字段、依赖、阶段（只到当前或之后）；pending 和 ready 都算未开始', () => {
  const r = diff((p) => { p.tasks.find((t) => t.id === 'T-003')!.title = '新标题'; p.tasks.find((t) => t.id === 'T-003')!.writes = ['src/new/**']; });
  const a = r.actions.find((x) => x.kind === 'adjust')!;
  assert.deepEqual(r.errors, []);
  assert.equal(a.kind === 'adjust' && a.id, 'T-003');
  assert.deepEqual(a.kind === 'adjust' && a.fields.sort(), ['title', 'writes']);
  assert.deepEqual(a.kind === 'adjust' && a.patch, { title: '新标题', writes: ['src/new/**', 'tests/acceptance/T-003/**'] });
  // ready 同样可以调整；S2 的 task 可以移到当前阶段
  const ready = TASKS().map((t) => (t.id === 'T-003' ? { ...t, status: 'ready' as const } : t));
  assert.deepEqual(kinds(diff((p) => { p.tasks.find((t) => t.id === 'T-005')!.stage = 'S1'; }, ready)), ['adjust:T-005']);
  // 不能移到已完成的阶段
  assert.match(errs(diff((p) => { p.tasks.find((t) => t.id === 'T-005')!.stage = 'S0'; })), /T-005 的阶段 S0 在当前阶段 S1 之前/);
  // 只有依赖变化也要调整（依赖由修订后的计划推导）
  const deps = new Map([['T-003', [{ task: 'T-004', type: 'hard' as const, reason: 'x' }]]]);
  const r2 = diff(() => {}, TASKS(), flowAt('S1'), { deps });
  assert.deepEqual(r2.actions.map((x) => x.kind === 'adjust' && x.fields), [['depends_on']]);
});

test('已开始或已完成的 task 不能直接修改，错误里指出用 modifies', () => {
  for (const id of ['T-002', 'T-004']) {
    const r = diff((p) => { p.tasks.find((t) => t.id === id)!.ac = ['REQ-1.AC9']; });
    assert.match(errs(r), new RegExp(`${id} 已.*不能直接修改.*modifies: ${id}`));
    assert.deepEqual(r.actions, []);
  }
  // blocked、queued_merge 等在途状态同样算已开始
  const blocked = TASKS().map((t) => (t.id === 'T-003' ? { ...t, status: 'blocked' as const } : t));
  assert.match(errs(diff((p) => { p.tasks.find((t) => t.id === 'T-003')!.title = 'x'; }, blocked)), /T-003 已开始（blocked）/);
});

test('取消：从计划里删除未开始的 task；已开始、已完成的不行', () => {
  const r = diff((p) => { p.tasks = p.tasks.filter((t) => t.id !== 'T-003'); });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.actions, [{ kind: 'cancel', id: 'T-003', title: '任务 T-003', also: [] }]);
  assert.match(errs(diff((p) => { p.tasks = p.tasks.filter((t) => t.id !== 'T-002'); })), /T-002 已开始（in_progress），不能取消/);
  assert.match(errs(diff((p) => { p.tasks = p.tasks.filter((t) => t.id !== 'T-004'); })), /T-004 已完成，不能取消/);
  assert.match(errs(diff((p) => { p.tasks = p.tasks.filter((t) => t.id !== 'T-001'); })), /T-001 已完成，不能取消|已完成的阶段 S0/);
});

test('修改 task（modifies）：对进行中或已完成的原 task 是 followup；对未开始的 task 拒绝', () => {
  const r = diff((p) => { p.tasks.push(pt('T-010', 'S1', { modifies: 'T-004', ac: ['REQ-1.AC7'] }), pt('T-011', 'S1', { modifies: 'T-002' })); });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(kinds(r), ['followup:T-010', 'followup:T-011']);
  const f = r.actions[0]!;
  assert.deepEqual(f.kind === 'followup' && [f.of, f.originalStatus], ['T-004', 'done']);
  assert.deepEqual(r.actions[1]!.kind === 'followup' && r.actions[1]!.originalStatus, 'in_progress');
  assert.match(errs(diff((p) => { p.tasks.push(pt('T-010', 'S1', { modifies: 'T-003' })); })), /T-003 还没开始，直接调整它/);
  assert.match(errs(diff((p) => { p.tasks.push(pt('T-010', 'S1', { modifies: 'T-099' })); })), /T-099 不是已有的 task/);
  assert.match(errs(diff((p) => { p.tasks.push(pt('T-010', 'S1', { modifies: 'T-004' })); p.tasks = p.tasks.filter((t) => t.id !== 'T-004'); })), /不能同时从计划里删除/);
  assert.match(errs(diff((p) => { p.tasks.push(pt('T-010', 'S0', { modifies: 'T-004' })); })), /阶段 S0 在当前阶段/);
  assert.match(errs(diff((p) => { p.tasks.find((t) => t.id === 'T-003')!.modifies = 'T-004'; })), /已有的 task，不能加 modifies/);
});

test('阶段：当前阶段之后可以新增、调整、删除；已完成与当前阶段的目标不能改；当前阶段的 exit 只能追加', () => {
  const ok = diff((p) => { p.stages.push({ id: 'S3', goal: '新阶段', exit: [] }); p.stages[2]!.goal = '改目标'; p.tasks.push(pt('T-010', 'S3')); });
  assert.deepEqual(ok.errors, []);
  const s = ok.actions.find((a) => a.kind === 'stages')!;
  assert.deepEqual(s.kind === 'stages' && [s.added, s.adjusted, s.removed], [['S3'], ['S2'], []]);
  const del = diff((p) => { p.stages = p.stages.filter((x) => x.id !== 'S2'); p.tasks = p.tasks.filter((t) => t.stage !== 'S2'); });
  assert.deepEqual(del.actions.find((a) => a.kind === 'stages') && del.errors, []);
  assert.match(errs(diff((p) => { p.stages[0]!.goal = '改'; })), /不能修改已完成的阶段 S0/);
  assert.match(errs(diff((p) => { p.stages = p.stages.slice(1); })), /不能删除已完成的阶段 S0/);
  assert.match(errs(diff((p) => { p.stages[1]!.goal = '改'; })), /不能修改当前阶段 S1 的目标/);
  assert.match(errs(diff((p) => { p.stages[1]!.exit = []; })), /当前阶段 S1 的 exit 只能追加/);
  assert.deepEqual(diff((p) => { p.stages[1]!.exit.push('REQ-NEW'); }).errors, []);
  assert.match(errs(diff((p) => { p.stages.splice(1, 0, { id: 'SX', goal: 'x', exit: [] }); })), /新增的阶段 SX 在当前阶段 S1 之前/);
  assert.match(errs(diffPlanRevision(OLD, next(OLD, () => {}), TASKS(), flowAt('P1'))), /不是实施阶段/);
});

test('批准页：动作清单（中文）、被暂停的 task、changeSummary', () => {
  const r = diff((p) => {
    p.tasks.find((t) => t.id === 'T-003')!.title = '新标题';
    p.tasks = p.tasks.filter((t) => t.id !== 'T-005');
    p.tasks.push(pt('T-010', 'S1'), pt('T-011', 'S1', { modifies: 'T-004' }));
    p.stages.push({ id: 'S3', goal: 'x', exit: [] }); p.tasks.push(pt('T-012', 'S3'));
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(changeTouched(r.actions), ['T-003', 'T-005']);
  const actions = summarizeActions(r.actions);
  const text = summarizeText(actions);
  assert.match(text, /新增 task T-010（S1）/);
  assert.match(text, /调整未开始的 T-003：title/);
  assert.match(text, /取消未开始的 T-005/);
  assert.match(text, /为 T-004 新增修改 task T-011（S1，硬依赖 T-004）/);
  assert.match(text, /阶段：新增 S3/);
  assert.equal(summarizeText([]), '- 没有任何 task 或阶段的变化（只改了契约或文档）');
  const page = changeSummary({ id: 'C-001', status: 'proposed', what: '改契约', why: '原因', impact: '影响', source: 'worker:T-002', actions, rounds: 2, assumptions: [{ question: 'q', decision: 'd' }], feedback: '上次意见' });
  assert.match(page, /change:C-001（proposed，来源 worker:T-002，第 2 轮）/);
  assert.match(page, /变更内容：改契约[\s\S]*assumptions[\s\S]*1\. q → d[\s\S]*上次的意见：上次意见/);
});

test('暂停：等待批准（proposed）的变更请求要调整或取消的 task 不派发；其他状态与其他 task 不受影响', () => {
  const c = (status: ChangeFile['status'], touched: string[]) => ({ status, touched });
  assert.equal(pausedByChange([c('proposed', ['T-003', 'T-003.at'])], 'T-003'), true);
  assert.equal(pausedByChange([c('proposed', ['T-003'])], 'T-002'), false);
  assert.equal(pausedByChange([c('drafting', ['T-003'])], 'T-003'), false, '起草中还不知道要改什么');
  assert.equal(pausedByChange([c('approved', ['T-003']), c('rejected', ['T-003'])], 'T-003'), false);
  assert.deepEqual(['drafting', 'proposed', 'rejected', 'approved', 'cancelled'].map((s) => isOpenChange({ status: s as ChangeFile['status'] })), [true, true, true, false, false]);
});

// —— checkPlan：modifies ——

test('checkPlan：modifies 只在变更请求里允许；重复列出原 task 的 AC 不算再分配', () => {
  const plan = parsePlan(PLAN_YAML).plan!;
  const withMod = structuredClone(plan);
  withMod.tasks.push({ ...structuredClone(plan.tasks[1]!), id: 'T-009', modifies: 'T-003', produces: [], requires: [], writes: ['server/src/datasource2/**'], shared: [] });
  const ctx = { catalog: parseContracts(CONTRACTS).catalog, spec: effectiveSpec(P1_SPEC), existingTaskIds: ['T-001'], limits: { max_parallel: 4, max_task_files: 12 } };
  assert.match(checkPlan(withMod, ctx).errors.join('\n'), /T-009 写了 modifies/);
  const ok = checkPlan(withMod, { ...ctx, allowModifies: true });
  assert.deepEqual(ok.errors, []);
  const bad = structuredClone(withMod);
  bad.tasks.at(-1)!.modifies = 'T-777';
  assert.match(checkPlan(bad, { ...ctx, allowModifies: true }).errors.join('\n'), /T-009 的 modifies T-777 不在计划里/);
});

// —— materializeChange ——

test('materializeChange：新增 task 带自己的验收目录，修改 task 硬依赖原 task，取消，阶段整体替换', () => {
  const r = diff((p) => {
    p.tasks.find((t) => t.id === 'T-003')!.title = '新标题';
    p.tasks = p.tasks.filter((t) => t.id !== 'T-005');
    p.tasks.push(pt('T-010', 'S1', { ac: ['REQ-1.AC8'] }), pt('T-011', 'S1', { modifies: 'T-004', ac: ['REQ-1.AC9'] }));
    p.stages.push({ id: 'S3', goal: 'x', exit: [] }); p.tasks.push(pt('T-012', 'S3'));
  });
  const plan = next(OLD, (p) => { p.tasks.push(pt('T-010', 'S1'), pt('T-011', 'S1', { modifies: 'T-004' })); });
  const ops = materializeChange(r.actions, plan, TASKS(), { flowStage: 'S1', scopes: { worker: ['code'] }, verify: ['test'], changeId: 'C-001' });
  const byId = new Map(ops.add.map((t) => [t.id, t]));
  assert.deepEqual([...byId.keys()].sort(), ['T-010', 'T-011', 'T-012']);
  assert.deepEqual(byId.get('T-011')!.depends_on.map((d) => [d.task, d.type]), [['T-004', 'hard']]);
  assert.deepEqual(byId.get('T-011')!.verify, ['test']);
  for (const id of ['T-010', 'T-011', 'T-012']) assert.ok(byId.get(id)!.writes.includes(`tests/acceptance/${id}/**`), id);
  assert.match(ops.handoffs['T-011']!, /修改 task（变更请求 C-001）/);
  assert.deepEqual(ops.cancels.map((c) => c.id), ['T-005']);
  assert.deepEqual(ops.patches.map((p) => p.id), ['T-003']);
  assert.deepEqual(ops.stages!.stages.map((s) => s.id), ['S0', 'S1', 'S2', 'S3']);
  // 与 deriveTasks 的一致性：没有 modifies 的新增 task 和 P1 落地的生成方式相同
  const derived = deriveTasks({ ...plan, tasks: [pt('T-010', 'S1', { ac: ['REQ-1.AC8'] })] }, new Map(), { worker: ['code'] }, { verify: ['test'] });
  assert.deepEqual(byId.get('T-010'), derived[0]);
});

// —— StateStore：一个事务里落地 ——

const PLAN_STAGES = [{ id: 'S1', goal: '一', exit: ['REQ-001'] }, { id: 'S2', goal: '二', exit: ['REQ-002'] }];
function force(p: Project, rel: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', rel);
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}
async function stateProject() {
  const p = await setupProject({ stages: ['P1'], tasks: [
    mkTask('T-001', { stage: 'S1', title: '一号' }), mkTask('T-002', { stage: 'S1', title: '二号', ac: ['REQ-001.AC1'] }),
    mkTask('T-003', { stage: 'S2', title: '三号' }),
  ] });
  await p.store.setStages(p.flowId, PLAN_STAGES);
  force(p, flowRel(p.flowId), { stage: 'S1', stage_status: 'active' });
  force(p, taskRel(p.flowId, 'T-001'), { status: 'done' });
  return p;
}
const archTask = (id: string) => ({ id, stage: 'S1', kind: 'doc' as const, role: 'architect', title: '变更', scopes: ['docs'], depends_on: [], inputs: [], writes: ['docs/plan/**'], verify: [] });

test('applyChange：新增、调整、取消、阶段修订、approved 与 approval 事件在同一个事务里落地', async () => {
  const p = await stateProject();
  try {
    const { change } = await p.store.createChange(p.flowId, { what: 'w', why: 'y', impact: 'i', source: 'main' }, archTask('T-004'), 'brief', 'orchestrator');
    await p.store.saveChangeProposal(p.flowId, change.id, { task: 'T-004', plan_hash: 'a'.repeat(64), plan_text: 'x', assumptions: [], extras: [], summary: 's', actions: [], touched: ['T-003'], warnings: [] }, 'run:r');
    const before = p.store.readEvents().length;
    const newStages = [...PLAN_STAGES, { id: 'S3', goal: '三', exit: [] }];
    const saved = await p.store.applyChange(p.flowId, change.id, {
      add: [mkTask('T-010', { stage: 'S1' }) as never],
      notes: { 'T-010': ['REQ-001.AC1：x'] }, handoffs: { 'T-010': '来自变更请求' },
      patches: [{ id: 'T-002', patch: { title: '二号（改）', writes: ['src/new/**'], shared: undefined } }],
      cancels: [{ id: 'T-003', reason: '变更' }],
      stages: { stages: newStages },
    });
    assert.equal(saved.status, 'approved');
    assert.ok(saved.decided_at);
    assert.deepEqual(saved.touched, []);
    const tasks = new Map(p.store.listTasks(p.flowId).map((t) => [t.id, t]));
    assert.equal(tasks.get('T-010')!.status, 'pending');
    assert.equal(tasks.get('T-002')!.title, '二号（改）');
    assert.deepEqual(tasks.get('T-002')!.writes, ['src/new/**']);
    assert.equal(tasks.get('T-003')!.status, 'cancelled');
    assert.deepEqual(p.store.readFlow(p.flowId).s_stages!.map((s) => s.id), ['S1', 'S2', 'S3']);
    assert.deepEqual(p.store.readFlow(p.flowId).stages, ['P1', 'S1', 'S2', 'S3']);
    assert.match(p.store.readHandoff(p.flowId, 'T-010'), /来自变更请求/);
    assert.deepEqual(p.store.readNotes(`flows/${p.flowId}/notes/T-010.json`)!.goal, ['REQ-001.AC1：x']);
    const events = p.store.readEvents().slice(before);
    assert.ok(events.some((e) => e.type === 'stages_revised'));
    const approval = events.find((e) => e.type === 'approval')!;
    assert.deepEqual([approval.data!['change'], approval.data!['status'], approval.data!['stages_changed']], ['C-001', 'approved', true]);
    assert.deepEqual(p.store.readEvents().every((e, i) => e.seq === i + 1), true);
  } finally { p.cleanup(); }
});

test('applyChange：任何一步失败整体回滚（取消一个已开始的 task、改不允许的字段、没有等待批准的变更请求）', async () => {
  const p = await stateProject();
  try {
    const { change } = await p.store.createChange(p.flowId, { what: 'w', why: 'y', impact: 'i', source: 'main' }, archTask('T-004'), 'b', 'orchestrator');
    const empty = { add: [], notes: {}, handoffs: {}, patches: [], cancels: [] };
    await assert.rejects(p.store.applyChange(p.flowId, change.id, empty), /没有等待批准/);
    await p.store.saveChangeProposal(p.flowId, change.id, { task: 'T-004', plan_hash: 'a'.repeat(64), plan_text: 'x', assumptions: [], extras: [], summary: 's', actions: [], touched: [], warnings: [] }, 'run:r');
    force(p, taskRel(p.flowId, 'T-002'), { status: 'in_progress' });
    const seq = p.store.readEvents().length;
    const tasksBefore = p.store.listTasks(p.flowId).length;
    await assert.rejects(p.store.applyChange(p.flowId, change.id, { ...empty, add: [mkTask('T-010', { stage: 'S1' }) as never], cancels: [{ id: 'T-003', reason: 'r' }, { id: 'T-002', reason: 'r' }] }), /T-002 已经是 in_progress，不能取消/);
    await assert.rejects(p.store.applyChange(p.flowId, change.id, { ...empty, patches: [{ id: 'T-003', patch: { status: 'done' } }] }), /不能修改任务字段：status/);
    await assert.rejects(p.store.applyChange(p.flowId, change.id, { ...empty, patches: [{ id: 'T-002', patch: { title: 'x' } }] }), /T-002 已经是 in_progress，不能调整/);
    assert.equal(p.store.listTasks(p.flowId).length, tasksBefore, '新增的 task 没有写入');
    assert.equal(p.store.readTask(p.flowId, 'T-003').status, 'pending', '取消被回滚');
    assert.equal(p.store.readChange(p.flowId, change.id).status, 'proposed');
    assert.equal(p.store.readEvents().length, seq);
  } finally { p.cleanup(); }
});

test('requestChange：只在计划批准后、阶段 active 时可以；同一时间只能有一个未结束的变更请求；创建 architect 的 doc task', async () => {
  const p = await stateProject();
  try {
    const input = { what: '把 users.email 改成必填', why: 'REQ-001.AC1', impact: 'T-002 受影响' };
    const r = await requestChange(p.dir, p.store, p.config, p.flowId, input, 'worker:T-002');
    assert.equal(r.change.id, 'C-001');
    assert.equal(r.change.status, 'drafting');
    assert.equal(r.task.id, 'T-004');
    assert.deepEqual([r.task.kind, r.task.role, r.task.stage, r.task.status], ['doc', 'architect', 'S1', 'pending']);
    assert.deepEqual(r.task.writes, ['docs/contracts/**', 'docs/arch/**', 'docs/plan/**', 'docs/spec/glossary.md']);
    assert.deepEqual(r.task.scopes, ['plan'], 'architect 另有 code scope，变更请求的 task 只用 plan scope');
    const brief = p.store.readHandoff(p.flowId, 'T-004');
    assert.match(brief, /# 变更请求 C-001[\s\S]*来源：worker:T-002[\s\S]*变更内容：把 users\.email 改成必填/);
    assert.match(brief, /新增 task 的编号从 T-005 起/);
    assert.match(brief, /modifies: <原 task 编号>/);
    assert.match(brief, /## 发起者 T-002 的进展/, '说明里带发起者的改动与 handoff');
    // 发起者自己的 task 不受影响
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'pending');
    await assert.rejects(requestChange(p.dir, p.store, p.config, p.flowId, input, 'main'), /已有变更请求 C-001 在处理（drafting）/);
    await assert.rejects(requestChange(p.dir, p.store, p.config, p.flowId, { ...input, impact: ' ' }, 'main'), ChangeError);
    // 阶段不是 active、计划还没批准
    await p.store.cancelChange(p.flowId, 'C-001', '不要了', 'human');
    force(p, flowRel(p.flowId), { stage_status: 'awaiting_gate' });
    await assert.rejects(requestChange(p.dir, p.store, p.config, p.flowId, input, 'main'), /不是进行中/);
    force(p, flowRel(p.flowId), { stage_status: 'active', s_stages: undefined });
    await assert.rejects(requestChange(p.dir, p.store, p.config, p.flowId, input, 'main'), /计划还没有批准/);
  } finally { p.cleanup(); }
});

// —— 完整流程：起草 → 提交 → 预检 → 批准（真实仓库里的契约、规格与计划）——

const SPEC_FILES = Object.fromEntries(Object.entries(P1_SPEC).map(([k, v]) => [`docs/spec/${k}.md`, v]));
const CONTRACT_FILES = Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [`docs/contracts/${k}`, v]));


async function planProject(withStages = true) {
  const p = await setupProject({ stages: ['P1'], files: { ...SPEC_FILES, ...CONTRACT_FILES, 'docs/plan/plan.yaml': PLAN_YAML } });
  const plan = parsePlan(PLAN_YAML).plan!;
  const check = checkPlan(plan, { catalog: parseContracts(CONTRACTS).catalog, spec: effectiveSpec(P1_SPEC), existingTaskIds: [], limits: { max_parallel: 4, max_task_files: 12 } });
  assert.deepEqual(check.errors, []);
  const tasks = deriveTasks(plan, check.deps, { worker: p.config.role('worker').scopes }, { verify: ['test'] });
  force(p, flowRel(p.flowId), { approvals: { P0: { by: 'human', at: new Date().toISOString() } } });
  if (withStages) {
    await p.store.setStages(p.flowId, plan.stages);
    await p.store.addTasks(p.flowId, tasks, 'engine');
    force(p, flowRel(p.flowId), { stage: 'S1', stage_status: 'active', contracts_base: p.git('rev-parse', 'HEAD') });
    force(p, taskRel(p.flowId, 'T-002'), { status: 'done' });
  }
  return { p, plan };
}

/** 修订：S1 的 T-003（未开始）改标题；新增阶段 S2 与 T-005；T-006 修改已完成的 T-002 */
function revisedPlan(plan: PlanFile, ids: [string, string] = ['T-005', 'T-006']): string {
  const r = structuredClone(plan);
  r.tasks.find((t) => t.id === 'T-003')!.title = '数据源管理（含 SSL）';
  r.stages.push({ id: 'S2', goal: '导出', exit: ['REQ-003'] });
  r.tasks.push(
    { id: ids[0], stage: 'S2', module: 'export', title: '导出数据源', size: 'S', layers: ['backend'], ac: ['REQ-003.AC1'], writes: ['server/src/export/**'], produces: [], requires: [], test_interface: ['HTTP /api/export'] },
    { id: ids[1], stage: 'S1', module: 'team', title: '团队列表：增加成员数', size: 'S', layers: ['backend'], ac: ['REQ-002.AC1'], writes: ['server/src/team/count/**'], produces: [], requires: [], test_interface: [], modifies: 'T-002' },
  );
  return stringify(r);
}

/** 模拟 architect：在任务 worktree 里写修订，返回提交修订（forge_propose_plan）的函数 */
async function draft(p: Project, taskId: string, planText: string) {
  const flow = p.store.readFlow(p.flowId);
  const wt = createTaskWorktree(p.dir, p.flowId, taskId, flow.integration_branch, flow.integration_branch);
  await p.store.updateTask(p.flowId, taskId, { worktree: wt.path, branch: wt.branch, base_sha: wt.base_sha }, { actor: 'test', type: 'note' });
  writeFileSync(path.join(wt.path, 'docs/plan/plan.yaml'), planText);
  return { wt, propose: () => proposeChange(p.dir, p.store, p.config, p.flowId, p.store.readTask(p.flowId, taskId), { assumptions: [{ question: '导出格式', decision: 'CSV' }], extras: [] }, 'run:arch') };
}

test('完整流程：创建 → 起草提交（proposed）→ doc 预检 → 暂停 → 合并后出现在批准清单 → 批准一次性落地', async () => {
  const { p, plan } = await planProject();
  try {
    const { task } = await requestChange(p.dir, p.store, p.config, p.flowId, { what: '加 SSL 选项与导出', why: 'REQ-003', impact: 'T-003 与 T-002' }, 'main');
    assert.equal(task.id, 'T-004');
    assert.match(p.store.readHandoff(p.flowId, 'T-004'), /你的工作区里的 docs\/plan\/plan\.yaml 可能不是它[\s\S]*数据源管理/);
    const text = revisedPlan(plan);
    const d = await draft(p, 'T-004', text);
    // 提交前没有修订：预检拒绝
    assert.match(changeDocPrecheck(p.dir, p.store, p.config, p.flowId, p.store.readTask(p.flowId, 'T-004')) ?? '', /还没有用 forge_propose_plan 提交修订/);
    const r = await d.propose();
    assert.equal(r.ok, true, r.text);
    for (const re of [/等待批准 change:C-001/, /调整未开始的 T-003：title/, /新增 task T-005（S2）/, /为 T-002 新增修改 task T-006/]) assert.match(r.text, re);
    const c = p.store.readChange(p.flowId, 'C-001');
    assert.equal(c.status, 'proposed');
    assert.deepEqual(c.touched, ['T-003']);
    assert.equal(c.plan_text, text);
    assert.deepEqual(c.assumptions, [{ question: '导出格式', decision: 'CSV' }]);
    // 暂停：被调整的 task 不派发；还没合并时不进批准清单
    assert.equal(pausedByChange(p.store.listChanges(p.flowId), 'T-003'), true);
    assert.deepEqual(approvalTargets(p.store, p.flowId).map((t) => t.object), []);
    await assert.rejects(approveChange(p.dir, p.store, p.config, p.flowId, 'C-001'), /还没有合并/);
    // 预检：分支上的计划与提案不一致 → 拒绝；一致 → 通过（契约检查不要求只追加，architect 可以修改已有契约）
    writeFileSync(path.join(d.wt.path, 'docs/plan/plan.yaml'), `${text}# 改了\n`);
    snapshot(d.wt.path, 'plan 改过');
    assert.match(changeDocPrecheck(p.dir, p.store, p.config, p.flowId, p.store.readTask(p.flowId, 'T-004')) ?? '', /在 forge_propose_plan 之后又改过/);
    writeFileSync(path.join(d.wt.path, 'docs/plan/plan.yaml'), text);
    writeFileSync(path.join(d.wt.path, 'docs/contracts/errors/common.yaml'), 'FORBIDDEN: { http: 403, message: 禁止访问 }\n');
    snapshot(d.wt.path, '契约与计划');
    assert.equal(changeDocPrecheck(p.dir, p.store, p.config, p.flowId, p.store.readTask(p.flowId, 'T-004')), null);
    // 合并（模拟）：修订进集成分支，task done
    const integration = p.store.readFlow(p.flowId).integration_branch;
    commitToBranch(p.dir, integration, { 'docs/plan/plan.yaml': text }, '合并修订');
    force(p, taskRel(p.flowId, 'T-004'), { status: 'done' });
    assert.deepEqual(pendingChanges(p.store, p.flowId).map((x) => x.id), ['C-001']);
    const targets = approvalTargets(p.store, p.flowId);
    assert.deepEqual(targets.map((t) => t.object), ['change:C-001']);
    assert.match(targets[0]!.summary, /批准后程序会一次性落地/);

    const msg = await approveChange(p.dir, p.store, p.config, p.flowId, 'C-001');
    assert.match(msg, /已批准 change:C-001[\s\S]*新增 task：[\s\S]*T-005[\s\S]*T-006[\s\S]*调整：T-003/);
    const tasks = new Map(p.store.listTasks(p.flowId).map((t) => [t.id, t]));
    assert.deepEqual(['T-005', 'T-006'].map((id) => tasks.has(id)), [true, true]);
    assert.deepEqual(tasks.get('T-006')!.depends_on.map((x) => [x.task, x.type]), [['T-002', 'hard']]);
    assert.equal(tasks.get('T-003')!.title, '数据源管理（含 SSL）');
    assert.equal(tasks.get('T-005')!.stage, 'S2');
    assert.deepEqual(p.store.readFlow(p.flowId).s_stages!.map((s) => s.id), ['S0', 'S1', 'S2']);
    assert.ok(p.store.readEvents().some((e) => e.type === 'stages_revised'));
    assert.equal(p.store.readChange(p.flowId, 'C-001').status, 'approved');
    assert.equal(pausedByChange(p.store.listChanges(p.flowId), 'T-003'), false);
    // 当前计划变成批准后的这一份；已经批准的变更请求不能再批准
    const cur = currentPlan(p.dir, p.store, p.flowId);
    assert.ok(typeof cur !== 'string' && cur.plan.stages.length === 3);
    await assert.rejects(approveChange(p.dir, p.store, p.config, p.flowId, 'C-001'), /没有等待批准/);
    assert.equal((await requestChange(p.dir, p.store, p.config, p.flowId, { what: '下一个', why: 'y', impact: 'i' }, 'main')).change.id, 'C-002');
  } finally { p.cleanup(); }
});

test('提交修订时的校验：改了已完成的 task、DAG 错误都被拒绝，变更请求保持 drafting', async () => {
  const { p, plan } = await planProject();
  try {
    await requestChange(p.dir, p.store, p.config, p.flowId, { what: 'w', why: 'y', impact: 'i' }, 'main');
    const bad = structuredClone(plan);
    bad.tasks.find((t) => t.id === 'T-002')!.title = '偷偷改已完成的 task';
    bad.tasks.push({ id: 'T-005', stage: 'S1', module: 'm', title: '新增', size: 'S', layers: ['backend'], ac: [], writes: ['x/**'], produces: [], requires: ['api:GET /api/nothing'], test_interface: [] });
    const d = await draft(p, 'T-004', stringify(bad));
    const r = await d.propose();
    assert.equal(r.ok, false);
    assert.match(r.text, /缺少生产方/, 'DAG 校验错误先报告');
    bad.tasks.find((t) => t.id === 'T-005')!.requires = [];
    writeFileSync(path.join(d.wt.path, 'docs/plan/plan.yaml'), stringify(bad));
    const r2 = await d.propose();
    assert.equal(r2.ok, false);
    assert.match(r2.text, /T-002 已完成，不能直接修改/);
    assert.equal(p.store.readChange(p.flowId, 'C-001').status, 'drafting');
  } finally { p.cleanup(); }
});

test('打回：状态 rejected，程序新建 architect task（fork 上一个）返工，变更请求回到 drafting，说明带着意见；批准前集成分支的计划被改过则拒绝批准', async () => {
  const { p, plan } = await planProject();
  try {
    await requestChange(p.dir, p.store, p.config, p.flowId, { what: 'w', why: 'y', impact: 'i' }, 'main');
    const text = revisedPlan(plan);
    const d = await draft(p, 'T-004', text);
    assert.equal((await d.propose()).ok, true);
    force(p, taskRel(p.flowId, 'T-004'), { status: 'done' });
    // 集成分支上的计划与提交的不一致
    const integration = p.store.readFlow(p.flowId).integration_branch;
    commitToBranch(p.dir, integration, { 'docs/plan/plan.yaml': `${text}# 别人改的\n` }, '改动');
    await assert.rejects(approveChange(p.dir, p.store, p.config, p.flowId, 'C-001'), /与提交的修订不一致/);
    await assert.rejects(rejectChange(p.dir, p.store, p.config, p.flowId, 'C-001', ' '), /必须写明意见/);
    const msg = await rejectChange(p.dir, p.store, p.config, p.flowId, 'C-001', '不要加导出阶段');
    assert.match(msg, /已打回 change:C-001，程序已派 architect（T-005）按意见返工/);
    const c = p.store.readChange(p.flowId, 'C-001');
    assert.deepEqual([c.status, c.task, c.rounds, c.feedback, c.plan_text, c.touched], ['drafting', 'T-005', 2, '不要加导出阶段', undefined, []]);
    const t = p.store.readTask(p.flowId, 'T-005');
    assert.deepEqual([t.kind, t.role, t.fork_from_task], ['doc', 'architect', 'T-004']);
    assert.match(p.store.readHandoff(p.flowId, 'T-005'), /打回的意见：不要加导出阶段[\s\S]*新增 task 的编号从 T-006 起/);
    assert.equal(await ensureChangeTask(p.dir, p.store, p.config, p.flowId), null, '没有被打回的变更请求时什么也不做');
    // 打回时阶段不是 active：先记下，等 active 后由引擎新建
    const d2 = await draft(p, 'T-005', revisedPlan(plan, ['T-006', 'T-007']));
    assert.equal((await d2.propose()).ok, true);
    force(p, taskRel(p.flowId, 'T-005'), { status: 'done' });
    force(p, flowRel(p.flowId), { stage_status: 'awaiting_gate' });
    assert.match(await rejectChange(p.dir, p.store, p.config, p.flowId, 'C-001', '再改'), /阶段回到进行中后/);
    assert.equal(p.store.readChange(p.flowId, 'C-001').status, 'rejected');
    force(p, flowRel(p.flowId), { stage_status: 'active' });
    assert.equal((await ensureChangeTask(p.dir, p.store, p.config, p.flowId))!.id, 'T-006');
    assert.equal(p.store.readChange(p.flowId, 'C-001').status, 'drafting');
  } finally { p.cleanup(); }
});

test('主会话审核修订：就绪后先交给主会话，可以批准落地；转交用户后只有用户能批准', async () => {
  const { p, plan } = await planProject();
  try {
    await requestChange(p.dir, p.store, p.config, p.flowId, { what: 'w', why: 'y', impact: 'i' }, 'main');
    const text = revisedPlan(plan);
    const d = await draft(p, 'T-004', text);
    assert.equal((await d.propose()).ok, true);
    commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, { 'docs/plan/plan.yaml': text }, '合并修订');
    force(p, taskRel(p.flowId, 'T-004'), { status: 'done' });
    assert.deepEqual(pendingDecisions(p.store, p.flowId).map((x) => [x.id, x.options]), [['C-001', ['approve', 'reject', 'user']]]);
    await decide({ root: p.dir, store: p.store, config: p.config }, p.flowId, 'C-001', 'user', '新增了一个阶段，请用户确认');
    assert.equal(p.store.readChange(p.flowId, 'C-001').to_user, '新增了一个阶段，请用户确认');
    assert.deepEqual(pendingDecisions(p.store, p.flowId), []);
    await assert.rejects(decide({ root: p.dir, store: p.store, config: p.config }, p.flowId, 'C-001', 'approve', 'ok'), /没有等主会话决定/);
    // 用户仍可以批准
    assert.match(await approveChange(p.dir, p.store, p.config, p.flowId, 'C-001'), /已批准 change:C-001/);
  } finally { p.cleanup(); }
});

test('主会话批准修订：在一个事务里落地，批准事件记主会话', async () => {
  const { p, plan } = await planProject();
  try {
    await requestChange(p.dir, p.store, p.config, p.flowId, { what: 'w', why: 'y', impact: 'i' }, 'main');
    const text = revisedPlan(plan);
    const d = await draft(p, 'T-004', text);
    assert.equal((await d.propose()).ok, true);
    commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, { 'docs/plan/plan.yaml': text }, '合并修订');
    force(p, taskRel(p.flowId, 'T-004'), { status: 'done' });
    assert.match((await decide({ root: p.dir, store: p.store, config: p.config }, p.flowId, 'C-001', 'approve', '修订与原因一致')).text, /已批准 change:C-001/);
    assert.equal(p.store.readChange(p.flowId, 'C-001').status, 'approved');
    assert.ok(p.store.readEvents().some((e) => e.type === 'approval' && e.actor === 'orchestrator' && e.data?.['change'] === 'C-001'));
  } finally { p.cleanup(); }
});

// —— 引擎：暂停与阶段闸门 ——

test('引擎：等待批准的变更请求要调整的 task 不派发，其他 task 照常', async () => {
  const p = await stateProject();
  try {
    await p.store.addTasks(p.flowId, [mkTask('T-009', { stage: 'S1', writes: ['src/other/**'] })], 'architect');
    const { change } = await p.store.createChange(p.flowId, { what: 'w', why: 'y', impact: 'i', source: 'main' }, archTask('T-004'), 'b', 'orchestrator');
    await p.store.saveChangeProposal(p.flowId, change.id, { task: 'T-004', plan_hash: 'a'.repeat(64), plan_text: 'x', assumptions: [], extras: [], summary: 's', actions: [], touched: ['T-002'], warnings: [] }, 'run:r');
    force(p, taskRel(p.flowId, 'T-004'), { status: 'done' });
    const { engine } = makeEngine(p, async () => {});
    const started = await engine.next(p.flowId);
    assert.deepEqual(started.map((d) => d.task), ['T-009']);
    await engine.idle();
    assert.notEqual(p.store.readTask(p.flowId, 'T-002').status, 'in_progress');
    await assert.rejects(engine.dispatch(p.flowId, 'T-002'), /被等待批准的变更请求暂停/);
    // 打回后不再暂停
    await p.store.rejectChange(p.flowId, change.id, '重来');
    assert.equal(pausedByChange(p.store.listChanges(p.flowId), 'T-002'), false);
  } finally { p.cleanup(); }
});

test('阶段闸门：变更请求未结束时 stageStep 一直等待，结束后才提交门禁', async () => {
  const p = await stateProject();
  try {
    for (const t of p.store.listTasks(p.flowId).filter((x) => x.stage === 'S1' && x.status !== 'done')) force(p, taskRel(p.flowId, t.id), { status: 'done' });
    const deps = { root: p.dir, store: p.store, config: p.config };
    const { change } = await p.store.createChange(p.flowId, { what: 'w', why: 'y', impact: 'i', source: 'main' }, archTask('T-004'), 'b', 'orchestrator');
    force(p, taskRel(p.flowId, 'T-004'), { status: 'done' });
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'wait');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active');
    await p.store.cancelChange(p.flowId, change.id, '不要了', 'human');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'gate');
  } finally { p.cleanup(); }
});
