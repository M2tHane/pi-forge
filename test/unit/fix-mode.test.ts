// fix 模式（M7）：纯函数、fixStep 的状态推进（不跑 agent，直接改任务状态与 evidence）、/forge-fix 的拒绝规则。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { evidenceRel, isFinished, taskRel } from '../../src/core/state/state-store.ts';
import { QA_INPUT, QA_REPORT, QA_CONFIRM } from '../../src/core/stage/stage-qa.ts';
import { readReviewEvidence, type ReviewInputFile } from '../../src/core/stage/review-flow.ts';
import {
  FIX_TASK, acceptFix, buildFixHandoff, buildFixQaBrief, fixLogName, fixPhase, fixStatusLine, readFixLog, regressionTestsOf, renderFixLog, fixStep,
} from '../../src/modes/fix.ts';
import { fixDescription, fixRefusal, runFlowFix, type CommandEnv } from '../../src/commands/forge.ts';
import { statusText } from '../../src/tools/orchestrator-tools.ts';
import { renderStatus } from '../../src/core/ops/status-view.ts';

const YAML = PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true');
const must = { id: 'R-1', level: 'must' as const, basis: 'defect:仍然复现', files: ['src/login.ts'], location: 'login', problem: '登录仍然失败', expected: '登录成功' };

