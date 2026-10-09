// 来源：pi-flow test/e2e/finish.test.ts @ 31f3f15
// 第六轮 7.2、A1：最后一个阶段闸门通过后显示"完成（待合入）"，程序生成收尾汇报，主会话照此告诉用户。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { nextStep } from '../../src/core/context-injector.ts';
import { actionsNeeded, statusLine } from '../../src/core/status-view.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/forge.ts';
import { PKG_CONTENT } from '../helpers/package.ts';

test('收尾：全部完成后状态栏显示"完成（待合入）"，主会话拿到收尾汇报，/forge report 可查看', async () => {
  const yaml = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: [] }), mkTask('T-002', { verify: [] })] });
  try {
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      await a.call('forge_claim');
      await a.call('write', { path: `src/server/${a.env.task.toLowerCase()}/a.ts`, content: 'ok\n' });
      await a.call('forge_note', { text: '完成' });
      await a.call('forge_submit', { summary: '完成' });
    });
    await p.store.transitionTask(p.flowId, 'T-002', { to: 'cancelled', trigger: 'cancel', actor: 'human', facts: { reason: '不要了' } });
    for (let i = 0; i < 5 && p.store.readFlow(p.flowId).stage_status === 'active'; i++) {
      await engine.next(p.flowId);
      await engine.idle();
      await engine.pump(p.flowId);
    }
    assert.deepEqual(errors, []);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(statusLine(p.store, p.config) ?? '', /B-001 完成（待合入）.*等你批准合入/);
    assert.ok(actionsNeeded(p.store, p.config).some((a) => /全部模块已完成，等你批准合入主分支/.test(a.text)));
    const step = nextStep(p.store, 2);
    assert.match(step.next, /照下面的收尾汇报向用户说明/);
    assert.match(step.next, /## 模块（1 个）\n- T-001「任务 T-001」：已合入集成分支[^\n]*运行 1 次/);
    assert.match(step.next, /取消的任务：T-002/);
    assert.match(step.next, /## 用时与用量\n- 用时 \d+ 分钟/);
    const env: CommandEnv = { root: p.dir, packageRoot: PKG_CONTENT, ui: null,
      engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
      roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: false };
    assert.match(await runFlowCommand('report', env), /# B-001「演示」收尾汇报[\s\S]*各阶段进行中（分钟）：S3 [\d.]+/);
    // 耗时分布（A1）
    const timing = await runFlowCommand('status --timing', env);
    assert.match(timing, /# B-001 耗时分布[\s\S]*- S3：[\d.]+ \/ [\d.]+ \/ [\d.]+[\s\S]*- backend-engineer：1 次，[\d.]+ 分钟（提交 1）[\s\S]*排队等合并 [\d.]+，合并与验证 [\d.]+[\s\S]*T-001「任务 T-001」：1 次/);
    const json = JSON.parse(await runFlowCommand('status --timing --json', env)) as { flow: string; roles: { role: string; runs: number }[] };
    assert.equal(json.flow, 'B-001');
    assert.deepEqual(json.roles.map((r) => [r.role, r.runs]), [['backend-engineer', 1]]);
  } finally { p.cleanup(); }
});
