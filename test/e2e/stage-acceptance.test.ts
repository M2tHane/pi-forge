// M6：阶段验收（第 11 节）与精简模式的阶段审查（第 7.6 节）。fake-subagent 经真实的引擎、SubagentRuntime 与工具操作。
// 覆盖：覆盖率缺口生成 .at-n；stage-qa 的 must 生成 fix 并走流水线；超出轮数进入 needs_human、accept 放行；
// 没有 worktree 的 stage-qa 用 forge_service 启动的服务运行在集成分支 HEAD 的临时 worktree 里，主工作区没有任何改动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { hard, mkTask } from '../helpers/tasks.ts';
import { P0_SPEC } from '../helpers/spec.ts';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { worktreesRoot } from '../../src/core/worktree.ts';
import { sessionDirOf } from '../../src/core/session-log.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';

const REQS = P0_SPEC.requirements.replace('- AC1：Given 已登录 When 创建看板 Then 返回看板编号', '- AC1：Given 已登录 When 创建看板 Then 返回看板编号\n- AC2：Given 名称为空 When 创建看板 Then 返回 400');
const FILES = { ...Object.fromEntries(Object.entries({ ...P0_SPEC, requirements: REQS }).map(([k, v]) => [`docs/spec/${k}.md`, v])) };
// serve 把自己的工作目录写到测试指定的文件
const OUT = mkdtempSync(path.join(tmpdir(), 'pi-forge-serve-'));
const yamlWith = (qa: boolean) => (qa ? PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true') : PROJECT_YAML)
  .replace('acceptance_list: "true"', `acceptance_list: "true"\n  serve:     "pwd > ${OUT}/cwd; sleep 30"`);
const impl = mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1', 'REQ-001.AC2'] });
const at = mkTask('T-001.at', { stage: 'S1', kind: 'acctest', role: 'test-author', scopes: ['acctest'], for_task: 'T-001', verify: [], ac: ['REQ-001.AC1', 'REQ-001.AC2'],
  depends_on: [], writes: ['tests/acceptance/T-001/**', 'tests/acceptance/_support/T-001/**'] });
const must = { level: 'must' as const, basis: 'ac:REQ-001.AC2', files: ['src/server/t-001/a.ts'], location: 'create', problem: '名称为空时仍然创建成功', expected: '返回 400' };

async function project(qa: boolean, tasks = [impl, at]): Promise<Project> {
  const p = await setupProject({ yaml: yamlWith(qa), files: FILES, stages: ['S1'], tasks });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  return p;
}
const stageStatus = (p: Project) => p.store.readFlow(p.flowId).stage_status;
const AC1_TEST = "test('[REQ-001.AC1] 返回编号', () => {});\n";
const AC2_TEST = "test('[REQ-001.AC2] 名称为空返回 400', () => {});\n";

test('覆盖率缺口：AC2 没有带编号的测试 → 为 T-001 建 .at-2（coverage），补齐后门禁通过、docs/qa/S1.md 写入集成分支', async () => {
  // .at 提交时只检查它自己的 ac；它只分到了 AC1，AC2 的缺口要到阶段门禁的覆盖率检查才发现
  const p = await project(false, [impl, { ...at, ac: ['REQ-001.AC1'] }]);
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (role === 'worker') { await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' }); return submitWork(a, '实现'); }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': AC1_TEST }); return submitWork(a, '只覆盖了 AC1'); }
    assert.equal(id, 'T-001.at-2');
    assert.match(p.store.readHandoff(p.flowId, id), /补充 AC 的测试[\s\S]*REQ-001\.AC2/);
    await writeFiles(a, { 'tests/acceptance/T-001/b.test.ts': AC2_TEST });
    return submitWork(a, '补上 AC2');
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    const at2 = p.store.readTask(p.flowId, 'T-001.at-2');
    assert.deepEqual([at2.status, at2.acctest_round?.kind], ['done', 'coverage']);
    assert.equal(stageStatus(p), 'awaiting_human');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const md = p.git('show', `${integ}:docs/qa/S1.md`);
    assert.match(md, /REQ-001\.AC2[\s\S]*tests\/acceptance\/T-001\/b\.test\.ts/);
    assert.match(await runFlowCommand('report', e.cmd), /覆盖率/);
  } finally { p.cleanup(); }
});

