// M3：P1 契约与计划。architect 由 fake-subagent 扮演，经真实的 SubagentRuntime（guard + forge_* 工具）提交。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, type Project } from '../helpers/project.ts';
import { commitToBranch } from '../helpers/engine.ts';
import type { MergeHooks } from '../../src/core/engine/merge-queue.ts';
import { CONTRACTS, P1_SPEC, PLAN_YAML } from '../helpers/contracts.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/forge.ts';
import { nextStep, turnContext } from '../../src/core/engine/context-injector.ts';
import { renderStatus } from '../../src/core/ops/status-view.ts';
import { flowSpec, statusText } from '../../src/tools/orchestrator-tools.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { engineEnv } from '../helpers/commands.ts';

const COMMANDS_DRAFT = 'commands:\n  test: "true"\n  contract_lint: "true"\nshared_env:\n  deps: ["node_modules", "web/node_modules"]\n';
const GLOSSARY_ADD = '\n**连接测试（ConnectionTest）**：\n检查数据源能否连上。\n';

async function writeAll(a: FakeAgent, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const r = await a.call('write', { path: rel, content });
    assert.ok(r.ok, `${rel}：${r.text}`);
  }
}
/** architect 的完整产出（不含 plan.yaml） */
async function writeDesign(a: FakeAgent) {
  await writeAll(a, {
    ...Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [`docs/contracts/${k}`, v])),
    'docs/arch/overview.md': '# 架构\nNode + React。\n',
    'commands.yaml': COMMANDS_DRAFT,
    'AGENTS.md': '# 开发说明\n',
  });
  const glossary = (await a.call('read', { path: 'docs/spec/glossary.md' })).text;
  await writeAll(a, { 'docs/spec/glossary.md': glossary + GLOSSARY_ADD });
}


async function toP1(p: Project, cmd: CommandEnv) {
  await flowSpec(p.dir, p.store, p.config, P1_SPEC);
  await runFlowCommand('approve stage:P0', cmd);
}

