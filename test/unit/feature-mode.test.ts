// 第 13.3 节 feature 模式：前置条件、增量规格、权限变更清单、P1 的增量约束、/forge-build --feature 与 /forge-add。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, type Project } from '../helpers/project.ts';
import { CONTRACTS, P1_SPEC } from '../helpers/contracts.ts';
import { makeEngine } from '../helpers/engine.ts';
import { lintSpec, effectiveSpec } from '../../src/core/spec.ts';
import { FEATURES_DIR, featureFileName, featurePermissionSummary, featurePrecondition, formatPermissionChanges, lockedContractProblems, permissionChanges, readSpecAt, scopeSpecToFeature, submitFeatureSpec } from '../../src/core/feature-spec.ts';
import { startFlow } from '../../src/core/stages.ts';
import { runStageGate } from '../../src/core/gates.ts';
import { architectBrief, checkP1, readSpecFrom, usedTaskIds } from '../../src/core/plan-flow.ts';
import { nextStep } from '../../src/core/context-injector.ts';
import { flowSpec } from '../../src/tools/orchestrator-tools.ts';
import { runFlowBuild, runFlowCommand, type CommandEnv } from '../../src/commands/forge.ts';
import { FlowToolError } from '../../src/tools/subagent-tools.ts';

const BASELINE_FILES = Object.fromEntries(Object.entries(P1_SPEC).map(([k, v]) => [`docs/spec/${k}.md`, v]));
const CONTRACT_FILES = Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [`docs/contracts/${k}`, v]));
const SCREEN_STATES = '状态：\n| 状态 | 表现 |\n| 加载 | 骨架屏 |\n| 空 | 还没有数据源 |\n| 错误 | 错误条 |\n| 无权限 | N/A：成员也能查看 |';
const FEATURE = `# 导出

## 需求
### REQ-004 导出数据源 [MVP]
角色：团队负责人
- AC1：Given 已登录的团队负责人 When 导出数据源 Then 下载 CSV 文件

## 页面
## 数据源列表 /datasources
REQ：REQ-001、REQ-004
${SCREEN_STATES}

## 权限
| 资源 · 操作 | 团队负责人 | 成员 |
|---|---|---|
| 数据源 · 创建 | ✓ | 仅本团队 |
| 数据源 · 导出 | ✓ | ✗ |
`;

async function featureProject(files: Record<string, string> = { ...BASELINE_FILES, ...CONTRACT_FILES }) {
  const p = await setupProject({ stages: ['P0', 'P1'], files });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'feature', '导出');
  return { p, flow };
}
const ROOT = path.join(import.meta.dirname, '../..');
function env(p: Project, talks: string[] = [], conversation = true): CommandEnv {
  const { engine } = makeEngine(p, async () => {});
  return {
    root: p.dir, packageRoot: ROOT, ui: null, engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
    ...(conversation ? { startConversation: (t: string) => { talks.push(t); } } : {}),
  };
}

test('REQ 编号：重复是错误，跳号是提醒，接着最大编号则干净；修订可以复用编号', () => {
  const feature = (head: string) => `## 需求\n${head}\n角色：团队负责人\n- AC1：Given 已登录 When 导出 Then 下载文件\n\n## 页面\n\n## 权限\n| 资源 · 操作 | 团队负责人 | 成员 |\n|---|---|---|\n`;
  const lint = (head: string) => lintSpec(P1_SPEC, [{ name: 'a.md', content: feature(head) }]);
  assert.match(lint('### REQ-001 重复 [MVP]').errors.map((e) => e.message).join(), /req-duplicate/);
  const skipped = lint('### REQ-009 跳号 [MVP]');
  assert.equal(skipped.errors.length, 0);
  assert.match(skipped.warnings.map((w) => w.message).join(), /req-sequence.*REQ-004/);
  const ok = lint('### REQ-004 接续 [MVP]');
  assert.deepEqual([ok.errors, ok.warnings], [[], []]);
  assert.deepEqual(lint('### REQ-001（修订）创建 [MVP]').errors, []);
});

test('权限变更：已有行被改动单独列出前后值，新行另列；没有基线时全部算新增', () => {
  const before = effectiveSpec(P1_SPEC, []);
  const after = effectiveSpec(P1_SPEC, [{ name: 'a.md', content: FEATURE }]);
  const c = permissionChanges(before, after);
  assert.deepEqual(c.modified, [{ resource: '数据源 · 创建', cells: [{ role: '成员', from: '✗', to: '仅本团队' }] }]);
  assert.deepEqual(c.added.map((r) => r.resource), ['数据源 · 导出']);
  const text = formatPermissionChanges(c);
  assert.match(text[0]!, /^修改的权限行[\s\S]*数据源 · 创建：成员 ✗ → 仅本团队/);
  assert.match(text[1]!, /^新增的权限行[\s\S]*数据源 · 导出/);
  assert.deepEqual(permissionChanges(null, after).modified, []);
  assert.equal(permissionChanges(null, after).added.length, 2);
  assert.deepEqual(formatPermissionChanges(permissionChanges(after, after)), []);
});

