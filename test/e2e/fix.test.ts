// M7：/forge-fix（第 13.4 节）。fake-subagent 经真实的引擎、SubagentRuntime 与工具操作。
// worker 定位并修复（含回归测试）→ 合并时全量测试 → 直接合入主分支 → stage-qa 只读复现确认 → 修复日志（含成本）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { runFlowFix, runFlowCommand } from '../../src/commands/forge.ts';
import { engineEnv, submitWork } from '../helpers/commands.ts';
const YAML = PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true');

async function settle(e: ReturnType<typeof engineEnv>, fixId: string) {
  for (let i = 0; i < 15; i++) { await e.engine.pump(fixId); await e.engine.idle(); }
}

test('/forge-fix：worker 修复 → 合入主分支 → stage-qa 第一轮有 must → .fx-1 → X1.qa-2 确认 → 修复日志含成本', async () => {
  const p = await setupProject({ yaml: YAML });
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') return submitWork(a, '修好并加回归测试', { 'src/server/t-001/a.ts': 'ok\n', 'test/regression.test.ts': 'regression\n' });
    if (id === 'T-001.fx-1') { assert.equal(role, 'worker'); return submitWork(a, '补修', { 'src/server/t-001/a.ts': 'ok v2\n' }); }
    assert.equal(role, 'stage-qa');
    if (id === 'X1.qa') {
      const r = await a.call('forge_qa_report', { verdict: 'changes', issues: [{ level: 'must', basis: 'ac:修复：问题不再出现', files: ['src/server/t-001/a.ts'], location: 'a', problem: '空输入仍崩溃', expected: '返回错误' }] });
      assert.ok(r.ok, r.text);
      return;
    }
    const r = await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: true }] });
    assert.ok(r.ok, r.text);
  });
  try {
    // 没有进行中的 build 流程时才可以；setupProject 建了一个 build 流程，先中止
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const msg = await runFlowFix('"登录后看板列表为空"', e.cmd);
    assert.match(msg, /已创建修复 X-/);
    const fix = p.store.openFixFlow() ?? p.store.listFlows().map((id) => p.store.readFlow(id)).find((f) => f.mode === 'fix')!;
    await settle(e, fix.id);
    assert.deepEqual(e.errors, []);
    assert.equal(p.git('show', 'main:src/server/t-001/a.ts'), 'ok v2', '直接合入主分支');
    assert.equal(p.store.readTask(fix.id, 'X1.qa-2').status, 'done');
    const status = await runFlowCommand('status', e.cmd);
    assert.match(status, /修复日志|成本/);
  } finally { p.cleanup(); }
});

test('/forge-fix：同时只允许一个修复；build 流程运行中拒绝', async () => {
  const p = await setupProject({ yaml: YAML });
  const e = engineEnv(p, async (_r, _n, a) => { await a.call('forge_claim'); await a.call('forge_block', { reason: '停' }); });
  try {
    assert.equal(p.store.readState().active_flow, p.flowId, 'setupProject 建的 build 流程是活动流程');
    await assert.rejects(runFlowFix('"x"', e.cmd), /不能同时修复|正在阶段/);
  } finally { p.cleanup(); }
});
