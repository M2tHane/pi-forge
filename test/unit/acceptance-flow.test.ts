// 验收流程保留的纯函数：失败输出里的验收目录、.fx-n 编号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingAcceptanceDirs, nextFixId } from '../../src/core/acceptance/acceptance-flow.ts';

test('nextFixId：接着已有的 .fx-n 连续编号，忽略别的 impl 的', () => {
  const tasks = [{ id: 'T-003.fx-1' }, { id: 'T-003.fx-2' }, { id: 'T-004.fx-1' }, { id: 'T-003' }];
  assert.equal(nextFixId(tasks, 'T-003'), 'T-003.fx-3');
  assert.equal(nextFixId(tasks, 'T-005'), 'T-005.fx-1');
});

test('failingAcceptanceDirs：按失败输出里的目录判断归属（_support 下的按子目录归属）', () => {
  const out = [
    ' FAIL  tests/acceptance/T-002/team.test.ts > [REQ-002.AC1] 看到团队',
    '   at tests/acceptance/_support/T-002/login.ts:12',
    ' FAIL  tests/acceptance/T-005/ds.test.ts',
    ' ok    tests/acceptance/_support/env.ts',
  ].join('\n');
  assert.deepEqual(failingAcceptanceDirs(out), ['T-002', 'T-005']);
});