test('P1：architect 提交错误计划被拒 → 改正后通过 → 预检、合并、闸门 → 批准生成 S 阶段与 task，规则与命令应用，契约锁定，进入 S0', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] });
  const results: { tool: string; ok: boolean; text: string }[] = [];
  let architectRuns = 0; // 第 1 次是 P1 的 doc task，第 2 次是 S0 的 impl
  const e = engineEnv(p, async (role, nth, a) => {
    if (role === 'architect' && ++architectRuns === 1) {
      await a.call('forge_claim');
      await writeDesign(a);
      // S0 的 task 依赖 S1 才产出的表：调度不了，被拒
      await writeAll(a, { 'docs/plan/plan.yaml': PLAN_YAML.replace('    requires: []', '    requires: [table:datasources]') });
      results.push({ tool: 'forge_propose_plan', ...(await a.call('forge_propose_plan', {})) });
      await writeAll(a, { 'docs/plan/plan.yaml': PLAN_YAML });
      results.push({ tool: 'forge_propose_plan', ...(await a.call('forge_propose_plan', {
        assumptions: [{ question: '数据源名称是否区分大小写', decision: '不区分' }],
        extras: [{ what: '密码加密存储', why: '数据源配置含数据库密码' }],
      })) });
      await a.call('forge_note', { text: '契约与计划已完成' });
      results.push({ tool: 'forge_submit', ...(await a.call('forge_submit', { summary: '契约与计划' })) });
      return;
    }
    // S0 的 architect（第二次派发）：这里只确认被派发，然后交给用户
    if (role === 'architect') {
      await a.call('forge_claim'); await a.call('forge_block', { reason: '测试到此为止' });
      return;
    }
    throw new Error(`意外的角色 ${role}#${nth}`);
  });
  try {
    await toP1(p, e.cmd);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    // 第一次 propose：依赖更晚阶段；第二次通过并给出报告；提交成功
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.text, /T-002（S0）需要的 table:datasources 由更晚阶段的 T-003（S1）产出/);
    assert.equal(results[1]!.ok, true, results[1]!.text);
    assert.match(results[1]!.text, /S0（1 个 task）[\s\S]*关键路径 2/);
    assert.equal(results[2]!.ok, true, results[2]!.text);
    const arch = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([arch.kind, arch.role, arch.stage, arch.status], ['doc', 'architect', 'P1', 'done']);
    assert.match(e.launcher.launched[0]!.prompt ?? JSON.stringify(e.launcher.launched[0]), /worker 使用的模型：fake\/model[\s\S]*从 T-002 起/);
    const flow = p.store.readFlow(p.flowId);
    assert.deepEqual([flow.stage, flow.stage_status], ['P1', 'awaiting_human']);
    // 主会话与状态视图：计划报告、assumptions、extras
    const ctx = turnContext(p.store, 3, 0, p.config);
    assert.match(ctx, /stage:P1[\s\S]*数据源名称是否区分大小写 → 不区分[\s\S]*密码加密存储/);
    assert.equal(nextStep(p.store, 3).tool, 'none');
    assert.match(renderStatus(p.store, p.config), /计划：已提交提案/);
    assert.match(statusText(p.store, null, p.flowId), /assumptions[\s\S]*extras/);

    const before = p.git('rev-parse', 'main');
    const integrationHead = p.git('rev-parse', p.store.readFlow(p.flowId).integration_branch);
    const out = await runFlowCommand('approve', e.cmd);
    assert.doesNotMatch(out, /合入/, 'P1 批准不会合入主分支');
    assert.match(out, /已生成 2 个 S 阶段（S0、S1）与 2 个 task[\s\S]*契约已锁定[\s\S]*进入阶段 S0/);
    const after = p.store.readFlow(p.flowId);
    assert.deepEqual(after.stages, ['P0', 'P1', 'S0', 'S1']);
    assert.deepEqual(after.s_stages!.map((s) => [s.id, s.exit]), [['S0', ['REQ-002']], ['S1', ['REQ-001']]]);
    assert.equal(after.contracts_base, integrationHead, '契约锁定在批准时集成分支的提交上');
    assert.equal(after.stage, 'S0');
    assert.ok(p.store.readEvents().some((ev) => ev.type === 'stages_planned'));
    // task：S0 的 impl 归 architect；依赖由符号推导；S0 多两个验收目录
    const t2 = p.store.readTask(p.flowId, 'T-002');
    const t3 = p.store.readTask(p.flowId, 'T-003');
    assert.deepEqual([t2.kind, t2.role, t2.stage, t2.module], ['impl', 'architect', 'S0', 'team']);
    assert.ok(t2.writes.includes('tests/acceptance/_support/**') && t2.writes.includes('tests/acceptance/S0-smoke/**') && t2.writes.includes('rules/**'));
    assert.deepEqual(t3.depends_on, [{ task: 'T-002', type: 'hard', reason: 'table:teams、api:GET /api/teams、fn:team#currentTeam' }]);
    assert.deepEqual(t3.ac, ['REQ-001.AC1', 'REQ-001.AC2']);
    // 没有 .at：worker 自己写验收测试，writes 带自己的验收目录
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.id.endsWith('.at')));
    assert.ok(t3.writes.includes('tests/acceptance/T-003/**'));
    const notes = p.store.readNotes(`flows/${p.flowId}/notes/T-003.json`)!;
    assert.match(notes.goal.join('\n'), /REQ-001\.AC2：Given 已有同名数据源 When 再次创建 Then 失败[\s\S]*manual/);
    // 运行中的配置换成集成分支上的 commands.yaml；主分支不动（规则由 S0 直接写）
    assert.equal(p.git('rev-parse', 'main'), before);
    assert.equal(p.config.commands['contract_lint'], 'true');
    assert.deepEqual(p.config.sharedEnv?.deps, ['node_modules', 'web/node_modules']);
    // S0 开工：由 architect 执行（S0 由架构师搭骨架），提示里注入了按 layers 选择的 rules/backend.md
    await e.engine.idle();
    const worker = e.launcher.launched.find((s) => s.env['PI_FORGE_TASK'] === 'T-002')!;
    assert.ok(worker, '进入 S0 后派发了 S0 的 task');
    assert.equal(worker.env['PI_FORGE_ROLE'], 'architect');
    assert.equal(worker.env['PI_FORGE_TASK'], 'T-002');
    assert.ok((await p.store.verifyIntegrity()).ok);
  } finally { p.cleanup(); }
});

