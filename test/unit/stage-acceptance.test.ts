// 第 7.6、11 节的阶段验收编排：afterChecks 与 stageStep 的分支（不跑命令：检查结果直接构造）。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { P0_SPEC } from '../helpers/spec.ts';
import { commitToBranch } from '../helpers/engine.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { afterChecks, gatePassedHead, stageStep, stageWorkSettled } from '../../src/core/stage/stage-acceptance.ts';
import { taskRel } from '../../src/core/state/state-store.ts';
import { QA_INPUT, QA_REPORT } from '../../src/core/stage/stage-qa.ts';
import { evidenceRel } from '../../src/core/state/state-store.ts';
import { mkdirSync } from 'node:fs';

const FILES = Object.fromEntries(Object.entries(P0_SPEC).map(([k, v]) => [`docs/spec/${k}.md`, v]));

function force(p: Project, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(p.flowId, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}

async function project(qa: boolean) {
  const yaml = qa ? PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true') : PROJECT_YAML;
  const p = await setupProject({ yaml, files: FILES, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', layers: ['backend'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  force(p, 'T-001', { status: 'done', base_sha: p.git('rev-parse', 'HEAD') });
  commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, { 'src/server/t-001/a.ts': 'export const a = 1;\n' }, '实现');
  await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  return { p, deps: { root: p.dir, store: p.store, config: qa ? parseConfig(yaml) : p.config } };
}
const head = (p: Project) => p.git('rev-parse', p.store.readFlow(p.flowId).integration_branch);
const checks = (p: Project, over: Record<string, unknown> = {}) => ({ stage: 'S1', passed: true, reasons: [], head: head(p), ...over });

test('gatePassedHead 取最近一次通过时的 HEAD，阶段被打回后作废；stageWorkSettled 不看阶段级 task', () => {
  const ev = (type: string, data: Record<string, unknown>) => ({ type, flow: 'B-001', data });
  assert.equal(gatePassedHead([ev('note', { kind: 'gate_checks_passed', stage: 'S1', head: 'a' }), ev('note', { kind: 'gate_checks_passed', stage: 'S2', head: 'b' })], 'B-001', 'S1'), 'a');
  assert.equal(gatePassedHead([ev('note', { kind: 'gate_checks_passed', stage: 'S1', head: 'a' }), ev('stage_reopened', { stage: 'S1' })], 'B-001', 'S1'), null);
  const t = (id: string, kind: string, status: string) => ({ id, kind, status, stage: 'S1' }) as never;
  assert.equal(stageWorkSettled([t('T-001', 'impl', 'done'), t('S1.qa', 'qa', 'in_progress')], 'S1'), true);
  assert.equal(stageWorkSettled([t('T-001', 'impl', 'done'), t('T-001.fx-1', 'fix', 'ready')], 'S1'), false);
});

test('不跑 stage-qa：通过 → 签收（awaiting_human，最后一个阶段）', async () => {
  const { p, deps } = await project(false);
  try {
    const r = await afterChecks(deps, p.flowId, checks(p));
    assert.equal(r.done, false);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.equal(gatePassedHead(p.store.readEvents(), p.flowId, 'S1'), head(p));
  } finally { p.cleanup(); }
});

test('跑 stage-qa：通过 → 建 S1.qa（ready），阶段留在 awaiting_gate；qa 通过且 HEAD 未变 → 签收', async () => {
  const { p, deps } = await project(true);
  try {
    await afterChecks(deps, p.flowId, checks(p));
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
    assert.equal(p.store.readTask(p.flowId, 'S1.qa').status, 'ready');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'wait');
    // 模拟 stage-qa 提交通过
    force(p, 'S1.qa', { status: 'done' });
    const dir = path.join(p.dir, '.forge', evidenceRel(p.flowId, 'S1.qa'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, QA_REPORT), JSON.stringify({ round: 1, requested: 'pass', verdict: 'pass', issues: [], downgraded: [], head: head(p) }));
    assert.ok(JSON.parse(readFileSync(path.join(dir, QA_INPUT), 'utf8')).head);
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'changed');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
});

test('门禁命令失败且无法归属 → needs_human；/forge gate（force）从 needs_human 重跑', async () => {
  const { p, deps } = await project(false);
  try {
    const r = await afterChecks(deps, p.flowId, checks(p, { passed: false, reasons: ['test 失败'], failed: { command: 'test', output: 'boom' } }));
    assert.match(r.note ?? '', /无法从日志定位/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'needs_human');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'wait');
    assert.equal(await stageStep(deps, p.flowId, { force: true, gateFailedWithoutChange: () => false }), 'gate');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
  } finally { p.cleanup(); }
});

test('门禁命令失败、日志能归属 → 建 .fx-1 回 active；第三次失败（两轮用尽）→ needs_human', async () => {
  const { p, deps } = await project(false);
  try {
    const failed = { command: 'test', output: 'Error at src/server/t-001/a.ts:1' };
    await afterChecks(deps, p.flowId, checks(p, { passed: false, reasons: ['test 失败'], failed }));
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active');
    const fx = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual([fx.kind, fx.for_task, fx.writes], ['fix', 'T-001', ['src/server/t-001/a.ts']]);
    for (const n of [2, 3]) {
      force(p, `T-001.fx-${n - 1}`, { status: 'done' });
      await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      await afterChecks(deps, p.flowId, checks(p, { passed: false, reasons: ['test 失败'], failed }));
    }
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'needs_human');
  } finally { p.cleanup(); }
});
