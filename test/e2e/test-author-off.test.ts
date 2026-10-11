// 偏离 81（M9 的 A1 臂）：implementation_gate.test_author 为 false 时没有 .at，worker 自己写 tests/acceptance/<T>/ 下的验收测试。
// fake-subagent 经真实的引擎、SubagentRuntime 与工具操作。覆盖：一个阶段跑通（worker 提交测试、预检跑了它、合入、覆盖率通过）；
// 覆盖缺口不生成 .at-n，改为给 impl 建 .fx-n（补齐 AC 编号的验收测试），修好后阶段通过；别的 task 的验收目录仍然写不进去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { P0_SPEC } from '../helpers/spec.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';

const REQS = P0_SPEC.requirements.replace('- AC1：Given 已登录 When 创建看板 Then 返回看板编号', '- AC1：Given 已登录 When 创建看板 Then 返回看板编号\n- AC2：Given 名称为空 When 创建看板 Then 返回 400');
const FILES = Object.fromEntries(Object.entries({ ...P0_SPEC, requirements: REQS }).map(([k, v]) => [`docs/spec/${k}.md`, v]));
const OUT = mkdtempSync(path.join(tmpdir(), 'pi-forge-selftest-'));
const LOG = path.join(OUT, 'acc.log');
// 预检的 acceptance 命令是 `<命令> -- T-001`：这里把它记下来，并要求测试文件已经在 worktree 里
const YAML = PROJECT_YAML.replace('acceptance: "true"', `acceptance: "test -f tests/acceptance/T-001/a.test.ts && echo ran >> ${LOG}"`).replace(/^  qa: false$/m, '  qa: false\n  test_author: false');
const impl = mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1', 'REQ-001.AC2'], writes: ['src/server/t-001/**', 'tests/acceptance/T-001/**'] });
const AC1_TEST = "test('[REQ-001.AC1] 返回编号', () => {});\n";
const AC2_TEST = "test('[REQ-001.AC2] 名称为空返回 400', () => {});\n";

async function project(): Promise<Project> {
  const p = await setupProject({ yaml: YAML, files: FILES, stages: ['S1'], tasks: [impl] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  return p;
}

test('test_author: false：worker 自己提交 src 与验收测试，预检跑了它的测试，合入后覆盖率通过，没有 .at', async () => {
  const p = await project();
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    assert.equal(role, 'worker');
    assert.equal(a.env.task, 'T-001');
    assert.match(p.store.readTask(p.flowId, 'T-001').writes.join(), /tests\/acceptance\/T-001\/\*\*/);
    const d = await a.call('forge_dispute', { test: 'tests/acceptance/T-001/a.test.ts', reason: 'x', evidence: 'docs/spec/requirements.md#REQ-001' });
    assert.ok(!d.ok && /没有争议流程/.test(d.text), d.text);
    await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n', 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST });
    return submitWork(a, '实现并写验收测试');
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'acctest'), '没有 .at / .at-n');
    assert.ok(existsSync(LOG) && /ran/.test(readFileSync(LOG, 'utf8')), '预检运行了 acceptance');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    assert.match(p.git('show', `${integ}:tests/acceptance/T-001/a.test.ts`), /REQ-001\.AC2/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(p.git('show', `${integ}:docs/qa/S1.md`), /缺口：无/);
  } finally { p.cleanup(); }
});

test('test_author: false：覆盖缺口建 .fx-n（补齐 AC 编号的验收测试，writes 含自己的验收目录），不建 .at-n；补齐后阶段通过', async () => {
  const p = await project();
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') return submitWork(a, '只写了 AC1 的测试', { 'src/server/t-001/a.ts': 'ok\n', 'tests/acceptance/T-001/a.test.ts': AC1_TEST });
    assert.equal(id, 'T-001.fx-1');
    assert.match(p.store.readHandoff(p.flowId, id), /补齐验收测试[\s\S]*REQ-001\.AC2/);
    // 只能写自己的验收目录：别的 task 的目录被工具层拒绝
    assert.equal((await a.call('write', { path: 'tests/acceptance/T-002/x.test.ts', content: AC2_TEST })).ok, false);
    return submitWork(a, '补上 AC2', { 'tests/acceptance/T-001/b.test.ts': AC2_TEST });
  });
  try {
    await drive(e, p.flowId, 30);
    assert.deepEqual(e.errors, []);
    const fx = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual([fx.kind, fx.status, fx.title, fx.for_task], ['fix', 'done', '补齐 AC 编号的验收测试', 'T-001']);
    assert.ok(fx.writes.includes('tests/acceptance/T-001/**'));
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'acctest'), '没有 .at-n');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    assert.match(p.git('show', `${integ}:docs/qa/S1.md`), /缺口：无/);
  } finally { p.cleanup(); }
});

