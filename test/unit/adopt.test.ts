// 第 13.3 节 /forge init --adopt：纳管流程的创建、architect 任务、预检与闸门、批准合入、打回与状态显示。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, type Project } from '../helpers/project.ts';
import { CONTRACTS } from '../helpers/contracts.ts';
import { commitToBranch, makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { ADOPT_STAGE, ADOPT_WRITES, adoptApprovalSummary, adoptBrief, adoptContractProblems, adoptGateProblems, adoptPrecheck, adoptScope, startAdoptFlow } from '../../src/core/adopt.ts';
import { ensureArchitectTask, planStatus } from '../../src/core/plan-flow.ts';
import { runStageGate } from '../../src/core/gates.ts';
import { approveStage, rejectStage } from '../../src/core/stages.ts';
import { featurePrecondition } from '../../src/core/feature-spec.ts';
import { nextStep } from '../../src/core/context-injector.ts';
import { phaseOfStage, renderStatus } from '../../src/core/status-view.ts';
import { taskRel } from '../../src/core/state-store.ts';
import { runFlowCommand, FLOW_USAGE, type CommandEnv } from '../../src/commands/forge.ts';
import { statusText } from '../../src/tools/orchestrator-tools.ts';

const CONTRACT_FILES = Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [`docs/contracts/${k}`, v]));
const ROOT = path.join(import.meta.dirname, '../..');

/** 已有代码、没有契约的项目：构造时的 build 流程先中止 */
async function legacyProject(files: Record<string, string> = { 'src/app.ts': 'export const app = 1;\n' }) {
  const p = await setupProject({ stages: ['P0', 'P1'], files });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  return p;
}
const deps = (p: Project) => ({ root: p.dir, store: p.store, config: p.config });

test('startAdoptFlow：mode=feature、唯一阶段 ADOPT、标题 adopt: …；主分支已有契约时需要 --force', async () => {
  const p = await legacyProject();
  try {
    const flow = await startAdoptFlow(deps(p), '订单模块');
    assert.deepEqual([flow.mode, flow.stages, flow.stage, flow.title], ['feature', [ADOPT_STAGE], ADOPT_STAGE, 'adopt: 订单模块']);
    assert.equal(p.store.readState().active_flow, flow.id);
    assert.equal(p.git('rev-parse', flow.integration_branch), p.git('rev-parse', 'main'));
    assert.equal(adoptScope(flow.title), '订单模块');
    assert.equal(adoptScope((await (async () => { await p.store.transitionStage(flow.id, { to: 'aborted', trigger: 'abort', actor: 'human' }); return startAdoptFlow(deps(p), '  '); })()).title), '项目中与后续功能相关的模块');
  } finally { p.cleanup(); }
  const full = await legacyProject({ ...CONTRACT_FILES });
  try {
    await assert.rejects(startAdoptFlow(deps(full), '订单'), /已经有 docs\/contracts\/[\s\S]*--force/);
    assert.equal(full.store.readState().active_flow, null);
    assert.equal((await startAdoptFlow(deps(full), '订单', true)).mode, 'feature');
  } finally { full.cleanup(); }
});

test('adoptBrief：只描述现有行为、限定可写路径、不要 forge_propose_plan；已有契约时说明锁定', () => {
  const b = adoptBrief('订单模块', { existingContracts: false });
  assert.match(b, /订单模块/);
  assert.match(b, /只描述现有代码的实际行为[\s\S]*不修改任何代码/);
  assert.match(b, /docs\/contracts\/\*\* 与 docs\/arch\/\*\*/);
  assert.match(b, /不需要 forge_propose_plan/);
  assert.doesNotMatch(b, /已锁定/);
  assert.match(adoptBrief('x', { existingContracts: true }), /已锁定，只能追加/);
  assert.match(adoptBrief('x', { existingContracts: false, rework: '补上错误码' }), /需要返工[\s\S]*补上错误码/);
});

