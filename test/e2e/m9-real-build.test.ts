// scripts/real-build.ts 的冒烟：真实 pi（RPC 模式）+ fake-llm，不用真实模型。
// 覆盖：建仓库、/forge init、写实验配置（角色模型与思考级别）、RPC 主会话、P0 的 ask_user（select）被自动回答并计数、
// P0 文字提问被自动回复并按轮计、规格审批（/forge-approve）、--stop-after-gates 提前停止、留档文件齐全。
// 不覆盖：P1 之后的派发、task blocked、交付、变更、隐藏测试计分（完整跑到交付需要能驱动 architect 与 worker 的假子进程脚本，成本过高；
// 这些分支由 test/unit/m9-simulator.test.ts 与 m9-score.test.ts 覆盖规则与计算）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { parseDocument } from 'yaml';
import { applyExperimentConfig } from '../../scripts/real-build.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const P0_SCRIPT = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/fake-llm/scripts/orch-p0.json'), 'utf8')) as { steps: Record<string, unknown>[] };
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }

let llm: FakeLlm;
let work: string;
let scripts: string;
before(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'm9-real-build-'));
  scripts = path.join(work, 'scripts');
  mkdirSync(scripts);
  const [read, , validSpec, done] = P0_SCRIPT.steps as [Record<string, unknown>, unknown, Record<string, unknown>, Record<string, unknown>];
  // 用 ask_user 提问两个问题（第一个有"（推荐）"，第二个没有），然后读 PRD、提交规格
  const ask = { tool_calls: [{ name: 'ask_user', arguments: { questions: [
    { question: '登录方式？', options: [{ label: '邮箱密码' }, { label: '短信（推荐）', description: '快' }] },
    { question: '数据存哪里？', options: [{ label: 'SQLite', description: '单文件' }, { label: 'JSON 文件' }] },
  ] } }] };
  writeFileSync(path.join(scripts, 'm9-orch.json'), JSON.stringify({ steps: [ask, read, validSpec, done] }));
  // 不用 ask_user，直接用文字提问并结束这一轮；用户回复后再读 PRD、提交规格
  const text = { text: '开始前请回答：\n1. 要不要登录？\n2. 数据存哪里？' };
  writeFileSync(path.join(scripts, 'm9-orch-text.json'), JSON.stringify({ steps: [text, read, validSpec, done] }));
  writeFileSync(path.join(scripts, 'm9-coder.json'), JSON.stringify({ steps: [] }));
  llm = await startFakeLlm({ scriptsDir: scripts, logFile: path.join(work, 'llm.log') });
});
after(() => { rmSync(work, { recursive: true, force: true }); return llm?.close(); });

