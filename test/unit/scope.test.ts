// 第 14 节：扩大可写范围的申请。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScope, STARTED_STATUSES } from '../../src/core/workspace/scope.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { TaskStatus } from '../../src/core/state/schemas.ts';

const me = mkTask('T-001', { status: 'in_progress', writes: ['src/server/team/**'] });
const other = (status: TaskStatus, writes = ['src/server/ds/**']) => mkTask('T-002', { status, writes });
const ROLE = ['src/**', 'tests/**', 'docs/contracts/**'];

test('硬限制：验收测试、规格、契约（包括别的模块的契约文件），主会话也不能批准', () => {
  const c = checkScope(me, [me], ['tests/acceptance/T-001/x.ts', 'docs/spec/glossary.md', 'docs/contracts/paths/ds.yaml', 'tests/acceptance/**'], ROLE);
  assert.equal(c.invalid.length, 4);
  assert.match(c.invalid[0]!, /forge_dispute/);
  assert.match(c.invalid[1]!, /规格修订/);
  assert.match(c.invalid[2]!, /别的模块的契约文件不能改/);
});

test('与已开工的 task 重叠直接拒绝；只与 pending、ready、blocked 重叠的交给主会话；done、cancelled 不算', () => {
  for (const s of STARTED_STATUSES) {
    const c = checkScope(me, [me, other(s)], ['src/server/ds/routes.ts'], ROLE);
    assert.deepEqual([c.started, c.conflicts], [[{ path: 'src/server/ds/routes.ts', task: 'T-002' }], []], s);
  }
  for (const s of ['pending', 'ready', 'blocked'] as const) {
    const c = checkScope(me, [me, other(s)], ['src/server/ds/routes.ts'], ROLE);
    assert.deepEqual([c.started, c.conflicts], [[], [{ path: 'src/server/ds/routes.ts', task: 'T-002' }]], s);
  }
  for (const s of ['done', 'cancelled'] as const) {
    const c = checkScope(me, [me, other(s)], ['src/server/ds/routes.ts'], ROLE);
    assert.deepEqual([c.started, c.conflicts, c.invalid], [[], [], []], s);
  }
});

test('角色范围外的交给主会话；路径写法与范围大小校验保留', () => {
  const c = checkScope(me, [me], ['web/src/x.ts', '../x', '**'], ROLE);
  assert.deepEqual(c.outsideRole, ['web/src/x.ts']);
  assert.equal(c.invalid.length, 2);
});

test('偏离 107：test_author 关闭时对验收测试的拒绝不再指向 forge_dispute', () => {
  const c = checkScope(me, [me], ['tests/acceptance/T-004/x.ts'], ROLE, { testAuthorOff: true });
  assert.equal(c.invalid.length, 1);
  assert.doesNotMatch(c.invalid[0]!, /用 forge_dispute/);
  assert.match(c.invalid[0]!, /加入可写范围并退回给你/);
});