test('stage-qa 的 must → T-001.fx-1（fork worker 会话、writes 只含问题文件）走流水线合并 → S1.qa-2 只确认 → 签收', async () => {
  const p = await project(true);
  const seen: Record<string, string> = {};
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') { await writeFiles(a, { 'src/server/t-001/a.ts': 'v1\n' }); return submitWork(a, '实现'); }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST }); return submitWork(a, 'AC1、AC2'); }
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
    assert.deepEqual([fx.kind, fx.status, fx.for_task, fx.fork_from_task, fx.writes], ['fix', 'done', 'T-001', 'T-001', ['src/server/t-001/a.ts']]);
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
    if (id === 'T-001' || id === 'T-001.fx-1') { await writeFiles(a, { 'src/server/t-001/a.ts': `${id}\n` }); return submitWork(a, id); }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST }); return submitWork(a, 'AC'); }
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

test('第 14 节：stage-qa 没有自己的 worktree，forge_service 的服务运行在集成分支 HEAD 的临时 worktree，主工作区无进程无改动', async () => {
  const p = await project(true);
  const statusBefore = p.git('status', '--porcelain');
  let cwd = '';
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') { await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' }); return submitWork(a, '实现'); }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST }); return submitWork(a, 'AC'); }
    const s = await a.call('forge_service', { action: 'start', name: 'serve' });
    assert.ok(s.ok, s.text);
    for (let i = 0; i < 50 && !cwd; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const f = path.join(OUT, 'cwd');
      if (existsSync(f)) cwd = readFileSync(f, 'utf8').trim();
    }
    await a.call('forge_service', { action: 'stop', name: 'serve' });
    // full 档 bash 也写不到主工作区：绝对路径参数与内联脚本里写死的路径都被拦下（偏离 79）
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

test('精简模式：阶段 impl 合并后 S1.rv 审查整个阶段的 diff；must → .fx-1 → S1.rv-2 只确认 → 门禁 → 签收；S2 的 impl 接着 S1 的 worker 会话', async () => {
  const p = await setupProject({ yaml: yamlWith(false), files: FILES, stages: ['S1', 'S2'], tasks: [
    impl, at, mkTask('T-002', { stage: 'S2', ac: [], writes: ['src/server/t-002/**'], deps: [hard('T-001')] }),
  ] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }, { id: 'S2', goal: '收尾', exit: [] }], 'lean');
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (role === 'worker') {
      // 模拟 pi 的会话留档，下一阶段的 impl 接着它
      const dir = sessionDirOf(p.dir, a.env.run);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 's.jsonl'), '{"type":"session"}\n');
      await writeFiles(a, { [`src/server/${id.slice(0, 5).toLowerCase()}/a.ts`]: `${id}\n` });
      return submitWork(a, id);
    }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST }); return submitWork(a, 'AC'); }
    assert.equal(role, 'reviewer');
    if (id === 'S1.rv') { const r = await a.call('forge_review_report', { verdict: 'changes', issues: [must] }); assert.ok(r.ok, r.text); return; }
    assert.equal(id, 'S1.rv-2');
    const r = await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: true }] });
    assert.ok(r.ok, r.text);
  });
  try {
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.id === 'T-001.rv'), '精简模式不做逐任务审查');
    assert.equal(p.store.readTask(p.flowId, 'T-001.fx-1').status, 'done');
    assert.equal(p.store.readTask(p.flowId, 'S1.rv-2').status, 'done');
    assert.equal(stageStatus(p), 'awaiting_human');
    await runFlowCommand('approve', e.cmd).catch(() => runFlowCommand('approve S1', e.cmd));
    await drive(e, p.flowId, 10);
    const s2 = e.launcher.launched.find((s) => s.env['PI_FORGE_TASK'] === 'T-002');
    assert.ok(s2, 'T-002 已派发');
    const fx = p.store.listRuns().find((r) => r.task === 'T-001.fx-1')!;
    assert.equal(s2.forkFrom, path.join(sessionDirOf(p.dir, fx.run_id), 's.jsonl'), '接着上一阶段 worker 最后一次（.fx-1）的会话');
  } finally { p.cleanup(); }
});
