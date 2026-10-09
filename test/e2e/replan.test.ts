// 来源：pi-flow test/e2e/replan.test.ts @ 31f3f15
// 第二轮 G 验收（第六轮起由主 agent 直接起草）：用户 /forge replan 或在对话里提出 → 主 agent 用 forge_revise_plan 提交 → 用户批准后程序增删任务；
// 进行中的任务不受影响；打回后主 agent 带着意见重新起草。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { makeEngine, ALL_FAKE } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { flowRevisePlan, statusText } from '../../src/tools/orchestrator-tools.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/forge.ts';
import { actionsNeeded } from '../../src/core/status-view.ts';
import { nextStep } from '../../src/core/context-injector.ts';
import { PKG_CONTENT } from '../helpers/package.ts';

const YAML = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');
const until = async (cond: () => boolean, ms = 60_000, tick?: () => Promise<unknown>) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('等待超时');
    await tick?.().catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
  }
};
const env = (p: Project, engine: ReturnType<typeof makeEngine>['engine'], talks: string[] = []): CommandEnv => ({
  root: p.dir, packageRoot: PKG_CONTENT, ui: null,
  engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
  roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: false,
  startConversation: (t) => { talks.push(t); },
});
async function implement(a: FakeAgent, file: string) {
  assert.ok((await a.call('forge_claim')).ok);
  assert.ok((await a.call('write', { path: file, content: 'x\n' })).ok, file);
  await a.call('forge_note', { text: '完成' });
  const r = await a.call('forge_submit', { summary: file });
  assert.ok(r.ok, r.text);
}
const impl = (title: string, writes: string, deps: { task: string; type: 'hard'; reason: string }[] = []) => ({ id: 'N-001', stage: 'S3', kind: 'impl' as const, title, role: 'backend-engineer', scopes: ['backend'], depends_on: deps,
  inputs: [], writes: [writes], acceptance: ['可导出'], verify: [] });
const IMPACT = '影响：导出模块；未开始的任务按下列调整';