test('计划只需要覆盖本次新增或修改的 AC', () => {
  const before = effectiveSpec(P1_SPEC, []);
  const after = effectiveSpec(P1_SPEC, [{ name: 'a.md', content: FEATURE }]);
  assert.deepEqual(scopeSpecToFeature(after, before).reqs.map((r) => `${r.id}:${r.acs.map((a) => a.id)}`), ['REQ-004:AC1']);
  assert.equal(scopeSpecToFeature(after, null), after);
});

test('feature 文件名：日期不早于已有 feature，000 排在本流程的修订之前', () => {
  assert.equal(featureFileName('导出', [], '2026-10-09'), '2026-10-09-000-导出.md');
  assert.equal(featureFileName('导出', ['2026-12-01-003-x.md'], '2026-10-09'), '2026-12-01-000-导出.md');
});

test('前置条件：主分支没有 docs/contracts/ 时给出 --adopt 提示；有契约则放行', async () => {
  const bare = await setupProject({ files: BASELINE_FILES });
  const full = await setupProject({ files: { ...BASELINE_FILES, ...CONTRACT_FILES } });
  try {
    assert.match(featurePrecondition(bare.dir, 'main')!, /没有 docs\/contracts\/[\s\S]*\/forge init --adopt/);
    assert.equal(featurePrecondition(full.dir, 'main'), null);
    assert.match(featurePrecondition(full.dir, 'nope')!, /--adopt/);
  } finally { bare.cleanup(); full.cleanup(); }
});

test('/forge-build --feature：没有契约时只给提示、不建流程；有契约时建 feature 流程并让主会话写增量规格', async () => {
  const bare = await setupProject({ files: BASELINE_FILES });
  const full = await setupProject({ files: { ...BASELINE_FILES, ...CONTRACT_FILES } });
  try {
    for (const p of [bare, full]) {
      await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
      mkdirSync(path.join(p.dir, 'inputs'));
      writeFileSync(path.join(p.dir, 'inputs/prd.md'), '# 导出 PRD');
    }
    assert.match(await runFlowBuild('--feature --prd inputs/prd.md', env(bare)), /\/forge init --adopt/);
    assert.equal(bare.store.readState().active_flow, null);
    const talks: string[] = [];
    const out = await runFlowBuild('--feature --prd inputs/prd.md', env(full, talks));
    const id = full.store.readState().active_flow!;
    const flow = full.store.readFlow(id);
    assert.deepEqual([flow.mode, flow.stage, flow.stages], ['feature', 'P0', ['P0', 'P1']]);
    assert.match(out, /已创建流程 F-\d+（feature）/);
    assert.match(talks[0]!, /feature 模式[\s\S]*feature_name \+ feature/);
    assert.equal(full.git('show', `${flow.integration_branch}:docs/spec/inputs/prd/prd.md`), '# 导出 PRD');
    assert.equal(nextStep(full.store, 3).tool, 'forge_spec');
    assert.match(nextStep(full.store, 3).next, /增量规格[\s\S]*REQ 编号接着已有的最大编号/);
    // 已有进行中的流程时不能再开
    await assert.rejects(runFlowBuild('--feature', env(full)), /已有进行中的流程/);
  } finally { bare.cleanup(); full.cleanup(); }
});

