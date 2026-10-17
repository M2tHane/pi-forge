// 动态实施阶段的门禁：只运行已配置命令；失败按 task 生成 .fx-n，两轮后 needs_human；accept 放行后最终签收以 --no-ff 合入主分支。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { approveStage, rejectStage } from '../../src/core/stage/stages.ts';
import { nextStep } from '../../src/core/engine/context-injector.ts';
import { stageDef } from '../../src/core/stage/gates.ts';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { commandEnv } from '../helpers/commands.ts';


test('动态实施闸门：只运行已配置命令，两轮 .fx-n 后 needs_human；用户接受后最终签收以 --no-ff 合入主分支', async () => {
  const yaml = PROJECT_YAML.replace('commands:\n', 'commands:\n  gate_test: "echo src/server/t-001/a.ts; false"\n')
    .replace(/  auto: \[[^\n]*\]/, '  auto: [gate_test, not_configured]');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001')] });
  try {
    assert.deepEqual(stageDef(p.config, 'S3').gate.auto, ['gate_test']);
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
    // impl 一律审查，.fx-n 不审查
    assert.deepEqual(p.store.listTasks(p.flowId).sort((a, b) => a.id.localeCompare(b.id)).map((t) => [t.id, t.kind, t.status, t.for_task ?? null]), [['T-001', 'impl', 'done', null], ['T-001.fx-1', 'fix', 'done', 'T-001'], ['T-001.fx-2', 'fix', 'done', 'T-001'], ['T-001.rv', 'review', 'done', 'T-001']]);
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

test('S0 批准：架构产出合入 main，集成分支移到合入后的提交，之后的阶段在它上面继续；S0 一律人工签收', async () => {
  const p = await setupProject({ yaml: PROJECT_YAML.replace(/^  human: true/m, '  human: false'), stages: ['S0'] });
  // 计划已经落地（批准中途崩溃后重试的情形）：批准只合入主分支
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '第 1 批', exit: [] }]);
  await p.store.addTasks(p.flowId, [mkTask('T-001', { stage: 'S0' }), mkTask('T-002', { stage: 'S1', writes: ['src/server/t-002/**'] })], 'engine');
  try {
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      assert.ok((await a.call('write', { path: `src/server/${a.env.task.toLowerCase()}/a.ts`, content: a.env.task })).ok);
      await a.call('forge_note', { text: '完成' });
      assert.ok((await a.call('forge_submit', { summary: a.env.task })).ok);
    });
    for (let i = 0; i < 3; i++) { await engine.next(p.flowId); await engine.idle(); }
    assert.deepEqual(errors, []);
    const integ = p.store.readFlow(p.flowId).integration_branch;
    assert.deepEqual([p.store.readFlow(p.flowId).stage, p.store.readFlow(p.flowId).stage_status], ['S0', 'awaiting_human'], 'gate.human 为 false 时 S0 也等人工');
    assert.match(await approveStage({ root: p.dir, store: p.store, config: p.config }, p.flowId), /架构产出已合入 main/);
    assert.equal(p.git('show', 'main:src/server/t-001/a.ts'), 'T-001');
    assert.equal(p.git('rev-parse', integ), p.git('rev-parse', 'main'), '集成分支移到 main 的合入提交');
    for (let i = 0; i < 3; i++) { await engine.next(p.flowId); await engine.idle(); }
    assert.deepEqual(errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
    assert.equal(p.git('show', `${integ}:src/server/t-002/a.ts`), 'T-002');
    assert.ok(!p.git('ls-tree', '--name-only', 'main', 'src/server/').includes('t-002'), 'S1 的改动等交付时才进 main');
  } finally { p.cleanup(); }
});

test('用户打回已完成的实施阶段：不立刻重提门禁，主会话的下一步是把修改加进本阶段（后面阶段还有没开始的 task 也一样）；有新任务变化后照常验收', async () => {
  const p = await setupProject({ yaml: PROJECT_YAML, stages: ['S3', 'S4'], tasks: [mkTask('T-001'), mkTask('T-009', { stage: 'S4', writes: ['src/server/t-009/**'] })] });
  try {
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      assert.ok((await a.call('write', { path: `src/server/${a.env.task.toLowerCase()}/a.ts`, content: a.env.task })).ok);
      await a.call('forge_note', { text: '完成' });
      assert.ok((await a.call('forge_submit', { summary: a.env.task })).ok);
    });
    for (let i = 0; i < 3; i++) { await engine.next(p.flowId); await engine.idle(); }
    assert.deepEqual(errors, []);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(await rejectStage({ root: p.dir, store: p.store, config: p.config }, p.flowId, '仓库代码填小写会被拒绝'), /变更请求/);
    for (let i = 0; i < 2; i++) { await engine.pump(p.flowId); await engine.idle(); }
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active', '没有新变化前不重提门禁');
    const step = nextStep(p.store, 3, 0, p.config);
    assert.match(step.next, /用户打回了阶段 S3：仓库代码填小写会被拒绝[\s\S]*forge_change_request/);
    await p.store.addTasks(p.flowId, [mkTask('T-002', { writes: ['src/server/t-002/**'] })], 'engine');
    for (let i = 0; i < 3; i++) { await engine.next(p.flowId); await engine.idle(); }
    assert.deepEqual(errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
});

test('回归不在合并时拦下，而是在阶段门禁的全量 test 里发现，并按责任 task 建 .fx-n；修好后门禁通过', async () => {
  // 全量 test：src/server 里出现 REGRESSION 就失败，并列出文件（门禁按输出里的文件找责任 task）
  const yaml = PROJECT_YAML.replace(/  test:      ".*"/, `  test:      "if grep -rqs REGRESSION src/server; then grep -rl REGRESSION src/server; exit 1; fi"`).replace(/^  coverage: true/m, '  coverage: false');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: ['test'] }), mkTask('T-002', { verify: ['test'], writes: ['src/server/t-002/**'] })] });
  try {
    const { engine, errors } = makeEngine(p, async (_role, nth, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      const id = a.env.task;
      const bad = id === 'T-002' && nth === 1;
      assert.ok((await a.call('write', { path: `src/server/${id.slice(0, 5).toLowerCase()}/a.ts`, content: bad ? 'REGRESSION\n' : 'ok\n' })).ok);
      await a.call('forge_note', { text: '完成' });
      assert.ok((await a.call('forge_submit', { summary: id })).ok);
    });
    for (let i = 0; i < 4; i++) { await engine.next(p.flowId); await engine.idle(); }
    assert.deepEqual(errors, []);
    // 合并时没有拦下 T-002（合并不跑 test）：它直接 done
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
    assert.equal(p.store.readTask(p.flowId, 'T-002').merge_failures ?? 0, 0);
    // 门禁发现回归：责任 task 是 T-002（文件在它的 writes 里），建 T-002.fx-1，修好后门禁通过
    const fx = p.store.readTask(p.flowId, 'T-002.fx-1');
    assert.deepEqual([fx.kind, fx.status, fx.for_task], ['fix', 'done', 'T-002']);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.id === 'T-001.fx-1'), 'T-001 没有问题');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.equal(p.git('show', `${p.store.readFlow(p.flowId).integration_branch}:src/server/t-002/a.ts`), 'ok');
  } finally { p.cleanup(); }
});
