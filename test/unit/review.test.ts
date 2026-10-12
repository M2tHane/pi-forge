// 第 10 节：逐任务审查的纯函数部分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_DIFF_MAX, buildReviewBrief, classifyIssues, contractFilesFor, effectiveVerdict, fitSnippets, isValidMustBasis, mustHandoff, mustOf, ruleBasisProblem,
  nextReviewId, reviewMode, reviewRoundOf, reviewTasksOf, stripAcceptanceDiff, suggestionLine, touchesContracts, truncateDiff, validateConfirm,
  type ReviewPolicy,
} from '../../src/core/stage/review.ts';
import type { ReviewFinding } from '../../src/core/state/schemas.ts';
import { hard, mkTask } from '../helpers/tasks.ts';

const policy: ReviewPolicy = { perTask: true, skipSizes: ['S'], criticalFanout: 3, maxRounds: 2 };
// mkTask 默认 review: 'skip'（保持流水线测试不变），推导用的 task 去掉这个字段
const derived = (id: string, over: Parameters<typeof mkTask>[1] = {}) => {
  const { review: _review, ...t } = mkTask(id, over);
  return t;
};

test('reviewMode：task.review 有值就用它；impl 写 skip 无效（偏离 117）', () => {
  const tasks = [mkTask('T-001')];
  assert.equal(reviewMode(mkTask('T-001', { review: 'strong', size: 'S' }), tasks, policy, false), 'strong');
  assert.equal(reviewMode(mkTask('T-001', { review: 'auto', size: 'S' }), tasks, policy, false), 'auto');
  assert.equal(reviewMode(mkTask('T-001', { review: 'skip', risk: 'high' }), tasks, policy, false), 'strong', 'impl 不能跳过审查，按风险推导');
});

test('reviewMode：被 critical_fanout 个 task 硬依赖、layers 含 auth、risk=high 都是 strong（优先于 size）', () => {
  const base = derived('T-001', { size: 'S' });
  const dependents = ['T-002', 'T-003', 'T-004'].map((id) => mkTask(id, { deps: [hard('T-001')] }));
  assert.equal(reviewMode(base, [mkTask('T-001'), ...dependents], policy, false), 'strong');
  assert.equal(reviewMode(base, [mkTask('T-001'), ...dependents.slice(0, 2)], policy, false), 'auto', '只有 2 个依赖者，不到 3');
  assert.equal(reviewMode(base, [mkTask('T-001'), ...dependents], { ...policy, criticalFanout: 0 }, false), 'auto', 'critical_fanout 为 0 关闭');
  const soft = ['T-002', 'T-003', 'T-004'].map((id) => mkTask(id, { depends_on: [{ task: 'T-001', type: 'soft' }] }));
  assert.equal(reviewMode(base, [mkTask('T-001'), ...soft], policy, false), 'auto', '软依赖不计');
  const cancelled = dependents.map((t) => ({ ...t, status: 'cancelled' as const }));
  assert.equal(reviewMode(base, [mkTask('T-001'), ...cancelled], policy, false), 'auto', '已取消的不计');
  assert.equal(reviewMode(derived('T-001', { layers: ['backend', 'auth'], size: 'S' }), [], policy, false), 'strong');
  assert.equal(reviewMode(derived('T-001', { risk: 'high', size: 'S' }), [], policy, false), 'strong');
  assert.equal(reviewMode(derived('T-001', { risk: 'normal' }), [], policy, false), 'auto');
});

test('reviewMode：impl 不受 skip_sizes 与 per_task=false 影响，一律审查（偏离 117）', () => {
  assert.equal(reviewMode(derived('T-001', { size: 'S' }), [], policy, false), 'auto');
  assert.equal(reviewMode(derived('T-001', { size: 'M' }), [], { ...policy, skipSizes: ['S', 'M'] }, false), 'auto');
  assert.equal(reviewMode(derived('T-001'), [], { ...policy, perTask: false }, false), 'auto', 'lean 也逐任务审查');
  assert.equal(reviewMode(mkTask('T-001', { review: 'strong', risk: 'high' }), [], { ...policy, perTask: false }, false), 'strong');
});

test('reviewMode：fix / merge-fix / doc / acctest 不做逐任务审查（即使写了 review）', () => {
  for (const kind of ['fix', 'merge-fix', 'doc', 'acctest'] as const) {
    assert.equal(reviewMode(mkTask('T-001', { kind, review: 'strong', risk: 'high' }), [], policy, true), 'skip', kind);
  }
});

