// M8 验收：状态视图的快照测试。每个场景用临时项目 + 递增的确定性时钟 + 直接改状态构造，
// 渲染默认视图、--detail、--metrics、状态栏，与 test/unit/__snapshots__/status/*.txt 比较。
// UPDATE_SNAPSHOTS=1 重写快照文件（重写后要人工复核 git diff）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { changeRel, flowRel, taskRel, type TaskInput } from '../../src/core/state/state-store.ts';
import { hashToken } from '../../src/core/state/state-machine.ts';
import { actionsNeeded, renderStatus, statusLine } from '../../src/core/ops/status-view.ts';
import { renderDetail, renderMetricsView, renderCostView, sortTasks, taskTable } from '../../src/core/ops/status-detail.ts';
import type { TaskFile } from '../../src/core/state/schemas.ts';

const SNAP_DIR = path.join(import.meta.dirname, '__snapshots__/status');
const UPDATE = process.env['UPDATE_SNAPSHOTS'] === '1';
const T0 = Date.parse('2026-03-04T01:00:00Z');
/** 固定"当前时间"：快照里的耗时、预算分钟数、停滞判断都以它为准（比所有事件都晚） */
const NOW = new Date(T0 + 30 * 60_000);

/** 每次读取前进一分钟的确定性时钟：事件时间戳互不相同，耗时可预测 */
function ticker() {
  let n = 0;
  return () => new Date(T0 + 60_000 * n++);
}