test('P1 预检：没有 propose、或 propose 之后又改了 plan.yaml，预检失败退回 architect 并写进 handoff；改正后通过', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] });
  let run = 0;
  const e = engineEnv(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    const claim = await a.call('forge_claim');
    if (++run === 1) {
      await writeDesign(a);
      await writeAll(a, { 'docs/plan/plan.yaml': PLAN_YAML });
      assert.ok((await a.call('forge_propose_plan', {})).ok);
      // 提案之后又改了计划（未重新提交提案）
      await writeAll(a, { 'docs/plan/plan.yaml': PLAN_YAML.replace('骨架与团队列表', '骨架') });
    } else {
      assert.match(claim.text, /P1 预检未通过[\s\S]*plan\.yaml 在 forge_propose_plan 之后又改过/);
      assert.ok((await a.call('forge_propose_plan', {})).ok);
    }
    await a.call('forge_note', { text: `第 ${run} 次` });
    assert.ok((await a.call('forge_submit', { summary: '契约与计划' })).ok);
  });
  try {
    await toP1(p, e.cmd);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done');
    assert.equal(t.precheck_failures, 1);
    assert.equal(t.attempts, 0, '预检失败不计入运行失败');
    assert.equal(e.launcher.launched.length, 2);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
});

test('P1 打回：新建 architect task 接着上一个的会话，意见写进 handoff；主会话等待；返工后再次等待批准', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] });
  let run = 0;
  const e = engineEnv(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    await a.call('forge_claim');
    if (++run === 1) { await writeDesign(a); await writeAll(a, { 'docs/plan/plan.yaml': PLAN_YAML }); }
    // 返工 task 占用了 T-002：计划编号顺延（handoff 里写明从 T-003 起）
    else await writeAll(a, { 'docs/plan/plan.yaml': PLAN_YAML.replaceAll('T-003', 'T-004').replaceAll('T-002', 'T-003') });
    assert.ok((await a.call('forge_propose_plan', {})).ok);
    await a.call('forge_note', { text: `第 ${run} 次` });
    assert.ok((await a.call('forge_submit', { summary: '契约与计划' })).ok);
  });
  try {
    await toP1(p, e.cmd);
    await e.engine.idle();
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(await runFlowCommand('reject stage:P1 "数据源要放到 S0"', e.cmd), /architect 按意见返工/);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    const t2 = p.store.readTask(p.flowId, 'T-002');
    assert.deepEqual([t2.kind, t2.role, t2.stage, t2.fork_from_task, t2.status], ['doc', 'architect', 'P1', 'T-001', 'done']);
    assert.match(p.store.readHandoff(p.flowId, 'T-002'), /从 T-003 起[\s\S]*需要返工[\s\S]*用户打回：数据源要放到 S0/);
    assert.ok(p.store.readEvents().some((ev) => ev.type === 'stage_reopened'));
    assert.equal(p.store.readFlow(p.flowId).plan_rework, undefined);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
});

test('P1 闸门：集成分支上的契约不合格时回到 active，派 architect 返工并把原因写进 handoff', async () => {
  const p = await setupProject({ stages: ['P0', 'P1'] });
  let broken = false;
  // 合并之后、闸门之前，别的提交弄坏了集成分支上的契约
  const hooks: MergeHooks = { afterMerge: async (root) => {
    if (broken) return;
    broken = true;
    commitToBranch(root, p.store.readFlow(p.flowId).integration_branch, { 'docs/contracts/errors/team.yaml': 'BAD: [unclosed\n' }, '外部改动');
  } };
  let run = 0;
  const e = engineEnv(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    await a.call('forge_claim');
    if (++run === 1) {
      await writeDesign(a);
      await writeAll(a, { 'docs/plan/plan.yaml': PLAN_YAML });
      assert.ok((await a.call('forge_propose_plan', {})).ok);
      await a.call('forge_note', { text: '完成' });
      assert.ok((await a.call('forge_submit', { summary: '契约与计划' })).ok);
    } else {
      await a.call('forge_block', { reason: '返工已开始，测试到此为止' });
    }
  }, hooks);
  try {
    await toP1(p, e.cmd);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    assert.ok(broken);
    assert.equal(e.launcher.launched.length, 2, '闸门失败后派了返工的 architect');
    const t2 = p.store.readTask(p.flowId, 'T-002');
    assert.deepEqual([t2.role, t2.fork_from_task], ['architect', 'T-001']);
    assert.match(p.store.readHandoff(p.flowId, 'T-002'), /P1 闸门未通过[\s\S]*errors\/team\.yaml：不是合法的 YAML/);
    assert.equal(p.store.readFlow(p.flowId).stage, 'P1');
  } finally { p.cleanup(); }
});