// 偏离 107：test_author 关闭时，合并验证里失败的验收目录不属于当前 task（此前流程留下的 legacy），不建 .at-n，
// 程序把该目录加进当前 task（impl 或 fix）的 writes 退回 worker，worker 自己按新需求改旧测试。
// 旧测试里有 OLD 且 src/server/t-001/b.ts 存在时 acceptance 失败（模拟"新需求让旧断言过时"）。
const ACC_SH = 'd=tests/acceptance; [ "$1" = "--" ] && d="tests/acceptance/$2"; for f in $(find $d -name "*.test.ts"); do if grep -q OLD "$f" && test -f src/server/t-001/b.ts; then echo "FAIL $f"; exit 1; fi; done\n';
const LEGACY_YAML = PROJECT_YAML.replace('acceptance: "true"', 'acceptance: "sh tests/acc.sh"').replace(/^  qa: false$/m, '  qa: false\n  test_author: false');
const OLD_TEST = "test('[REQ-009.AC1] OLD 旧行为', () => {});\n";
const NEW_TEST = "test('[REQ-009.AC1] 按新需求调整', () => {});\n";

async function legacyProject(): Promise<Project> {
  const p = await setupProject({ yaml: LEGACY_YAML, files: { ...FILES, 'tests/acc.sh': ACC_SH, 'tests/acceptance/T-009/old.test.ts': OLD_TEST }, stages: ['S1'], tasks: [impl] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  return p;
}

async function expectLegacyRework(p: Project, a: { call: (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> }, id: string): Promise<void> {
  const t = p.store.readTask(p.flowId, id);
  assert.ok(t.writes.includes('tests/acceptance/T-009/**'), t.writes.join());
  assert.match(p.store.readHandoff(p.flowId, id), /tests\/acceptance\/T-009\/[\s\S]*不能删用例[\s\S]*FAIL tests\/acceptance\/T-009\/old\.test\.ts/);
  const r = await a.call('forge_dispute', { test: 'tests/acceptance/T-009/old.test.ts', reason: 'x', evidence: 'docs/spec/requirements.md#REQ-001' });
  assert.ok(!r.ok && /已在你的可写范围内/.test(r.text), r.text);
  await writeFiles(a as never, { 'tests/acceptance/T-009/old.test.ts': NEW_TEST });
}

test('偏离 107：test_author 关闭，impl 合并验证时旧流程的验收目录失败 → 加进 impl 的 writes 退回 worker，改旧测试后合入，不建 .at-n', async () => {
  const p = await legacyProject();
  let n = 0;
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    assert.equal(role, 'worker');
    n++;
    if (n === 1) return submitWork(a, '实现并写测试', { 'src/server/t-001/a.ts': 'ok\n', 'src/server/t-001/b.ts': 'ok\n', 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST });
    await expectLegacyRework(p, a, 'T-001');
    return submitWork(a, '旧测试按新需求调整');
  });
  try {
    await drive(e, p.flowId, 30);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done', p.store.readTask(p.flowId, 'T-001').blocked_reason ?? undefined);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'acctest'), '没有 .at-n');
    assert.doesNotMatch(p.git('show', `${p.store.readFlow(p.flowId).integration_branch}:tests/acceptance/T-009/old.test.ts`), /OLD/);
  } finally { p.cleanup(); }
});

test('偏离 107：test_author 关闭，.fx-n 合并验证时旧流程的验收目录失败 → 加进 fix 的 writes 退回 worker，改旧测试后合入，不建 .at-n', async () => {
  const p = await legacyProject();
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') return submitWork(a, '只写了 AC1 的测试', { 'src/server/t-001/a.ts': 'ok\n', 'tests/acceptance/T-001/a.test.ts': AC1_TEST });
    assert.equal(id, 'T-001.fx-1');
    if (!p.store.readTask(p.flowId, id).writes.includes('tests/acceptance/T-009/**')) {
      return submitWork(a, '补上 AC2', { 'src/server/t-001/b.ts': 'ok\n', 'tests/acceptance/T-001/b.test.ts': AC2_TEST });
    }
    await expectLegacyRework(p, a, id);
    return submitWork(a, '旧测试按新需求调整');
  });
  try {
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001.fx-1').status, 'done');
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'acctest'), '没有 .at-n');
    assert.doesNotMatch(p.git('show', `${p.store.readFlow(p.flowId).integration_branch}:tests/acceptance/T-009/old.test.ts`), /OLD/);
  } finally { p.cleanup(); }
});
