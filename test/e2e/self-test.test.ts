// worker 自己写 tests/acceptance/<T>/ 下的验收测试。
// fake-subagent 经真实的引擎、SubagentRuntime 与工具操作。覆盖：一个阶段跑通（worker 提交测试、审查者运行它、合入、覆盖率通过）；
// 覆盖缺口给 impl 建 .fx-n（补齐 AC 编号的验收测试），修好后阶段通过；别的 task 的验收目录仍然写不进去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
// acceptance 命令是 `<命令> -- T-001`：预检不再运行命令，由审查者按任务说明运行，这里要求测试文件已经在 worktree 里
const YAML = PROJECT_YAML.replace('acceptance: "true"', `acceptance: "test -f tests/acceptance/T-001/a.test.ts && echo ran >> ${LOG}"`);
const impl = mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1', 'REQ-001.AC2'], writes: ['src/server/t-001/**', 'tests/acceptance/T-001/**'] });
const AC1_TEST = "test('[REQ-001.AC1] 返回编号', () => {});\n";
const AC2_TEST = "test('[REQ-001.AC2] 名称为空返回 400', () => {});\n";

async function project(): Promise<Project> {
  const p = await setupProject({ yaml: YAML, files: FILES, stages: ['S1'], tasks: [impl] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }]);
  return p;
}

test('worker 自己提交 src 与验收测试，审查任务说明带着 AC 覆盖与要运行的验收命令，合入后覆盖率通过', async () => {
  const p = await project();
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    assert.equal(role, 'worker');
    assert.equal(a.env.task, 'T-001');
    assert.match(p.store.readTask(p.flowId, 'T-001').writes.join(), /tests\/acceptance\/T-001\/\*\*/);
    const d = await a.call('forge_dispute', { test: 'tests/acceptance/T-001/a.test.ts', reason: 'x', evidence: 'docs/spec/requirements.md#REQ-001' });
    assert.ok(!d.ok, '争议工具已删除');
    await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n', 'tests/acceptance/T-001/a.test.ts': AC1_TEST + AC2_TEST });
    return submitWork(a, '实现并写验收测试');
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    // 审查者拿到的任务说明里有要运行的验收命令和程序扫描的 AC 覆盖，diff 含验收测试
    const brief = p.store.readHandoff(p.flowId, 'T-001.rv');
    assert.match(brief, /先运行本 task 自己的测试[\s\S]*acceptance：`test -f tests\/acceptance\/T-001\/a\.test\.ts[^\n]*-- T-001`/);
    assert.match(brief, /审查本 task 的验收测试[\s\S]*REQ-001\.AC1：tests\/acceptance\/T-001\/a\.test\.ts[\s\S]*REQ-001\.AC2：tests\/acceptance\/T-001\/a\.test\.ts[\s\S]*每条 AC 都有测试/);
    assert.match(brief, /含 tests\/acceptance\/\*\*/);
    const integ = p.store.readFlow(p.flowId).integration_branch;
    assert.match(p.git('show', `${integ}:tests/acceptance/T-001/a.test.ts`), /REQ-001\.AC2/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(p.git('show', `${integ}:docs/qa/S1.md`), /缺口：无/);
  } finally { p.cleanup(); }
});

// 合并不再运行 acceptance，原来“合并验证时旧流程的验收目录失败 → 加进 writes 退回 worker”的两个用例随之删除；
// 旧流程验收目录被破坏的情形现在由阶段门禁（全量 acceptance）发现。
