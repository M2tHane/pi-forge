// 偏离 110–112（lean 变轻）：lean 且 test_author 关闭时，所有 impl 的验收测试写进一个共享目录 tests/acceptance/suite/，没有 .at；
// 一个测试名可带多个 AC 编号；含单元测试写权限且没写 unit_tests 理由的 lean 计划被拒。
// architect 与 worker 由 fake-subagent 扮演，经真实的 SubagentRuntime（guard + forge_* 工具）、预检、合并队列与阶段验收。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { CONTRACTS, P1_SPEC, PLAN_YAML } from '../helpers/contracts.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/forge.ts';
import { flowSpec } from '../../src/tools/orchestrator-tools.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { drive, engineEnv, submitWork } from '../helpers/commands.ts';

const LEAN_PLAN = PLAN_YAML.replace('mode: standard', 'mode: lean');
const OUT = mkdtempSync(path.join(tmpdir(), 'pi-forge-lean-light-'));
const LOG = path.join(OUT, 'acc.log');
// 审查者运行的 acceptance 命令是 `node tests/acc.js -- suite/<文件>`：记下参数
// 运行时夹具显式写了 test_author: true；去掉它，沿用模板默认（偏离 118：关闭）
// （审查者的 bash 是 allowlist，sh 属于脚本解释器会被拒，所以用 node 脚本）
const YAML = PROJECT_YAML.replace(/^  test_author: true.*\n/m, '').replace(/^  test: .*$/m, '  test: "true"').replace('acceptance: "true"', 'acceptance: "node tests/acc.js"');
const FILES = { 'tests/acc.js': `require('node:fs').appendFileSync(${JSON.stringify(LOG)}, process.argv.slice(2).join(' ') + '\\n');\n` };

async function writeAll(a: FakeAgent, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const r = await a.call('write', { path: rel, content });
    assert.ok(r.ok, `${rel}：${r.text}`);
  }
}
async function writeDesign(a: FakeAgent) {
  await writeAll(a, {
    ...Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [`docs/contracts/${k}`, v])),
    'docs/arch/overview.md': '# 架构\nNode + React。\n',
    'docs/rules-draft/commands.yaml': 'commands:\n  test: "true"\n',
    'AGENTS.md': '# 开发说明\n',
  });
}
async function toP1(p: Project, cmd: CommandEnv) {
  await flowSpec(p.dir, p.store, p.config, P1_SPEC);
  await runFlowCommand('approve stage:P0', cmd);
}

const HELPERS = "export const api = (path) => path;\n";
const S0_TEST = "import { api } from './_helpers.js';\ntest('[REQ-002.AC1] 成员看到自己所在的团队', () => api('/api/teams'));\n";
const S1_TEST = "import { api } from './_helpers.js';\ntest('[REQ-001.AC1][REQ-001.AC2] 负责人创建数据源，同名再建被拒', () => api('/api/datasources'));\n";

