// 命令层：/forge approve、unblock、gate、/forge-build 的参数与交互（无 UI 环境）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runFlowCommand, runFlowBuild } from '../../src/commands/forge.ts';
import { setupProject, DIRECT_YAML } from '../helpers/project.ts';
import { StateStore } from '../../src/core/state/state-store.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { commandEnv } from '../helpers/commands.ts';


test('/forge unblock 附回答写入 handoff 并回到 ready；approve 在没有等待批准的闸门时报错；最后阶段无 UI 需 --yes', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const { engine } = makeEngine(p, async (_r, _n, a) => { await a.call('forge_claim'); await a.call('forge_block', { reason: '用 PostgreSQL 还是 SQLite？' }); });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'blocked');
    const e = commandEnv(p, engine);
    // 解除阻塞后会被重新派发（脚本仍会 block），这里只验证回答写入与状态转移
    const out = await runFlowCommand('unblock T-001 "用 SQLite" --reset', e);
    assert.match(out, /已解除 T-001 的阻塞/);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /用户回答：\n用 SQLite/);
    await assert.rejects(runFlowCommand('unblock', e), /用法/);
    await assert.rejects(runFlowCommand('approve', e), /没有等待批准的闸门/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    assert.match(await runFlowCommand('approve', e), /确认请执行 \/forge-approve --yes/);
    await assert.rejects(runFlowCommand('bogus', e), /未知子命令/);
    await engine.idle();
  } finally { p.cleanup(); }
});

test('/forge-build 缺 docs/PRD.md 或原型时只提示，不建流程、不建分支；未知参数报错', async () => {
  const p = await setupProject();
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const { engine } = makeEngine(p, async () => { throw new Error('输入不全不应派发'); });
    const e = commandEnv(p, engine);
    const branches = p.git('for-each-ref', '--format=%(refname)', 'refs/heads/flow/');
    const noFlow = () => {
      assert.equal(p.store.readState().active_flow, null);
      assert.equal(p.git('for-each-ref', '--format=%(refname)', 'refs/heads/flow/'), branches);
    };
    let out = await runFlowBuild('', e);
    assert.match(out, /还不能开始：\n- 缺少 docs\/PRD\.md[\s\S]*- 缺少 docs\/prototype\//);
    noFlow();
    mkdirSync(path.join(p.dir, 'docs/prototype'), { recursive: true });
    writeFileSync(path.join(p.dir, 'docs/PRD.md'), '# PRD');
    writeFileSync(path.join(p.dir, 'docs/prototype/README.md'), '说明');
    out = await runFlowBuild('"看板"', e);
    assert.match(out, /docs\/prototype\/ 里没有 \.html 文件/);
    noFlow();
    for (const args of ['--prd docs/PRD.md', '--prototype docs/prototype']) {
      await assert.rejects(runFlowBuild(args, e), /未知参数/);
      noFlow();
    }
    assert.match(await runFlowBuild('help', e), /docs\/PRD\.md[\s\S]*docs\/prototype\//);
    assert.doesNotMatch(await runFlowBuild('help', e), /--prd|--prototype/);
    assert.match(await runFlowCommand('help', e), /\/forge-build \["<项目名>"\]/);
  } finally { p.cleanup(); }
});

test('/forge-build PRD 与原型齐全时入库到集成分支，流程从 S0 开始；PRD 检查只提醒；活动流程阻止重复建流程', async () => {
  const p = await setupProject();
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const { engine } = makeEngine(p, async () => {});
    let activated = 0;
    const e = { ...commandEnv(p, engine), activateOrchestrator: () => { activated++; } };
    mkdirSync(path.join(p.dir, 'docs/prototype/img'), { recursive: true });
    writeFileSync(path.join(p.dir, 'docs/PRD.md'), '# 看板\n\n### 创建看板 REQ-001\n- AC1 Given 已登录 When 创建 Then 成功\n\n### 删除看板 REQ-002\n说明\n');
    writeFileSync(path.join(p.dir, 'docs/prototype/boards.html'), '<title>看板</title>');
    const image = Buffer.from([0, 255, 2, 3]);
    writeFileSync(path.join(p.dir, 'docs/prototype/img/logo.png'), image);
    const out = await runFlowBuild('"团队 看板"', e);
    assert.match(out, /共 3 个文件/);
    assert.match(out, /PRD 检查的提醒（不影响开始）：\n- REQ-002「删除看板」没有验收标准/);
    assert.match(out, /从架构阶段（S0）开始/);
    const flow = p.store.readFlow(p.store.readState().active_flow!);
    assert.equal(flow.title, '团队 看板');
    assert.deepEqual([flow.stages, flow.stage, flow.stage_status], [['S0'], 'S0', 'active']);
    assert.equal(p.git('show', `${flow.integration_branch}:docs/PRD.md`), '# 看板\n\n### 创建看板 REQ-001\n- AC1 Given 已登录 When 创建 Then 成功\n\n### 删除看板 REQ-002\n说明');
    assert.deepEqual(execFileSync('git', ['show', `${flow.integration_branch}:docs/prototype/img/logo.png`], { cwd: p.dir }), image);
    assert.equal(p.git('ls-tree', '-r', '--name-only', 'main', '--', 'docs/PRD.md'), '', '主分支不动');
    assert.equal(flow.intake?.files.length, 3);
    assert.equal(activated, 1);
    await assert.rejects(runFlowBuild('', e), /已有进行中的流程/);
    assert.equal(p.store.readState().active_flow, flow.id);
  } finally { p.cleanup(); }
});

