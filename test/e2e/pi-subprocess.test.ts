// 真实 pi 子进程 + 假 LLM（OpenAI 兼容流式服务）：验证 pi-adapter（启动参数、子进程扩展、guard、forge_* 工具、token 统计）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Engine } from '../../src/core/engine/dispatcher.ts';
import { PiLauncher, buildPiArgs } from '../../src/pi-adapter/launcher.ts';
import { summarizeSession } from '../../src/core/engine/session-log.ts';
import { readFileSync } from 'node:fs';
import { parseConfig } from '../../src/core/state/config.ts';
import { PROJECT_YAML } from '../helpers/project.ts';
import { firstNonAppend, startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { setupProject, DIRECT_YAML } from '../helpers/project.ts';
import { AGENTS } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const SCRIPTS = path.join(ROOT, 'test/fixtures/fake-llm/scripts');
let llm: FakeLlm;
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }

before(async () => {
  llm = await startFakeLlm({ scriptsDir: SCRIPTS, logFile: '/tmp/pi-forge-e2e-llm.log' });
  process.env['FAKE_LLM_URL'] = llm.url;
  // 测试不需要联网：关闭模型目录刷新与版本检查（网络不通时 pi 启动会被拖慢约 60 秒）
  process.env['PI_OFFLINE'] = '1';
  process.env['PI_SKIP_VERSION_CHECK'] = '1';
  process.env['FAKE_LLM_SCRIPTS'] = SCRIPTS;
});
after(() => llm?.close());

