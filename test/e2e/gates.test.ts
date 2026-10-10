// 动态实施阶段的门禁（第 11 节）：只运行已配置命令；失败按 task 生成 .fx-n（第 11.1 节），两轮后 needs_human；accept 放行后最终签收以 --no-ff 合入主分支。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { approveStage } from '../../src/core/stages.ts';
import { stageDef } from '../../src/core/gates.ts';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { commandEnv } from '../helpers/commands.ts';


test('动态实施闸门：只运行已配置命令，两轮 .fx-n 后 needs_human；用户接受后最终签收以 --no-ff 合入主分支', async () => {
  const yaml = PROJECT_YAML.replace('commands:\n', 'commands:\n  gate_test: "echo src/server/t-001/a.ts; false"\n')
    .replace(/  auto: \[[^\n]*\]/, '  auto: [gate_test, not_configured]');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001')] });
  try {
    assert.deepEqual(stageDef(p.config, 'build', 'S3').gate.auto, ['gate_test']);
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content: `完成 ${a.env.task}` })).ok);
      await a.call('forge_note', { text: '修复完成' });
      const submit = await a.call('forge_submit', { summary: '提交' });
      assert.ok(submit.ok, submit.text);
    });
    for (let i = 0; i < 3; i++) { await engine.next(p.flowId); await engine.idle(); }
    assert.deepEqual(errors, []);
    const flow = p.store.readFlow(p.flowId);
    assert.equal(flow.stage_status, 'needs_human');
    assert.equal(flow.gate_rounds?.length, 2);
    assert.deepEqual(p.store.listTasks(p.flowId).sort((a, b) => a.id.localeCompare(b.id)).map((t) => [t.id, t.kind, t.status, t.for_task ?? null]), [['T-001', 'impl', 'done', null], ['T-001.fx-1', 'fix', 'done', 'T-001'], ['T-001.fx-2', 'fix', 'done', 'T-001']]);
    assert.ok(p.store.readEvents().some((e) => e.trigger === 'gate_exhausted'));
    const env = commandEnv(p, engine);
    await assert.rejects(runFlowCommand('accept S3', env), /--note/);
    assert.match(await runFlowCommand('accept S3 --note "保留门禁例外"', env), /仍需 \/forge-approve/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(await approveStage({ root: p.dir, store: p.store, config: p.config }, p.flowId), /已把.*合入 main/);
    assert.equal(p.store.readState().active_flow, null);
    assert.equal(p.git('rev-list', '--parents', '-n', '1', 'main').split(' ').length, 3, '最终提交有两个父提交');
    assert.equal(p.git('show', 'main:src/server/t-001/a.ts'), '完成 T-001.fx-2');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});
