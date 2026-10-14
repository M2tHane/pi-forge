// 主会话裁决：程序与子进程造成的阻塞先交给 orchestrator（forge_decide），它解决不了再转交用户。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { flowDecide, statusText } from '../../src/tools/orchestrator-tools.ts';
import { nextStep } from '../../src/core/engine/context-injector.ts';
import { actionsNeeded } from '../../src/core/ops/status-view.ts';
import { pendingDecisions } from '../../src/core/engine/decisions.ts';

test('子进程提问：先交给主会话；主会话 retry 回答后任务接着做完；转交用户后只有用户能处理', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: [] }), mkTask('T-002', { verify: [], writes: ['src/server/t-002/**'] })] });
  try {
    const handoffs: string[] = [];
    const { engine, errors } = makeEngine(p, async (_role, n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      const task = a.env.task;
      if (n === 1) { await a.call('forge_block', { reason: '用 PostgreSQL 还是 SQLite？建议 SQLite' }); return; }
      handoffs.push(p.store.readHandoff(p.flowId, task));
      assert.ok((await a.call('write', { path: `src/server/${task.toLowerCase()}/a.ts`, content: 'x\n' })).ok);
      await a.call('forge_note', { text: '完成' });
      assert.ok((await a.call('forge_submit', { summary: 'a' })).ok);
    });
    await engine.next(p.flowId);
    await engine.idle();
    for (const id of ['T-001', 'T-002']) {
      const t = p.store.readTask(p.flowId, id);
      assert.deepEqual([t.status, t.blocked_by, t.blocked_owner], ['blocked', 'agent', 'orchestrator']);
    }
    assert.deepEqual(pendingDecisions(p.store, p.flowId).map((d) => [d.id, d.options]), [['T-001', ['retry', 'user']], ['T-002', ['retry', 'user']]]);
    assert.match(statusText(p.store, engine, p.flowId), /等你决定（forge_decide）[\s\S]*T-001[\s\S]*PostgreSQL/);
    assert.doesNotMatch(statusText(p.store, engine, p.flowId), /阻塞，需要用户处理/);
    assert.equal(nextStep(p.store, 2, 0, p.config).tool, 'forge_decide');
    assert.equal(actionsNeeded(p.store, p.config).find((x) => x.key.includes(':blocked:T-001:'))!.owner, 'orchestrator');

    await assert.rejects(flowDecide(p.dir, p.store, p.config, engine, { target: 'T-001', decision: 'accept', note: 'x' }), /不能 accept/);
    const r = await flowDecide(p.dir, p.store, p.config, engine, { target: 'T-001', decision: 'retry', note: '用 SQLite' });
    assert.match(r.text, /重新做/);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.equal(p.store.readTask(p.flowId, 'T-001').decisions, 1);
    assert.match(handoffs[0] ?? '', /主会话的意见：\n用 SQLite/);

    await flowDecide(p.dir, p.store, p.config, engine, { target: 'T-002', decision: 'user', note: '要用户选数据库' });
    const t2 = p.store.readTask(p.flowId, 'T-002');
    assert.deepEqual([t2.status, t2.blocked_owner], ['blocked', undefined]);
    assert.match(statusText(p.store, engine, p.flowId), /阻塞，需要用户处理：\n- T-002/);
    assert.equal(nextStep(p.store, 2, 0, p.config).tool, 'none');
    await assert.rejects(flowDecide(p.dir, p.store, p.config, engine, { target: 'T-002', decision: 'retry', note: 'x' }), /没有等主会话决定/);
    assert.deepEqual(errors, []);
  } finally { p.cleanup(); }
});

test('同一任务主会话最多决定 2 次：之后再阻塞直接等用户', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: [] })] });
  try {
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      await a.call('forge_block', { reason: '还是不清楚' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    for (let i = 0; i < 2; i++) {
      assert.equal(p.store.readTask(p.flowId, 'T-001').blocked_owner, 'orchestrator');
      await flowDecide(p.dir, p.store, p.config, engine, { target: 'T-001', decision: 'retry', note: `第 ${i + 1} 次意见` });
      await engine.idle();
    }
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([t.status, t.decisions, t.blocked_owner], ['blocked', 2, undefined]);
    assert.deepEqual(pendingDecisions(p.store, p.flowId), []);
    assert.deepEqual(errors, []);
  } finally { p.cleanup(); }
});
