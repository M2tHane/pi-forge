// P1 的 architect task：scopes 与 writes 只取 plan scope（architect 在 S0 另有 code scope，不能因此变宽）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject } from '../helpers/project.ts';
import { ensureArchitectTask } from '../../src/core/plan/plan-flow.ts';
import { validateDag } from '../../src/core/state/dag.ts';

test('ensureArchitectTask：P1 task 的 scopes 为 plan，writes 只是 plan scope 的范围', async () => {
  const p = await setupProject({ stages: ['P1'] });
  try {
    const t = await ensureArchitectTask(p.store, p.config, p.flowId, null);
    assert.ok(t, '新建了 architect task');
    assert.deepEqual([t.kind, t.role, t.stage], ['doc', 'architect', 'P1']);
    assert.deepEqual(t.scopes, ['plan']);
    assert.deepEqual(t.writes, p.config.scopeWrites()['plan']);
    assert.ok(!t.writes.includes('**') && !t.writes.includes('rules/**'));
    // 角色确实还拥有 code scope（S0 用），但 task 没有带上
    assert.deepEqual(p.config.role('architect').scopes, ['plan', 'code']);
    assert.deepEqual(validateDag([t], p.config.dagCatalog()).errors, []);
  } finally { p.cleanup(); }
});
