// P0 提交、闸门、人工打回。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { P0_SPEC } from '../helpers/spec.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/forge.ts';
import { flowSpec } from '../../src/tools/orchestrator-tools.ts';
import { submitSpec, readSpec } from '../../src/core/spec/spec-flow.ts';
import { commitFilesToBranch, importInputs } from '../../src/core/spec/intake.ts';
import { runStageGate } from '../../src/core/stage/gates.ts';
import { turnContext, nextStep } from '../../src/core/engine/context-injector.ts';
import { renderStatus } from '../../src/core/ops/status-view.ts';
import { StateStore } from '../../src/core/state/state-store.ts';
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
test('P0 不合格规格不写集成分支（保存为草稿）；只重交改动的那份，其余沿用上一次提交；合格规格独立索引提交，打回带意见，批准后进入 P1 并派发 architect', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] });
  const e = env(p);
  try {
    writeFileSync(path.join(p.dir, 'prd.md'), 'PRD 原文');
    await importInputs(p.dir, p.store, p.flowId, { prd: 'prd.md' });
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const state = p.store.readState();
    const flow = p.store.readFlow(p.flowId);
    const sha = p.git('rev-parse', ref);
    // 分次交：先只交 requirements，存为草稿、提示还差的；状态不变、集成分支不动
    assert.match((await flowSpec(p.dir, p.store, p.config, { requirements: P0_SPEC.requirements.replace('[MVP]', '') })).text, /已保存 requirements，还差 permissions、glossary/);
    assert.equal(p.store.readState().active_flow, state.active_flow);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active');
    assert.equal(p.git('rev-parse', ref), sha);
    // 交齐剩下的（requirements 沿用刚才的草稿，里面缺了优先级）：spec-lint 不通过
    await assert.rejects(flowSpec(p.dir, p.store, p.config, { screens: P0_SPEC.screens, permissions: P0_SPEC.permissions, glossary: P0_SPEC.glossary }), /spec-lint 未通过[\s\S]*\[MVP\]、\[LATER\] 或 \[NO\][\s\S]*只需重交/);
    assert.match(p.store.readEvents().at(-1)!.reason ?? '', /未通过 spec-lint/);
    assert.deepEqual(p.store.readFlow(p.flowId), flow);
    assert.equal(p.git('rev-parse', ref), sha);
    assert.equal(p.git('ls-tree', '-r', '--name-only', ref, '--', 'docs/spec/requirements.md'), '');
    writeFileSync(path.join(p.dir, 'staged.md'), '用户的暂存内容');
    p.git('add', 'staged.md');
    const index = p.git('diff', '--cached');
    // 只重交改好的 requirements：其余三份沿用上一次提交
    assert.match((await flowSpec(p.dir, p.store, p.config, { requirements: P0_SPEC.requirements })).text, /screens、permissions、glossary 沿用上一次提交[\s\S]*等待用户 \/forge-approve/);
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
    await flowSpec(p.dir, p.store, p.config, { requirements: P0_SPEC.requirements.replace('返回看板编号', '返回唯一看板编号') });
    assert.match(readSpec(p.dir, ref).files.requirements, /返回唯一看板编号/);
    assert.match(await runFlowCommand('approve', e.cmd), /进入阶段 P1/);
    assert.deepEqual([p.store.readFlow(p.flowId).stage, p.store.readFlow(p.flowId).stage_status], ['P1', 'active']);
    await e.engine.idle();
    assert.equal(e.launched(), 1);
    assert.equal(p.store.readTask(p.flowId, 'T-001').role, 'architect');
    // architect 的阻塞先交给主会话决定
    assert.equal(nextStep(p.store, 3).tool, 'forge_decide');
    assert.match(nextStep(p.store, 3).next, /等你决定：T-001/);
    assert.deepEqual(readSpec(p.dir, ref).files.screens, P0_SPEC.screens);
    await assert.rejects(submitSpec(p.dir, p.store, p.flowId, P0_SPEC), /只能在/);
    assert.ok((await p.store.verifyIntegrity()).ok);
  } finally { p.cleanup(); }
});
test('P0 闸门重读集成分支：本地文件不能掩盖不合格或缺失规格，失败回 active；恢复处理 awaiting_gate', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] });
  const e = env(p);
  try {
    await submitSpec(p.dir, p.store, p.flowId, P0_SPEC);
    assert.match(turnContext(p.store, 3), /重读集成分支/);
    commitFilesToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, [{ rel: 'docs/spec/requirements.md', content: P0_SPEC.requirements.replace('[MVP]', '') }], '模拟提交后的规格变化');
    const r = await runStageGate(p.dir, p.store, p.config, p.flowId);
    assert.equal(r.passed, false);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active');
    assert.match(p.store.readFlow(p.flowId).spec!.feedback!, /\[MVP\]/);
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
