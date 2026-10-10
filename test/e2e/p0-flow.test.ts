// 改编自 pi-flow test/e2e/flow6.test.ts @ 31f3f15：P0 提交、闸门、人工打回与修订。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { P0_SPEC, P0_AMEND } from '../helpers/spec.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/forge.ts';
import { flowSpec, flowSpecAmend, statusText } from '../../src/tools/orchestrator-tools.ts';
import { approveSpecAmend, proposeSpecAmend, submitSpec, readSpec } from '../../src/core/spec-flow.ts';
import { commitFilesToBranch, importInputs } from '../../src/core/intake.ts';
import { runStageGate } from '../../src/core/gates.ts';
import { turnContext, nextStep } from '../../src/core/context-injector.ts';
import { renderStatus } from '../../src/core/status-view.ts';
import { StateStore } from '../../src/core/state-store.ts';
const ROOT = path.join(import.meta.dirname, '../..');
function env(p: Project): { cmd: CommandEnv; engine: ReturnType<typeof makeEngine>['engine']; launched: () => number } {
  // P0 不派发子进程；进入 P1 后 architect 被派发（这里只计数，P1 的流程见 p1-flow）
  const { engine, launcher } = makeEngine(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    await a.call('forge_claim');
    await a.call('forge_block', { reason: '测试到此为止' });
  });
  return { cmd: { root: p.dir, packageRoot: ROOT, ui: null, engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store, roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true }, engine, launched: () => launcher.launched.length };
}
test('P0 不合格规格零写入；合格规格独立索引提交，打回带意见，批准后进入 P1 并派发 architect', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] });
  const e = env(p);
  try {
    writeFileSync(path.join(p.dir, 'prd.md'), 'PRD 原文');
    await importInputs(p.dir, p.store, p.flowId, { prd: 'prd.md' });
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const state = p.store.readState();
    const flow = p.store.readFlow(p.flowId);
    const sha = p.git('rev-parse', ref);
    await assert.rejects(flowSpec(p.dir, p.store, p.config, { ...P0_SPEC, requirements: P0_SPEC.requirements.replace('Given', '') }), /spec-lint.*未通过[\s\S]*Given/);
    assert.deepEqual(p.store.readState(), state);
    assert.deepEqual(p.store.readFlow(p.flowId), flow);
    assert.equal(p.git('rev-parse', ref), sha);
    assert.equal(p.git('ls-tree', '-r', '--name-only', ref, '--', 'docs/spec/requirements.md'), '');
    writeFileSync(path.join(p.dir, 'staged.md'), '用户的暂存内容');
    p.git('add', 'staged.md');
    const index = p.git('diff', '--cached');
    assert.match((await flowSpec(p.dir, p.store, p.config, P0_SPEC)).text, /等待用户 \/forge-approve/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.equal(p.git('diff', '--cached'), index);
    assert.equal(existsSync(path.join(p.dir, 'docs/spec/requirements.md')), false);
    assert.match(renderStatus(p.store, p.config), /stage:P0[\s\S]*规格：已提交；检查：通过/);
    await assert.rejects(submitSpec(p.dir, p.store, p.flowId, P0_SPEC), /等待用户/);
    await assert.rejects(runFlowCommand('approve typo', e.cmd), /用法/);
    await assert.rejects(runFlowCommand('approve stage:P0 amend:A-001', e.cmd), /用法/);
    assert.match(await runFlowCommand('reject stage:P0 "名称要唯一"', e.cmd), /意见/);
    assert.deepEqual([p.store.readFlow(p.flowId).stage_status, p.store.readFlow(p.flowId).spec?.submitted], ['active', false]);
    assert.ok(p.store.readEvents().some((ev) => ev.type === 'stage_reopened' && ev.reason === '名称要唯一'));
    const restored = new StateStore(p.dir);
    assert.match(turnContext(restored, 3, 0, p.config), /名称要唯一[\s\S]*docs\/spec\/inputs\/prd\/prd.md/);
    assert.equal(nextStep(restored, 3).tool, 'forge_spec');
    await flowSpec(p.dir, p.store, p.config, { ...P0_SPEC, requirements: P0_SPEC.requirements.replace('返回看板编号', '返回唯一看板编号') });
    assert.match(await runFlowCommand('approve', e.cmd), /进入阶段 P1/);
    assert.deepEqual([p.store.readFlow(p.flowId).stage, p.store.readFlow(p.flowId).stage_status], ['P1', 'active']);
    await e.engine.idle();
    assert.equal(e.launched(), 1);
    assert.equal(p.store.readTask(p.flowId, 'T-001').role, 'architect');
    assert.match(nextStep(p.store, 3).next, /向用户报告阻塞：T-001（测试到此为止）/);
    assert.deepEqual(readSpec(p.dir, ref).files.screens, P0_SPEC.screens);
    await assert.rejects(submitSpec(p.dir, p.store, p.flowId, P0_SPEC), /只能在/);
    assert.ok((await p.store.verifyIntegrity()).ok);
  } finally { p.cleanup(); }
});
test('P0 闸门重读集成分支：本地文件不能掩盖不合格或缺失规格，失败回 active；恢复处理 awaiting_gate', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] });
  const e = env(p);
  try {
    await assert.rejects(proposeSpecAmend(p.dir, p.store, p.flowId, { content: P0_AMEND, reason: '补充' }), /P0 批准之后/);
    await submitSpec(p.dir, p.store, p.flowId, P0_SPEC);
    assert.match(turnContext(p.store, 3), /重读集成分支/);
    commitFilesToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, [{ rel: 'docs/spec/requirements.md', content: P0_SPEC.requirements.replace('Given', '') }], '模拟提交后的规格变化');
    const r = await runStageGate(p.dir, p.store, p.config, p.flowId);
    assert.equal(r.passed, false);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active');
    assert.match(p.store.readFlow(p.flowId).spec!.feedback!, /Given/);
    assert.ok(p.store.readEvents().some((ev) => ev.trigger === 'gate_failed'));
    await submitSpec(p.dir, p.store, p.flowId, P0_SPEC);
    await e.engine.pump(p.flowId);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(turnContext(p.store, 3), /spec-lint 通过[\s\S]*等待用户/);
    assert.ok((await p.store.verifyIntegrity()).ok);
  } finally { p.cleanup(); }
  const missing = await setupProject({ stages: ['P0', 'P1'] });
  try {
    await missing.store.transitionStage(missing.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    assert.equal((await runStageGate(missing.dir, missing.store, missing.config, missing.flowId)).passed, false);
    assert.match(missing.store.readFlow(missing.flowId).spec!.feedback!, /没有规格文件/);
  } finally { missing.cleanup(); }
});
test('规格修订：列出 AC 差异与关联 task；多个待批对象须明确；批准提交 features，打回不改分支并注入意见', async () => {
  const p = await setupProject({ stages: ['P0', 'P1', 'S3'], tasks: [mkTask('T-001', { ac: ['REQ-001.AC1'] }), mkTask('T-002', { ac: ['REQ-001.AC9'] })] });
  const e = env(p);
  try {
    await flowSpec(p.dir, p.store, p.config, P0_SPEC);
    await runFlowCommand('approve stage:P0', e.cmd);
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const initial = p.git('rev-parse', ref);
    const proposed = await flowSpecAmend(p.dir, p.store, { name: '唯一名称', content: P0_AMEND, reason: '名称要唯一且校验空值' });
    assert.match(proposed.text, /AC 新增：REQ-001\.AC2；修改：REQ-001\.AC1[\s\S]*T-001/);
    assert.equal(p.git('rev-parse', ref), initial);
    assert.equal(p.store.listAmends(p.flowId)[0]!.status, 'proposed');
    assert.match(renderStatus(p.store, p.config), /amend:A-001[\s\S]*AC 新增 1[\s\S]*T-001/);
    assert.match(statusText(p.store, e.engine, p.flowId), /amend:A-001[\s\S]*T-001/);
    await assert.rejects(flowSpecAmend(p.dir, p.store, { content: P0_AMEND, reason: '重复' }), /已有修订等待批准/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });
    assert.match(await runFlowCommand('approve', e.cmd), /有多个对象[\s\S]*stage:P1[\s\S]*amend:A-001[\s\S]*T-001/);
    assert.match(await runFlowCommand('reject "重做"', e.cmd), /有多个对象/);
    assert.match(turnContext(p.store, 3), /stage:P1、amend:A-001/);
    assert.match(await runFlowCommand('approve amend:A-001', e.cmd), /M7 实现/);
    const a = p.store.readAmend(p.flowId, 'A-001');
    assert.equal(a.status, 'approved');
    assert.equal(a.version, 2);
    assert.equal(p.git('show', `${ref}:${a.path}`), P0_AMEND);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    await assert.rejects(approveSpecAmend(p.dir, p.store, p.flowId, 'A-001'), /没有等待批准/);
    const followup = P0_AMEND.replace('返回唯一看板编号', '返回稳定唯一看板编号');
    await proposeSpecAmend(p.dir, p.store, p.flowId, { content: followup, reason: '保持编号稳定' });
    const beforeReject = p.git('rev-parse', ref);
    await assert.rejects(runFlowCommand('approve amend:A-999', e.cmd), /没有等待批准/);
    await runFlowCommand('reject amend:A-002 "先说明兼容行为"', e.cmd);
    assert.equal(p.store.readAmend(p.flowId, 'A-002').status, 'rejected');
    assert.equal(p.git('rev-parse', ref), beforeReject);
    assert.match(turnContext(new StateStore(p.dir), 3), /先说明兼容行为/);
    // 被打回记录不叠加进生效规格，编号也不复用。
    const next = await proposeSpecAmend(p.dir, p.store, p.flowId, { content: followup, reason: '已补充说明' });
    assert.equal(next.id, 'A-003');
    assert.deepEqual(next.diff.changed, ['REQ-001.AC1']);
    assert.ok((await p.store.verifyIntegrity()).ok);
  } finally { p.cleanup(); }
});
test('修订校验零写入；批准时发现规格/任务影响变化会拒绝，避免批准未经审阅的影响', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] }); const e = env(p);
  try {
    await flowSpec(p.dir, p.store, p.config, P0_SPEC); await runFlowCommand('approve', e.cmd);
    const state = p.store.readState();
    await assert.rejects(proposeSpecAmend(p.dir, p.store, p.flowId, { name: '../越界', content: P0_AMEND, reason: '变更' }), /名字/);
    await assert.rejects(proposeSpecAmend(p.dir, p.store, p.flowId, { content: P0_AMEND.replace('Given', ''), reason: '变更' }), /spec-lint 未通过/);
    assert.deepEqual(p.store.readState(), state);
    assert.deepEqual(p.store.listAmends(p.flowId), []);
    await proposeSpecAmend(p.dir, p.store, p.flowId, { content: P0_AMEND, reason: '变更' });
    await p.store.addTasks(p.flowId, [mkTask('T-009', { ac: ['REQ-001.AC1'] })], 'architect');
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const before = p.git('rev-parse', ref);
    await assert.rejects(approveSpecAmend(p.dir, p.store, p.flowId, 'A-001'), /影响清单已变化/);
    assert.equal(p.git('rev-parse', ref), before);
    assert.equal(p.store.readAmend(p.flowId, 'A-001').status, 'proposed');
  } finally { p.cleanup(); }
});
