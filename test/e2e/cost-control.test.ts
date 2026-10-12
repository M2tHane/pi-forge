// 改编自 pi-flow test/e2e/cost-control.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
// 第二轮 H、I 验收：失败后升级模型；关键底座；流程预算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { actionsNeeded } from '../../src/core/ops/status-view.ts';
import { nextStep } from '../../src/core/engine/context-injector.ts';
import { commandEnv } from '../helpers/commands.ts';

const MODELS = (yaml: string) => yaml
  .replace(/  test:      ".*"/, '  test:      "! grep -rqs FAIL src/server"')
  // 偏离 117：合并只跑 merge_check，用它让 T-001 前两次提交的合并验证失败
  .replace(/(  acceptance_list: .*\n)/, '$1  merge_check: "! grep -rqs FAIL src/server"\n')
  // 此用例显式把 worker 起始模型降为 medium，验证失败升级与关键底座机制。
  .replace('worker:            { model: strong', 'worker:            { model: medium')
  .replace(/models:[\s\S]*?\ntesting:/, 'models:\n  strong: "f/strong"\n  medium: "f/medium"\n  cheap:  "f/cheap"\ntesting:');
const SETTINGS = { version: 1 as const, roles: {} };
const env = (p: Parameters<typeof commandEnv>[0], engine: Parameters<typeof commandEnv>[1]) => commandEnv(p, engine, { roleSettings: () => SETTINGS });
async function implement(a: FakeAgent, file: string, content = 'x\n') {
  assert.ok((await a.call('forge_claim')).ok);
  assert.ok((await a.call('write', { path: file, content })).ok, file);
  await a.call('forge_note', { text: '完成' });
  const r = await a.call('forge_submit', { summary: file });
  assert.ok(r.ok, r.text);
}

test('失败后升级模型：第 2 次失败后的派发使用升级模型并记录；超预算暂停派发新任务、提示用户，提高预算后继续', async () => {
  const p = await setupProject({ yaml: MODELS(PROJECT_YAML).replace(/max_merge_failures: \d+/, 'max_merge_failures: 3'), tasks: [mkTask('T-001', { verify: ['test'] }),
    mkTask('T-002', { verify: [], writes: ['src/server/t-002/**'], deps: [{ task: 'T-001', type: 'hard', reason: '需要 T-001' }] })] });
  try {
    const { engine, errors } = makeEngine(p, async (_role, nth, a) =>
      // T-001 前两次提交的代码让合并时的 merge_check 失败
      implement(a, `src/server/${a.env.task.toLowerCase()}/a.ts`, a.env.task === 'T-001' && nth <= 2 ? 'FAIL\n' : 'x\n'), SETTINGS);
    // 预算：只够 T-001 的几次运行
    await p.store.setFlowBudget(p.flowId, { tokens: 2200 });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const impl = p.store.listRuns().filter((r) => r.task === 'T-001' && r.role === 'worker');
    assert.deepEqual(impl.map((r) => [r.model, !!r.escalated]), [['f/medium', false], ['f/medium', false], ['f/strong', true]]);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(await runFlowCommand('status --cost', env(p, engine)), /## 按角色[\s\S]*worker：\d+ 次运行[^\n]*平均 [\d.]+ 轮/);

    // 超预算：不再派发新任务；提示用户；orchestrator 只能报告
    assert.deepEqual(await engine.next(p.flowId), []);
    assert.ok(actionsNeeded(p.store, p.config).some((x) => /已超出：暂停派发新任务/.test(x.text)));
    assert.match(nextStep(p.store, 2, 0, p.config).next, /预算已用完/);
    await assert.rejects(engine.dispatch(p.flowId, 'T-002'), /预算已用完/);
    assert.match(await runFlowCommand('status --cost', env(p, engine)), /预算：token [\d,]+ \/ 2,200，已用 \d+%，已超出/);
    // 提高预算后继续
    assert.match(await runFlowCommand('budget tokens 1000000', env(p, engine)), /已派发：T-002/);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
  } finally { p.cleanup(); }
});

test('关键底座：被至少 3 个任务硬依赖的实施任务第一次就用升级模型；普通任务照常；可关闭', async () => {
  const deps = ['T-002', 'T-003', 'T-004'].map((id) => mkTask(id, { verify: [], writes: [`src/server/${id.toLowerCase()}/**`], deps: [{ task: 'T-001', type: 'hard', reason: '需要底座' }] }));
  for (const [yaml, expected] of [[MODELS(PROJECT_YAML), 'f/strong'], [MODELS(PROJECT_YAML).replace(/critical_fanout: 3\b/, 'critical_fanout: 0'), 'f/medium']] as const) {
    const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: [] }), ...deps] });
    try {
      const { engine, launcher } = makeEngine(p, async (_role, _n, a) => implement(a, `src/server/${a.env.task.toLowerCase()}/a.ts`), SETTINGS);
      await engine.next(p.flowId);
      await engine.idle();
      const first = launcher.launched.find((s) => s.env['PI_FORGE_TASK'] === 'T-001' && s.env['PI_FORGE_ROLE'] === 'worker')!;
      assert.equal(first.model, expected);
      assert.equal(!!p.store.listRuns().find((r) => r.task === 'T-001' && r.role === 'worker')!.escalated, expected === 'f/strong');
      await engine.next(p.flowId);
      await engine.idle();
      assert.equal(launcher.launched.find((s) => s.env['PI_FORGE_TASK'] === 'T-002' && s.env['PI_FORGE_ROLE'] === 'worker')!.model, 'f/medium', '普通任务照常');
    } finally { p.cleanup(); }
  }
});