test('feature P0：增量规格写进 docs/spec/features/，基线不动；lint 合并基线与 feature；权限变更写进批准页', async () => {
  const { p, flow } = await featureProject();
  try {
    const ref = flow.integration_branch;
    const baseBefore = p.git('rev-parse', `${ref}:docs/spec/requirements.md`);
    // 编号与基线重复：零写入
    const head = p.git('rev-parse', ref);
    await assert.rejects(submitFeatureSpec(p.dir, p.store, flow.id, { name: '导出', content: FEATURE.replace('REQ-004 导出', 'REQ-001 导出') }), /spec-lint.*未通过[\s\S]*req-duplicate/);
    assert.equal(p.git('rev-parse', ref), head);
    assert.equal(p.store.readFlow(flow.id).stage_status, 'active');
    // 基线已存在时不能再传基线；名字必须合法
    await assert.rejects(submitFeatureSpec(p.dir, p.store, flow.id, { name: '导出', content: FEATURE, baseline: P1_SPEC }), /基线规格.*已经存在/);
    await assert.rejects(submitFeatureSpec(p.dir, p.store, flow.id, { name: '导/出', content: FEATURE }), /feature 名字/);

    const r = await submitFeatureSpec(p.dir, p.store, flow.id, { name: '导出', content: FEATURE });
    assert.match(r.path, new RegExp(`^${FEATURES_DIR}/\\d{4}-\\d{2}-\\d{2}-000-导出\\.md$`));
    assert.equal(p.git('show', `${ref}:${r.path}`), FEATURE.trimEnd());
    assert.equal(p.git('rev-parse', `${ref}:docs/spec/requirements.md`), baseBefore);
    assert.equal(p.store.readFlow(flow.id).stage_status, 'awaiting_gate');
    const gate = await runStageGate(p.dir, p.store, p.config, flow.id);
    assert.equal(gate.passed, true);
    const after = p.store.readFlow(flow.id);
    assert.equal(after.stage_status, 'awaiting_human');
    assert.match(after.spec!.permission_changes!.join('\n'), /修改的权限行[\s\S]*数据源 · 创建：成员 ✗ → 仅本团队[\s\S]*新增的权限行[\s\S]*数据源 · 导出/);
    assert.match(nextStep(p.store, 3).next, /必须向用户单独列出权限变更/);
    assert.deepEqual(featurePermissionSummary(p.dir, after), after.spec!.permission_changes);

    // 打回后重提沿用同一个文件名，不会留下第二个 feature 文件
    await p.store.transitionStage(flow.id, { to: 'active', trigger: 'reject', actor: 'human', reason: '导出要带表头' });
    const again = await submitFeatureSpec(p.dir, p.store, flow.id, { name: '改个名字', content: FEATURE.replace('CSV 文件', 'CSV 文件，第一行是表头') });
    assert.equal(again.path, r.path);
    assert.equal(readSpecAt(p.dir, `refs/heads/${ref}`)!.features.length, 1);
  } finally { p.cleanup(); }
});

