// 批次验收：S0 批准后按计划进入第 1 批；stage-qa 的 must 按归属建修复（页面问题归页面任务，跨 domain 的交给 architect）→
// 修复合入后只确认的一轮 → 等待签收 → 签收后进入第 2 批 → 最后一批签收后合入主分支。页面任务的审查材料带原型与 page-api.md 里这一页。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { runFlowCommand } from '../../src/commands/forge.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';
import { ARCH_FILES } from '../helpers/arch.ts';

const INPUTS = Object.fromEntries(Object.entries(ARCH_FILES).filter(([k]) => k.startsWith('docs/PRD') || k.startsWith('docs/prototype/')));
const OUTPUTS = Object.fromEntries(Object.entries(ARCH_FILES).filter(([k]) => !(k in INPUTS)));
const yaml = PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true');

/** 每个任务写的文件：domain 在 src/server/<domain>/，页面在 src/web/pages/<page>.ts */
const FILE: Record<string, string> = {
  'T-002': 'src/server/user/index.ts', 'T-003': 'src/server/catalog/index.ts', 'T-004': 'src/server/inventory/index.ts',
  'T-005': 'src/web/app.ts', 'T-006': 'src/web/pages/login.ts', 'T-007': 'src/web/pages/products.ts', 'T-008': 'src/web/api.ts',
  'T-009': 'src/server/purchase/index.ts', 'T-010': 'src/web/pages/purchase-orders.ts', 'T-011': 'src/web/api-b2.ts',
};
const mustOf = (basis: string, files: string[], problem: string) => ({ level: 'must' as const, basis, files, location: '', problem, expected: '修好' });

test('批次验收：must 按归属建修复（页面归页面任务、跨 domain 归 architect）→ 复验 → 签收 → 第 2 批 → 最后一批签收后合入主分支', async () => {
  const p = await setupProject({ yaml, stages: ['S0'], files: INPUTS });
  const qaRuns: string[] = [];
  const handoffs: Record<string, string> = {};
  const e = engineEnv(p, async (role, _nth, a: FakeAgent) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (role === 'architect' && id === 'T-001') { await writeFiles(a, OUTPUTS); return submitWork(a, '架构'); }
    if (id.includes('.fx-')) {
      handoffs[id] = p.store.readHandoff(p.flowId, id);
      const t = p.store.readTask(p.flowId, id);
      return submitWork(a, `修复 ${id}`, Object.fromEntries(t.writes.filter((w) => !w.includes('*')).map((f) => [f, `// 已修复（${id}）\n`])));
    }
    if (role === 'backend' || role === 'frontend') return submitWork(a, `${id} 完成`, { [FILE[id]!]: `export const id = '${id}';\n` });
    if (role === 'stage-qa') {
      qaRuns.push(id);
      if (id === 'S1.qa') {
        const r = await a.call('forge_qa_report', { verdict: 'changes', issues: [
          mustOf('ac:REQ-001.AC1', ['src/web/pages/login.ts'], '登录按钮点了没反应，控制台报 TypeError'),
          mustOf('ac:REQ-002.AC1', ['src/server/user/index.ts', 'src/server/catalog/index.ts'], '新建商品返回 500：catalog 调 user 的接口参数对不上'),
        ] });
        assert.ok(r.ok, r.text);
        return;
      }
      if (id === 'S1.qa-2') { const r = await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: true }, { id: 'R-2', resolved: true }] }); assert.ok(r.ok, r.text); return; }
      const r = await a.call('forge_qa_report', { verdict: 'pass', issues: [] });
      assert.ok(r.ok, r.text);
      return;
    }
    if (role === 'reviewer') {
      handoffs[id] = p.store.readHandoff(p.flowId, id);
      await a.call('forge_review_report', { verdict: 'pass', issues: [] });
      return;
    }
    throw new Error(`意外的任务 ${id}（${role}）`);
  });
  const flow = () => p.store.readFlow(p.flowId);
  try {
    await e.engine.pump(p.flowId);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    assert.deepEqual([flow().stage, flow().stage_status], ['S0', 'awaiting_human']);
    assert.match(await runFlowCommand('approve', e.cmd), /进入阶段 S1/);

    await drive(e, p.flowId, 60);
    assert.deepEqual(e.errors, []);
    assert.deepEqual(qaRuns, ['S1.qa', 'S1.qa-2']);
    // 页面任务的审查材料：原型路径与 page-api.md 里这一页
    assert.match(handoffs['T-006.rv']!, /## 页面「login」的审查材料[\s\S]*原型：docs\/prototype\/login\.html[\s\S]*- login：POST \/api\/login/);
    assert.doesNotMatch(handoffs['T-002.rv']!, /审查材料/);
    // 一条问题只交给一个任务：页面问题归页面任务（接着它的会话），跨 domain 的整条交给 architect
    const fixes = p.store.listTasks(p.flowId).filter((t) => t.kind === 'fix').map((t) => [t.id, t.role, t.for_task, t.fork_from_task, t.status]);
    assert.deepEqual(fixes, [['T-001.fx-1', 'architect', 'T-001', 'T-001', 'done'], ['T-006.fx-1', 'frontend', 'T-006', 'T-006', 'done']]);
    assert.match(handoffs['T-001.fx-1']!, /交给你（架构师）修[\s\S]*catalog 调 user 的接口参数对不上/);
    assert.doesNotMatch(handoffs['T-001.fx-1']!, /登录按钮/);
    assert.match(handoffs['T-006.fx-1']!, /登录按钮点了没反应/);
    const integ = flow().integration_branch;
    assert.match(p.git('show', `${integ}:src/web/pages/login.ts`), /已修复（T-006\.fx-1）/);
    assert.match(p.git('show', `${integ}:src/server/catalog/index.ts`), /已修复（T-001\.fx-1）/);
    assert.deepEqual([flow().stage, flow().stage_status], ['S1', 'awaiting_human'], '复验通过后等待签收');

    assert.match(await runFlowCommand('approve', e.cmd), /S2/);
    assert.equal(flow().stage, 'S2');
    await drive(e, p.flowId, 60);
    assert.deepEqual(e.errors, []);
    assert.deepEqual(qaRuns, ['S1.qa', 'S1.qa-2', 'S2.qa']);
    assert.deepEqual([flow().stage, flow().stage_status], ['S2', 'awaiting_human']);
    assert.match(handoffs['T-010.rv']!, /原型：docs\/prototype\/purchase-orders\.html[\s\S]*没找到这一页的部分/);

    assert.match(await runFlowCommand('approve', e.cmd), /将把 .* 合入 main，流程随之结束[\s\S]*--yes/);
    assert.match(await runFlowCommand('approve --yes', e.cmd), /已把.*合入 main/);
    assert.equal(p.store.readState().active_flow, null);
    for (const f of ['src/web/pages/login.ts', 'src/server/purchase/index.ts', 'src/web/pages/purchase-orders.ts']) assert.ok(p.git('show', `main:${f}`), f);
    assert.match(p.git('show', 'main:src/server/catalog/index.ts'), /已修复/);
  } finally { p.cleanup(); }
});
