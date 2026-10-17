// 架构阶段 S0：architect 由 fake-subagent 扮演，经真实的 SubagentRuntime（guard + forge_* 工具）提交；
// 提交时检查必需文件与 docs/plan.md → 审查 → 合并 → 门禁 → 等用户批准 → 合入主分支并按计划生成批次阶段与任务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject } from '../helpers/project.ts';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { nextStep } from '../../src/core/engine/context-injector.ts';
import { renderStatus } from '../../src/core/ops/status-view.ts';
import { statusText } from '../../src/tools/orchestrator-tools.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { engineEnv } from '../helpers/commands.ts';
import { ARCH_FILES } from '../helpers/arch.ts';

/** PRD 与原型在流程开始时已入库 */
const INPUTS = Object.fromEntries(Object.entries(ARCH_FILES).filter(([k]) => k.startsWith('docs/PRD') || k.startsWith('docs/prototype/')));
const OUTPUTS = Object.fromEntries(Object.entries(ARCH_FILES).filter(([k]) => !(k in INPUTS)));

async function writeAll(a: FakeAgent, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const r = await a.call('write', { path: rel, content });
    assert.ok(r.ok, `${rel}：${r.text}`);
  }
}

test('S0：缺必需文件时提交被退回 → 补齐后提交 → 审查、合并、门禁 → 批准页 → 批准后合入主分支并生成批次阶段与任务', async () => {
  const p = await setupProject({ stages: ['S0'], files: INPUTS });
  const submits: { ok: boolean; text: string }[] = [];
  let architectRuns = 0;
  const e = engineEnv(p, async (role, _nth, a) => {
    if (role === 'architect') {
      architectRuns++;
      await a.call('forge_claim');
      const { 'docs/arch/domains.md': _domains, ...partial } = OUTPUTS;
      await writeAll(a, { ...partial, 'rules/backend.md': '- 调用别的 domain 只经接口\n', 'tests/acceptance/S0-smoke/smoke.test.ts': '// 冒烟\n' });
      submits.push(await a.call('forge_submit', { summary: '架构' }));
      await writeAll(a, { 'docs/arch/domains.md': OUTPUTS['docs/arch/domains.md']! });
      await a.call('forge_note', { text: '架构已完成' });
      submits.push(await a.call('forge_submit', { summary: '架构' }));
      return;
    }
    if (role === 'backend' || role === 'frontend') { await a.call('forge_claim'); await a.call('forge_block', { reason: '测试到此为止' }); return; }
    throw new Error(`意外的角色 ${role}`);
  });
  try {
    await e.engine.pump(p.flowId);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    assert.equal(architectRuns, 1);
    assert.equal(submits[0]!.ok, false);
    assert.match(submits[0]!.text, /架构产出还不能提交（1 处）[\s\S]*- 缺少 docs\/arch\/domains\.md/);
    assert.equal(submits[1]!.ok, true, submits[1]!.text);
    assert.match(submits[1]!.text, /提醒[\s\S]*REQ-004/);
    const arch = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([arch.kind, arch.role, arch.stage, arch.status], ['impl', 'architect', 'S0', 'done']);
    assert.equal(p.store.readTask(p.flowId, 'T-001.rv').status, 'done', '架构产出经过审查');
    const flow = p.store.readFlow(p.flowId);
    assert.deepEqual([flow.stage, flow.stage_status], ['S0', 'awaiting_human']);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'qa'), '架构阶段不做浏览器验收');
    // 批准页：说明部分、风险与假设、提醒
    const step = nextStep(p.store, 3, 0, p.config);
    assert.equal(step.tool, 'none');
    assert.match(step.next, /\/forge-approve[\s\S]*2 个批次[\s\S]*## 风险与假设\n- 报表留到下一期[\s\S]*REQ-004/);
    assert.match(statusText(p.store, null, p.flowId), /docs\/plan\.md 的说明部分[\s\S]*Node \+ SQLite/);
    assert.match(renderStatus(p.store, p.config), /架构产出已通过检查，等你批准/);

    const out = await runFlowCommand('approve', e.cmd);
    assert.match(out, /已生成 2 个批次阶段（S1、S2）与 10 个 task[\s\S]*架构产出已合入 main[\s\S]*进入阶段 S1/);
    const after = p.store.readFlow(p.flowId);
    assert.deepEqual(after.stages, ['S0', 'S1', 'S2']);
    assert.deepEqual(after.s_stages!.map((s) => [s.id, s.goal, s.exit]), [['S1', 'B1 基础资料', ['REQ-001', 'REQ-002']], ['S2', 'B2 单据', ['REQ-003']]]);
    assert.equal(after.stage, 'S1');
    assert.equal(p.git('show', 'main:docs/plan.md'), OUTPUTS['docs/plan.md']!.trim(), '架构产出合入了主分支');
    assert.equal(p.git('show', 'main:rules/backend.md'), '- 调用别的 domain 只经接口');
    const titles = p.store.listTasks(p.flowId).filter((t) => t.stage !== 'S0').map((t) => `${t.id} ${t.stage} ${t.title}`);
    assert.deepEqual(titles, [
      'T-002 S1 后端 user', 'T-003 S1 后端 catalog', 'T-004 S1 后端 inventory', 'T-005 S1 前端基础', 'T-006 S1 页面 login', 'T-007 S1 页面 products', 'T-008 S1 接入真实接口（B1）',
      'T-009 S2 后端 purchase', 'T-010 S2 页面 purchase-orders', 'T-011 S2 接入真实接口（B2）',
    ]);
    assert.deepEqual(p.store.readTask(p.flowId, 'T-004').depends_on.map((d) => d.task), ['T-003']);
    assert.deepEqual(p.store.readTask(p.flowId, 'T-008').depends_on.map((d) => d.task), ['T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007']);
    assert.equal(p.store.readTask(p.flowId, 'T-007').fork_from_task, 'T-006');
    assert.equal(after.max_parallel_backend, 2, 'plan.md 的 max_parallel_backend 记在流程上');
    // 第 1 批开工：后端按 plan.md 的 max_parallel_backend=2 并行（user、catalog；inventory 等 catalog），前端只派前端基础
    await e.engine.idle();
    const launched = e.launcher.launched.filter((s) => ['backend', 'frontend'].includes(s.env['PI_FORGE_ROLE']!)).map((s) => `${s.env['PI_FORGE_TASK']} ${s.env['PI_FORGE_ROLE']}`);
    assert.deepEqual(launched.sort(), ['T-002 backend', 'T-003 backend', 'T-005 frontend']);
    assert.ok((await p.store.verifyIntegrity()).ok);
  } finally { p.cleanup(); }
});