test('/forge knowledge：列出、确认改写、废弃、提升；/forge rules 在没有流程时也读取主分支上的草案并应用', async () => {
  const p = await setupProject();
  try {
    const { engine } = makeEngine(p, async () => {});
    const e = commandEnv(p, engine);
    assert.match(await runFlowCommand('knowledge', e), /知识库还是空的/);
    const { learn } = await import('../../src/core/engine/knowledge.ts');
    const src = { kind: 'review' as const, flow: p.flowId, task: 'T-001', run: null, role: null };
    await learn(p.store, p.config, { category: 'convention', content: '审查打回：缺少参数校验', scopes: ['code'], source: src, status: 'candidate' }, 'engine');
    await learn(p.store, p.config, { category: 'pitfall', content: '本地测试需要先启动 redis', source: { ...src, kind: 'agent' }, status: 'active' }, 'engine');
    assert.match(await runFlowCommand('knowledge', e), /2 条，其中 1 条候选待确认[\s\S]*K-001 \[约定\]（code） 审查打回：缺少参数校验　候选/);
    assert.match(await runFlowCommand('knowledge redis', e), /K-002[\s\S]*/);
    assert.match(await runFlowCommand('knowledge accept K-001 "handler 入参一律用 zod 校验"', e), /已确认 K-001[\s\S]*handler 入参一律用 zod 校验/);
    assert.match(await runFlowCommand('knowledge accept K-001', e), /不是候选/);
    assert.match(await runFlowCommand('knowledge promote K-001', e), /docs\/rules-draft\/global\.md[\s\S]*\/forge rules apply global\.md/);
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.match(await runFlowCommand('rules', e), /（主分支）[\s\S]*docs\/rules-draft\/global\.md → rules\/global\.md/);
    assert.match(await runFlowCommand('rules apply global.md', e), /已应用：rules\/global\.md[\s\S]*知识 K-001 已成为规则/);
    assert.match(await runFlowCommand('knowledge retire K-002 "已改用内存实现"', e), /已废弃 K-002/);
    assert.doesNotMatch(await runFlowCommand('knowledge', e), /K-00/);
    assert.match(await runFlowCommand('knowledge --all', e), /K-001[\s\S]*已成为规则[\s\S]*K-002[\s\S]*已废弃/);
  } finally { p.cleanup(); }
});

test('/forge next 先推进程序步骤：引擎重启前已提交、排队合并的任务（不逐任务审查）由新引擎合入', async () => {
  const p = await setupProject({ yaml: DIRECT_YAML, tasks: [mkTask('T-001')] });
  try {
    // 旧引擎：提交后子进程挂住不退出（随后引擎被杀），任务停在合并队列里
    const old = makeEngine(p, async (_r, _n, a) => {
      await a.call('forge_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok' });
      await a.call('forge_note', { text: '完成' });
      await a.call('forge_submit', { summary: 's' });
      await new Promise(() => {});
    });
    await old.engine.next(p.flowId);
    const end = Date.now() + 30_000;
    while (p.store.readTask(p.flowId, 'T-001').status !== 'awaiting_inputs') { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); }
    const store = new StateStore(p.dir, { limits: p.config.limits });
    const fresh = makeEngine({ ...p, store }, async () => { throw new Error('不应再派发'); });
    await runFlowCommand('next', commandEnv({ ...p, store }, fresh.engine));
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done');
    assert.deepEqual(fresh.errors, []);
  } finally { p.cleanup(); }
});