function force(p: Project, flow: string, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(flow, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}
function evidence(p: Project, flow: string, id: string, name: string, body: unknown) {
  const dir = path.join(p.dir, '.forge', evidenceRel(flow, id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), JSON.stringify(body));
}

async function fixProject(yaml = YAML) {
  const p = await setupProject({ yaml });
  // 先让 build 流程不占用：本组测试只关心 fix 流程
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  const base = p.git('rev-parse', 'HEAD');
  const fix = await p.store.createLightFlow('fix', '登录失败', 'main', base);
  await p.store.saveFlowBrief(fix.id, '# 登录失败\n输入正确密码仍提示错误。');
  const calls: string[] = [];
  const ctx = {
    root: p.dir, store: p.store, config: parseConfig(yaml), now: () => new Date('2026-03-04T05:06:07Z'),
    dispatch: async (_f: string, t: string) => { calls.push(t); },
    promote: async () => {},
  };
  return { p, fix, ctx, calls };
}

// —— 纯函数 ——

test('buildFixHandoff：问题、根因、回归测试、大改动时 forge_block 并建议 feature', () => {
  const t = buildFixHandoff('登录失败', 5);
  assert.match(t, /登录失败/);
  assert.match(t, /根因/);
  assert.match(t, /回归测试/);
  assert.match(t, /forge_block/);
  assert.match(t, /5 个文件/);
  assert.match(t, /--feature/);
});

test('buildFixQaBrief：第 1 轮要复现并核对回归测试；确认轮只核对上一轮 must', () => {
  const base = { qaId: 'X1.qa', round: 1, problem: '登录失败', range: { from: 'a'.repeat(40), to: 'b'.repeat(40) }, stat: ' a.ts | 2 +-', serves: ['serve'], priorMust: [] };
  const first = buildFixQaBrief(base);
  assert.match(first, /登录失败/);
  assert.match(first, /复现/);
  assert.match(first, /回归测试/);
  assert.match(first, /forge_qa_report/);
  assert.match(first, /aaaaaaaa\.\.bbbbbbbb/);
  assert.match(first, /forge_service/);
  const confirm = buildFixQaBrief({ ...base, qaId: 'X1.qa-2', round: 2, priorMust: [must] });
  assert.match(confirm, /forge_qa_confirm/);
  assert.match(confirm, /登录仍然失败/);
  assert.doesNotMatch(confirm, /第一轮/);
});

test('regressionTestsOf 与 fixLogName', () => {
  assert.deepEqual(regressionTestsOf(['src/a.ts', 'test/a.test.ts', 'tests/unit/b.ts', 'src/c.spec.ts']), ['test/a.test.ts', 'tests/unit/b.ts', 'src/c.spec.ts']);
  assert.equal(fixLogName('2026-03-04', []), '2026-03-04-001.md');
  assert.equal(fixLogName('2026-03-04', ['2026-03-04-001.md', '2026-03-03-001.md']), '2026-03-04-002.md');
});

test('renderFixLog：包含问题、提交、回归测试、QA 结论、返工与成本', () => {
  const md = renderFixLog({
    flow: { id: 'X-001', title: '登录失败' }, date: '2026-03-04', mainBranch: 'main', problem: '输入正确密码仍提示错误',
    commits: [{ sha: 'abcdef1234567890', subject: '[X-001/T-001] fix: 登录失败' }], files: ['src/login.ts', 'test/login.test.ts'],
    qa: { rounds: 2, conclusion: 'confirmed', must: 1 }, rework: { merge_fail: 1, run_failed: 0, fix_tasks: 1 }, cost: ['合计：3 次运行'],
  });
  for (const s of ['# 修复 X-001：登录失败', '输入正确密码仍提示错误', 'abcdef12 [X-001/T-001]', '- test/login.test.ts', '已确认修复', '轮数：2；发现 must 1 条', '合并时全量测试失败 1 次', '合计：3 次运行']) assert.ok(md.includes(s), s);
  const none = renderFixLog({ flow: { id: 'X-002', title: 't' }, date: 'd', mainBranch: 'main', problem: '', commits: [], files: [], qa: { rounds: 0, conclusion: 'skipped', must: 0 }, rework: { merge_fail: 0, run_failed: 0, fix_tasks: 0 }, cost: [] });
  assert.match(none, /没有识别出测试文件/);
  assert.match(none, /未运行/);
});

test('fixPhase 与 fixStatusLine：修复中 / 合并 / 复现确认 / 需要你处理 / 完成', () => {
  const flow = (s: string) => ({ stage: 'X1', stages: ['X1'], stage_status: s }) as never;
  const t = (id: string, kind: string, status: string) => ({ id, kind, status }) as never;
  assert.equal(fixPhase(flow('active'), []), 'fixing');
  assert.equal(fixPhase(flow('active'), [t('T-001', 'impl', 'in_progress')]), 'fixing');
  assert.equal(fixPhase(flow('active'), [t('T-001', 'impl', 'queued_merge')]), 'merging');
  assert.equal(fixPhase(flow('active'), [t('T-001', 'impl', 'in_review')]), 'merging');
  assert.equal(fixPhase(flow('active'), [t('T-001', 'impl', 'done')]), 'confirming');
  assert.equal(fixPhase(flow('active'), [t('T-001', 'impl', 'done'), t('T-001.fx-1', 'fix', 'in_progress')]), 'fixing');
  assert.equal(fixPhase(flow('active'), [t('T-001', 'impl', 'blocked')]), 'needs_human');
  assert.equal(fixPhase(flow('needs_human'), [t('T-001', 'impl', 'done')]), 'needs_human');
  assert.equal(fixPhase(flow('done'), []), 'done');
  assert.match(fixStatusLine(flow('active'), [t('T-001', 'impl', 'done'), t('X1.qa', 'qa', 'in_progress')] as never), /复现确认（第 1 轮）/);
  assert.match(fixStatusLine(flow('active'), [t('T-001', 'impl', 'in_progress')] as never), /修复中/);
});

test('fixDescription：位置参数或 --from 文件的第一行', () => {
  assert.equal(fixDescription(['登录', '失败'], null), '登录 失败');
  assert.equal(fixDescription(['--from', 'a.md', '--yes'], '# 登录失败\n细节'), '登录失败');
  assert.equal(fixDescription(['--yes'], null), '');
});

// —— fixStep ——

test('fixStep 创建 T-001：impl、worker、writes **、verify test；重入不重复创建', async () => {
  const { p, fix, ctx } = await fixProject();
  try {
    await fixStep(ctx, fix.id);
    const t = p.store.readTask(fix.id, FIX_TASK);
    assert.deepEqual([t.kind, t.role, t.stage, t.review], ['impl', 'worker', 'X1', undefined]);
    assert.deepEqual(t.writes, ['**']);
    assert.deepEqual(t.verify, ['test']);
    assert.match(p.store.readHandoff(fix.id, FIX_TASK), /输入正确密码仍提示错误/);
    await fixStep(ctx, fix.id);
    assert.equal(p.store.listTasks(fix.id).length, 1);
    assert.equal(p.store.readFlow(fix.id).stage_status, 'active');
  } finally { p.cleanup(); }
});

test('fixStep 只对 ready 任务派发；T-001 阻塞时不建 qa', async () => {
  const { p, fix, ctx, calls } = await fixProject();
  try {
    await fixStep(ctx, fix.id);
    assert.deepEqual(calls, []);
    force(p, fix.id, FIX_TASK, { status: 'ready' });
    await fixStep(ctx, fix.id);
    assert.deepEqual(calls, [FIX_TASK]);
    force(p, fix.id, FIX_TASK, { status: 'blocked', blocked_reason: '改动太大', blocked_by: 'agent' });
    await fixStep(ctx, fix.id);
    assert.equal(p.store.listTasks(fix.id).filter((t) => t.kind === 'qa').length, 0);
    assert.equal(fixPhase(p.store.readFlow(fix.id), p.store.listTasks(fix.id)), 'needs_human');
  } finally { p.cleanup(); }
});

test('完整路径：T-001 合入 → X1.qa 出 must → fix → X1.qa-2 只确认 → 用尽 → needs_human → accept 放行并写日志', async () => {
  const { p, fix, ctx, calls } = await fixProject();
  try {
    const base = p.git('rev-parse', 'HEAD');
    await fixStep(ctx, fix.id);
    // 模拟合并：主分支多一个提交，T-001 done，并留下 merge 事件
    mkdirSync(path.join(p.dir, 'src'), { recursive: true });
    writeFileSync(path.join(p.dir, 'src/login.ts'), 'export const login = () => true;\n');
    mkdirSync(path.join(p.dir, 'test'), { recursive: true });
    writeFileSync(path.join(p.dir, 'test/login.test.ts'), '// 回归测试\n');
    p.git('add', '-A'); p.git('commit', '-q', '-m', `[${fix.id}/T-001] fix: 登录失败`);
    const sha = p.git('rev-parse', 'HEAD');
    force(p, fix.id, FIX_TASK, { status: 'done', base_sha: base });
    await p.store.recordEvent({ flow: fix.id, task: FIX_TASK, actor: 'merge-queue', type: 'merge', evidence: sha, data: { integration_branch: 'main', from: base, to: sha } });

    // 第 1 轮 qa：创建且 ready，已派发
    await fixStep(ctx, fix.id);
    const qa1 = p.store.readTask(fix.id, 'X1.qa');
    assert.deepEqual([qa1.kind, qa1.role, qa1.status], ['qa', 'stage-qa', 'ready']);
    assert.deepEqual(calls, ['X1.qa']);
    assert.match(p.store.readHandoff(fix.id, 'X1.qa'), /独立复现/);
    const input = readReviewEvidence<ReviewInputFile>(p.store, fix.id, 'X1.qa', QA_INPUT)!;
    assert.equal(input.head, sha);
    assert.equal(input.base, base);
    // qa 还在跑：什么都不变
    force(p, fix.id, 'X1.qa', { status: 'in_progress' });
    await fixStep(ctx, fix.id);
    assert.equal(p.store.listTasks(fix.id).length, 2);

    // qa 提出 must → 生成交回 worker 的 fix 任务
    evidence(p, fix.id, 'X1.qa', QA_REPORT, { round: 1, requested: 'changes', verdict: 'changes', issues: [must], downgraded: [], head: sha });
    force(p, fix.id, 'X1.qa', { status: 'done' });
    await fixStep(ctx, fix.id);
    const fx = p.store.listTasks(fix.id).find((t) => t.kind === 'fix')!;
    assert.deepEqual([fx.id, fx.role, fx.for_task, fx.fork_from_task], ['T-001.fx-1', 'worker', FIX_TASK, FIX_TASK]);
    assert.equal(fixPhase(p.store.readFlow(fix.id), p.store.listTasks(fix.id)), 'fixing');
    // 重入幂等
    await fixStep(ctx, fix.id);
    assert.equal(p.store.listTasks(fix.id).filter((t) => t.kind === 'fix').length, 1);

    // fix 合入后 → 确认轮 X1.qa-2
    force(p, fix.id, fx.id, { status: 'done' });
    await fixStep(ctx, fix.id);
    const qa2 = p.store.readTask(fix.id, 'X1.qa-2');
    assert.equal(qa2.status, 'ready');
    assert.match(p.store.readHandoff(fix.id, 'X1.qa-2'), /forge_qa_confirm/);
    assert.deepEqual(readReviewEvidence<ReviewInputFile>(p.store, fix.id, 'X1.qa-2', QA_INPUT)!.prior_must.map((m) => m.id), ['R-1']);

    // 确认轮仍未解决 → 轮数用尽 → needs_human
    evidence(p, fix.id, 'X1.qa-2', QA_CONFIRM, { round: 2, items: [{ id: 'R-1', resolved: false, note: '还是失败' }], unresolved: ['R-1'], head: sha });
    force(p, fix.id, 'X1.qa-2', { status: 'done' });
    await fixStep(ctx, fix.id);
    assert.equal(p.store.readFlow(fix.id).stage_status, 'needs_human');
    assert.equal(fixPhase(p.store.readFlow(fix.id), p.store.listTasks(fix.id)), 'needs_human');
    assert.match(renderStatus(p.store, p.config), /修复需要你处理/);
    assert.match(statusText(p.store, null, fix.id), /\/forge accept/);
    await fixStep(ctx, fix.id);
    assert.equal(p.store.readFlow(fix.id).stage_status, 'needs_human', 'needs_human 时 fixStep 不推进');

    // 人工放行：写日志、流程结束
    await assert.rejects(acceptFix(ctx, 'B-001', '不是修复'), /不是修复或小改动流程/);
    const msg = await acceptFix(ctx, fix.id, '手工验证过了');
    assert.match(msg, /已放行/);
    const flow = p.store.readFlow(fix.id);
    assert.equal(flow.stage_status, 'done');
    assert.ok(isFinished(flow));
    assert.equal(p.store.openLightFlow(), null);
    const log = readFixLog(p.store, fix.id)!;
    for (const s of ['2026-03-04', '输入正确密码仍提示错误', sha.slice(0, 8), 'fix: 登录失败', '- src/login.ts', '- test/login.test.ts', '人工放行', '轮数：2；发现 must 1 条', '手工验证过了', '验收返修任务 1 个']) assert.ok(log.includes(s), s);
    assert.deepEqual(p.store.listFixLogs(), ['2026-03-04-001.md']);
    assert.match(statusText(p.store, null, fix.id), /修复日志：/);
  } finally { p.cleanup(); }
});

test('第 1 轮 qa 通过 → 写日志并结束流程（done、finished）', async () => {
  const { p, fix, ctx } = await fixProject();
  try {
    await fixStep(ctx, fix.id);
    force(p, fix.id, FIX_TASK, { status: 'done', base_sha: p.git('rev-parse', 'HEAD') });
    await fixStep(ctx, fix.id);
    const head = p.git('rev-parse', 'HEAD');
    evidence(p, fix.id, 'X1.qa', QA_REPORT, { round: 1, requested: 'pass', verdict: 'pass', issues: [], downgraded: [], head });
    force(p, fix.id, 'X1.qa', { status: 'done' });
    await fixStep(ctx, fix.id);
    const flow = p.store.readFlow(fix.id);
    assert.ok(isFinished(flow));
    assert.equal(fixPhase(flow, p.store.listTasks(fix.id)), 'done');
    assert.match(readFixLog(p.store, fix.id)!, /已确认修复/);
    assert.equal(p.store.listFixLogs().length, 1);
    await fixStep(ctx, fix.id);
    assert.equal(p.store.listFixLogs().length, 1, '重入不重复写日志');
    assert.equal(p.store.readState().active_flow, null);
  } finally { p.cleanup(); }
});

test('implementation_gate.qa 关闭时：T-001 合入即写日志并结束', async () => {
  const { p, fix, ctx } = await fixProject(PROJECT_YAML);
  try {
    await fixStep(ctx, fix.id);
    force(p, fix.id, FIX_TASK, { status: 'done', base_sha: p.git('rev-parse', 'HEAD') });
    await fixStep(ctx, fix.id);
    assert.ok(isFinished(p.store.readFlow(fix.id)));
    assert.match(readFixLog(p.store, fix.id)!, /未运行/);
  } finally { p.cleanup(); }
});

test('acceptFix：只能放行 needs_human，且要求已有合入的 T-001', async () => {
  const { p, fix, ctx } = await fixProject();
  try {
    await fixStep(ctx, fix.id);
    await assert.rejects(acceptFix(ctx, fix.id, 'x'), /不是"需要你处理"/);
  } finally { p.cleanup(); }
});

// —— /forge-fix 的规则 ——

function envOf(p: Project, opts: { ui?: CommandEnv['ui']; files?: Record<string, string> } = {}) {
  const pumped: string[] = [];
  const env = {
    root: p.dir, packageRoot: p.dir, ui: opts.ui ?? null, waitForIdle: false,
    engine: () => ({ store: p.store, config: p.config, engine: { pump: async (f: string) => { pumped.push(f); }, idle: async () => {} } }),
    store: () => p.store, roleSettings: () => ({}), availableModels: () => [], activateOrchestrator: () => {},
  } as unknown as CommandEnv;
  return { env, pumped };
}

test('fixRefusal：无流程放行；运行中的流程拒绝；等待审批需要确认，--yes 跳过', async () => {
  const p = await setupProject();
  try {
    assert.equal(fixRefusal(p.store, false)?.kind, 'error');
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });
    assert.equal(fixRefusal(p.store, false)?.kind, 'confirm');
    assert.equal(fixRefusal(p.store, true), null);
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.equal(fixRefusal(p.store, false), null);
  } finally { p.cleanup(); }
});