test('S0 打回：新建 architect task 接着上一个的会话，意见写进 handoff；返工后再次等待批准', async () => {
  const p = await setupProject({ stages: ['S0'], files: INPUTS });
  let run = 0;
  const e = engineEnv(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    await a.call('forge_claim');
    run++;
    await writeAll(a, run === 1 ? OUTPUTS : { 'docs/arch/domains.md': '# domain\n- user、catalog、inventory、purchase（inventory 并入 catalog 之后）\n' });
    await a.call('forge_note', { text: `第 ${run} 次` });
    assert.ok((await a.call('forge_submit', { summary: '架构' })).ok);
  });
  try {
    await e.engine.pump(p.flowId);
    await e.engine.idle();
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(await runFlowCommand('reject "inventory 要等 catalog 做完"', e.cmd), /architect 接着原会话按意见返工/);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    const t2 = p.store.readTask(p.flowId, 'T-002');
    assert.deepEqual([t2.kind, t2.role, t2.stage, t2.fork_from_task, t2.status], ['impl', 'architect', 'S0', 'T-001', 'done']);
    assert.match(p.store.readHandoff(p.flowId, 'T-002'), /需要返工[\s\S]*用户打回：inventory 要等 catalog 做完/);
    assert.ok(p.store.readEvents().some((ev) => ev.type === 'stage_reopened'));
    assert.equal(p.store.readFlow(p.flowId).plan_rework, undefined);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
});
