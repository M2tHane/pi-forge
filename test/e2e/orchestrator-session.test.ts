// 来源：pi-flow test/e2e/orchestrator-session.test.ts @ 31f3f15
// 真实 pi 主会话：/forge resume 进入调度模式；orchestrator 越权被拦；每轮注入"唯一允许的下一步"；派发与等待跑通。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../../src/core/state-store.ts';
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { FLOW5_YAML } from '../helpers/flow5.ts';
import { PKG_CONTENT } from '../helpers/package.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const SCRIPTS = path.join(ROOT, 'test/fixtures/fake-llm/scripts');
const LOG = path.join(tmpdir(), `pi-forge-orch-llm-${process.pid}.log`);
let llm: FakeLlm;
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }
before(async () => { llm = await startFakeLlm({ scriptsDir: SCRIPTS, logFile: LOG }); });
after(() => { rmSync(LOG, { force: true }); return llm?.close(); });

test('调度模式：orchestrator 不能自己写代码，只能 dispatch/wait；任务经子进程完成', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  // 旧角色只在测试夹具里：放进项目的 .pi/agents 覆盖目录
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })],
    files: { '.pi/agents/backend-engineer.md': readFileSync(path.join(ROOT, 'test/fixtures/agents/backend-engineer.md'), 'utf8') } });
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-forge-agentdir-'));
  try {
    writeFileSync(path.join(agentDir, 'pi-forge.json'), JSON.stringify({ version: 1, roles: {
      orchestrator: { model: 'fakellm/orch' }, 'backend-engineer': { model: 'fakellm/impl-happy' } } }));
    const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
    // 必须异步：假 LLM 在本进程内，spawnSync 会阻塞事件循环导致死锁
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '--model', 'fakellm/plain',
        '/forge resume', '开始调度', '/forge off', '你好'], {
        cwd: p.dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_FORGE_CONTENT_ROOT: PKG_CONTENT, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: SCRIPTS, PI_FORGE_EXTRA_EXTENSIONS: provider },
      });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (b) => { stdout += b; });
      c.stderr.on('data', (b) => { stderr += b; });
      const timer = setTimeout(() => c.kill('SIGKILL'), 240_000);
      c.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /恢复摘要/);
    const store = new StateStore(p.dir);
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done', r.stdout + r.stderr);

    // write 已从启用工具中移除，Pi 直接拒绝；读 docs/ 之外的文件被 guard 拦下并记录违规
    const orchViolations = store.readEvents().filter((e) => e.type === 'violation' && e.data?.['role'] === 'orchestrator');
    assert.deepEqual(orchViolations.map((e) => [e.data?.['tool'], e.data?.['rule']]), [['read', 'read_paths']]);
    assert.match(orchViolations[0]!.reason ?? '', /你是调度者，不能直接修改代码。请调用 forge_dispatch\(T-001\)/);

    const all = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // 进入调度模式后主会话切到 /forge-config 中 orchestrator 的模型；/forge off 后恢复原模型与工具
    const mainReqs = all.filter((x) => x.model === 'orch' || x.model === 'plain');
    assert.equal(mainReqs[0].model, 'orch', '调度模式使用 orchestrator 的模型');
    const last = mainReqs.at(-1);
    assert.equal(last.model, 'plain', '/forge off 后恢复原模型');
    assert.ok(['read', 'bash', 'edit', 'write'].every((t) => last.tools.includes(t)), `恢复原工具：${last.tools}`);
    assert.match(r.stdout + r.stderr, /已退出调度模式，恢复原来的模型（fakellm\/plain）/);
    const reqs = all.filter((x) => x.model === 'orch');
    assert.match(JSON.stringify(reqs[1].last), /Tool write not found/);
    // 只启用了 orchestrator 的工具
    assert.deepEqual([...reqs[0].tools].sort(), ['forge_dispatch', 'forge_plan_doc', 'forge_propose_modules', 'forge_requirements', 'forge_resolve_scope', 'forge_resolve_timeout', 'forge_revise_plan', 'forge_status', 'forge_wait', 'history', 'notes', 'read']);
    const sys = JSON.stringify(reqs[0].system);
    assert.match(sys, /你是 pi-forge 的主会话/);
    assert.match(sys, /唯一允许的下一步.*forge_dispatch\(T-001\)/);
    // 主会话用量记入 runs（role=orchestrator），成本统计可见
    const orch = store.listRuns().filter((x) => x.role === 'orchestrator');
    assert.equal(orch.length, 1, JSON.stringify(orch));
    assert.equal(orch[0]!.flow, p.flowId);
    assert.ok((orch[0]!.turns ?? 0) >= 2 && (orch[0]!.tokens.output ?? 0) > 0 && orch[0]!.model === 'fakellm/orch', JSON.stringify(orch[0]));
    assert.ok(orch[0]!.ended_at && orch[0]!.outcome === 'noted');
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    p.cleanup();
  }
});