test('出处校验：must 只认 rule:、ac:、contract:、defect: 且冒号后非空', () => {
  for (const ok of ['rule:rules/backend.md#3', 'ac:REQ-001.AC2', 'contract:paths/ds.yaml:12', 'defect:空名称时抛 500', ' ac: REQ-001.AC1 ']) assert.equal(isValidMustBasis(ok), true, ok);
  for (const bad of ['', 'rule:', 'ac:   ', '坏味道：过长函数', 'rules/backend.md#3', 'Rule:x', 'defects:x', '感觉不对']) assert.equal(isValidMustBasis(bad), false, bad);
});

test('classifyIssues：编号 R-1…；出处不合格的 must 降为 suggest 并列出；suggest 不受影响', () => {
  const mk = (level: 'must' | 'suggest', basis: string) => ({ level, basis, files: ['src/a.ts'], location: 'f()', problem: 'p', expected: 'e' });
  const r = classifyIssues([mk('must', 'ac:REQ-001.AC1'), mk('must', '我觉得'), mk('suggest', '坏味道'), mk('must', 'defect:')]);
  assert.deepEqual(r.issues.map((i) => [i.id, i.level]), [['R-1', 'must'], ['R-2', 'suggest'], ['R-3', 'suggest'], ['R-4', 'suggest']]);
  assert.deepEqual(r.downgraded.map((d) => d.id), ['R-2', 'R-4']);
  assert.equal(mustOf(r.issues).length, 1);
  assert.equal(effectiveVerdict(r.issues), 'changes');
  assert.equal(classifyIssues([], 1).issues.length, 0);
  assert.equal(classifyIssues([mk('suggest', 'x')], 5).issues[0]!.id, 'R-5');
});

test('effectiveVerdict：降级后没有 must 就是 pass，不管 reviewer 写了什么', () => {
  const r = classifyIssues([{ level: 'must', basis: '没有出处', files: ['a.ts'], location: '', problem: 'p', expected: 'e' }]);
  assert.equal(r.downgraded.length, 1);
  assert.equal(effectiveVerdict(r.issues), 'pass');
  assert.equal(effectiveVerdict([]), 'pass');
});

test('validateConfirm：必须覆盖上一轮全部 must，不能多出编号（第二轮不能提新问题），不能重复', () => {
  const prior = ['R-1', 'R-3'];
  assert.deepEqual(validateConfirm([{ id: 'R-1', resolved: true }, { id: 'R-3', resolved: false, note: '还差一处' }], prior), []);
  assert.match(validateConfirm([{ id: 'R-1', resolved: true }], prior).join(), /还没有回答这些编号：R-3/);
  assert.match(validateConfirm([{ id: 'R-1', resolved: true }, { id: 'R-3', resolved: true }, { id: 'R-9', resolved: false }], prior).join(), /不在上一轮的清单里.*R-9/);
  assert.match(validateConfirm([{ id: 'R-2', resolved: true }, { id: 'R-1', resolved: true }, { id: 'R-3', resolved: true }], prior).join(), /R-2/, 'suggest 的编号也不是上一轮的 must');
  assert.match(validateConfirm([{ id: 'R-1', resolved: true }, { id: 'R-1', resolved: false }, { id: 'R-3', resolved: true }], prior).join(), /R-1 重复/);
  assert.ok(validateConfirm([], prior).length > 0);
});

test('审查 task 的编号与轮次：.rv → .rv-2 → .rv-3；取消的轮次也占编号；reviewTasksOf 忽略取消的与别的 task 的', () => {
  assert.equal(reviewRoundOf('T-003.rv'), 1);
  assert.equal(reviewRoundOf('T-003.rv-2'), 2);
  assert.equal(reviewRoundOf('T-003'), 0);
  assert.equal(nextReviewId([{ id: 'T-003' }], 'T-003'), 'T-003.rv');
  assert.equal(nextReviewId([{ id: 'T-003.rv' }], 'T-003'), 'T-003.rv-2');
  assert.equal(nextReviewId([{ id: 'T-003.rv' }, { id: 'T-003.rv-2' }, { id: 'T-013.rv-7' }], 'T-003'), 'T-003.rv-3');
  const rv = (id: string, for_task: string, status: 'done' | 'cancelled') => ({ id, kind: 'review' as const, for_task, status });
  assert.deepEqual(reviewTasksOf([rv('T-003.rv-2', 'T-003', 'done'), rv('T-003.rv', 'T-003', 'done'), rv('T-003.rv-3', 'T-003', 'cancelled'), rv('T-004.rv', 'T-004', 'done')], 'T-003').map((t) => t.id), ['T-003.rv', 'T-003.rv-2']);
});

