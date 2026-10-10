// 来源：pi-flow test/e2e/commands.test.ts @ 31f3f15
// 命令层：/forge approve、unblock、gate、/forge-build 的参数与交互（无 UI 环境）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runFlowCommand, runFlowBuild, type CommandEnv } from '../../src/commands/forge.ts';
import { startFlow } from '../../src/core/stages.ts';
import { setupProject, DIRECT_YAML, type Project } from '../helpers/project.ts';
import { StateStore } from '../../src/core/state-store.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
const PACKAGE_ROOT = new URL('../..', import.meta.url).pathname;

function env(p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv {
  return {
    root: p.dir, packageRoot: PACKAGE_ROOT, ui: null,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
  };
}

test('/forge unblock 附回答写入 handoff 并回到 ready；approve 在没有等待批准的闸门时报错；最后阶段无 UI 需 --yes', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const { engine } = makeEngine(p, async (_r, _n, a) => { await a.call('forge_claim'); await a.call('forge_block', { reason: '用 PostgreSQL 还是 SQLite？' }); });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'blocked');
    const e = env(p, engine);
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

test('/forge-build 入库 PRD 与原型后停在 P0，启动主会话讨论，不派发任务', async () => {
  const p = await setupProject();
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const { engine, launcher } = makeEngine(p, async () => { throw new Error('P0 不应派发'); });
    let activated = 0;
    const talks: string[] = [];
    const e = { ...env(p, engine), activateOrchestrator: () => { activated++; }, startConversation: (s: string) => { talks.push(s); } };
    mkdirSync(path.join(p.dir, 'inputs'));
    writeFileSync(path.join(p.dir, 'inputs/用户 服务.md'), '# 用户服务\n原始 PRD');
    const image = Buffer.from([0, 255, 2, 3]);
    writeFileSync(path.join(p.dir, 'inputs/screen.png'), image);
    const output = await runFlowBuild('--prd "inputs/用户 服务.md" --prototype inputs/screen.png', e);
    assert.match(output, /主会话将和你讨论需求、整理规格/);
    assert.match(output, /docs\/spec\/inputs\/prd\/用户 服务\.md/);
    assert.match(output, /image\/png/);
    const id = p.store.readState().active_flow!;
    const ref = p.store.readFlow(id).integration_branch;
    assert.equal(p.git('show', `${ref}:docs/spec/inputs/prd/用户 服务.md`), '# 用户服务\n原始 PRD');
    assert.deepEqual(execFileSync('git', ['show', `${ref}:docs/spec/inputs/prototype/screen.png`], { cwd: p.dir }), image);
    assert.deepEqual(p.store.readFlow(id).stages, ['P0', 'P1']);
    assert.equal(p.store.readFlow(id).stage, 'P0');
    assert.deepEqual(p.store.listTasks(id), []);
    assert.ok(p.git('rev-parse', p.store.readFlow(id).integration_branch));
    await engine.pump(id);
    await engine.idle();
    assert.equal(p.store.readFlow(id).stage_status, 'active');
    assert.equal(activated, 1);
    assert.match(talks[0]!, /docs\/spec\/inputs\/prd\/用户 服务\.md[\s\S]*screen\.png/);
    assert.equal(p.store.readFlow(id).intake?.files.length, 2);
    assert.equal(launcher.launched.length, 0);
  } finally { p.cleanup(); }
});

test('/forge-build 缺参数、旧参数与路径错误不建流程；feature 明确提示 M7', async () => {
  const p = await setupProject();
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const { engine } = makeEngine(p, async () => { throw new Error('输入错误不应派发'); });
    const e = env(p, engine);
    mkdirSync(path.join(p.dir, 'inputs'));
    mkdirSync(path.join(p.dir, 'empty'));
    writeFileSync(path.join(p.dir, 'inputs/prd.md'), '# PRD');
    const branches = p.git('for-each-ref', '--format=%(refname)', 'refs/heads/flow/');
    for (const [args, error] of [
      ['', /缺少必填参数 --prd[\s\S]*用法/],
      ['--prototype inputs', /缺少必填参数 --prd/],
      ['--prd', /缺少路径/],
      ['--prd --prototype inputs', /缺少路径/],
      ['--prd ""', /缺少路径/],
      ['想法', /未知参数/],
      ['--from inputs/prd.md', /未知参数/],
      ['--prd inputs/prd.md --arch inputs', /未知参数/],
      ['--prd inputs/prd.md --design inputs', /未知参数/],
      ['--prd inputs/prd.md --prd inputs/prd.md', /不能重复/],
      ['--prd missing.md', /找不到PRD/],
      ['--prd inputs/prd.md --prototype missing.png', /找不到原型/],
      ['--prd empty', /空目录/],
    ] as const) {
      await assert.rejects(runFlowBuild(args, e), error);
      assert.equal(p.store.readState().active_flow, null);
      assert.equal(p.git('for-each-ref', '--format=%(refname)', 'refs/heads/flow/'), branches);
    }
    assert.match(await runFlowBuild('--feature --prd inputs/prd.md', e), /\/forge init --adopt/);
    assert.equal(p.store.readState().active_flow, null);
    assert.match(await runFlowBuild('--help', e), /--prd <文件或目录> \[--prototype <路径>\]/);
    assert.match(await runFlowCommand('help', e), /\/forge-build --prd <文件或目录> \[--prototype <路径>\]/);
    assert.doesNotMatch(await runFlowBuild('help', e), /--arch|--design|--from/);
  } finally { p.cleanup(); }
});

test('/forge-build PRD 目录无需原型，原样入库并停在 P0；活动流程阻止重复建流程', async () => {
  const p = await setupProject();
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const { engine } = makeEngine(p, async () => {});
    const e = env(p, engine);
    mkdirSync(path.join(p.dir, 'prd/nested'), { recursive: true });
    writeFileSync(path.join(p.dir, 'prd/requirements.md'), '# 需求');
    writeFileSync(path.join(p.dir, 'prd/nested/detail.txt'), '补充');
    assert.match(await runFlowBuild('--prd prd', e), /共 2 个文件/);
    const flow = p.store.readFlow(p.store.readState().active_flow!);
    assert.equal(flow.stage, 'P0');
    assert.equal(flow.stage_status, 'active');
    assert.equal(p.git('show', `${flow.integration_branch}:docs/spec/inputs/prd/nested/detail.txt`), '补充');
    assert.equal(p.git('ls-tree', '-r', '--name-only', flow.integration_branch, '--', 'docs/spec/inputs/prototype'), '');
    await assert.rejects(runFlowBuild('--prd prd', e), /已有进行中的流程/);
    assert.equal(p.store.readState().active_flow, flow.id);
  } finally { p.cleanup(); }
});

test('/forge knowledge：列出、确认改写、废弃、提升；/forge rules 在没有流程时也读取主分支上的草案并应用', async () => {
  const p = await setupProject();
  try {
    const { engine } = makeEngine(p, async () => {});
    const e = env(p, engine);
    assert.match(await runFlowCommand('knowledge', e), /知识库还是空的/);
    const { learn } = await import('../../src/core/knowledge.ts');
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
    await runFlowCommand('next', env({ ...p, store }, fresh.engine));
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done');
    assert.deepEqual(fresh.errors, []);
  } finally { p.cleanup(); }
});