test('/forge-fix：流程运行中拒绝；等待审批时无 UI 提示 --yes、有 UI 可取消；--from 保存问题描述；同时只允许一个', async () => {
  const p = await setupProject();
  try {
    await assert.rejects(runFlowFix('登录失败', envOf(p).env), /不能同时修复/);
    await assert.rejects(runFlowFix('', envOf(p).env), /请描述问题/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });

    const noUi = envOf(p);
    assert.match(await runFlowFix('登录失败', noUi.env), /--yes/);
    assert.equal(p.store.openLightFlow(), null);

    const cancel = envOf(p, { ui: { select: async () => '取消', notify: () => {} } });
    assert.equal(await runFlowFix('登录失败', cancel.env), '已取消。');
    assert.equal(p.store.openLightFlow(), null);

    writeFileSync(path.join(p.dir, 'bug.md'), '# 登录失败\n输入正确密码仍提示错误。\n');
    const go = envOf(p, { ui: { select: async () => '继续修复', notify: () => {} } });
    const out = await runFlowFix('--from bug.md', go.env);
    const open = p.store.openLightFlow()!;
    assert.deepEqual([open.mode, open.stage, open.title, open.integration_branch], ['fix', 'X1', '登录失败', 'main']);
    assert.match(p.store.readFlowBrief(open.id), /输入正确密码仍提示错误/);
    assert.deepEqual(go.pumped, [open.id]);
    assert.match(out, /已创建修复 X-\d+/);
    assert.equal(p.store.readState().active_flow, p.flowId, '修复不占用活动流程指针');

    await assert.rejects(runFlowFix('另一个问题 --yes', envOf(p).env), /已有进行中的修复/);
    await assert.rejects(runFlowFix('--from missing.md', envOf(p).env), /找不到文件/);
  } finally { p.cleanup(); }
});