test('真实 pi：空仓库执行 /forge-build（没有 PRD），主 agent 逐轮问用户、自己查代码，用户确认后提交需求说明，检查通过直接进入规划', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-build-'));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-forge-agentdir-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(path.join(agentDir, 'pi-forge.json'), JSON.stringify({ version: 1, roles: { orchestrator: { model: 'fakellm/grill' } } }));
    const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
    const out = await new Promise<{ status: number | null; text: string }>((resolve) => {
      const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '--model', 'fakellm/plain',
        '/forge-build "做一个待办应用"', '帮我做个待办', '只有我自己用，就按你推荐的写'], {
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_FORGE_CONTENT_ROOT: PKG_CONTENT, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: SCRIPTS, PI_FORGE_EXTRA_EXTENSIONS: provider },
      });
      let text = '';
      c.stdout.on('data', (b) => { text += b; });
      c.stderr.on('data', (b) => { text += b; });
      const timer = setTimeout(() => c.kill('SIGKILL'), 240_000);
      c.on('close', (status) => { clearTimeout(timer); resolve({ status, text }); });
    });
    assert.equal(out.status, 0, out.text);
    assert.match(out.text, /已创建流程 B-001（build）/);
    const store = new StateStore(dir);
    const flow = store.readFlow('B-001');
    assert.equal(flow.stage, 'D2', out.text);
    assert.equal(flow.stage_status, 'active', out.text);
    assert.equal(flow.planning, undefined, '规划由主 agent 进行，还没提交');
    assert.deepEqual(store.listTasks('B-001'), [], '需求讨论与规划都不派子任务');
    assert.match(execFileSync('git', ['show', 'flow/B-001/integration:docs/requirements.md'], { cwd: dir, encoding: 'utf8' }), /待办应用需求说明[\s\S]*## 术语/);
    assert.match(out.text, /开始规划/);
    const all = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const reqs = all.filter((x) => x.model === 'grill');
    // 讨论中：注入逐轮追问与写需求说明的技能，唯一允许的下一步是讨论并 forge_requirements；能读代码（grep），不能写
    const sys = JSON.stringify(reqs[0].system);
    assert.match(sys, /逐轮追问[\s\S]*写需求说明/);
    assert.match(sys, /唯一允许的下一步.*需求讨论.*forge_requirements/);
    assert.ok(reqs[0].tools.includes('grep') && reqs[0].tools.includes('forge_requirements') && !reqs[0].tools.includes('write'), JSON.stringify(reqs[0].tools));
    assert.ok(!store.readEvents().some((e) => e.type === 'violation'), '读代码不算越权');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.worktrees`, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('真实 pi print：首次接收与新进程恢复都把集成分支 PRD 原文放进模型请求', { skip: !piAvailable && 'pi 不可用', timeout: 120_000 }, async () => {
  const p = await setupProject({ yaml: FLOW5_YAML });
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-forge-agentdir-'));
  const prd = `${p.dir}.prd.md`;
  const marker = '恢复验收原件：POST /api/users 必须返回 201，不能根据截断标题改为看板 CRUD。';
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    writeFileSync(prd, `# 团队服务\n${marker}\n`);
    writeFileSync(path.join(agentDir, 'pi-forge.json'), JSON.stringify({ version: 1, roles: { orchestrator: { model: 'fakellm/plain' } } }));
    const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
    const invoke = (messages: string[]) => new Promise<{ status: number | null; text: string }>((resolve) => {
      const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '--model', 'fakellm/plain', ...messages], {
        cwd: p.dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_FORGE_CONTENT_ROOT: PKG_CONTENT, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: SCRIPTS, PI_FORGE_EXTRA_EXTENSIONS: provider },
      });
      let text = '';
      c.stdout.on('data', b => { text += b; }); c.stderr.on('data', b => { text += b; });
      const timer = setTimeout(() => c.kill('SIGKILL'), 50_000);
      c.on('close', status => { clearTimeout(timer); resolve({ status, text }); });
    });
    const offset = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const first = await invoke([`/forge-build --prd ${JSON.stringify(prd)}`, '请检查用户的 PRD']);
    assert.equal(first.status, 0, first.text);
    const resumed = await invoke(['/forge-resume', '请接着检查用户的 PRD']);
    assert.equal(resumed.status, 0, resumed.text);
    const reqs = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(offset).map(l => JSON.parse(l));
    assert.equal(reqs.length, 2, '首次接收与新进程恢复各发一个模型请求');
    for (const req of reqs) {
      assert.ok(JSON.stringify(req.system).includes(marker), '真实模型请求必须包含原件内容');
      assert.match(JSON.stringify(req.system), /唯一允许的下一步.*现在是接收/);
    }
    const store = new StateStore(p.dir), id = store.readState().active_flow!;
    assert.equal(store.readFlow(id).stage, 'D0', '假模型只回复，不修改需求');
    assert.throws(() => readFileSync(path.join(p.dir, store.readFlow(id).intake!.prd)), /ENOENT/, '原件仍只在集成分支上');
  } finally {
    rmSync(prd, { force: true }); rmSync(agentDir, { recursive: true, force: true }); p.cleanup();
  }
});
