// 第 11.1 节：阶段验收覆盖率（矩阵、渲染、报告提交、补测轮次）与实施阶段程序检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageMatrix, createCoverageRounds, renderCoverageMarkdown, stageCoverage, writeCoverageReport } from '../../src/core/coverage.ts';
import { createCoverageGapRound, gateFailed, gateIssues, MAX_GATE_ROUNDS, runImplementationChecks } from '../../src/core/gates.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { Requirement } from '../../src/core/spec.ts';

const req = (id: string, priority: 'MVP' | 'LATER', acs: [string, boolean][]) => ({ id, priority, acs: acs.map(([a, manual]) => ({ id: a, manual, text: `${a} 的内容`, line: 1 })) }) as Pick<Requirement, 'id' | 'priority' | 'acs'>;
const REQS = [req('REQ-001', 'MVP', [['AC1', false], ['AC2', false], ['AC3', true]]), req('REQ-002', 'LATER', [['AC1', false]]), req('REQ-003', 'MVP', [['AC1', false]])];
const TASKS = [
  { id: 'T-001', kind: 'impl', status: 'done', ac: ['REQ-001.AC1', 'REQ-001.AC2'] },
  { id: 'T-002', kind: 'impl', status: 'cancelled', ac: ['REQ-003.AC1'] },
  { id: 'T-003', kind: 'impl', status: 'done', ac: ['REQ-003.AC1'] },
] as const;

