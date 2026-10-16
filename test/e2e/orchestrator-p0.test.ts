// 真实 Pi + fake LLM 的 P0 验收。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject, stubPlaywrightSkill } from '../helpers/project.ts';
import { StateStore } from '../../src/core/state/state-store.ts';
import { firstNonAppend, startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
const ROOT = path.join(import.meta.dirname, '../..');
const SCRIPTS = path.join(ROOT, 'test/fixtures/fake-llm/scripts');
const LOG = path.join(tmpdir(), `pi-forge-p0-llm-${process.pid}.log`);
let llm: FakeLlm;
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }
before(async () => { llm = await startFakeLlm({ scriptsDir: SCRIPTS, logFile: LOG }); });
after(() => { rmSync(LOG, { force: true }); return llm?.close(); });
async function session(cwd: string, agentDir: string, prompts: string[]) {
  const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
  return new Promise<string>((resolve, reject) => {
    const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '--model', 'fakellm/plain', ...prompts], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: SCRIPTS },
    });
    let output = '';
    c.stdout.on('data', (b) => { output += b; }); c.stderr.on('data', (b) => { output += b; });
    const timer = setTimeout(() => c.kill('SIGKILL'), 180_000);
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
    c.on('close', (status) => { clearTimeout(timer); status === 0 ? resolve(output) : reject(new Error(`Pi 退出 ${status}：${output}`)); });
  });
}
test('真实 pi print：forge_read 读 PRD；不合格规格被拒，合格规格等待批准；打回后新进程恢复仍注入输入和意见，用户批准进入 P1', { skip: !piAvailable && 'pi 不可用', timeout: 420_000 }, async () => {
  const p = await setupProject();
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-forge-p0-agentdir-'));
  stubPlaywrightSkill(agentDir);
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    writeFileSync(path.join(p.dir, 'prd.md'), '# PRD 原文\n团队维护看板，名称要唯一。');
    writeFileSync(path.join(agentDir, 'pi-forge.json'), JSON.stringify({ version: 1, roles: { orchestrator: { model: 'fakellm/orch-p0' } } }));
    const output = await session(p.dir, agentDir, ['/forge-build --prd prd.md', '请阅读 PRD 并提交规格']);
    assert.match(output, /主会话将和你讨论需求、整理规格/);
    assert.match(output, /等待用户 \/forge-approve/);
    let store = new StateStore(p.dir);
    const id = store.readState().active_flow!;
    const flow = store.readFlow(id);
    assert.equal(flow.stage, 'P0');
    assert.equal(flow.stage_status, 'awaiting_human');
    const requests = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'orch-p0');
    assert.equal(requests.length, 4);
    assert.ok(['forge_read', 'forge_spec', 'forge_change'].every((t) => requests[0].tools.includes(t)));
    assert.ok(!requests[0].tools.includes('write') && !requests[0].tools.includes('bash'));
    const system = requests[0].system.join('\n');
    assert.match(JSON.stringify(requests[0].status), /docs\/spec\/inputs\/prd\/prd.md/);
    assert.match(system, /## 第二步：写四份文件/); // spec-from-prd 全文
    assert.match(system, /## 按轮提问/); // grilling 全文
    assert.equal(firstNonAppend(requests), -1, '主会话每次请求只在上一次的末尾追加（提示缓存只认追加）');
    assert.match(JSON.stringify(requests[1].last), /PRD 原文.*团队维护看板/);
    assert.match(JSON.stringify(requests[2].last), /spec-lint 未通过.*\[MVP\]、\[LATER\] 或 \[NO\]/);
    assert.match(JSON.stringify(requests[3].last), /等待用户 \/forge-approve/);
    assert.match(p.git('show', `${flow.integration_branch}:docs/spec/inputs/prd/prd.md`), /名称要唯一/);
    for (const file of ['requirements', 'screens', 'permissions', 'glossary']) assert.ok(p.git('show', `${flow.integration_branch}:docs/spec/${file}.md`));
    await session(p.dir, agentDir, ['/forge resume', '/forge-reject stage:P0 "增加唯一性说明"']);
    store = new StateStore(p.dir);
    assert.equal(store.readFlow(id).stage_status, 'active');
    const previousCount = requests.length;
    await session(p.dir, agentDir, ['/forge resume', '根据打回意见重新阅读 PRD 并提交规格', '/forge-approve']);
    store = new StateStore(p.dir);
    assert.deepEqual([store.readFlow(id).stage, store.readFlow(id).stage_status], ['P1', 'active']);
    const resumed = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'orch-p0').slice(previousCount);
    assert.match(JSON.stringify(resumed[0].status), /增加唯一性说明[\s\S]*docs\/spec\/inputs\/prd\/prd.md/);
    assert.match(JSON.stringify(resumed[1].last), /PRD 原文/);
    // 进入 P1 后程序建了 architect 的 doc task（P1 的流程见 p1-flow）
    assert.deepEqual(store.listTasks(id).map((t) => [t.id, t.kind, t.role, t.stage]), [['T-001', 'doc', 'architect', 'P1']]);
    assert.ok((await store.verifyIntegrity()).ok);
  } finally { p.cleanup(); rmSync(agentDir, { recursive: true, force: true }); }
});