/** 抹掉每次运行都会变的内容：临时目录、40 位 sha、短 sha、时间戳 */
export function normalize(text: string, dir: string): string {
  return text
    .split(dir).join('<项目>')
    .replace(/(?:\/private)?\/(?:var\/folders|tmp)\/[^\s'"，；）)]*/g, '<临时目录>')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/契约锁定于 [0-9a-f]{8}/g, '契约锁定于 <sha8>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<时间>');
}

function check(name: string, actual: string) {
  const file = path.join(SNAP_DIR, `${name}.txt`);
  const body = `${actual.trimEnd()}\n`;
  if (UPDATE) { mkdirSync(SNAP_DIR, { recursive: true }); writeFileSync(file, body); return; }
  assert.ok(existsSync(file), `缺少快照 ${name}.txt：用 UPDATE_SNAPSHOTS=1 生成并复核`);
  assert.equal(body, readFileSync(file, 'utf8'), `快照 ${name} 不一致（有意修改时用 UPDATE_SNAPSHOTS=1 重写并复核 diff）`);
}

function forceTask(p: Project, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(p.flowId, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}
function forceFlow(p: Project, patch: Record<string, unknown>, flowId = p.flowId) {
  const f = path.join(p.dir, '.forge', flowRel(flowId));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}
const lease = (role: string, run: string) => ({ run_id: run, role, token_hash: hashToken(run), acquired_at: '2026-03-04T01:10:00.000Z', expires_at: '2999-01-01T00:00:00.000Z' });
const running = (role: string, run: string) => ({ status: 'in_progress', lease: lease(role, run), branch: 'b', worktree: '/w', base_sha: 'a'.repeat(40) });
const HUMAN = { by: 'human', at: '2026-03-04T01:00:00.000Z' };

const S_STAGES = [{ id: 'S0', goal: '项目骨架与契约落地', exit: ['REQ-001'] }, { id: 'S1', goal: '可以创建并查看看板', exit: ['REQ-001', 'REQ-002'] }, { id: 'S2', goal: '看板成员协作', exit: ['REQ-003'] }];
const ALL_STAGES = ['P1'];
const QA_YAML = PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true');

type T = ReturnType<typeof mkTask>;
async function mk(opts: { stages?: string[]; tasks?: T[]; yaml?: string; at?: string; plan?: boolean; approvals?: string[] } = {}) {
  const p = await setupProject({ stages: opts.stages ?? ALL_STAGES, now: ticker(), ...(opts.yaml ? { yaml: opts.yaml } : {}) });
  // 与真实流程一致：S 阶段在 P1 批准时追加到 flow.stages 末尾，之后才有 S 阶段的任务
  if (opts.plan) await p.store.setStages(p.flowId, S_STAGES, 'standard');
  if (opts.tasks?.length) await p.store.addTasks(p.flowId, opts.tasks as TaskInput[], 'architect');
  const patch: Record<string, unknown> = {};
  if (opts.at) patch['stage'] = opts.at;
  if (opts.approvals) patch['approvals'] = Object.fromEntries(opts.approvals.map((a) => [a, HUMAN]));
  if (Object.keys(patch).length) forceFlow(p, patch);
  return p;
}
const toGate = (p: Project) => p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
const toSignoff = async (p: Project) => { await toGate(p); await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true }); };
const impl = (id: string, stage: string, over: Parameters<typeof mkTask>[1] = {}) => mkTask(id, { stage, layers: ['backend'], ...over });

async function addRun(p: Project, id: string, task: string | null, role: string, startMin: number, minutes: number, tokens: number, cost: number | null, flow: string | null = p.flowId) {
  await p.store.createRun({ run_id: id, flow, task, role, model: 'fake/model', started_at: new Date(T0 + startMin * 60_000).toISOString(), ended_at: new Date(T0 + (startMin + minutes) * 60_000).toISOString(),
    tokens: { input: tokens, output: Math.round(tokens / 4), cache_read: tokens * 2, cache_write: 0 }, outcome: 'submitted', token_hash: hashToken(id), violations: 0, cost, turns: 12 });
}

interface Scenario { name: string; build: () => Promise<Project> }
const scenarios: Scenario[] = [];
const scenario = (name: string, build: () => Promise<Project>) => scenarios.push({ name, build });

// —— 架构阶段 ——

scenario('s0-start', async () => mk({ stages: ['S0'] }));

scenario('p1-drafting', async () => {
  const p = await mk({ at: 'P1', tasks: [mkTask('T-001', { stage: 'P1', kind: 'doc', role: 'architect', scopes: ['plan'], writes: ['docs/**'] })] });
  forceTask(p, 'T-001', running('architect', 'r-p1'));
  return p;
});

scenario('p1-awaiting-approval', async () => {
  const p = await mk({ at: 'P1', tasks: [mkTask('T-001', { stage: 'P1', kind: 'doc', role: 'architect', scopes: ['plan'], writes: ['docs/**'] })] });
  forceTask(p, 'T-001', { status: 'done' });
  await toSignoff(p);
  return p;
});

// —— 开发阶段 ——

scenario('s1-running', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: [
    impl('T-001', 'S0'), impl('T-002', 'S1', { title: '看板列表接口' }), impl('T-003', 'S1', { kind: 'review', role: 'reviewer', title: '看板列表接口审查', for_task: 'T-002', writes: [] }),
    impl('T-004', 'S1', { title: '创建看板接口' }), impl('T-005', 'S1', { title: '看板页面', deps: [{ task: 'T-002', type: 'hard' }] }), impl('T-006', 'S2', { title: '成员邀请' })] });
  forceTask(p, 'T-001', { status: 'done' });
  forceTask(p, 'T-002', running('worker', 'r-2'));
  forceTask(p, 'T-003', running('reviewer', 'r-3'));
  forceTask(p, 'T-004', { status: 'blocked', blocked_by: 'agent', blocked_reason: '规格里 title 是否可为空没有说清，与 REQ-001.AC2 不一致', review_rounds: 1, version: 4 });
  forceTask(p, 'T-005', { status: 'ready' });
  await addRun(p, 'r-1', 'T-001', 'worker', 5, 12, 20000, 0.2);
  await addRun(p, 'r-2', 'T-002', 'worker', 30, 8, 15000, 0.15);
  return p;
});

scenario('s1-stage-qa', async () => {
  const p = await mk({ plan: true, at: 'S1', yaml: QA_YAML, approvals: ['P1'], tasks: [
    impl('T-001', 'S1', { title: '看板列表接口' }), impl('T-002', 'S1', { title: '创建看板接口' }),
    mkTask('S1.qa', { stage: 'S1', kind: 'qa', role: 'stage-qa', scopes: ['qa'], writes: [], title: 'S1 阶段验收', for_task: 'T-001' })] });
  forceTask(p, 'T-001', { status: 'done' });
  forceTask(p, 'T-002', { status: 'done' });
  forceTask(p, 'S1.qa', running('stage-qa', 'r-qa'));
  await toGate(p);
  await addRun(p, 'r-1', 'T-001', 'worker', 5, 12, 20000, 0.2);
  await addRun(p, 'r-2', 'T-002', 'worker', 10, 9, 18000, 0.18);
  return p;
});