test('ensureArchitectTask 在 ADOPT 阶段：建一个只能写 contracts 与 arch 的 doc task，写入说明，不重复建；返工再建一个', async () => {
  const p = await legacyProject();
  try {
    const flow = await startAdoptFlow(deps(p), '订单模块');
    const t = await ensureArchitectTask(p.store, p.config, flow.id, null);
    assert.ok(t);
    assert.deepEqual([t.kind, t.role, t.stage, t.title], ['doc', 'architect', ADOPT_STAGE, '纳管契约']);
    assert.deepEqual(t.writes, [...ADOPT_WRITES]);
    assert.match(p.store.readHandoff(flow.id, t.id), /已有项目纳管[\s\S]*订单模块/);
    assert.equal(await ensureArchitectTask(p.store, p.config, flow.id, null), null);
    // 任务完成后被打回：返工任务带原因
    const file = path.join(p.dir, '.forge', taskRel(flow.id, t.id));
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), status: 'done' }, null, 2));
    await p.store.setPlanRework(flow.id, '用户打回：补上错误码', 'human');
    const again = await ensureArchitectTask(p.store, p.config, flow.id, null);
    assert.equal(again?.title, '纳管契约（返工）');
    assert.match(p.store.readHandoff(flow.id, again!.id), /需要返工[\s\S]*补上错误码/);
    assert.equal(p.store.readFlow(flow.id).plan_rework, undefined);
  } finally { p.cleanup(); }
});

test('契约结构检查：没有契约、结构错误都算问题；合格契约通过', () => {
  assert.match(adoptContractProblems({}).join(), /缺少根文件 openapi\.yaml/);
  assert.deepEqual(adoptContractProblems(CONTRACTS), []);
  assert.ok(adoptContractProblems({ ...CONTRACTS, 'paths/team.yaml': ': : not yaml [' }).length > 0);
});

