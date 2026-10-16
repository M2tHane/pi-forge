// M6：阶段验收。fake-subagent 经真实的引擎、SubagentRuntime 与工具操作。
// 覆盖：覆盖率缺口生成 .fx-n；stage-qa 的 must 生成 fix 并走流水线；超出轮数进入 needs_human、accept 放行；
// 没有 worktree 的 stage-qa 用 forge_service 启动的服务运行在集成分支 HEAD 的临时 worktree 里，主工作区没有任何改动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { P0_SPEC } from '../helpers/spec.ts';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { worktreesRoot } from '../../src/core/workspace/worktree.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';
import { rejectStage } from '../../src/core/stage/stages.ts';

const REQS = P0_SPEC.requirements.replace('- AC1：Given 已登录 When 创建看板 Then 返回看板编号', '- AC1：Given 已登录 When 创建看板 Then 返回看板编号\n- AC2：Given 名称为空 When 创建看板 Then 返回 400');
const FILES = { ...Object.fromEntries(Object.entries({ ...P0_SPEC, requirements: REQS }).map(([k, v]) => [`docs/spec/${k}.md`, v])) };
// serve 把自己的工作目录写到测试指定的文件
const OUT = mkdtempSync(path.join(tmpdir(), 'pi-forge-serve-'));
const yamlWith = (qa: boolean) => (qa ? PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true') : PROJECT_YAML)
  .replace('acceptance: "true"', `acceptance: "true"\n  serve:     "pwd > ${OUT}/cwd; sleep 30"`);
const impl = mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1', 'REQ-001.AC2'], writes: ['src/server/t-001/**', 'tests/acceptance/T-001/**'] });
const must = { level: 'must' as const, basis: 'ac:REQ-001.AC2', files: ['src/server/t-001/a.ts'], location: 'create', problem: '名称为空时仍然创建成功', expected: '返回 400' };

async function project(qa: boolean, tasks = [impl]): Promise<Project> {
  const p = await setupProject({ yaml: yamlWith(qa), files: FILES, stages: ['S1'], tasks });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }]);
  return p;
}
const stageStatus = (p: Project) => p.store.readFlow(p.flowId).stage_status;
const AC1_TEST = "test('[REQ-001.AC1] 返回编号', () => {});\n";
const AC2_TEST = "test('[REQ-001.AC2] 名称为空返回 400', () => {});\n";

test('覆盖率缺口只报告：AC2 没有带编号的测试也不建补测任务，门禁照常通过，缺口写进 docs/qa/S1.md 与签收材料', async () => {
  const p = await project(false);
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    assert.equal(a.env.task, 'T-001');
    await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n', 'tests/acceptance/T-001/a.test.ts': AC1_TEST });
    return submitWork(a, '只覆盖了 AC1');
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.id.includes('.fx')), '不建补测任务');
    assert.equal(stageStatus(p), 'awaiting_human');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    assert.match(p.git('show', `${integ}:docs/qa/S1.md`), /REQ-001\.AC2/);
    assert.match(await runFlowCommand('report', e.cmd), /覆盖[\s\S]*REQ-001\.AC2/);
  } finally { p.cleanup(); }
});

test('stage-qa 的 must → T-001.fx-1（fork worker 会话、writes 含问题文件与自己的验收目录）走流水线合并 → S1.qa-2 只确认 → 签收', async () => {
  const p = await project(true);
  const seen: Record<string, string> = {};
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') { await writeFiles(a, { 'src/server/t-001/a.ts': 'v1\n', 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST }); return submitWork(a, '实现'); }
    if (id === 'T-001.fx-1') {
      assert.equal(role, 'worker');
      seen['fx'] = p.store.readHandoff(p.flowId, id);
      await writeFiles(a, { 'src/server/t-001/a.ts': 'v2 返回 400\n' });
      return submitWork(a, '修好');
    }
    assert.equal(role, 'stage-qa');
    if (id === 'S1.qa') { const r = await a.call('forge_qa_report', { verdict: 'changes', issues: [must] }); assert.ok(r.ok, r.text); return; }
    assert.equal(id, 'S1.qa-2');
    const extra = await a.call('forge_qa_report', { verdict: 'pass', issues: [] });
    assert.equal(extra.ok, false, '确认轮不能提新问题');
    const r = await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: true }] });
    assert.ok(r.ok, r.text);
  });
  try {
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    const fx = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual([fx.kind, fx.status, fx.for_task, fx.fork_from_task, fx.writes], ['fix', 'done', 'T-001', 'T-001', ['src/server/t-001/a.ts', 'tests/acceptance/T-001/**']]);
    assert.match(seen['fx']!, /名称为空时仍然创建成功/);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.id.startsWith('T-001.fx') && t.id.includes('.rv')), 'fix 不做逐任务审查');
    assert.equal(p.git('show', `${p.store.readFlow(p.flowId).integration_branch}:src/server/t-001/a.ts`), 'v2 返回 400');
    assert.equal(p.store.readTask(p.flowId, 'S1.qa-2').status, 'done');
    assert.equal(stageStatus(p), 'awaiting_human');
    assert.ok(!existsSync(path.join(worktreesRoot(p.dir), `${p.flowId}-S1.qa`)), 'stage-qa 的临时 worktree 已删除');
  } finally { p.cleanup(); }
});

test('stage-qa 超出 qa.max_rounds → needs_human；/forge accept S1 --note 放行进入签收', async () => {
  const p = await project(true);
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001' || id === 'T-001.fx-1') { await writeFiles(a, { 'src/server/t-001/a.ts': `${id}\n`, 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST }); return submitWork(a, id); }
    if (id === 'S1.qa') { await a.call('forge_qa_report', { verdict: 'changes', issues: [must] }); return; }
    await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: false, note: '仍然创建成功' }] });
  });
  try {
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    assert.equal(stageStatus(p), 'needs_human');
    assert.match(await runFlowCommand('status', e.cmd), /\/forge accept/);
    await assert.rejects(runFlowCommand('accept S1', e.cmd), /用法/);
    await runFlowCommand('accept S1 --note "已知问题，下个阶段处理"', e.cmd);
    assert.equal(stageStatus(p), 'awaiting_human');
    assert.ok(p.store.readEvents().some((ev) => ev.trigger === 'accept' && ev.data?.['entity'] === 'stage'));
  } finally { p.cleanup(); }
});

test('stage-qa 轮数用尽后用户打回、变更请求的 task 合入：开一轮只确认的 stage-qa 复验，而不是按旧结论直接交给用户；没有新改动时仍交给用户', async () => {
  const p = await project(true);
  const confirms: string[] = [];
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001' || id === 'T-001.fx-1') { await writeFiles(a, { 'src/server/t-001/a.ts': `${id}\n`, 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST }); return submitWork(a, id); }
    if (id === 'T-002') { await writeFiles(a, { 'src/server/t-002/a.ts': '名称为空返回 400\n' }); return submitWork(a, id); }
    if (id === 'S1.qa') { await a.call('forge_qa_report', { verdict: 'changes', issues: [must] }); return; }
    confirms.push(id);
    const fixed = p.store.listTasks(p.flowId).some((t) => t.id === 'T-002' && t.status === 'done');
    await a.call('forge_qa_confirm', { items: [{ id: 'R-1', resolved: fixed, note: fixed ? '已返回 400' : '仍然创建成功' }] });
  });
  try {
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    assert.equal(stageStatus(p), 'needs_human', '修复轮数用尽');
    await rejectStage({ root: p.dir, store: p.store, config: p.config }, p.flowId, '名称为空仍然创建成功');
    await p.store.addTasks(p.flowId, [mkTask('T-002', { stage: 'S1', writes: ['src/server/t-002/**'] })], 'engine');
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    assert.deepEqual(confirms, ['S1.qa-2', 'S1.qa-3'], '变更合入后复验一轮');
    assert.deepEqual(p.store.readTask(p.flowId, 'S1.qa-3').status, 'done');
    assert.equal(stageStatus(p), 'awaiting_human');
  } finally { p.cleanup(); }
});

test('stage-qa 没有自己的 worktree，forge_service 的服务运行在集成分支 HEAD 的临时 worktree，主工作区无进程无改动', async () => {
  const p = await project(true);
  const statusBefore = p.git('status', '--porcelain');
  let cwd = '';
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') { await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n', 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST }); return submitWork(a, '实现'); }
    const s = await a.call('forge_service', { action: 'start', name: 'serve' });
    assert.ok(s.ok, s.text);
    for (let i = 0; i < 50 && !cwd; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const f = path.join(OUT, 'cwd');
      if (existsSync(f)) cwd = readFileSync(f, 'utf8').trim();
    }
    await a.call('forge_service', { action: 'stop', name: 'serve' });
    // full 档 bash 也写不到主工作区：绝对路径参数与内联脚本里写死的路径都被拦下
    for (const command of [`touch ${p.dir}/qa-wrote.txt`, `node -e "require('fs').writeFileSync('${p.dir}/qa-wrote.txt','x')"`]) {
      const r = await a.call('bash', { command });
      assert.ok(!r.ok && /主工作区|工作区之外/.test(r.text), `应被拦下：${command}\n${r.text}`);
    }
    await a.call('forge_qa_report', { verdict: 'pass', issues: [] });
  });
  try {
    await drive(e, p.flowId, 30);
    assert.deepEqual(e.errors, []);
    assert.ok(cwd, '服务写下了工作目录');
    assert.notEqual(path.resolve(cwd), path.resolve(p.dir));
    assert.ok(cwd.includes(`${p.flowId}-S1.qa`), cwd);
    assert.equal(p.git('status', '--porcelain'), statusBefore, '主工作区没有改动');
    assert.ok(!existsSync(path.join(p.dir, 'qa-wrote.txt')));
    assert.equal(stageStatus(p), 'awaiting_human');
  } finally { p.cleanup(); rmSync(OUT, { recursive: true, force: true }); }
});
