// 叫醒主会话：只在出现新的待决定事项时发消息。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeMessage } from '../../src/core/engine/decisions.ts';

test('wakeMessage：只列新出现的事项；没有新事项、事项减少时不发', () => {
  assert.equal(wakeMessage(new Set(), []), null);
  assert.equal(wakeMessage(new Set(['B-1:task:T-001']), ['B-1:task:T-001']), null);
  assert.equal(wakeMessage(new Set(['B-1:task:T-001', 'B-1:stage:S1']), ['B-1:stage:S1']), null);
  const m = wakeMessage(new Set(['B-1:task:T-001']), ['B-1:task:T-001', 'B-1:task:T-002', 'B-1:change:C-1']);
  assert.match(m ?? '', /等你决定：T-002、C-1。.*forge_decide/);
});
