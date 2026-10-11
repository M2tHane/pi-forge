// 第 9.3–9.5 节：验收测试返工与单独合并的纯函数部分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitedAcctest, classifyAcceptanceFailure, failingAcceptanceDirs, latestAcctest, nextAcctestId, nextFixId, validateEvidence } from '../../src/core/acceptance/acceptance-flow.ts';
import type { TaskStatus } from '../../src/core/state/schemas.ts';

const at = (id: string, status: TaskStatus, for_task = 'T-003') => ({ id, kind: 'acctest' as const, for_task, status });

test('latestAcctest：按轮次取最新，忽略已取消的与别的 impl 的；nextAcctestId / nextFixId 连续编号', () => {
  const tasks = [at('T-003.at', 'done'), at('T-003.at-2', 'done'), at('T-003.at-3', 'cancelled'), at('T-004.at', 'ready', 'T-004'), { id: 'T-003', kind: 'impl' as const, status: 'in_progress' as TaskStatus }];
  assert.equal(latestAcctest(tasks, 'T-003')?.id, 'T-003.at-2');
  assert.equal(latestAcctest(tasks, 'T-005'), undefined);
  assert.equal(nextAcctestId(tasks, 'T-003'), 'T-003.at-4', '取消的轮次也占编号');
  assert.equal(nextAcctestId([{ id: 'T-009' }], 'T-009'), 'T-009.at-2');
  assert.equal(nextFixId([{ id: 'T-003.fx-1' }, { id: 'T-003.fx-2' }, { id: 'T-013.fx-5' }], 'T-003'), 'T-003.fx-3');
  assert.equal(nextFixId([], 'T-003'), 'T-003.fx-1');
});

test('awaitedAcctest：impl 预检要等最新一轮验收测试；硬依赖 impl 的（impl 合入后才写）不等', () => {
  const dep = (task: string, type: 'hard' | 'soft') => ({ task, type, ...(type === 'hard' ? { reason: 'x' } : {}) });
  assert.equal(awaitedAcctest([{ ...at('T-003.at', 'ready'), depends_on: [] }], 'T-003')?.id, 'T-003.at');
  assert.equal(awaitedAcctest([{ ...at('T-003.at', 'ready'), depends_on: [dep('T-002', 'hard')] }], 'T-003')?.id, 'T-003.at', '依赖别的 task 的照样要等');
  assert.equal(awaitedAcctest([{ ...at('T-003.at', 'ready'), depends_on: [dep('T-003', 'hard')] }], 'T-003'), undefined);
  assert.equal(awaitedAcctest([], 'T-003'), undefined);
});

test('failingAcceptanceDirs 与 classifyAcceptanceFailure：按失败输出里的目录判断归属', () => {
  const out = [
    ' FAIL  tests/acceptance/T-002/team.test.ts > [REQ-002.AC1] 看到团队',
    '   at tests/acceptance/_support/T-002/login.ts:12',
    ' FAIL  tests/acceptance/T-005/ds.test.ts',
    ' ok    tests/acceptance/_support/env.ts',
  ].join('\n');
  assert.deepEqual(failingAcceptanceDirs(out), ['T-002', 'T-005']);
  assert.equal(classifyAcceptanceFailure('T-005', ['T-005']), 'own');
  assert.equal(classifyAcceptanceFailure('T-005', ['T-002']), 'foreign');
  assert.equal(classifyAcceptanceFailure('T-005', ['T-002', 'T-005']), 'mixed');
  assert.equal(classifyAcceptanceFailure('T-005', []), 'unknown');
});

test('validateEvidence：认可存在的规格或契约文件（行号在范围内、标题存在）与规格中的 AC 编号', () => {
  const files: Record<string, string> = { 'docs/contracts/paths/ds.yaml': 'a\nb\nc\n', 'docs/spec/requirements.md': '### REQ-001 创建数据源\n- AC2：同名失败\n' };
  const read = (rel: string) => files[rel] ?? null;
  const acs = new Set(['REQ-001.AC2']);
  assert.deepEqual(validateEvidence('见 docs/contracts/paths/ds.yaml:2 的 409', read, acs).refs, ['docs/contracts/paths/ds.yaml:2']);
  assert.equal(validateEvidence('docs/contracts/paths/ds.yaml:99', read, acs).ok, false, '行号超出文件');
  assert.equal(validateEvidence('docs/spec/requirements.md#REQ-001', read, acs).ok, true);
  assert.equal(validateEvidence('docs/spec/requirements.md#REQ-404', read, acs).ok, false, '标题不存在');
  assert.equal(validateEvidence('REQ-001.AC2 说同名失败', read, acs).ok, true);
  assert.equal(validateEvidence('REQ-001.AC9', read, acs).ok, false);
  assert.equal(validateEvidence('src/server/ds.ts:3', read, acs).ok, false, '实现代码不算依据');
  assert.match(validateEvidence('我觉得不对', read, acs).reason!, /规格或契约的具体位置/);
});