scenario('s1-needs-human', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: [impl('T-001', 'S1', { title: '看板列表接口' }), impl('T-002', 'S1', { title: '创建看板接口' })] });
  forceTask(p, 'T-001', { status: 'done' });
  forceTask(p, 'T-002', { status: 'done' });
  await toGate(p);
  await p.store.transitionStage(p.flowId, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'engine', reason: '全量测试失败：test 命令退出码 1，已自动修复 2 轮仍未通过' });
  return p;
});

scenario('s1-awaiting-signoff', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: [impl('T-001', 'S1', { title: '看板列表接口' }), impl('T-002', 'S1', { title: '创建看板接口' }), impl('T-003', 'S2', { title: '成员邀请' })] });
  forceTask(p, 'T-001', { status: 'done' });
  forceTask(p, 'T-002', { status: 'done' });
  await toSignoff(p);
  return p;
});

scenario('delivery-awaiting-signoff', async () => {
  const p = await mk({ plan: true, at: 'S2', approvals: ['P1'], tasks: [impl('T-001', 'S0', { title: '骨架' }), impl('T-002', 'S1', { title: '看板列表接口' }), impl('T-003', 'S2', { title: '成员邀请' })] });
  for (const id of ['T-001', 'T-002', 'T-003']) forceTask(p, id, { status: 'done' });
  forceTask(p, 'T-003', { merge_failures: 1, attempts: 1 });
  await toSignoff(p);
  await addRun(p, 'r-1', 'T-001', 'worker', 5, 10, 20000, 0.2);
  await addRun(p, 'r-2', 'T-002', 'worker', 20, 14, 30000, 0.3);
  await addRun(p, 'r-3', 'T-003', 'worker', 40, 11, 25000, 0.25);
  return p;
});

scenario('blocked-variants', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: ['T-001', 'T-002', 'T-003', 'T-004', 'T-005'].map((id) => impl(id, 'S1')) });
  const kinds = ['review_exhausted', 'precheck_exhausted', 'agent', 'integration_broken', 'merge_exhausted'];
  ['T-001', 'T-002', 'T-003', 'T-004', 'T-005'].forEach((id, i) => forceTask(p, id, { status: 'blocked', blocked_by: kinds[i], blocked_reason: `原因 ${kinds[i]}`, version: 3,
    ...(i === 0 ? { review_rounds: 3 } : i === 1 ? { precheck_failures: 3 } : i === 4 ? { merge_failures: 3 } : {}) }));
  return p;
});

scenario('sync-conflict', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: [impl('T-001', 'S1')] });
  forceTask(p, 'T-001', { status: 'ready' });
  forceFlow(p, { sync: { stage: 'S1', status: 'conflict', main_sha: 'b'.repeat(40), at: '2026-03-04T01:20:00.000Z', files: ['src/app.ts'], reason: 'src/app.ts 两边都改了同一段' } });
  return p;
});

scenario('budget-exceeded', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: [impl('T-001', 'S1'), impl('T-002', 'S1')] });
  forceTask(p, 'T-001', { status: 'done' });
  forceTask(p, 'T-002', { status: 'ready' });
  forceFlow(p, { budget: { tokens: 50000 } });
  await addRun(p, 'r-1', 'T-001', 'worker', 5, 30, 50000, 1);
  return p;
});

// —— 变更与修订 ——

scenario('change-request-pending', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: [impl('T-001', 'S1', { title: '看板列表接口' }), impl('T-002', 'S1', { title: '创建看板接口' })] });
  forceTask(p, 'T-001', { status: 'done' });
  forceTask(p, 'T-002', running('worker', 'r-2'));
  const { change } = await p.store.createChange(p.flowId, { what: '看板增加归档功能', why: '用户要求', impact: '新增 1 个接口', source: 'main' },
    mkTask('T-009', { stage: 'S1', kind: 'doc', role: 'architect', scopes: ['plan'], writes: ['docs/**'], title: '变更请求：看板增加归档功能' }) as TaskInput, '起草修订', 'orchestrator');
  forceTask(p, 'T-009', { status: 'done' });
  const f = path.join(p.dir, '.forge', changeRel(p.flowId, change.id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), status: 'proposed', summary: '新增 T-007 归档接口' }, null, 2));
  return p;
});