test('执行中修订计划：/forge replan 交给主 agent，主 agent 直接提交修订，校验拒绝改动已开始的任务；用户批准后新增、调整依赖、取消；进行中的任务不受影响；打回后带着意见重做', async () => {
  const p = await setupProject({ yaml: YAML, tasks: [
    mkTask('T-001', { verify: [] }),
    mkTask('T-002', { verify: [], deps: [{ task: 'T-001', type: 'hard', reason: '需要 T-001' }] }),
    mkTask('T-003', { verify: [], deps: [{ task: 'T-001', type: 'hard', reason: '需要 T-001' }] }),
  ] });
  try {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const { engine, launcher, errors } = makeEngine(p, async (_role, _n, a) => {
      if (a.env.task === 'T-001') await hold;
      const w = p.store.readTask(p.flowId, a.env.task).writes[0]!;
      return implement(a, w.endsWith('/**') ? `${w.slice(0, -3)}/a.ts` : w);
    }, ALL_FAKE);
    const talks: string[] = [];
    const e = env(p, engine, talks);
    await engine.next(p.flowId);
    await until(() => p.store.readTask(p.flowId, 'T-001').status === 'in_progress');
    const lease = p.store.readTask(p.flowId, 'T-001').lease!.run_id;

    // 1. 用户提出修订：记下请求交给主 agent，不派子任务
    assert.match(await runFlowCommand('replan "漏了导出 CSV 的功能"', e), /交给主 agent 起草/);
    assert.match(talks.at(-1)!, /漏了导出 CSV/);
    assert.equal(p.store.listTasks(p.flowId).length, 3);
    const step = nextStep(p.store, 2);
    assert.equal(step.tool, 'forge_revise_plan');
    assert.match(step.next, /用户要求修订计划：漏了导出 CSV 的功能/);
    assert.match(statusText(p.store, engine, p.flowId), /修订请求[\s\S]*T-001 \[S3\/impl\/in_progress\]/);

    // 2. 主 agent 提交：已开始的任务不能取消；取消的任务还被依赖时拒绝；合法的保存为待批准，请求清除
    await assert.rejects(flowRevisePlan(p.dir, p.store, p.config, { impact: IMPACT, summary: '错误示例', cancel: [{ task: 'T-001', reason: '不要了' }] }), /T-001 当前是 in_progress/);
    await assert.rejects(flowRevisePlan(p.dir, p.store, p.config, { impact: IMPACT, summary: '错误示例', cancel: [{ task: 'T-003', reason: '合并进新任务' }],
      add: [impl('导出 CSV', 'src/server/export/**', [{ task: 'T-003', type: 'hard', reason: 'x' }])] }), /依赖被取消的 T-003/);
    const ok = await flowRevisePlan(p.dir, p.store, p.config, { impact: IMPACT, summary: '补上导出', add: [impl('导出 CSV', 'src/server/export/**', [{ task: 'T-001', type: 'hard', reason: '需要模型' }])],
      cancel: [{ task: 'T-003', reason: '与导出重复' }], rewire: [{ task: 'T-002', depends_on: [] }] });
    assert.match(ok.text, /等用户批准/);
    assert.equal(p.store.readFlow(p.flowId).replan_request, undefined);
    assert.equal(p.store.readRevision(p.flowId)?.reason, '漏了导出 CSV 的功能');

    // 3. 待批准：提示用户，主 agent 只能等待；agent 不能取消任务
    assert.ok(actionsNeeded(p.store, p.config).some((x) => /计划修订等待你批准/.test(x.text)));
    assert.match(nextStep(p.store, 2).next, /计划修订等待用户批准/);
    await assert.rejects(p.store.transitionTask(p.flowId, 'T-003', { to: 'cancelled', trigger: 'cancel', actor: 'run:r-x', facts: { reason: 'x' } }), /只有用户/);

    // 4. 用户批准
    const out = await runFlowCommand('approve', e);
    assert.match(out, /已批准计划修订[\s\S]*新增任务编号：N-001→T-004/);
    const tasks = () => Object.fromEntries(p.store.listTasks(p.flowId).map((t) => [t.id, t]));
    assert.equal(tasks()['T-003']!.status, 'cancelled');
    assert.deepEqual(tasks()['T-002']!.depends_on, []);
    assert.equal(tasks()['T-004']!.title, '导出 CSV');
    assert.deepEqual(tasks()['T-004']!.depends_on.map((d) => d.task), ['T-001']);
    assert.equal(tasks()['T-001']!.lease?.run_id, lease, '进行中的任务不受影响');

    // 5. 再提一次修订，用户打回后主 agent 带着意见重做
    await runFlowCommand('replan 再加一个导出格式', e);
    await flowRevisePlan(p.dir, p.store, p.config, { impact: IMPACT, summary: '再加导出格式', add: [impl('导出 PDF', 'src/server/pdf/**')] });
    assert.match(await runFlowCommand('replan 第三个', e), /已有一份计划修订等待批准/);
    assert.match(await runFlowCommand('reject 不要 PDF，改成 Excel', e), /主 agent 会带着你的意见重新起草/);
    assert.match(talks.at(-1)!, /打回了计划修订/);
    assert.match(nextStep(p.store, 2).next, /再加一个导出格式[\s\S]*被打回，意见：不要 PDF，改成 Excel/);
    await flowRevisePlan(p.dir, p.store, p.config, { impact: IMPACT, summary: '改成 Excel', add: [impl('导出 Excel', 'src/server/excel/**')] });
    assert.match(await runFlowCommand('approve', e), /新增任务编号：N-001→T-005/);
    assert.equal(tasks()['T-005']!.title, '导出 Excel');
    assert.ok(!launcher.launched.some((s) => s.env['PI_FORGE_ROLE'] === 'architect'), '修订不派子进程');

    // 6. 放行 T-001，流程跑完（被取消的任务视为已结束，闸门照常）
    release();
    for (let i = 0; i < 10 && p.store.readFlow(p.flowId).stage_status === 'active'; i++) {
      await engine.pump(p.flowId);
      await engine.next(p.flowId);
      await engine.idle();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(Object.values(tasks()).map((t) => `${t.id}:${t.status}`), ['T-001:done', 'T-002:done', 'T-003:cancelled', 'T-004:done', 'T-005:done']);
    assert.equal(p.store.readRevision(p.flowId)?.status, 'approved');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('修订待批准期间，被点名调整或取消的任务暂停派发；打回后恢复', async () => {
  const p = await setupProject({ yaml: YAML, tasks: [mkTask('T-001', { verify: [] }), mkTask('T-002', { verify: [], writes: ['src/server/t-002/**'] })] });
  try {
    const { engine } = makeEngine(p, async (role, _n, a) => {
      return implement(a, `src/server/${a.env.task.toLowerCase()}/a.ts`);
    }, ALL_FAKE);
    await engine.promote(p.flowId);
    await p.store.saveRevision(p.flowId, { task: 'T-001', reason: '测试', run: 'r-x', created_at: new Date().toISOString(), status: 'proposed',
      add: [], rewire: [{ task: 'T-002', depends_on: [] }], cancel: [{ task: 'T-001', reason: '不要了' }], summary: '取消 T-001' }, 'test');
    assert.deepEqual(await engine.next(p.flowId), []);
    await assert.rejects(engine.dispatch(p.flowId, 'T-001'), /待批准的计划修订中/);
    assert.notEqual(nextStep(p.store, 2).tool, 'forge_dispatch');
    await p.store.rejectRevision(p.flowId, '不改了');
    assert.deepEqual((await engine.next(p.flowId)).map((d) => d.task).sort(), ['T-001', 'T-002']);
    await engine.idle();
  } finally { p.cleanup(); }
});
