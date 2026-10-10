// M7 验收：进行中的 worker 发起变更请求 → 程序派 architect 起草修订（forge_propose_plan）→ 合并 → /forge-approve change:C-001
// → 任务图、S 阶段与 .at-n 在一个事务里正确更新。fake-subagent 经真实的引擎、SubagentRuntime 与工具操作。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { makeEngine, type RoleScript } from '../helpers/engine.ts';
import { CONTRACTS, P1_SPEC, PLAN_YAML } from '../helpers/contracts.ts';
import { deriveTasks, checkPlan, parsePlan } from '../../src/core/plan.ts';
import { parseContracts } from '../../src/core/contract-check.ts';
import { effectiveSpec } from '../../src/core/spec.ts';
import { flowRel, taskRel } from '../../src/core/state-store.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/forge.ts';
import type { PlanFile } from '../../src/core/schemas.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
const ROOT = path.join(import.meta.dirname, '../..');

const SPEC_FILES = Object.fromEntries(Object.entries(P1_SPEC).map(([k, v]) => [`docs/spec/${k}.md`, v]));
const CONTRACT_FILES = Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [`docs/contracts/${k}`, v]));

function force(p: Project, rel: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', rel);
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}

/** 已批准计划、进入 S1 的流程：T-002 已完成，其余照计划 */
async function project() {
  const p = await setupProject({ yaml: PROJECT_YAML, stages: ['P1'], files: { ...SPEC_FILES, ...CONTRACT_FILES, 'docs/plan/plan.yaml': PLAN_YAML } });
  const plan = parsePlan(PLAN_YAML).plan!;
  const check = checkPlan(plan, { catalog: parseContracts(CONTRACTS).catalog, spec: effectiveSpec(P1_SPEC, []), existingTaskIds: [], mode: 'build', limits: { max_parallel: 4, max_task_files: 12, lean_below_loc: 6000 } });
  assert.deepEqual(check.errors, []);
  const tasks = deriveTasks(plan, check.deps, { worker: p.config.role('worker').scopes, testAuthor: p.config.role('test-author').scopes }, { acctest: true, verify: ['test'] });
  force(p, flowRel(p.flowId), { approvals: { P0: { by: 'human', at: new Date().toISOString() }, P1: { by: 'human', at: new Date().toISOString() } } });
  await p.store.setStages(p.flowId, plan.stages, 'standard');
  await p.store.addTasks(p.flowId, tasks.map((t) => ({ ...t, review: 'skip' as const })), 'engine');
  force(p, flowRel(p.flowId), { stage: 'S1', stages: ['P0', 'P1', ...plan.stages.map((s) => s.id)], stage_status: 'active', contracts_base: p.git('rev-parse', 'HEAD') });
  for (const id of ['T-001', 'T-001.at', 'T-002', 'T-002.at']) force(p, taskRel(p.flowId, id), { status: 'done' });
  return { p, plan };
}

/** 修订：T-003（未开始）改标题；新增阶段 S2 与 T-005；T-006 修改已完成的 T-002 */
function revisedPlan(plan: PlanFile): string {
  const r = structuredClone(plan);
  r.tasks.find((t) => t.id === 'T-003')!.title = '数据源管理（含 SSL）';
  r.stages.push({ id: 'S2', goal: '导出', exit: ['REQ-003'] });
  r.tasks.push(
    { id: 'T-005', stage: 'S2', module: 'export', title: '导出数据源', size: 'S', layers: ['backend'], ac: ['REQ-003.AC1'], writes: ['server/src/export/**'], produces: [], requires: [], test_interface: ['HTTP /api/export'] },
    { id: 'T-006', stage: 'S1', module: 'team', title: '团队列表：增加成员数', size: 'S', layers: ['backend'], ac: ['REQ-002.AC1'], writes: ['server/src/team/count/**'], produces: [], requires: [], test_interface: [], modifies: 'T-002' },
  );
  return stringify(r);
}

function env(p: Project, scripts: RoleScript) {
  const m = makeEngine(p, scripts);
  const cmd: CommandEnv = { root: p.dir, packageRoot: ROOT, ui: null, engine: () => ({ store: p.store, engine: m.engine, config: p.config }), store: () => p.store,
    roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true };
  return { ...m, cmd };
}

test('变更请求：worker 发起 → architect 起草并提交修订 → 合并 → 批准后任务图、S 阶段与 .at-n 正确更新；等待批准期间被调整的 task 不派发', async () => {
  const { p, plan } = await project();
  const text = revisedPlan(plan);
  const results: Record<string, { ok: boolean; text: string }> = {};
  const e = env(p, async (role, _n, a: FakeAgent) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (role === 'architect') {
      assert.match(p.store.readHandoff(p.flowId, id), /加 SSL 选项与导出/);
      assert.ok((await a.call('write', { path: 'docs/plan/plan.yaml', content: text })).ok);
      results['propose'] = await a.call('forge_propose_plan', { assumptions: [{ question: '导出格式', decision: 'CSV' }], extras: [] });
      await a.call('forge_note', { text: '修订完成' });
      results['submit'] = await a.call('forge_submit', { summary: '修订计划' });
      return;
    }
    if (id === 'T-004' && !results['request']) {
      results['request'] = await a.call('forge_change_request', { what: '加 SSL 选项与导出', why: 'REQ-003 需要导出', impact: 'T-003 与 T-002' });
      await a.call('forge_block', { reason: '等变更请求' });
      return;
    }
    await a.call('forge_block', { reason: '测试到此为止' });
  });
  try {
    for (let i = 0; i < 12; i++) { await e.engine.next(p.flowId); await e.engine.idle(); }
    assert.ok(results['request']?.ok, results['request']?.text);
    assert.ok(results['propose']?.ok, results['propose']?.text);
    assert.match(results['propose']!.text, /新增 task T-005（S2）[\s\S]*为 T-002 新增修改 task T-006/);
    assert.equal(p.store.readChange(p.flowId, 'C-001').status, 'proposed');
    assert.ok(!e.launcher.launched.some((s) => s.env['PI_FORGE_TASK'] === 'T-003'), '等待批准期间被调整的 T-003 不派发');
    assert.match(await runFlowCommand('approve change:C-001', e.cmd), /已批准 change:C-001/);
    const tasks = new Map(p.store.listTasks(p.flowId).map((t) => [t.id, t]));
    assert.equal(tasks.get('T-003')!.title, '数据源管理（含 SSL）');
    assert.deepEqual(['T-005', 'T-005.at', 'T-006', 'T-002.at-2'].map((id) => tasks.has(id)), [true, true, true, true]);
    assert.deepEqual(tasks.get('T-006')!.depends_on.map((d) => [d.task, d.type]), [['T-002', 'hard']]);
    assert.equal(tasks.get('T-002.at-2')!.acctest_round?.kind, 'change');
    const flow = p.store.readFlow(p.flowId);
    assert.deepEqual(flow.s_stages!.map((s) => s.id), [...plan.stages.map((s) => s.id), 'S2']);
    assert.ok(flow.stages.includes('S2'));
    assert.ok(p.store.readEvents().some((ev) => ev.type === 'stages_revised'));
  } finally { p.cleanup(); }
});
