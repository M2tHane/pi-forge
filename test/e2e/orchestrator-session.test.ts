// 真实 Pi 进程连接本地假模型：主会话只读，任务由程序派发。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../../src/core/state/state-store.ts';
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const SCRIPTS = path.join(ROOT, 'test/fixtures/fake-llm/scripts');
const LOG = path.join(tmpdir(), `pi-forge-orch-llm-${process.pid}.log`);
let llm: FakeLlm;
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }
before(async () => { llm = await startFakeLlm({ scriptsDir: SCRIPTS, logFile: LOG }); });
after(() => { rmSync(LOG, { force: true }); return llm?.close(); });

test('调度模式：orchestrator 不能自己写代码，程序派发后 wait/status；任务经子进程完成', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const p = await setupProject({ yaml: PROJECT_YAML.replace('auto_dispatch: false', 'auto_dispatch: true'),
    tasks: [mkTask('T-001', { verify: ['test'] })] });
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-forge-agentdir-'));
  try {
    writeFileSync(path.join(agentDir, 'pi-forge.json'), JSON.stringify({ version: 1, roles: {
      orchestrator: { model: 'fakellm/orch-runtime' }, 'worker': { model: 'fakellm/impl-happy' }, 'reviewer': { model: 'fakellm/review-pass' } } }));
    const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '--model', 'fakellm/plain',
        '/forge resume', '开始调度', '/forge off', '你好'], {
        cwd: p.dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: SCRIPTS, PI_FORGE_EXTRA_EXTENSIONS: provider },
      });
      let stdout = ''; let stderr = '';
      c.stdout.on('data', (b) => { stdout += b; }); c.stderr.on('data', (b) => { stderr += b; });
      const timer = setTimeout(() => c.kill('SIGKILL'), 240_000);
      c.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /恢复摘要/);
    const store = new StateStore(p.dir);
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done', r.stdout + r.stderr);
    const violations = store.readEvents().filter((e) => e.type === 'violation' && e.data?.['role'] === 'orchestrator');
    // 读取不限范围：脚本里读源码不再算违规
    assert.deepEqual(violations.map((e) => [e.data?.['tool'], e.data?.['rule']]), []);
    const all = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const reqs = all.filter((x) => x.model === 'orch-runtime');
    assert.ok(reqs.length >= 5);
    assert.ok(!reqs[0].tools.includes('write') && !reqs[0].tools.includes('forge_dispatch'));
    assert.ok(['read', 'forge_status', 'forge_wait', 'notes', 'history'].every((t) => reqs[0].tools.includes(t)));
    assert.match(JSON.stringify(reqs[1].last), /Tool write not found/);
    assert.match(JSON.stringify(reqs[0].system), /你是 pi-forge 的主会话/);
    assert.doesNotMatch(JSON.stringify(reqs[0].system), /\[pi-forge 状态\]/, '每轮变化的状态不进系统提示');
    assert.match(JSON.stringify(reqs[0].status), /\[唯一允许的下一步\]/);
    // 系统提示在整个调度过程中不变，提示缓存可以命中
    assert.ok(reqs.every((x) => JSON.stringify(x.system) === JSON.stringify(reqs[0].system)), '系统提示不随轮次变化');
    const last = all.filter((x) => x.model === 'plain').at(-1);
    assert.ok(last && ['read', 'bash', 'edit', 'write'].every((t) => last.tools.includes(t)));
    assert.match(r.stdout + r.stderr, /已退出调度模式，恢复原来的模型/);
    const orch = store.listRuns().filter((x) => x.role === 'orchestrator');
    assert.equal(orch.length, 1);
    assert.ok((orch[0]!.turns ?? 0) >= 2 && (orch[0]!.tokens.output ?? 0) > 0);
    assert.equal(orch[0]!.model, 'fakellm/orch-runtime');
    assert.ok(orch[0]!.ended_at && orch[0]!.outcome === 'noted');
  } finally { p.cleanup(); rmSync(agentDir, { recursive: true, force: true }); }
});