// —— 修复流程、结束 ——

async function fixProject(): Promise<Project> {
  const p = await setupProject({ yaml: QA_YAML, now: ticker() });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  const fix = await p.store.createLightFlow('fix', '登录失败', 'main', p.git('rev-parse', 'HEAD'));
  await p.store.saveFlowBrief(fix.id, '# 登录失败\n输入正确密码仍提示错误。');
  return Object.assign(p, { flowId: fix.id });
}
const fixTask = (id: string, over: Partial<TaskFile> = {}) => mkTask(id, { stage: 'X1', title: id === 'T-001' ? '修复：登录失败' : '复现确认', ...over }) as TaskInput;

scenario('fix-fixing', async () => {
  const p = await fixProject();
  await p.store.addTasks(p.flowId, [fixTask('T-001')], 'engine');
  forceTask(p, 'T-001', running('worker', 'r-fix'));
  return p;
});

scenario('fix-confirming', async () => {
  const p = await fixProject();
  await p.store.addTasks(p.flowId, [fixTask('T-001'), fixTask('X1.qa', { kind: 'qa', role: 'stage-qa', scopes: ['qa'], writes: [], for_task: 'T-001' })], 'engine');
  forceTask(p, 'T-001', { status: 'done' });
  forceTask(p, 'X1.qa', running('stage-qa', 'r-fqa'));
  await addRun(p, 'r-fix', 'T-001', 'worker', 5, 6, 9000, 0.09);
  return p;
});

scenario('fix-needs-human', async () => {
  const p = await fixProject();
  await p.store.addTasks(p.flowId, [fixTask('T-001')], 'engine');
  forceTask(p, 'T-001', { status: 'blocked', blocked_by: 'agent', blocked_reason: '改动涉及 9 个文件，超出修复范围，建议改用 /forge-build --feature', version: 3 });
  return p;
});

scenario('finished-flow', async () => {
  const p = await mk({ stages: ['S1'], tasks: [impl('T-001', 'S1', { title: '看板列表接口' })] });
  forceTask(p, 'T-001', { status: 'done' });
  await toGate(p);
  await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
  await p.store.transitionStage(p.flowId, { to: 'done', trigger: 'approve', actor: 'human' });
  await p.store.advanceStage(p.flowId, 'human');
  await addRun(p, 'r-1', 'T-001', 'worker', 5, 10, 20000, 0.2);
  return p;
});

scenario('no-flow', async () => {
  const p = await setupProject({ now: ticker() });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  return p;
});

for (const s of scenarios) {
  test(`状态快照：${s.name}`, async () => {
    const p = await s.build();
    try {
      const norm = (t: string) => normalize(t, p.dir);
      check(`${s.name}.default`, norm(renderStatus(p.store, p.config, NOW)));
      check(`${s.name}.detail`, norm(renderDetail(p.store, p.config, NOW)));
      check(`${s.name}.metrics`, norm(renderMetricsView(p.store, NOW, p.dir)));
      check(`${s.name}.line`, norm(statusLine(p.store, p.config, NOW) ?? '（清除状态栏）'));
    } finally { p.cleanup(); }
  });
}

// —— 非快照断言 ——

test('默认视图不暴露内部状态名和任务类型；这些只在 --detail', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: [impl('T-001', 'S1'), impl('T-002', 'S1', { kind: 'review', role: 'reviewer', for_task: 'T-001', writes: [] })] });
  try {
    forceTask(p, 'T-001', running('worker', 'r-1'));
    forceTask(p, 'T-002', { status: 'blocked', blocked_by: 'review_exhausted', blocked_reason: 'x', version: 2 });
    const out = renderStatus(p.store, p.config, NOW);
    assert.doesNotMatch(out, /in_progress|awaiting_|queued_merge|needs_human|blocked_by|review_exhausted/, '不出现内部状态、任务类型、blocked_by 取值');
    const detail = renderDetail(p.store, p.config, NOW);
    assert.match(detail, /\| T-002 \| review \| reviewer \| blocked \| S1 \|/);
    assert.match(detail, /in_progress/);
  } finally { p.cleanup(); }
});