const section = (file: string, body = '+x') => `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}\n`;

test('stripAcceptanceDiff：去掉 tests/acceptance/** 的文件段，其他文件（包括 tests/unit）保留', () => {
  const diff = section('src/a.ts') + section('tests/acceptance/T-001/a.test.ts') + section('tests/acceptance/_support/T-001/h.ts') + section('tests/unit/a.test.ts') + section('docs/tests/acceptance/x.md');
  const out = stripAcceptanceDiff(diff);
  assert.ok(out.includes('a/src/a.ts') && out.includes('a/tests/unit/a.test.ts') && out.includes('a/docs/tests/acceptance/x.md'));
  assert.ok(!out.includes('tests/acceptance/T-001') && !out.includes('_support'));
  assert.equal(stripAcceptanceDiff(''), '');
  assert.equal(stripAcceptanceDiff(section('tests/acceptance/T-001/a.test.ts')), '');
});

test('truncateDiff：不超过上限原样返回；超过在行边界截断并注明总字数', () => {
  const small = 'a\n'.repeat(10);
  assert.deepEqual(truncateDiff(small), { text: small, truncated: false });
  const big = `${'x'.repeat(99)}\n`.repeat(400);
  assert.ok(big.length > REVIEW_DIFF_MAX);
  const r = truncateDiff(big);
  assert.equal(r.truncated, true);
  assert.match(r.text, new RegExp(`diff 共 ${big.length} 字，已截断到前 \\d+ 字`));
  const kept = r.text.split('\n…（')[0]!;
  assert.ok(kept.length <= REVIEW_DIFF_MAX);
  assert.ok(kept.split('\n').every((l) => l === 'x'.repeat(99)), '在整行处截断');
  assert.equal(truncateDiff('abcdef', 4).truncated, true);
  assert.equal(truncateDiff('abcd', 4).truncated, false);
});

test('契约片段：diff 里改到的在前，再加本模块同名的文件；超出总长上限的整份省略或截断', () => {
  const all = ['docs/contracts/openapi.yaml', 'docs/contracts/paths/datasource.yaml', 'docs/contracts/paths/team.yaml', 'docs/contracts/errors/datasource.yaml', 'docs/contracts/modules/datasource.md', 'src/x.ts'];
  assert.deepEqual(contractFilesFor('datasource', all, ['docs/contracts/errors/datasource.yaml', 'src/x.ts']), [
    'docs/contracts/errors/datasource.yaml', 'docs/contracts/paths/datasource.yaml', 'docs/contracts/modules/datasource.md',
  ]);
  assert.deepEqual(contractFilesFor(undefined, all, ['docs/contracts/openapi.yaml']), ['docs/contracts/openapi.yaml']);
  assert.deepEqual(contractFilesFor('billing', all, []), []);
  assert.equal(touchesContracts(['src/a.ts', 'docs/contracts/openapi.yaml']), true);
  assert.equal(touchesContracts(['src/a.ts', 'docs/contract.md']), false);

  const r = fitSnippets([{ path: 'a', content: 'x'.repeat(600) }, { path: 'b', content: 'y'.repeat(600) }, { path: 'c', content: 'z' }], 1000);
  assert.equal(r.shown.length, 2);
  assert.match(r.shown[1]!.content, /已截断/);
  assert.deepEqual(r.omitted, ['c']);
  assert.deepEqual(fitSnippets([{ path: 'a', content: 'small' }], 1000), { shown: [{ path: 'a', content: 'small' }], omitted: [] });
});

const must: ReviewFinding = { id: 'R-1', level: 'must', basis: 'ac:REQ-001.AC2', files: ['src/a.ts'], location: 'create()', problem: '名称为空时返回 500', expected: '返回 400' };

