// M4：争议的三种结果（第 9.3 节）与别的 task 的验收测试被破坏（第 9.4 节）。fake-subagent 经真实的 SubagentRuntime 操作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { hard, mkTask } from '../helpers/tasks.ts';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';

// 验收测试里有 STRICT 时 acceptance 失败（模拟"太紧"的测试）
const YAML = PROJECT_YAML.replace('acceptance: "true"', 'acceptance: "sh tests/acc.sh"');
const FILES = {
  // acceptance -- <task> 只跑该 task 的目录（预检）；不带参数跑全部（合并）
  'tests/acc.sh': 'd=tests/acceptance; [ "$1" = "--" ] && d="tests/acceptance/$2"; for f in $(find $d -name "*.test.ts"); do if grep -q STRICT "$f" || { grep -q BRITTLE "$f" && test -f src/server/t-001/a.ts; }; then echo "FAIL $f"; exit 1; fi; done\n',
  'docs/spec/requirements.md': '# 需求\n\n### REQ-001 创建数据源 [MVP]\n- AC1：Given 登录 When 创建 Then 成功\n',
};
const at = (impl: string, deps = [] as ReturnType<typeof hard>[]) => mkTask(`${impl}.at`, {
  kind: 'acctest', role: 'test-author', scopes: ['acctest'], for_task: impl, verify: [], ac: ['REQ-001.AC1'], depends_on: deps,
  writes: [`tests/acceptance/${impl}/**`, `tests/acceptance/_support/${impl}/**`],
});


/** 测试配置关闭了自动派发：反复 next 直到没有新的派发 */

type Outcome = 'fix' | 'uphold' | 'escalate';
async function disputeFlow(outcome: Outcome) {
  const p = await setupProject({ yaml: YAML, files: FILES, tasks: [mkTask('T-001', { ac: ['REQ-001.AC1'] }), at('T-001')] });
  const runs: Record<string, number> = {};
  const seen: string[] = [];
  const e = engineEnv(p, async (role, _nth, a) => {
    const id = a.env.task;
    const n = (runs[id] = (runs[id] ?? 0) + 1);
    const claim = await a.call('forge_claim');
    if (role === 'worker' && id === 'T-001') {
      if (n === 1) { await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' }); await submitWork(a, '实现完成'); return; }
      if (n === 2) {
        seen.push(claim.text);
        const r = await a.call('forge_dispute', { test: 'tests/acceptance/T-001/a.test.ts', reason: '规格没有要求 STRICT', evidence: 'docs/spec/requirements.md#REQ-001' });
        assert.ok(r.ok, r.text);
        return;
      }
      seen.push(p.store.readHandoff(p.flowId, 'T-001'));
      await a.call('forge_block', { reason: '测试到此为止' });
      return;
    }
    assert.equal(role, 'test-author');
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': "test('[REQ-001.AC1] STRICT', () => {});\n" }); await submitWork(a, '覆盖 AC1'); return; }
    if (id === 'T-001.at-2') {
      if (outcome === 'escalate') { await a.call('forge_block', { reason: '规格没写清楚是否 STRICT' }); return; }
      if (outcome === 'fix') await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': "test('[REQ-001.AC1] 创建成功', () => {});\n" });
      await submitWork(a, outcome === 'fix' ? '去掉了规格没要求的断言' : '维持：docs/spec/requirements.md#REQ-001 要求 STRICT');
      return;
    }
    assert.equal(id, 'T-001.at-3');
    await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': "test('[REQ-001.AC1] 按用户说明', () => {});\n" });
    await submitWork(a, '按用户说明修改');
  });
  return { p, e, seen };
}

test('争议 → test-author 改测试：dispute_fixed 直接重跑预检，不再派 worker，合并', async () => {
  const { p, e, seen } = await disputeFlow('fix');
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.match(seen[0]!, /预检未通过：验收测试/);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done');
    assert.deepEqual(t.disputes, { 'tests/acceptance/T-001/a.test.ts': 1 });
    assert.equal(p.store.readTask(p.flowId, 'T-001.at-2').fork_from_task, 'T-001.at', '接着上一个 test-author 的会话');
    assert.ok(p.store.readEvents().some((ev) => ev.task === 'T-001' && ev.trigger === 'dispute_fixed'));
    assert.equal(e.launcher.launched.filter((s) => s.env['PI_FORGE_TASK'] === 'T-001').length, 2);
  } finally { p.cleanup(); }
});

