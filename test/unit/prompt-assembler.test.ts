// 改编自 pi-flow test/unit/prompt-assembler.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAgent, parseAgentFile } from '../../src/core/agents.ts';
import { assemblePrompt, ruleFilesFor, upstreamSection } from '../../src/core/prompt-assembler.ts';
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

test('按 task 的 layers 附上 rules/<层>.md：存在才附上，不存在不算缺失；非法层名忽略', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-rules-'));
  try {
    mkdirSync(path.join(dir, 'rules'));
    writeFileSync(path.join(dir, 'rules/global.md'), 'G1');
    writeFileSync(path.join(dir, 'rules/backend.md'), 'B1');
    const r = ruleFilesFor(config, dir, ['code'], ['backend', 'frontend', '../secret']);
    assert.deepEqual(r.rules.map((x) => x.path), ['rules/global.md', 'rules/backend.md']);
    assert.deepEqual(r.missing, []);
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

test('任务说明：writes 含自己的验收目录（test_author: false）时多一节验收测试说明，系统提示不变', () => {
  const agent = { name: 'worker', tier: 'strong', thinking: null, description: '', prompt: 'ROLE-PROMPT' };
  const plain = mkTask('T-001', { ac: ['REQ-001.AC1', '口头说明'] });
  const own = mkTask('T-001', { ac: ['REQ-001.AC1', '口头说明'], writes: ['src/**', 'tests/acceptance/T-001/**'] });
  const a = assemblePrompt({ agent, rules: [], task: plain, flowId: 'B-001', handoff: '', mode: 'impl', commands: config.commands });
  const b = assemblePrompt({ agent, rules: [], task: own, flowId: 'B-001', handoff: '', mode: 'impl', commands: config.commands });
  assert.equal(a.system, b.system);
  assert.ok(!a.user.includes('验收测试（由你编写）'));
  assert.match(b.user, /## 验收测试（由你编写）[\s\S]*tests\/acceptance\/T-001\/[\s\S]*\[REQ-xxx\.ACn\][\s\S]*- \[REQ-001\.AC1\]/);
  assert.ok(!/- \[口头说明\]/.test(b.user), '只列 AC 编号');
  const review = assemblePrompt({ agent, rules: [], task: own, flowId: 'B-001', handoff: '', mode: 'review', commands: config.commands });
  assert.ok(!review.user.includes('由你编写'));
});

// —— 偏离 99：允许的测试入口与已交付的接口 ——
const ifaceAgent = (name: string) => ({ name, tier: 'strong', thinking: null, description: '', prompt: 'R' });
const ifaceTasks = () => [
  mkTask('T-002', { status: 'done', produces: ['table:teams', 'api:GET /api/teams', 'page:/teams'], test_interface: ['HTTP /api/teams'] }),
  mkTask('T-002.at', { kind: 'acctest', status: 'done', for_task: 'T-002', role: 'test-author', produces: ['api:GET /api/fake'] }),
  mkTask('T-003', { status: 'in_progress', produces: ['api:POST /api/datasources', 'fn:ds#create'], test_interface: ['HTTP /api/datasources*', 'page /datasources'] }),
  mkTask('T-003.at', { kind: 'acctest', for_task: 'T-003', role: 'test-author', test_interface: ['HTTP /api/datasources*', 'page /datasources'] }),
  mkTask('T-004', { status: 'pending', produces: ['api:GET /api/later'] }),
];
const ifaceUser = (role: string, taskId: string, tasks = ifaceTasks()) => assemblePrompt({ agent: ifaceAgent(role), rules: [], task: tasks.find((x) => x.id === taskId)!, flowId: 'B-001', handoff: '', mode: 'impl', commands: config.commands, flowTasks: tasks }).user;

test('任务说明带「允许的测试入口」与「本阶段及之前已交付的接口」：已 done 的 impl 的 api/page，加本 task 自己的 produces', () => {
  const u = ifaceUser('worker', 'T-003');
  assert.match(u, /## 允许的测试入口\n[^\n]*\n- HTTP \/api\/datasources\*\n- page \/datasources/);
  const sec = /## 本阶段及之前已交付的接口\n([\s\S]*?)(?=\n## |\n开始：)/.exec(u)![1]!;
  assert.match(sec, /- api:GET \/api\/teams（T-002）\n- page:\/teams（T-002）\n- api:POST \/api\/datasources（T-003 正在实现）\n- fn:ds#create（T-003 正在实现）/);
  assert.doesNotMatch(sec, /table:teams|api\/fake|api\/later/, '只列 api/page、只列 impl、不列未完成的');
});

test('.at 与 reviewer 用 for_task 的 impl 的 test_interface 和 produces；stage-qa、architect 不输出', () => {
  const at = ifaceUser('test-author', 'T-003.at');
  assert.match(at, /## 允许的测试入口[\s\S]*page \/datasources/);
  assert.match(at, /api:POST \/api\/datasources（T-003 正在实现）/);
  assert.match(ifaceUser('reviewer', 'T-003.at'), /## 本阶段及之前已交付的接口/);
  for (const role of ['stage-qa', 'architect']) assert.doesNotMatch(ifaceUser(role, 'T-003'), /## 允许的测试入口|## 本阶段及之前已交付的接口/, role);
  // test_interface 为空时不输出这一节
  assert.doesNotMatch(ifaceUser('worker', 'T-004'), /## 允许的测试入口/);
});

test('已交付的接口过长时截断并注明总数，本 task 自己的 produces 保留', () => {
  const many = mkTask('T-002', { status: 'done', produces: Array.from({ length: 60 }, (_, i) => `api:GET /api/r${i}`) });
  const cur = mkTask('T-003', { produces: ['api:GET /api/mine'] });
  const u = ifaceUser('worker', 'T-003', [many, cur]);
  assert.match(u, /共 61 项，只列出 40 项/);
  assert.match(u, /api:GET \/api\/mine（T-003 正在实现）/);
  assert.doesNotMatch(u, /api\/r59/);
});

test('上游 handoff 只带最后一次 run 写的段，跳过 dispatcher / engine 等程序段', () => {
  const handoff = [
    '', '## 2026-01-01T00:00:00Z dispatcher', '', '依赖准备失败：codegen 失败 Cannot find module', '',
    '## 2026-01-01T00:10:00Z run:r-1', '', '第一次运行的旧结论', '',
    '## 2026-01-01T00:20:00Z engine', '', '审查要求修改 R-1', '',
    '## 2026-01-01T00:30:00Z run:r-2', '', '最新结论：接口在 src/a.ts', '',
    '## 2026-01-01T00:31:00Z run:r-2', '', '提交说明：完成', '',
    '## 2026-01-01T00:32:00Z forge-submit', '', '提交前清理了文件', '',
  ].join('\n');
  const out = upstreamSection([{ id: 'T-002', title: 'x', type: 'hard', status: '已完成', handoff }]);
  assert.match(out, /最新结论：接口在 src\/a\.ts[\s\S]*提交说明：完成/);
  assert.doesNotMatch(out, /Cannot find module|旧结论|审查要求修改|提交前清理/);
  // 没有 run 写的段：只丢程序段；纯文本原样保留
  const human = '\n## 2026-01-01T00:00:00Z dispatcher\n\n过时\n\n## 2026-01-01T00:01:00Z human\n\n用户回答：用 PG\n';
  const h = upstreamSection([{ id: 'T-002', title: 'x', type: 'soft', status: '已完成', handoff: human }]);
  assert.doesNotMatch(h, /过时/);
  assert.match(h, /用户回答：用 PG/);
  assert.match(upstreamSection([{ id: 'T-002', title: 'x', type: 'soft', status: '已完成', handoff: '纯文本笔记' }]), /纯文本笔记/);
});