test('buildReviewBrief 第一轮：AC 原文、契约、术语表、偏离、diff 都在；截断时注明', () => {
  const brief = buildReviewBrief({
    taskId: 'T-001', title: '创建看板', reviewId: 'T-001.rv', acIds: ['REQ-001.AC1', 'REQ-001.AC9'], acTexts: { 'REQ-001.AC1': 'Given 已登录 When 创建 Then 返回编号' },
    contracts: { shown: [{ path: 'docs/contracts/paths/board.yaml', content: '/api/boards: {}' }], omitted: ['docs/contracts/openapi.yaml'] },
    glossary: '**看板（Board）**', deviations: ['多加了一个索引'], range: { from: 'aaaaaaaa1111', to: 'bbbbbbbb2222' },
    diff: { text: '+export const a = 1;', truncated: false }, priorMust: [],
  });
  assert.match(brief, /# 审查：T-001「创建看板」（T-001\.rv）/);
  assert.match(brief, /- REQ-001\.AC1：Given 已登录 When 创建 Then 返回编号/);
  assert.match(brief, /- REQ-001\.AC9：（规格里找不到原文）/);
  assert.match(brief, /### docs\/contracts\/paths\/board\.yaml[\s\S]*\/api\/boards/);
  assert.match(brief, /因长度限制省略：docs\/contracts\/openapi\.yaml/);
  assert.match(brief, /\*\*看板（Board）\*\*/);
  assert.match(brief, /多加了一个索引/);
  assert.match(brief, /aaaaaaaa\.\.bbbbbbbb[\s\S]*\+export const a = 1;/);
  assert.match(brief, /forge_review_report/);
  assert.ok(!brief.includes('forge_review_confirm'));
  const cut = buildReviewBrief({ taskId: 'T-001', title: 't', reviewId: 'T-001.rv', acIds: [], acTexts: {}, contracts: { shown: [], omitted: [] }, glossary: '', deviations: [], range: { from: 'a', to: 'b' }, diff: { text: 'x', truncated: true }, priorMust: [] });
  assert.match(cut, /已按 20000 字截断/);
  assert.match(cut, /（没有相关的契约文件）/);
});

test('buildReviewBrief 确认轮：只有上一轮的 must 清单和增量 diff，说明只能用 forge_review_confirm', () => {
  const brief = buildReviewBrief({
    taskId: 'T-001', title: '创建看板', reviewId: 'T-001.rv-2', acIds: ['REQ-001.AC1'], acTexts: { 'REQ-001.AC1': 'AC 原文不该出现' },
    contracts: { shown: [{ path: 'docs/contracts/x.yaml', content: '契约不该出现' }], omitted: [] }, glossary: '术语表不该出现', deviations: ['偏离不该出现'],
    range: { from: 'cccccccc', to: 'dddddddd' }, diff: { text: '+fix', truncated: false }, priorMust: [must],
  });
  assert.match(brief, /确认轮/);
  assert.match(brief, /forge_review_confirm/);
  assert.match(brief, /不能提出新问题/);
  assert.match(brief, /R-1　出处：ac:REQ-001\.AC2[\s\S]*src\/a\.ts（create\(\)）[\s\S]*名称为空时返回 500[\s\S]*返回 400/);
  assert.match(brief, /增量 diff[\s\S]*\+fix/);
  for (const absent of ['AC 原文不该出现', '契约不该出现', '术语表不该出现', '偏离不该出现']) assert.ok(!brief.includes(absent), absent);
});

test('mustHandoff 与 suggestionLine：返工说明带编号；用尽时说明已阻塞；suggest 带审查 task 与 R 编号', () => {
  assert.match(mustHandoff(1, [must], false), /第 1 轮[\s\S]*R-1[\s\S]*只会核对这些编号/);
  assert.match(mustHandoff(2, [must], true), /审查轮数已用完/);
  const line = suggestionLine('T-001.rv', 'T-001', { ...must, id: 'R-3', level: 'suggest', basis: '过长函数' });
  assert.match(line, /^- \[T-001\.rv R-3\] T-001：/);
  assert.ok(line.includes('src/a.ts') && line.includes('返回 400'));
});

// —— 偏离 100：rule: 出处必须指向真实存在的规则文件与条目 ——
const RULES: Record<string, string> = {
  'rules/global.md': '# 全局\n1. 完成的定义\n2. 范围\n',
  'rules/backend.md': '# 后端\n- R1 错误码来自 errors/*.yaml\n- 服务层抛出 AppError\n\n## 审查清单\n- [ ] R3 权限检查在服务层\n4. 日志不含密钥\n',
};
const readRule = (rel: string) => RULES[rel] ?? null;

test('ruleBasisProblem：文件存在且条目出现才算数；技能、不存在的文件、不存在的编号都不行', () => {
  for (const ok of ['rule:rules/global.md#2', 'rule:rules/backend.md#R1', 'rule:rules/backend.md#R3', 'rule:rules/backend.md#4', 'rule: rules/backend.md#服务层抛出 AppError', 'rule:rules/global.md', 'ac:REQ-001.AC1']) {
    assert.equal(ruleBasisProblem(ok, readRule), null, ok);
  }
  assert.match(ruleBasisProblem('rule:skills/tdd#三种坏测试', readRule)!, /不是项目的规则文件/);
  assert.match(ruleBasisProblem('rule:AGENTS.md#1', readRule)!, /不是项目的规则文件/);
  assert.match(ruleBasisProblem('rule:rules/../x.md#1', readRule)!, /不是项目的规则文件/);
  assert.match(ruleBasisProblem('rule:rules/ui.md#3', readRule)!, /rules\/ui\.md 不存在/);
  assert.match(ruleBasisProblem('rule:rules/backend.md#R9', readRule)!, /找不到条目 R9/);
  assert.match(ruleBasisProblem('rule:rules/global.md#R12', readRule)!, /找不到条目 R12/, '12 不能被 1 或 2 误匹配');
  assert.match(ruleBasisProblem('rule:rules/backend.md#不存在的话', readRule)!, /找不到条目/);
});

test('classifyIssues 带 readRule：rule: 出处不真实的 must 降为 suggest 并写明原因；不带 readRule 保持只看前缀', () => {
  const mk = (basis: string) => ({ level: 'must' as const, basis, files: ['a.ts'], location: 'f', problem: 'p', expected: 'e' });
  const r = classifyIssues([mk('rule:rules/backend.md#R3'), mk('rule:skills/tdd#三种坏测试'), mk('rule:rules/backend.md#R9'), mk('defect:空名称 500')], 1, readRule);
  assert.deepEqual(r.issues.map((i) => i.level), ['must', 'suggest', 'suggest', 'must']);
  assert.deepEqual(r.downgraded.map((d) => d.id), ['R-2', 'R-3']);
  assert.match(r.downgraded[0]!.reason!, /不是项目的规则文件/);
  assert.equal(classifyIssues([mk('rule:skills/tdd#x')]).issues[0]!.level, 'must');
});

test('buildReviewBrief（偏离 117、118）：给了 tests 与 acceptance 时，先列出要运行的命令，再列 AC 覆盖；缺失的 AC 点名为 must', () => {
  const base = { taskId: 'T-001', title: 't', reviewId: 'T-001.rv', acIds: ['REQ-001.AC1'], acTexts: {}, contracts: { shown: [], omitted: [] }, glossary: '', deviations: [], range: { from: 'a', to: 'b' }, diff: { text: 'x', truncated: false }, priorMust: [] };
  const brief = buildReviewBrief({
    ...base, withAcceptance: true,
    tests: { run: [{ name: 'acceptance', shell: 'pnpm acc -- T-001' }], skipped: ['单元测试：本 task 没有改动单元测试文件，全量单元测试在阶段门禁运行'] },
    acceptance: { rows: [{ ac: 'REQ-001.AC1', files: ['tests/acceptance/T-001/a.test.js'] }, { ac: 'REQ-001.AC2', files: [] }], missing: ['REQ-001.AC2'] },
  });
  assert.match(brief, /先运行本 task 自己的测试[\s\S]*pnpm acc -- T-001[\s\S]*未运行[\s\S]*没有改动单元测试文件/);
  assert.match(brief, /defect:<命令> 失败/);
  assert.match(brief, /REQ-001\.AC1：tests\/acceptance\/T-001\/a\.test\.js/);
  assert.match(brief, /REQ-001\.AC2：\*\*没有带该编号的测试\*\*/);
  assert.match(brief, /以下 AC 没有测试：REQ-001\.AC2/);
  assert.match(brief, /含 tests\/acceptance\/\*\*/);
  const plain = buildReviewBrief({ ...base });
  assert.doesNotMatch(plain, /先运行本 task 自己的测试|审查本 task 的验收测试/);
  assert.match(plain, /不含 tests\/acceptance/);
  const confirm = buildReviewBrief({ ...base, tests: { run: [{ name: 'test', shell: 'pnpm test x' }], skipped: [] }, priorMust: [{ id: 'R-1', level: 'must', basis: 'defect:x', files: ['a.ts'], location: '', problem: 'p', expected: 'e' }] });
  assert.match(confirm, /确认轮也先运行这些命令/);
});