test('争议 → test-author 维持测试：dispute_upheld 接着 worker 的会话，handoff 里附上理由', async () => {
  const { p, e, seen } = await disputeFlow('uphold');
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.ok(p.store.readEvents().some((ev) => ev.task === 'T-001' && ev.trigger === 'dispute_upheld'));
    assert.match(seen.at(-1)!, /争议结论：维持测试（T-001\.at-2）[\s\S]*要求 STRICT/);
    assert.equal(p.store.readTask(p.flowId, 'T-001.at-2').changed_tests, false);
  } finally { p.cleanup(); }
});

test('争议 → test-author 交给用户：impl 阻塞（dispute）；/forge-decide fix-test 取消旧轮次、派 .at-3，改好后重跑预检并合并', async () => {
  const { p, e } = await disputeFlow('escalate');
  try {
    await drive(e, p.flowId);
    let t = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([t.status, t.blocked_by], ['blocked', 'dispute']);
    await assert.rejects(runFlowCommand('decide T-001 fix-test', e.cmd), /fix-test 需要写明/);
    assert.match(await runFlowCommand('decide T-001 fix-test "去掉 STRICT"', e.cmd), /已派 T-001\.at-3/);
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001.at-2').status, 'cancelled');
    assert.equal(p.store.readTask(p.flowId, 'T-001.at-3').acctest_round?.kind, 'decide');
    t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done');
  } finally { p.cleanup(); }
});

test('争议的依据必须引用规格或契约的具体位置；不是本 task 的测试不能争议', async () => {
  const p = await setupProject({ yaml: YAML, files: FILES, tasks: [mkTask('T-001', { ac: ['REQ-001.AC1'] })] });
  const results: { ok: boolean; text: string }[] = [];
  const e = engineEnv(p, async (_role, _nth, a) => {
    await a.call('forge_claim');
    results.push(await a.call('forge_dispute', { test: 'tests/acceptance/T-009/x.test.ts', reason: 'x', evidence: 'docs/spec/requirements.md' }));
    results.push(await a.call('forge_dispute', { test: '[REQ-001.AC1] 创建', reason: 'x', evidence: '我觉得不对' }));
    results.push(await a.call('forge_dispute', { test: '[REQ-001.AC1] 创建', reason: 'x', evidence: 'src/server/t-001/a.ts:1' }));
    await a.call('forge_block', { reason: '到此为止' });
  });
  try {
    await drive(e, p.flowId, 2);
    assert.match(results[0]!.text, /只能对本 task 的验收测试提出争议/);
    assert.match(results[1]!.text, /规格或契约的具体位置/);
    assert.equal(results[2]!.ok, false);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'blocked');
  } finally { p.cleanup(); }
});

test('第 9.4 节：合并时别的 task 的验收测试失败 → 为它建 .at-n，当前 task 回 awaiting_inputs 等待、不计失败；修好后合并', async () => {
  // 默认的 test 命令要求 T-001 的文件，先合并的 T-002 过不了预检
  const p = await setupProject({ yaml: YAML.replace(/  test:      ".*"/, '  test:      "true"'), files: FILES, tasks: [
    mkTask('T-002', { ac: ['REQ-001.AC1'] }), at('T-002'),
    mkTask('T-001', { ac: ['REQ-001.AC1'], deps: [hard('T-002')] }), at('T-001', [hard('T-002')]),
  ] });
  const e = engineEnv(p, async (role, _nth, a) => {
    const id = a.env.task;
    await a.call('forge_claim');
    if (role === 'worker') {
      await writeFiles(a, { [`src/server/${id.toLowerCase()}/a.ts`]: 'ok\n' });
      await submitWork(a, `${id} 完成`);
      return;
    }
    if (id === 'T-002.at') { await writeFiles(a, { 'tests/acceptance/T-002/b.test.ts': "test('[REQ-001.AC1] BRITTLE 精确相等', () => {});\n" }); await submitWork(a, 'AC1'); return; }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': "test('[REQ-001.AC1] ok', () => {});\n" }); await submitWork(a, 'AC1'); return; }
    assert.equal(id, 'T-002.at-2');
    assert.match(p.store.readHandoff(p.flowId, id), /被 T-001 的改动破坏[\s\S]*FAIL tests\/acceptance\/T-002\/b\.test\.ts/);
    await writeFiles(a, { 'tests/acceptance/T-002/b.test.ts': "test('[REQ-001.AC1] 只断言规格规定的字段', () => {});\n" });
    await submitWork(a, '放宽到规格规定的部分');
  });
  try {
    await drive(e, p.flowId, 20);
    assert.deepEqual(e.errors, []);
    const t1 = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t1.status, 'done');
    assert.equal(t1.merge_failures ?? 0, 0, '不计入当前 task 的失败');
    assert.ok(p.store.readEvents().some((ev) => ev.task === 'T-001' && ev.trigger === 'foreign_tests_broken'));
    const fix = p.store.readTask(p.flowId, 'T-002.at-2');
    assert.deepEqual([fix.status, fix.acctest_round?.kind, fix.acctest_round?.from_task], ['done', 'foreign', 'T-001']);
  } finally { p.cleanup(); }
});

