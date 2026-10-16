// scripts/m9/native.ts 的冒烟：真实 pi（JSON 模式）+ fake-llm。一轮提问被代答，再提一次变更；检查代答计数、计时扣除、计分与 summary.json。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { stubPlaywrightSkill } from '../helpers/project.ts';

const ROOT = path.join(import.meta.dirname, '../..');
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }
let llm: FakeLlm;
let work: string;
before(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'm9-native-'));
  const scripts = path.join(work, 'scripts');
  mkdirSync(scripts);
  // 第 1 轮提问；被代答后第 2 轮做完；变更那条消息的第 3 轮做完
  writeFileSync(path.join(scripts, 'm9-native.json'), JSON.stringify({ steps: [{ text: '请问数据存哪里？' }, { text: '第一版完成。' }, { text: '变更完成。' }] }));
  llm = await startFakeLlm({ scriptsDir: scripts, logFile: path.join(work, 'llm.log') });
  process.env['FAKE_LLM_SCRIPTS'] = scripts;
});
after(() => { rmSync(work, { recursive: true, force: true }); return llm?.close(); });

test('native：提问被代答并计数，变更在同一会话里提出，hidden 结果计分，summary.json 与 real-build 同格式', { skip: !piAvailable && 'pi 不可用', timeout: 180_000 }, async () => {
  const out = path.join(work, 'run');
  const agentDir = path.join(work, 'agent');
  mkdirSync(agentDir);
  stubPlaywrightSkill(agentDir);
  writeFileSync(path.join(work, 'prd.md'), '做一个看板。');
  writeFileSync(path.join(work, 'change.md'), '加归档。');
  // 假 hidden.mjs：基础 3 个用例，其中"非法 JSON 返回 400"不计分；--change 时多 2 个变更用例，且基础用例 b 变成失败（回归）
  writeFileSync(path.join(work, 'hidden.mjs'), [
    "const change = process.argv.includes('--change');",
    "console.log('\\n## 账号（2/3）'); console.log('✓ a'); console.log(change ? '✗ b：500' : '✓ b'); console.log('✗ 非法 JSON 返回 400：200');",
    "if (change) { console.log('\\n## 变更：归档（1/2）'); console.log('✓ c1'); console.log('✗ c2：409'); }",
  ].join('\n'));
  const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
  const output = await new Promise<string>((resolve, reject) => {
    const c = spawn('node', [path.join(ROOT, 'scripts/m9/native.ts'), '--prd', path.join(work, 'prd.md'), '--then-file', path.join(work, 'change.md'), '--hidden', path.join(work, 'hidden.mjs'),
      '--out', out, '--model', 'fakellm/m9-native', '--ext', provider, '--no-plugins'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url },
    });
    let buf = '';
    c.stdout.on('data', (b) => { buf += b; }); c.stderr.on('data', (b) => { buf += b; });
    c.on('error', reject);
    c.on('close', () => resolve(buf));
  });
  const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.arm, 'N', output);
  assert.equal(summary.status, 'delivered', output);
  assert.equal(summary.interventions.p0_questions, 1, output);
  assert.match(summary.notes[0], /代答 1 次（新建 1，变更 0）/);
  assert.deepEqual(summary.phases.map((p: { name: string }) => p.name), ['build', 'change']);
  // 代答间隔被扣掉：agent 时间不超过墙钟
  for (const p of summary.phases) assert.ok(p.agent_min <= p.wall_min);
  assert.equal(summary.score.base.passed, 2);
  assert.equal(summary.score.base.total, 39);
  assert.equal(summary.score.change.passed, 1);
  assert.equal(summary.score.regression, 1);
  assert.deepEqual(summary.score.regressed, ['b']);
  assert.equal(summary.time_charged_min, summary.agent_min);
  const qa = readFileSync(path.join(out, 'qa.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(qa.length, 1);
  assert.equal(qa[0].answer, '同意你给出的建议（默认方案），按建议继续。');
  assert.match(qa[0].question_tail, /数据存哪里/);
  for (const f of ['hidden-build.json', 'hidden-change.json']) assert.ok(readFileSync(path.join(out, f), 'utf8'));
});