function runScript(out: string, planner: string, extra: string[]): Promise<{ code: number | null; output: string }> {
  const agentDir = path.join(work, `agent-${path.basename(out)}`);
  mkdirSync(agentDir, { recursive: true });
  const prd = path.join(work, 'prd.md');
  writeFileSync(prd, '# PRD 原文\n团队维护看板，名称要唯一。');
  writeFileSync(path.join(work, 'change.md'), '加一个归档功能。');
  const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
  return new Promise((resolve, reject) => {
    const c = spawn('node', [path.join(ROOT, 'scripts/real-build.ts'), '--arm', 'A0', '--prd', prd, '--change', path.join(work, 'change.md'), '--out', out,
      '--planner-model', planner, '--coder-model', 'fakellm/m9-coder', '--ext', provider, '--poll-sec', '1', '--stop-after-gates', '1', ...extra], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: scripts, PI_FORGE_EXTRA_EXTENSIONS: provider },
    });
    let output = '';
    c.stdout.on('data', (b) => { output += b; });
    c.stderr.on('data', (b) => { output += b; });
    const timer = setTimeout(() => c.kill('SIGKILL'), 240_000);
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

const lines = (f: string) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

test('applyExperimentConfig：角色模型与思考级别、关闭升级；A1 关闭 test-author', () => {
  const tpl = readFileSync(path.join(ROOT, 'templates/workflow.yaml'), 'utf8');
  const o = { arm: 'A0' as const, plannerModel: 'magpie/codex/gpt-6.1-sol', plannerThinking: 'medium', coderModel: 'magpie/zcode/GLM-5.3-Flash', coderThinking: 'high' };
  const a0 = parseDocument(applyExperimentConfig(tpl, o)).toJS() as { models: Record<string, string>; roles: Record<string, { model: string; thinking: string }>; escalation: { enabled: boolean }; implementation_gate: Record<string, unknown> };
  assert.equal(a0.models['planner'], 'magpie/codex/gpt-6.1-sol');
  assert.equal(a0.models['coder'], 'magpie/zcode/GLM-5.3-Flash');
  for (const r of ['orchestrator', 'architect', 'reviewer', 'stage-qa', 'researcher']) assert.deepEqual([a0.roles[r]!.model, a0.roles[r]!.thinking], ['planner', 'medium'], r);
  for (const r of ['worker', 'test-author']) assert.deepEqual([a0.roles[r]!.model, a0.roles[r]!.thinking], ['coder', 'high'], r);
  assert.equal(a0.escalation.enabled, false);
  assert.notEqual(a0.implementation_gate['test_author'], false);
  const a1 = parseDocument(applyExperimentConfig(tpl, { ...o, arm: 'A1' })).toJS() as { implementation_gate: { test_author?: boolean } };
  assert.equal(a1.implementation_gate.test_author, false);
});

test('real-build：ask_user 的 select 被自动回答并计数，规格审批后提前停止，留档齐全', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const out = path.join(work, 'run-ask');
  const r = await runScript(out, 'fakellm/m9-orch', ['--ext', path.join(ROOT, 'test/fixtures/m9/ask-user-stub.ts')]);
  assert.equal(r.code, 1, r.output); // 提前停止不算交付
  const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.arm, 'A0');
  assert.equal(summary.status, 'stopped_early', r.output);
  assert.equal(summary.failure.kind, 'stop_after_gates');
  assert.equal(summary.pi_version, '1.1.0');
  assert.match(summary.pi_forge_sha, /^[0-9a-f]{40}$/);
  assert.equal(summary.interventions.p0_questions, 2);
  assert.equal(summary.interventions.p0_text_turns, 0);
  assert.equal(summary.interventions.gates, 1);
  assert.equal(summary.interventions.extra_total, 0);
  assert.equal(summary.models.planner, 'fakellm/m9-orch');
  assert.equal(summary.thinking.coder, 'high');
  // interventions.jsonl：两次 select（第一次选带"（推荐）"的，第二次选第一个）和一次 /forge-approve
  const iv = lines(path.join(out, 'interventions.jsonl')).filter((x) => x['type'] !== 'result');
  const selects = iv.filter((x) => x['kind'] === 'ui_response');
  assert.deepEqual(selects.map((x) => x['answer']), ['2. 短信（推荐） — 快', '1. SQLite — 单文件']);
  assert.ok(selects.every((x) => x['category'] === 'p0_question'));
  const gate = iv.find((x) => x['category'] === 'gate');
  assert.equal(gate?.['command'], '/forge-approve stage:P0');
  // 留档
  for (const f of ['rpc.jsonl', 'interventions.jsonl', 'summary.json', 'init.log', 'metrics-build.txt']) assert.ok(existsSync(path.join(out, f)), f);
  const rpc = lines(path.join(out, 'rpc.jsonl'));
  assert.ok(rpc.some((x) => (x['msg'] as { type?: string }).type === 'extension_ui_request'));
  assert.ok(rpc.some((x) => x['dir'] === 'in' && (x['msg'] as { message?: string }).message?.startsWith('/forge-build --prd')));
  // 实验配置已写入并提交
  const wf = readFileSync(path.join(out, 'project/workflow.yaml'), 'utf8');
  assert.match(wf, /planner: fakellm\/m9-orch/);
  assert.equal(execFileSync('git', ['log', '--format=%s', '-1', '--', 'workflow.yaml'], { cwd: path.join(out, 'project'), encoding: 'utf8' }).trim(), 'M9 实验配置：角色模型与思考级别、关闭升级');
  // 流程确实进入了 P1
  const state = JSON.parse(readFileSync(path.join(out, 'project/.forge/state.json'), 'utf8'));
  assert.ok(state.active_flow);
});

test('real-build：没有 ask_user 时主会话用文字提问，自动回复"都按你的推荐，继续"并按轮计', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const out = path.join(work, 'run-text');
  const r = await runScript(out, 'fakellm/m9-orch-text', []);
  const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'stopped_early', r.output);
  assert.equal(summary.interventions.p0_text_turns, 1);
  assert.equal(summary.interventions.p0_text_numbered, 2);
  assert.equal(summary.interventions.p0_questions, 1);
  assert.equal(summary.interventions.gates, 1);
  const iv = lines(path.join(out, 'interventions.jsonl')).filter((x) => x['type'] !== 'result');
  assert.equal(iv[0]!['command'], '都按你的推荐，继续');
  assert.equal(iv[0]!['numbered_questions'], 2);
  assert.ok(summary.notes.some((n: string) => n.includes('ask_user')), '缺少 ask_user 插件要写进备注');
});
