// 改编自 pi-flow test/unit/prompt-assembler.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAgent, parseAgentFile } from '../../src/core/agents.ts';
import { assemblePrompt, ruleFilesFor } from '../../src/core/prompt-assembler.ts';
import { parseConfig } from '../../src/core/config.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { mkTask } from '../helpers/tasks.ts';
const PACKAGE_ROOT = new URL('../..', import.meta.url).pathname;

const config = parseConfig(TEST_YAML);
const PKG_AGENTS = path.join(PACKAGE_ROOT, 'agents');

test('解析角色文件；项目 .pi/agents 覆盖包内定义', () => {
  const a = parseAgentFile('---\nname: x\ntier: strong\nthinking: high\n---\n\n正文\n', 'x.md');
  assert.equal(a.name, 'x');
  assert.equal(a.tier, 'strong');
  assert.equal(a.thinking, 'high');
  assert.equal(a.prompt, '正文');
  assert.throws(() => parseAgentFile('没有 frontmatter', 'y.md'), /frontmatter/);
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-ag-'));
  try {
    assert.match(loadAgent('worker', dir, PKG_AGENTS).prompt, /你负责一个 task/);
    mkdirSync(path.join(dir, '.pi/agents'), { recursive: true });
    writeFileSync(path.join(dir, '.pi/agents/worker.md'), '---\nname: worker\n---\n项目自定义\n');
    assert.equal(loadAgent('worker', dir, PKG_AGENTS).prompt, '项目自定义');
    assert.throws(() => loadAgent('ghost', dir, PKG_AGENTS), /ghost/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('规则按 global + 任务 scopes 选择，缺失的文件报告出来', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-rules-'));
  try {
    mkdirSync(path.join(dir, 'rules'));
    writeFileSync(path.join(dir, 'rules/global.md'), 'G1');
    writeFileSync(path.join(dir, 'rules/backend.md'), 'B1');
    // 测试专用规则声明：沿用真实 code scope，验证去重、选中与缺失报告。
    const scoped = parseConfig(TEST_YAML);
    scoped.raw.scopes.code!.rules!.push('rules/backend.md', 'rules/shared-types.md');
    const r = ruleFilesFor(scoped, dir, ['code', 'review']);
    assert.deepEqual(r.rules.map((x) => x.path), ['rules/global.md', 'rules/backend.md']);
    assert.deepEqual(r.missing, ['rules/shared-types.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('提示组装顺序：角色提示 → 规则 → 任务与输入 → handoff 与打回意见；稳定前缀与任务无关', () => {
  const agent = { name: 'worker', tier: 'strong', thinking: null, description: '', prompt: 'ROLE-PROMPT' };
  const rules = [{ path: 'rules/global.md', content: 'RULE-G' }, { path: 'rules/backend.md', content: 'RULE-B' }];
  const t1 = mkTask('T-001', { title: '导出 API', ac: ['POST /exports 参数非法返回 422'], inputs: ['docs/contracts/export.ts'],
    last_failure: 'src/a.ts:3 缺少校验，应返回 422', base_sha: 'abc123' });
  const p1 = assemblePrompt({ agent, rules, task: t1, flowId: 'B-001', handoff: '## 上次做到 X', mode: 'impl', commands: config.commands });
  const p2 = assemblePrompt({ agent, rules, task: mkTask('T-002'), flowId: 'B-001', handoff: '', mode: 'impl', commands: config.commands });
  assert.equal(p1.system, p2.system, '稳定前缀不应随任务变化');
  const order = ['ROLE-PROMPT', 'RULE-G', 'RULE-B'].map((s) => p1.system.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order[0]! >= 0);
  const u = p1.user;
  const idx = ['T-001', '导出 API', 'POST /exports', 'docs/contracts/export.ts', 'src/server/t-001/**', 'pnpm test', '## 上次做到 X', '缺少校验']
    .map((s) => u.indexOf(s));
  assert.ok(idx.every((i) => i >= 0), JSON.stringify(idx));
  assert.ok(idx.indexOf(Math.max(...idx)) === idx.length - 1, '打回意见应在最后');
  assert.ok(u.indexOf('forge_claim') >= 0);
  assert.ok(!p1.system.includes('T-001'));
});

test('返工接着上一次的对话：用户消息只有续做说明，系统提示不变', () => {
  const agent = { name: 'worker', tier: 'strong', thinking: null, description: '', prompt: 'R' };
  const task = mkTask('T-001', { base_sha: 'abc123', last_failure: '审查前验证失败：test 退出码 1' });
  const base = { agent, rules: [], task, flowId: 'B-001', handoff: 'HANDOFF', mode: 'impl' as const, commands: config.commands, scratchDir: '/tmp/s/r-2' };
  const full = assemblePrompt(base);
  const cont = assemblePrompt({ ...base, continuation: { run: 'r-1' } });
  assert.equal(cont.system, full.system, '系统提示相同，命中缓存');
  assert.match(cont.user, /^# 继续任务 B-001\/T-001[\s\S]*r-1[\s\S]*审查前验证失败：test 退出码 1[\s\S]*\/tmp\/s\/r-2[\s\S]*forge_claim/);
  assert.doesNotMatch(cont.user, /验收标准|HANDOFF/, '任务说明与 handoff 已在对话里，不重复');
  assert.ok(cont.user.length < full.user.length);
});

test('重新派发时提示工作区已有的改动，位于任务说明之后、handoff 之前', () => {
  const agent = { name: 'worker', tier: 'strong', thinking: null, description: '', prompt: 'R' };
  const p = assemblePrompt({ agent, rules: [], task: mkTask('T-001', { base_sha: 'abc123' }), flowId: 'B-001', handoff: 'HANDOFF', mode: 'impl',
    commands: config.commands, existingWork: ' src/server/t-001/a.ts | 3 +++\n\n未提交：\n?? src/server/t-001/b.ts' });
  const iWork = p.user.indexOf('## 工作区已有的改动');
  assert.ok(iWork > p.user.indexOf('## 可写范围') && iWork < p.user.indexOf('HANDOFF'));
  assert.match(p.user, /git diff abc123[\s\S]*b\.ts/);
});

test('登记的公共文件显示在可写范围里并注明只做必要的追加', () => {
  const agent = { name: 'worker', tier: 'strong', thinking: null, description: '', prompt: 'I' };
  const p = assemblePrompt({ agent, rules: [], task: mkTask('T-001', { shared: ['src/routes.ts'] }), flowId: 'B-001', handoff: '', mode: 'impl', commands: config.commands });
  assert.match(p.user, /## 可写范围（writes）\n- src\/server\/t-001\/\*\*\n- src\/routes\.ts（登记的公共文件/);
});