test('adoptPrecheck：在 architect 的工作区上检查契约；非 ADOPT 的 task 不管', async () => {
  const p = await legacyProject();
  const dir = mkdtempSync(path.join(tmpdir(), 'adopt-wt-'));
  try {
    const flow = await startAdoptFlow(deps(p), '订单');
    const task = mkTask('T-001', { kind: 'doc', stage: ADOPT_STAGE, role: 'architect', worktree: dir });
    assert.match(adoptPrecheck(p.dir, flow, task)!, /纳管预检未通过[\s\S]*缺少根文件 openapi\.yaml/);
    for (const [rel, text] of Object.entries(CONTRACTS)) {
      mkdirSync(path.dirname(path.join(dir, 'docs/contracts', rel)), { recursive: true });
      writeFileSync(path.join(dir, 'docs/contracts', rel), text);
    }
    assert.equal(adoptPrecheck(p.dir, flow, task), null);
    assert.equal(adoptPrecheck(p.dir, flow, { ...task, stage: 'P1' }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); p.cleanup(); }
});

test('ADOPT 闸门：集成分支没有契约则回到 active；有契约则 awaiting_human，批准页列出契约', async () => {
  const p = await legacyProject();
  try {
    const flow = await startAdoptFlow(deps(p), '订单');
    assert.match(adoptGateProblems(p.dir, flow).join(), /缺少根文件 openapi\.yaml/);
    await p.store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    const failed = await runStageGate(p.dir, p.store, p.config, flow.id);
    assert.deepEqual([failed.passed, failed.stage, p.store.readFlow(flow.id).stage_status], [false, ADOPT_STAGE, 'active']);

    commitToBranch(p.dir, flow.integration_branch, { ...CONTRACT_FILES, 'docs/arch/overview.md': '# 架构\n\n## 待确认\n- 订单取消是否退款\n' }, '契约');
    await p.store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    const ok = await runStageGate(p.dir, p.store, p.config, flow.id);
    assert.deepEqual([ok.passed, p.store.readFlow(flow.id).stage_status], [true, 'awaiting_human']);
    const summary = adoptApprovalSummary(p.dir, p.store.readFlow(flow.id));
    assert.match(summary, /纳管范围：订单[\s\S]*契约文件 \d+ 个[\s\S]*openapi\.yaml[\s\S]*接口 \d+ 个[\s\S]*docs\/arch\/overview\.md[\s\S]*--no-ff 合入主分支/);
    assert.match(statusText(p.store, null, flow.id), /纳管范围：订单/);
  } finally { p.cleanup(); }
});

test('批准 ADOPT：集成分支以 --no-ff 合入主分支，流程结束，之后 feature 的前置条件满足；打回则让 architect 返工', async () => {
  const p = await legacyProject();
  try {
    const flow = await startAdoptFlow(deps(p), '订单');
    commitToBranch(p.dir, flow.integration_branch, CONTRACT_FILES, '契约');
    await p.store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await runStageGate(p.dir, p.store, p.config, flow.id);
    assert.match(featurePrecondition(p.dir, 'main')!, /--adopt/);

    // 先打回：stage 回 active，返工原因记录在 plan_rework
    assert.match(await rejectStage(deps(p), flow.id, '补上订单取消接口'), /architect 按意见返工/);
    assert.deepEqual([p.store.readFlow(flow.id).stage_status, p.store.readFlow(flow.id).plan_rework?.reason], ['active', '用户打回：补上订单取消接口']);
    await p.store.setPlanRework(flow.id, null, 'engine');
    await p.store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await runStageGate(p.dir, p.store, p.config, flow.id);

    const text = await approveStage(deps(p), flow.id);
    assert.match(text, /已把 flow\/F-\d+\/integration 合入 main/);
    assert.equal(p.store.readState().active_flow, null);
    assert.equal(p.git('show', 'main:docs/contracts/openapi.yaml'), CONTRACTS['openapi.yaml']!.trimEnd());
    assert.equal(p.git('rev-list', '--merges', '--count', 'main'), '1');
    assert.equal(featurePrecondition(p.dir, 'main'), null);
  } finally { p.cleanup(); }
});

test('状态与上下文：ADOPT 属于"契约与计划"阶段，状态里显示纳管进度，主会话被告知等待与概述契约', async () => {
  const p = await legacyProject();
  try {
    const flow = await startAdoptFlow(deps(p), '订单');
    assert.equal(phaseOfStage(p.config, 'feature', ADOPT_STAGE), 'plan');
    const status = renderStatus(p.store, p.config);
    assert.match(status, /契约与计划/);
    assert.match(status, /纳管：订单；architect 正在从现有代码整理契约/);
    assert.doesNotMatch(status, /规格 /);
    assert.equal(nextStep(p.store, 3).tool, 'forge_wait');
    assert.match(planStatus(p.store, flow.id), /纳管：订单/);
    commitToBranch(p.dir, flow.integration_branch, CONTRACT_FILES, '契约');
    await p.store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await runStageGate(p.dir, p.store, p.config, flow.id);
    assert.match(nextStep(p.store, 3).next, /概述[\s\S]*\/forge-approve stage:ADOPT/);
    assert.match(renderStatus(p.store, p.config), /交付（待合入）/);
  } finally { p.cleanup(); }
});

test('/forge init --adopt：建纳管流程并派发 architect；有活动流程、未知参数、已有契约（无 --force）时拒绝；帮助里有说明', async () => {
  const p = await legacyProject();
  try {
    const talks: string[] = [];
    const { engine } = makeEngine(p, async (role, _n, a) => {
      assert.equal(role, 'architect');
      await a.call('forge_claim');
      await a.call('forge_block', { reason: '测试到此为止' });
    });
    const env: CommandEnv = {
      root: p.dir, packageRoot: ROOT, ui: null, engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
      roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
      startConversation: (t) => { talks.push(t); },
    };
    await assert.rejects(runFlowCommand('init --adopt --bogus', env), /未知参数 --bogus/);
    const out = await runFlowCommand('init --adopt "订单和支付模块"', env);
    assert.match(out, /已创建纳管流程 F-\d+（adopt: 订单和支付模块）/);
    const id = p.store.readState().active_flow!;
    const [task] = p.store.listTasks(id);
    assert.deepEqual([task?.stage, task?.role, task?.kind], [ADOPT_STAGE, 'architect', 'doc']);
    assert.match(talks[0]!, /订单和支付模块[\s\S]*forge_wait[\s\S]*stage:ADOPT/);
    await assert.rejects(runFlowCommand('init --adopt', env), /已有进行中的流程/);
    assert.match(FLOW_USAGE, /init --adopt/);
  } finally { p.cleanup(); }
  const full = await legacyProject({ ...CONTRACT_FILES });
  try {
    const { engine } = makeEngine(full, async () => {});
    const env: CommandEnv = {
      root: full.dir, packageRoot: ROOT, ui: null, engine: () => ({ store: full.store, engine, config: full.config }), store: () => full.store,
      roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
    };
    await assert.rejects(runFlowCommand('init --adopt', env), /已经有 docs\/contracts\/[\s\S]*--force/);
  } finally { full.cleanup(); }
});