test('阻塞任务按 blocked_by 给出不同的解除命令', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: ['T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006'].map((id) => impl(id, 'S1')) });
  try {
    const kinds = ['review_exhausted', 'precheck_exhausted', 'agent', 'integration_broken', 'attempts'];
    kinds.forEach((k, i) => forceTask(p, `T-00${i + 2}`, { status: 'blocked', blocked_by: k, blocked_reason: 'r', version: 2 }));
    const cmd = (id: string) => actionsNeeded(p.store, p.config, NOW).find((a) => a.key.includes(`:blocked:${id}:`))!.command;
    assert.match(cmd('T-002'), /^\/forge accept T-002 --note/);
    assert.match(cmd('T-003'), /^\/forge unblock T-003 .*--reset/);
    assert.equal(cmd('T-004'), '/forge answer T-004');
    assert.match(cmd('T-005'), /\/forge unblock T-005$/);
    assert.match(cmd('T-006'), /^\/forge unblock T-006/);
  } finally { p.cleanup(); }
});

test('--detail 的任务表按阶段顺序、编号自然序排列，输出稳定', async () => {
  const p = await mk({ plan: true, at: 'S1', tasks: [impl('T-010', 'S1'), impl('T-002', 'S1'), impl('T-001', 'S2'), impl('T-003', 'S0')] });
  try {
    const tasks = p.store.listTasks(p.flowId);
    const flow = p.store.readFlow(p.flowId);
    assert.deepEqual(sortTasks(flow, [...tasks].reverse()).map((t) => t.id), ['T-003', 'T-002', 'T-010', 'T-001']);
    assert.equal(taskTable(flow, tasks), taskTable(flow, [...tasks].reverse()));
    assert.match(taskTable(flow, tasks).split('\n')[0]!, /任务 \| 类型 \| 角色 \| 状态 \| 阶段 \| 预检失败 \| 审查轮 \| 合并失败 \| 尝试/);
    assert.equal(renderDetail(p.store, p.config, NOW), renderDetail(p.store, p.config, NOW));
  } finally { p.cleanup(); }
});

test('--metrics 与 --cost：build、fix、没有运行记录的流程都不抛错', async () => {
  const cfg = parseConfig(PROJECT_YAML);
  const mkFlow = async () => setupProject({ now: ticker() });
  for (const make of [mkFlow, fixProject]) {
    const p = await make();
    try {
      assert.match(renderMetricsView(p.store, NOW, p.dir), /度量/);
      assert.match(renderCostView(p.store, cfg, NOW), /成本统计/);
      await addRun(p, 'r-1', null, 'worker', 5, 3, 1000, null);
      assert.match(renderMetricsView(p.store, NOW, p.dir), /度量/);
      assert.match(renderCostView(p.store, cfg, NOW), /1 次运行/);
    } finally { p.cleanup(); }
  }
  const empty = await setupProject({ now: ticker() });
  try { assert.match(renderMetricsView(empty.store, NOW), /度量/); } finally { empty.cleanup(); }
});

test('状态栏：短，只有高层阶段，不列任务编号；没有流程时为 null', async () => {
  const p = await mk({ plan: true, at: 'S1', approvals: ['P1'], tasks: [impl('T-001', 'S1'), impl('T-002', 'S1'), impl('T-003', 'S1')] });
  try {
    forceTask(p, 'T-001', running('worker', 'r-1'));
    forceTask(p, 'T-002', running('worker', 'r-2'));
    forceTask(p, 'T-003', { status: 'blocked', blocked_by: 'agent', blocked_reason: '问题', version: 2 });
    const line = statusLine(p.store, p.config, NOW)!;
    assert.equal(line, 'pi-forge B-001 开发 S1 · 0/3 · 2 个任务进行中 · 需要你处理 1 项');
    assert.ok(line.length < 60);
    assert.doesNotMatch(line, /T-00\d/);
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.equal(statusLine(p.store, p.config, NOW), null);
  } finally { p.cleanup(); }
});