test('偏离 90：合并时此前流程留下的验收测试失败（目录不属于本流程）→ 给本 task 建一轮 legacy .at-n 按新需求改旧测试，改完再合并、不计失败', async () => {
  const p = await setupProject({ yaml: YAML.replace(/  test:      ".*"/, '  test:      "true"'), files: {
    ...FILES,
    // 此前流程（例如 B-001 的 T-009）留在主分支上的验收测试：T-001 的实现落地后它就失败
    'tests/acceptance/T-009/old.test.ts': "test('[REQ-001.AC1] BRITTLE 旧行为', () => {});\n",
  }, tasks: [mkTask('T-001', { ac: ['REQ-001.AC1'] }), at('T-001')] });
  const e = engineEnv(p, async (role, _nth, a) => {
    const id = a.env.task;
    await a.call('forge_claim');
    if (role === 'worker') { await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' }); return submitWork(a, `${id} 完成`); }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': "test('[REQ-001.AC1] ok', () => {});\n" }); return submitWork(a, 'AC1'); }
    const t = p.store.readTask(p.flowId, id);
    assert.equal(t.acctest_round?.kind, 'legacy');
    assert.ok(t.writes.includes('tests/acceptance/T-009/**'), t.writes.join());
    assert.match(p.store.readHandoff(p.flowId, id), /旧的验收测试与本次需求冲突[\s\S]*FAIL tests\/acceptance\/T-009\/old\.test\.ts/);
    await writeFiles(a, { 'tests/acceptance/T-009/old.test.ts': "test('[REQ-001.AC1] 按新需求调整', () => {});\n" });
    await submitWork(a, '旧测试按新需求调整');
  });
  try {
    await drive(e, p.flowId, 20);
    assert.deepEqual(e.errors, []);
    const t1 = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t1.status, 'done');
    assert.equal(t1.merge_failures ?? 0, 0, '不计入当前 task 的失败');
    assert.ok(p.store.readEvents().some((ev) => ev.task === 'T-001' && ev.trigger === 'foreign_tests_broken'));
    assert.doesNotMatch(p.git('show', `${p.store.readFlow(p.flowId).integration_branch}:tests/acceptance/T-009/old.test.ts`), /BRITTLE/);
  } finally { p.cleanup(); }
});

test('偏离 87：.fx-1（继承 tests/acceptance/_support/**）提出争议后，同一谱系的 .at-2 照常派发，不因 writes 重叠互等', async () => {
  const p = await setupProject({ yaml: YAML.replace(/  test:      ".*"/, '  test:      "true"'), files: FILES, tasks: [
    mkTask('T-001', { ac: ['REQ-001.AC1'], writes: ['src/server/t-001/**', 'tests/acceptance/_support/**'] }), at('T-001', [hard('T-001')]),
  ] });
  const seen: string[] = [];
  const e = engineEnv(p, async (role, _nth, a) => {
    const id = a.env.task;
    seen.push(id);
    await a.call('forge_claim');
    if (id === 'T-001') { await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' }); return submitWork(a, '实现'); }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': "test('[REQ-001.AC1] STRICT', () => {});\n" }); return submitWork(a, 'AC1'); }
    if (id === 'T-001.fx-1') {
      const r = await a.call('forge_dispute', { test: 'tests/acceptance/T-001/a.test.ts', reason: '规格没有要求 STRICT', evidence: 'docs/spec/requirements.md#REQ-001' });
      assert.ok(r.ok, r.text);
      return;
    }
    assert.equal(id, 'T-001.at-2');
    await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': "test('[REQ-001.AC1] 按规格断言', () => {});\n" });
    await submitWork(a, '按规格改测试');
  });
  try {
    await drive(e, p.flowId, 20);
    assert.ok(seen.includes('T-001.at-2'), seen.join());
    assert.equal(p.store.readTask(p.flowId, 'T-001.at-2').status, 'done');
  } finally { p.cleanup(); }
});