test('lean + test_author 关闭：计划批准后两个阶段的 impl 都写共享目录 suite，审查者只跑本 task 的场景文件 acceptance -- suite/<文件>，覆盖率通过，没有 .at', async () => {
  const p = await setupProject({ yaml: YAML, files: FILES, stages: ['P0', 'P1'] });
  const seen: string[] = [];
  const e = engineEnv(p, async (role, _n, a) => {
    if (role === 'architect') {
      await a.call('forge_claim');
      await writeDesign(a);
      await writeAll(a, { 'docs/plan/plan.yaml': LEAN_PLAN });
      assert.ok((await a.call('forge_propose_plan', {})).ok);
      await a.call('forge_note', { text: '契约与计划已完成' });
      assert.ok((await a.call('forge_submit', { summary: '契约与计划' })).ok);
      return;
    }
    await a.call('forge_claim');
    const id = a.env.task;
    if (role === 'reviewer') {
      // 偏离 117：预检不跑命令，审查者按任务说明运行本 task 的验收测试（lean 共享目录只含本 task 新增或修改的场景文件）
      if (/^T-\d+\.rv$/.test(id)) {
        const m = /`(node tests\/acc\.js -- [^`]+)`/.exec(a.spec.prompt);
        assert.ok(m, a.spec.prompt);
        const ran = await a.call('bash', { command: m![1]! });
        assert.ok(ran.ok, ran.text);
        // 只放行 test 与 acceptance 两条命令：别的命令仍被拒
        assert.equal((await a.call('bash', { command: 'touch x.txt' })).ok, false);
      }
      const r = await a.call('forge_review_report', { verdict: 'pass', issues: [] });
      assert.ok(r.ok, r.text);
      return;
    }
    assert.equal(role, 'worker');
    seen.push(id);
    const t = p.store.readTask(p.flowId, id);
    assert.ok(t.writes.includes('tests/acceptance/suite/**'), t.writes.join());
    assert.ok(!t.writes.some((w) => /tests\/acceptance\/(?:_support\/)?T-\d+/.test(w)), '没有按 task 的验收目录');
    // 别的 task 风格的目录写不进去
    assert.equal((await a.call('write', { path: `tests/acceptance/${id}/x.test.js`, content: S0_TEST })).ok, false);
    if (id === 'T-002') {
      return submitWork(a, '骨架与团队列表', { 'server/src/team/a.js': 'ok\n', 'tests/acceptance/suite/_helpers.js': HELPERS, 'tests/acceptance/suite/team.test.js': S0_TEST });
    }
    assert.equal(id, 'T-003');
    // 上一个阶段的共享辅助函数已经合进来，直接复用；不能写 tests/unit（writes 之外）
    assert.ok(existsSync(path.join(t.worktree!, 'tests/acceptance/suite/_helpers.js')), 'S0 的 _helpers.js 在共享目录里');
    assert.equal((await a.call('write', { path: 'tests/unit/ds.test.js', content: 'x\n' })).ok, false);
    return submitWork(a, '数据源管理', { 'server/src/datasource/a.js': 'ok\n', 'tests/acceptance/suite/datasource.test.js': S1_TEST });
  });
  try {
    await toP1(p, e.cmd);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    const out = await runFlowCommand('approve', e.cmd);
    assert.match(out, /已生成 2 个 S 阶段（S0、S1，精简模式）与 2 个 task/);
    assert.equal(p.store.readFlow(p.flowId).plan_mode, 'lean');
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'acctest'), '计划批准后没有 .at');
    for (const id of ['T-002', 'T-003']) assert.ok(p.store.readTask(p.flowId, id).writes.includes('tests/acceptance/suite/**'), id);

    await drive(e, p.flowId, 30);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
    assert.equal(p.store.readFlow(p.flowId).stage, 'S0');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    await runFlowCommand('approve', e.cmd);
    await drive(e, p.flowId, 30);
    assert.deepEqual(e.errors, []);
    assert.deepEqual(seen.filter((x) => x.startsWith('T-')), ['T-002', 'T-003']);
    assert.equal(p.store.readTask(p.flowId, 'T-003').status, 'done', p.store.readTask(p.flowId, 'T-003').blocked_reason ?? undefined);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'acctest'), '全程没有 .at / .at-n');
    // 审查者对本 task 的场景文件运行 acceptance（不是整个 suite，也不是 T-xxx 目录）
    assert.ok(existsSync(LOG), '审查者运行了 acceptance');
    const acc = readFileSync(LOG, 'utf8');
    assert.match(acc, /-- suite\/team\.test\.js\n/);
    assert.match(acc, /-- suite\/datasource\.test\.js\n/);
    assert.doesNotMatch(acc, /-- T-|-- suite\n/);
    // 覆盖率：一个测试名带两个 AC 编号，都算覆盖
    const flow = p.store.readFlow(p.flowId);
    assert.equal(flow.stage, 'S1');
    assert.equal(flow.stage_status, 'awaiting_human');
    const qa = p.git('show', `${flow.integration_branch}:docs/qa/S1.md`);
    assert.match(qa, /缺口：无（2 条 AC 均有验收测试）/);
    assert.match(qa, /REQ-001\.AC1[\s\S]*tests\/acceptance\/suite\/datasource\.test\.js/);
    assert.match(qa, /REQ-001\.AC2[\s\S]*tests\/acceptance\/suite\/datasource\.test\.js/);
    // 辅助函数只有一份
    const files = p.git('ls-tree', '-r', '--name-only', flow.integration_branch, '--', 'tests/acceptance/').split('\n').filter(Boolean);
    assert.deepEqual(files.filter((f) => /helpers/.test(f)), ['tests/acceptance/suite/_helpers.js']);
  } finally { p.cleanup(); }
});

test('lean 计划：写了 tests/unit 写权限又没有 unit_tests 理由 → forge_propose_plan 被拒；写上理由后通过，impl 带单元测试路径', async () => {
  const p = await setupProject({ yaml: YAML, files: FILES, stages: ['P0', 'P1'] });
  const results: { ok: boolean; text: string }[] = [];
  const withUnit = LEAN_PLAN.replace('writes: [server/src/datasource/**, web/src/pages/datasource/**]', 'writes: [server/src/datasource/**, web/src/pages/datasource/**, tests/unit/datasource/**]');
  assert.notEqual(withUnit, LEAN_PLAN);
  const e = engineEnv(p, async (role, _n, a) => {
    if (role !== 'architect') return;
    await a.call('forge_claim');
    await writeDesign(a);
    await writeAll(a, { 'docs/plan/plan.yaml': withUnit });
    results.push(await a.call('forge_propose_plan', {}));
    await writeAll(a, { 'docs/plan/plan.yaml': withUnit.replace('    shared: [server/src/routes.ts]', '    shared: [server/src/routes.ts]\n    unit_tests: 权限矩阵：四种角色对增删改查的组合') });
    results.push(await a.call('forge_propose_plan', {}));
    await a.call('forge_note', { text: '契约与计划已完成' });
    assert.ok((await a.call('forge_submit', { summary: '契约与计划' })).ok);
  });
  try {
    await toP1(p, e.cmd);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.text, /T-003 的 writes tests\/unit\/datasource\/\*\* 是测试路径：精简模式（lean）不写单元测试[\s\S]*unit_tests: "<是哪类复杂逻辑>"/);
    assert.equal(results[1]!.ok, true, results[1]!.text);
    await runFlowCommand('approve', e.cmd);
    const t3 = p.store.readTask(p.flowId, 'T-003');
    assert.ok(t3.writes.includes('tests/unit/datasource/**') && t3.writes.includes('tests/acceptance/suite/**'), t3.writes.join());
    assert.ok(!p.store.readTask(p.flowId, 'T-002').writes.includes('tests/unit/datasource/**'));
  } finally { p.cleanup(); }
});