test('coverageMatrix：只算 exit 里 MVP 且非 manual 的 AC，owner 忽略 cancelled，files 来自标签', () => {
  const rows = coverageMatrix({ reqs: REQS, exit: ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-404'], tasks: TASKS, tests: new Map([['REQ-001.AC1', ['tests/acceptance/T-001/a.test.ts']]]) });
  assert.deepEqual(rows.map((r) => r.ac), ['REQ-001.AC1', 'REQ-001.AC2', 'REQ-003.AC1']);
  assert.deepEqual(rows.map((r) => r.owner), ['T-001', 'T-001', 'T-003']);
  assert.deepEqual(rows.map((r) => r.files.length), [1, 0, 0]);
});

test('coverageMatrix：exit 外的需求不计；没有 task 认领的 AC 没有 owner', () => {
  const rows = coverageMatrix({ reqs: REQS, exit: ['REQ-003'], tasks: [], tests: new Map() });
  assert.deepEqual(rows, [{ req: 'REQ-003', ac: 'REQ-003.AC1', text: 'AC1 的内容', files: [] }]);
});

test('renderCoverageMarkdown：表格与缺口汇总', () => {
  const md = renderCoverageMarkdown('S1', '登录', [
    { req: 'REQ-001', ac: 'REQ-001.AC1', text: 'a | b', owner: 'T-001', files: ['tests/acceptance/T-001/a.test.ts'] },
    { req: 'REQ-001', ac: 'REQ-001.AC2', text: 'c', files: [] },
  ]);
  assert.match(md, /# 阶段 S1 验收覆盖/);
  assert.match(md, /\| REQ-001 \| REQ-001\.AC1 \| a \\\| b \| T-001 \| `tests\/acceptance\/T-001\/a\.test\.ts` \|/);
  assert.match(md, /\*\*缺口\*\*/);
  assert.match(md, /缺口：1 \/ 2 条 AC 没有带编号的验收测试：REQ-001\.AC2/);
  assert.match(renderCoverageMarkdown('S1', 'x', []), /本阶段没有需要自动验收的 AC/);
  assert.match(renderCoverageMarkdown('S1', 'x', [{ req: 'R', ac: 'R.AC1', files: ['f'] }]), /缺口：无（1 条/);
});

const SPEC = {
  'docs/spec/requirements.md': '# 需求\n\n## 需求清单\n### REQ-001 登录 [MVP]\n角色：成员\n- AC1：Given 已注册 When 登录 Then 成功\n- AC2：Given 密码错误 When 登录 Then 失败\n- AC3（manual）：界面好看\n\n### REQ-002 导出 [LATER]\n角色：成员\n- AC1：Given 有数据 When 导出 Then 得到文件\n',
  'docs/spec/screens.md': '# 页面\n', 'docs/spec/permissions.md': '# 权限\n', 'docs/spec/glossary.md': '# 术语\n',
  'tests/acceptance/T-001/login.test.ts': "test('[REQ-001.AC1] 登录成功', () => {});\n",
  'src/server/t-001/a.ts': 'export const a = 1;\n',
};

async function project(extra: Record<string, string> = {}) {
  const p = await setupProject({ stages: ['S1'], files: { ...SPEC, ...extra }, tasks: [mkTask('T-001', { stage: 'S1', status: 'done', ac: ['REQ-001.AC1', 'REQ-001.AC2'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '登录', exit: ['REQ-001', 'REQ-002'] }], 'standard');
  return p;
}

test('stageCoverage：从集成分支读规格与验收测试，缺口就是没有标签的 AC', async () => {
  const p = await project();
  try {
    const r = stageCoverage(p.dir, p.store, p.config, p.flowId, 'S1', p.store.readFlow(p.flowId).integration_branch);
    assert.deepEqual(r.rows.map((x) => [x.ac, x.files.length, x.owner]), [['REQ-001.AC1', 1, 'T-001'], ['REQ-001.AC2', 0, 'T-001']]);
    assert.deepEqual(r.gaps.map((x) => x.ac), ['REQ-001.AC2']);
    assert.match(r.markdown, /REQ-001\.AC2/);
    assert.throws(() => stageCoverage(p.dir, p.store, p.config, p.flowId, 'S9', 'main'), /没有阶段 S9/);
  } finally { p.cleanup(); }
});

test('writeCoverageReport：提交到 docs/qa/<stage>.md，内容不变不再提交', async () => {
  const p = await project();
  try {
    const branch = p.store.readFlow(p.flowId).integration_branch;
    const before = p.git('rev-parse', branch);
    const h1 = await writeCoverageReport(p.dir, p.store, p.flowId, 'S1', '# 报告\n');
    assert.notEqual(h1, before);
    assert.equal(p.git('show', `${branch}:docs/qa/S1.md`), '# 报告');
    assert.equal(await writeCoverageReport(p.dir, p.store, p.flowId, 'S1', '# 报告\n'), h1);
  } finally { p.cleanup(); }
});

test('createCoverageRounds：每个 owner 一个 .at-n（kind coverage），进行中的跳过，无主的返回', async () => {
  const p = await project();
  try {
    const gaps = [
      { req: 'REQ-001', ac: 'REQ-001.AC2', text: '密码错误', owner: 'T-001', files: [] },
      { req: 'REQ-005', ac: 'REQ-005.AC1', files: [] },
    ];
    const r = await createCoverageRounds(p.store, p.flowId, gaps);
    assert.deepEqual(r.tasks, ['T-001.at-2']);
    assert.deepEqual(r.unowned.map((x) => x.ac), ['REQ-005.AC1']);
    const t = p.store.readTask(p.flowId, 'T-001.at-2');
    assert.equal(t.kind, 'acctest');
    assert.equal(t.acctest_round?.kind, 'coverage');
    assert.match(p.store.readHandoff(p.flowId, 'T-001.at-2'), /补充 AC 的测试[\s\S]*REQ-001\.AC2：密码错误/);
    // 上一轮还没结束：跳过
    const again = await createCoverageRounds(p.store, p.flowId, gaps);
    assert.deepEqual([again.tasks, again.skipped], [[], ['T-001']]);
  } finally { p.cleanup(); }
});

test('createCoverageGapRound：记一轮 coverage，与门禁修复共用轮次上限', async () => {
  const p = await project();
  try {
    const gap = [{ req: 'REQ-001', ac: 'REQ-001.AC2', owner: 'T-001', files: [] }];
    const r = await createCoverageGapRound(p.store, p.flowId, gap);
    assert.deepEqual(r.tasks, ['T-001.at-2']);
    assert.deepEqual(p.store.readFlow(p.flowId).gate_rounds?.map((x) => [x.stage, x.command, x.tasks]), [['S1', 'coverage', ['T-001.at-2']]]);
    await p.store.addGateRound(p.flowId, { stage: 'S1', command: 'test', tasks: [], at: new Date().toISOString() }, [], {});
    assert.equal(p.store.readFlow(p.flowId).gate_rounds!.length, MAX_GATE_ROUNDS);
    const last = await createCoverageGapRound(p.store, p.flowId, gap);
    assert.deepEqual(last.tasks, []);
    assert.match(last.reason ?? '', /2 轮/);
  } finally { p.cleanup(); }
});

test('runImplementationChecks：命令通过后写覆盖报告并返回缺口，不迁移阶段', async () => {
  const p = await project();
  try {
    const before = p.store.readFlow(p.flowId);
    const r = await runImplementationChecks(p.dir, p.store, p.config, p.flowId);
    assert.equal(r.passed, false);
    assert.deepEqual(r.reasons, ['覆盖率缺口：REQ-001.AC2']);
    assert.equal(r.failed, undefined);
    assert.deepEqual(r.coverage?.gaps.map((g) => g.ac), ['REQ-001.AC2']);
    const branch = before.integration_branch;
    assert.equal(r.head, p.git('rev-parse', branch));
    assert.match(p.git('show', `${branch}:docs/qa/S1.md`), /REQ-001\.AC2/);
    const after = p.store.readFlow(p.flowId);
    assert.equal(after.stage_status, before.stage_status);
    assert.equal(after.stage, before.stage);
  } finally { p.cleanup(); }
});

test('runImplementationChecks：覆盖齐全则通过；命令失败不算覆盖率', async () => {
  const p = await project({ 'tests/acceptance/T-001/more.test.ts': "test('[REQ-001.AC2] 失败', () => {});\n" });
  try {
    const ok = await runImplementationChecks(p.dir, p.store, p.config, p.flowId);
    assert.equal(ok.passed, true);
    assert.deepEqual(ok.coverage?.gaps, []);
  } finally { p.cleanup(); }
  const bad = await project({ 'src/server/t-001/a.ts': 'FAIL\n' });
  try {
    const r = await runImplementationChecks(bad.dir, bad.store, bad.config, bad.flowId);
    assert.equal(r.passed, false);
    assert.equal(r.failed?.command, 'test');
    assert.equal(r.coverage, undefined);
    assert.ok(!bad.git('ls-tree', '-r', '--name-only', bad.store.readFlow(bad.flowId).integration_branch).includes('docs/qa/S1.md'));
  } finally { bad.cleanup(); }
});

test('gateIssues：验收测试目录归该 impl 并沿用它的 writes；普通文件按 writes 归属；测试文件不当作 worker 的文件', () => {
  const tasks = [mkTask('T-001'), mkTask('T-002', { writes: ['src/b/**'] })];
  const tracked = new Set(['src/b/x.ts', 'tests/acceptance/T-001/a.test.ts']);
  const out = 'FAIL tests/acceptance/T-001/a.test.ts\n at src/b/x.ts:3\n  tests/acceptance/T-404/z.test.ts';
  const issues = gateIssues({ command: 'test', output: out }, tasks, tracked);
  assert.deepEqual(issues.map((i) => [i.owner, i.files, i.writes]), [['T-001', [], ['src/server/t-001/**']], [undefined, ['src/b/x.ts'], undefined]]);
  assert.match(issues[0]!.text, /全量 test 失败/);
  assert.deepEqual(gateIssues({ command: 'test', output: 'boom' }, tasks, tracked), []);
});

test('gateFailed：生成 .fx-n（验收测试失败时 writes 为 impl 的 writes）并记一轮；满轮次或定位不到时给原因', async () => {
  const p = await project();
  try {
    const d = { root: p.dir, store: p.store, config: p.config };
    const none = await gateFailed(d, p.flowId, { command: 'test', output: 'boom' });
    assert.deepEqual(none.tasks, []);
    assert.match(none.reason ?? '', /无法从日志定位/);
    assert.equal(p.store.readFlow(p.flowId).gate_rounds, undefined);
    const r = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-001/login.test.ts > [REQ-001.AC1]' });
    assert.deepEqual(r.tasks, ['T-001.fx-1']);
    const fx = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual(fx.writes, ['src/server/t-001/**']);
    assert.equal(fx.for_task, 'T-001');
    assert.deepEqual(p.store.readFlow(p.flowId).gate_rounds?.map((x) => [x.command, x.tasks]), [['acceptance', ['T-001.fx-1']]]);
    const r2 = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-001/login.test.ts' });
    assert.deepEqual(r2.tasks, ['T-001.fx-2']);
    const r3 = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-001/login.test.ts' });
    assert.deepEqual(r3.tasks, []);
    assert.match(r3.reason ?? '', /2 轮后仍失败/);
  } finally { p.cleanup(); }
});

test('createCoverageGapRound：selfTest（test_author: false）给 impl 建 .fx-n，写自己的验收目录，不建 .at-n', async () => {
  const p = await project();
  try {
    const gaps = [
      { req: 'REQ-001', ac: 'REQ-001.AC2', text: '密码错误', owner: 'T-001', files: [] },
      { req: 'REQ-005', ac: 'REQ-005.AC1', files: [] },
    ];
    const r = await createCoverageGapRound(p.store, p.flowId, gaps, true);
    assert.deepEqual(r.tasks, ['T-001.fx-1']);
    assert.deepEqual(r.unowned.map((x) => x.ac), ['REQ-005.AC1']);
    const t = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual([t.kind, t.role, t.for_task, t.title, t.fork_from_task], ['fix', 'worker', 'T-001', '补齐 AC 编号的验收测试', 'T-001']);
    assert.ok(t.writes.includes('tests/acceptance/T-001/**'));
    assert.ok(t.writes.includes('src/server/t-001/**'), '补测时也可以改实现：writes 同 impl');
    assert.deepEqual(t.ac, ['REQ-001.AC2']);
    assert.match(p.store.readHandoff(p.flowId, 'T-001.fx-1'), /补齐验收测试[\s\S]*REQ-001\.AC2：密码错误/);
    assert.ok(!p.store.listTasks(p.flowId).some((x) => x.kind === 'acctest'));
    assert.deepEqual(p.store.readFlow(p.flowId).gate_rounds?.map((x) => [x.command, x.tasks]), [['coverage', ['T-001.fx-1']]]);
    // 上一个 .fx-n 还没结束：跳过
    const again = await createCoverageRounds(p.store, p.flowId, gaps, 'engine', true);
    assert.deepEqual([again.tasks, again.skipped], [[], ['T-001']]);
  } finally { p.cleanup(); }
});