test('buildPiArgs：RPC 模式、关闭扩展发现、guard 扩展最后、工具白名单；提示经 stdin 发送，不在参数里', () => {
  const args = buildPiArgs({ cwd: '/w', model: 'p/m', thinking: 'low', tools: ['read', 'forge_claim'], extensions: ['/x.ts', '/sub.ts'],
    appendSystemPromptFiles: ['/s.md'], prompt: '--不是参数', env: {} });
  assert.deepEqual(args.slice(0, 7), ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']);
  assert.equal(args[args.lastIndexOf('-e') + 1], '/sub.ts');
  assert.ok(!args.includes('--不是参数') && !args.includes('-p'));
  const kept = buildPiArgs({ cwd: '/w', model: null, thinking: null, tools: [], extensions: [], appendSystemPromptFiles: [], prompt: 'x', env: {}, sessionDir: '/s/r-1' });
  assert.deepEqual(kept.slice(0, 4), ['--mode', 'rpc', '--session-dir', '/s/r-1']);
  assert.ok(!kept.includes('--no-session'));
  const forked = buildPiArgs({ cwd: '/w', model: null, thinking: null, tools: [], extensions: [], appendSystemPromptFiles: [], prompt: 'x', env: {}, sessionDir: '/s/r-2', forkFrom: '/s/r-1/a.jsonl' });
  assert.deepEqual(forked.slice(0, 6), ['--mode', 'rpc', '--session-dir', '/s/r-2', '--fork', '/s/r-1/a.jsonl']);
  assert.ok(args.includes('--tools') && args[args.indexOf('--tools') + 1] === 'read,forge_claim');
});

test('真实 pi 子进程：实施 → 审查 → 合并；越权被拦且计入违规；token 用量写入 run', { skip: !piAvailable && 'pi 不可用', timeout: 240_000 }, async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: p.config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: {
        'worker': { model: 'fakellm/impl-happy' }, 'reviewer': { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: AGENTS,
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.status} ${t.last_failure ?? ''} ${t.blocked_reason ?? ''}`);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), 'export const a = 1;');

    const violations = p.store.readEvents().filter((e) => e.type === 'violation');
    // worker 不再受 writes 限制，写 .forge/ 由受保护路径规则拦下
    assert.deepEqual(violations.map((v) => [v.data?.['role'], v.data?.['rule']]), [['worker', 'protected']]);

    // impl 一律审查，先 worker 后 reviewer
    const runs = p.store.listRuns().sort((a, b) => a.started_at.localeCompare(b.started_at));
    assert.deepEqual(runs.map((r) => r.role), ['worker', 'reviewer'], '提交后先审查再合并');
    const impl = runs[0]!;
    assert.equal(impl.outcome, 'submitted');
    assert.equal(impl.model, 'fakellm/impl-happy');
    // 假 LLM：默认每轮 prompt 100+turn、completion 10；第 3 轮 800/30/缓存 600 → input 不含缓存
    assert.equal(impl.tokens.output, 10 * 5 + 30);
    assert.equal(impl.tokens.cache_read, 600);
    assert.ok(impl.tokens.input! > 0);
    // 会话留档：每个 run 的会话文件在 <项目>.worktrees/.sessions/<run>/ 下，可摘要出工具调用与最后的回复
    for (const r of [impl]) {
      assert.ok(r.session_file && r.session_file.startsWith(r.session_dir!), JSON.stringify(r));
      assert.ok(existsSync(r.session_file));
    }
    const s = summarizeSession(impl.session_file!);
    assert.deepEqual(s.toolCalls.map((c) => c.name).filter((n) => n.startsWith('forge_')), ['forge_claim', 'forge_note', 'forge_submit']);
    assert.ok(s.toolCalls.some((c) => c.error), '被 guard 拦下的写入应显示为失败的工具调用');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：模型返回额度用完（429 insufficient_quota）时暂停该模型，任务不计失败', { skip: !piAvailable && 'pi 不可用', timeout: 120_000 }, async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: p.config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'worker': { model: 'fakellm/quota' }, 'reviewer': { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: AGENTS,
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'in_progress');
    assert.equal(t.attempts, 0, `${t.last_failure ?? ''}`);
    assert.equal(t.lease, null);
    const runs = p.store.listRuns();
    assert.equal(runs.length, 1, '暂停后不再派发');
    assert.equal(runs[0]!.outcome, 'unavailable');
    const pause = p.store.readModelPauses().pauses[0];
    assert.equal(pause?.model, 'fakellm/quota');
    assert.equal(pause?.kind, 'quota');
    assert.match(pause?.reason ?? '', /quota/);
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：审查要求修改后，接着上一次的对话修好再合入', { skip: !piAvailable && 'pi 不可用', timeout: 240_000 }, async () => {
  const p = await setupProject({ yaml: DIRECT_YAML, tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const logFile = '/tmp/pi-forge-e2e-llm.log';
    const before = existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0;
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: p.config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'worker': { model: 'fakellm/impl-fork' }, 'reviewer': { model: 'fakellm/review-changes' } } }),
      packageAgentsDir: AGENTS,
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.status} ${t.last_failure ?? ''}`);
    assert.equal(t.review_rounds, 1, '第一次提交被审查要求修改');
    assert.equal(t.precheck_failures ?? 0, 0);
    assert.equal(t.attempts, 0);
    const runs = p.store.listRuns().sort((a, b) => a.started_at.localeCompare(b.started_at)).filter((r) => r.role === 'worker');
    assert.deepEqual(runs.map((r) => r.role), ['worker', 'worker']);
    assert.equal(runs[1]!.forked_from, runs[0]!.run_id);
    const triggers = p.store.readEvents().filter((e) => e.task === 'T-001' && e.type === 'transition').map((e) => e.trigger);
    assert.deepEqual(triggers.filter((x) => x !== 'dispatch' && x !== 'schedule'),
      ['submit', 'inputs_ready', 'precheck_pass', 'review_changes', 'submit', 'inputs_ready', 'precheck_pass', 'review_pass', 'merge_start', 'merge_done'], triggers.join(','));
    const reqs = readFileSync(logFile, 'utf8').slice(before).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'impl-fork');
    const second = reqs.find((r) => r.turn === 5)!;
    assert.ok(second, '第二次运行的第一个请求带着上一次的 5 条回复');
    assert.match(JSON.stringify(second.last), /继续任务[\s\S]*a 不应是 FAIL[\s\S]*forge_claim/);
    assert.ok(runs[1]!.session_file && runs[1]!.session_file !== runs[0]!.session_file, '新会话单独留档');
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：bash 命令没给超时或超过上限时改成 limits.bash_timeout_s', { skip: !piAvailable && 'pi 不可用', timeout: 120_000 }, async () => {
  const yaml = PROJECT_YAML.replace(/^  bash_timeout_s: 300\b/m, '  bash_timeout_s: 2   ');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: ['test'] })] });
  try {
    const logFile = '/tmp/pi-forge-e2e-llm.log';
    const before = existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0;
    const engine = new Engine({
      root: p.dir, store: p.store, config: parseConfig(yaml), launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'worker': { model: 'fakellm/impl-sleep' }, 'reviewer': { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: AGENTS,
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
    });
    const t0 = Date.now();
    await engine.promote(p.flowId);
    await engine.dispatch(p.flowId, 'T-001');
    // 只等第一次运行：两次 sleep 30 各在 2 秒后被结束
    while (p.store.listRuns().every((r) => !r.ended_at) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 200));
    engine.killAll();
    await engine.idle();
    const reqs = readFileSync(logFile, 'utf8').slice(before).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'impl-sleep');
    assert.match(JSON.stringify(reqs.find((r) => r.turn === 1)?.last), /timed out after 2 seconds/);
    assert.match(JSON.stringify(reqs.find((r) => r.turn === 2)?.last), /timed out after 2 seconds/);
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：notes 与 history 工具可用；任务笔记由程序预填，开始时存进会话一次，更新后的笔记在工具结果里（不再每次请求接在末尾）', { skip: !piAvailable && 'pi 不可用', timeout: 240_000 }, async () => {
  const log = `/tmp/pi-forge-e2e-notes-${process.pid}.log`;
  const local = await startFakeLlm({ scriptsDir: SCRIPTS, logFile: log });
  const prev = process.env['FAKE_LLM_URL'];
  process.env['FAKE_LLM_URL'] = local.url;
  const p = await setupProject({ yaml: DIRECT_YAML, tasks: [mkTask('T-001', { verify: ['typecheck', 'test'], ac: ['导出 a = 1'] })] });
  try {
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: p.config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'worker': { model: 'fakellm/impl-notes' }, 'reviewer': { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: AGENTS,
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      promptVars: () => ({ 'playwright-browser': 'C:/fake/pi-playwright/skills/playwright-browser' }),
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.status} ${t.last_failure ?? ''} ${t.blocked_reason ?? ''}`);
    const notes = p.store.readNotes(`flows/${p.flowId}/notes/T-001.json`)!;
    assert.deepEqual(notes.todo, ['导出 a = 1']);
    assert.equal(notes.goal[0], `任务：${t.title}`);
    assert.deepEqual(notes.current, ['正在写 a.ts']);
    const reqs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { model: string; turn: number; notes: unknown; last: unknown; tools: string[]; hashes: string[] })
      .filter((r) => r.model === 'impl-notes');
    assert.ok(reqs[0]!.tools.includes('notes') && reqs[0]!.tools.includes('history'));
    assert.doesNotMatch(JSON.stringify((reqs[0] as unknown as { system: unknown }).system), /\{\{|playwright/, 'worker 的提示里没有浏览器技能，也没有没填的占位');
    const lastText = (r: { notes: unknown }) => JSON.stringify(r.notes);
    assert.match(lastText(reqs[0]!), /任务 T-001 的笔记[\s\S]*验收：导出 a = 1/, '第一次请求就带着预填的笔记');
    assert.ok(reqs.every((r) => lastText(r) === lastText(reqs[0]!)), '每次请求里是同一条存进会话的笔记，没有每次重新接一条（提示缓存只认追加）');
    assert.match(JSON.stringify(reqs.find((r) => r.turn === 2)!.last), /正在写 a\.ts/, '更新后的笔记在 notes 工具的结果里');
    assert.equal(firstNonAppend(reqs), -1, '每次请求只在上一次的末尾追加（提示缓存只认追加）');
    // history search 的结果作为工具输出出现在第 3 轮请求中（倒数第二条之前），在会话文件里能找到
    const session = readFileSync(p.store.listRuns().find((r) => r.task === 'T-001')!.session_file!, 'utf8');
    assert.match(session, /找到 \d+ 条（共 \d+ 条历史）[\s\S]*forge_claim/);
  } finally {
    p.cleanup();
    process.env['FAKE_LLM_URL'] = prev;
    await local.close();
  }
});