test('feature P0：项目没有基线规格时必须同时提交四份基线，并与 feature 一起 lint', async () => {
  const { p, flow } = await featureProject(CONTRACT_FILES);
  try {
    await assert.rejects(submitFeatureSpec(p.dir, p.store, flow.id, { name: '导出', content: FEATURE }), /还没有基线规格/);
    await assert.rejects(flowSpec(p.dir, p.store, p.config, { feature_name: '导出', feature: FEATURE }), /还没有基线规格/);
    await assert.rejects(flowSpec(p.dir, p.store, p.config, { feature_name: '导出', feature: FEATURE, requirements: 'x' }), /要么四份.*都给.*都不给/);
    const r = await flowSpec(p.dir, p.store, p.config, { feature_name: '导出', feature: FEATURE, ...P1_SPEC });
    assert.match(r.text, /增量规格已提交到 docs\/spec\/features\//);
    assert.equal(p.git('show', `${flow.integration_branch}:docs/spec/requirements.md`), P1_SPEC.requirements.trimEnd());
  } finally { p.cleanup(); }
});

test('forge_spec 按流程模式路由：feature 流程要 feature_name + feature，build 流程不接受它们', async () => {
  const { p } = await featureProject();
  try {
    await assert.rejects(flowSpec(p.dir, p.store, p.config, { ...P1_SPEC }), (e: Error) => e instanceof FlowToolError && /feature_name/.test(e.message));
    const r = await flowSpec(p.dir, p.store, p.config, { feature_name: '导出', feature: FEATURE });
    assert.match(r.text, /spec-lint（基线 \+ 全部 feature）通过[\s\S]*向用户单独列出权限变更[\s\S]*数据源 · 创建/);
    assert.equal(p.store.readFlow(p.store.readState().active_flow!).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
  const build = await setupProject({ stages: ['P0', 'P1'], files: BASELINE_FILES });
  try {
    await assert.rejects(flowSpec(build.dir, build.store, build.config, { ...P1_SPEC, feature_name: 'x', feature: FEATURE }), /build 流程不使用/);
    await assert.rejects(flowSpec(build.dir, build.store, build.config, { requirements: 'x' }), /四份完整规格/);
  } finally { build.cleanup(); }
});

test('feature P1：主分支已有契约一开始就锁定（只能追加）；architect 说明要求只写增量并列出 baseline', async () => {
  const { p, flow } = await featureProject();
  try {
    const base = flow.base_sha;
    // 追加合法；删除或改动已有条目违规
    assert.deepEqual(lockedContractProblems(p.dir, base, { ...CONTRACTS, 'paths/new.yaml': '/api/new:\n  get:\n    responses:\n      "200": { description: ok }\n' }), []);
    const broken = { ...CONTRACTS };
    delete broken['paths/team.yaml'];
    assert.match(lockedContractProblems(p.dir, base, broken).join('\n'), /已有契约只能追加.*paths\/team\.yaml/);
    assert.deepEqual(lockedContractProblems(p.dir, null, broken), []);
    // 基线没有契约时不锁
    const bare = await setupProject({ files: BASELINE_FILES });
    try { assert.deepEqual(lockedContractProblems(bare.dir, bare.git('rev-parse', 'HEAD'), {}), []); } finally { bare.cleanup(); }
    // checkP1 在 feature 流程里带上锁定检查（集成分支上删了已有契约）
    await submitFeatureSpec(p.dir, p.store, flow.id, { name: '导出', content: FEATURE });
    const wt = path.join(p.dir, '.forge-wt');
    p.git('worktree', 'add', '-q', wt, flow.integration_branch);
    try {
      p.git('-C', wt, 'rm', '-q', 'docs/contracts/paths/team.yaml');
      p.git('-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'drop');
    } finally { p.git('worktree', 'remove', '--force', wt); }
    const r = checkP1(p.dir, { root: p.dir, ref: flow.integration_branch }, p.store.readFlow(flow.id), [], p.config);
    assert.match(r.errors.join('\n'), /已有契约只能追加/);
    const brief = architectBrief(p.config, [], null, undefined, 'feature');
    assert.match(brief, /增量契约与计划（feature 模式）[\s\S]*基线，已锁定，只能追加[\s\S]*baseline: \[api:GET/);
    assert.doesNotMatch(architectBrief(p.config, [], null), /feature 模式/);
  } finally { p.cleanup(); }
});

test('/forge-add：交给主会话写 forge_spec_amend；没有流程、仍在 P0、已有待批准修订、没有主会话时拒绝', async () => {
  const { p, flow } = await featureProject();
  try {
    const talks: string[] = [];
    await assert.rejects(runFlowCommand('add', env(p, talks)), /用法/);
    // P0 未批准：拒绝，提示直接告诉主会话
    assert.match(await runFlowCommand('add "加导出"', env(p, talks)), /还在规格阶段（P0）[\s\S]*forge_spec/);
    assert.deepEqual(talks, []);
    // 模拟 P0 已批准
    await submitFeatureSpec(p.dir, p.store, flow.id, { name: '导出', content: FEATURE });
    await runStageGate(p.dir, p.store, p.config, flow.id);
    await p.store.transitionStage(flow.id, { to: 'done', trigger: 'approve', actor: 'human' });
    await p.store.advanceStage(flow.id, 'human');
    assert.match(await runFlowCommand('add "导出要支持 Excel"', env(p, talks, false)), /需要交互式主会话/);
    const out = await runFlowCommand('add "导出要支持 Excel"', env(p, talks));
    assert.match(out, /已把需求交给主会话[\s\S]*amend:<id>/);
    assert.match(talks[0]!, /导出要支持 Excel[\s\S]*forge_spec_amend\(\{ name, content, reason \}\)[\s\S]*### REQ-012（修订）[\s\S]*（删除）/);
    // 已有待批准的修订时不再追加
    await p.store.proposeAmend(flow.id, { name: 'x', path: 'docs/spec/features/x.md', content: 'x', reason: 'r', diff: { added: [], changed: [], removed: [] }, affected_tasks: [], base_sha: p.git('rev-parse', 'HEAD') });
    assert.match(await runFlowCommand('add "再加一条"', env(p, talks)), /已有规格修订等待批准/);
    assert.equal(talks.length, 1);
  } finally { p.cleanup(); }
  const idle = await setupProject({ stages: ['P0', 'P1'] });
  try {
    await idle.store.transitionStage(idle.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.match(await runFlowCommand('add "x"', env(idle)), /当前没有进行中的流程/);
  } finally { idle.cleanup(); }
});

test('feature 流程的 task 编号避开此前流程的 task 与主分支 tests/acceptance/ 下的目录（验收目录全仓库共用，偏离 89）', async () => {
  const p = await setupProject({ files: { ...BASELINE_FILES, 'tests/acceptance/T-007/a.test.ts': 'x\n', 'tests/acceptance/_support/h.ts': 'x\n' } });
  try {
    const ids = usedTaskIds(p.dir, p.store, p.flowId, p.config);
    assert.ok(ids.includes('T-007'), ids.join());
    assert.ok(!ids.includes('_support'));
  } finally { p.cleanup(); }
});

test('中文文件名的 feature 规格按 ref 也能读到（git 输出不转义非 ASCII 路径，偏离 91）', async () => {
  const p = await setupProject({ files: { ...BASELINE_FILES, 'docs/spec/features/2026-10-11-000-删除待办.md': '# 删除待办\n' } });
  try {
    const r = readSpecFrom({ root: p.dir, ref: 'HEAD' });
    assert.ok(typeof r !== 'string', String(r));
    assert.deepEqual((r as Exclude<typeof r, string>).features.map((f) => f.name), ['2026-10-11-000-删除待办.md']);
  } finally { p.cleanup(); }
});
