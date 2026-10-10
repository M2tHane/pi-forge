// M4：运行时资源隔离（第 4.1 节）。forge_service 启动的服务拿到本次运行分配的资源；运行结束后释放。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { listResources } from '../../src/core/resources.ts';

test('forge_service 启动的服务拿到本次运行的 PORT、FORGE_PORT_BASE、FORGE_DB_NAME、FORGE_TMP；运行结束后资源释放', async () => {
  const yaml = PROJECT_YAML.replace('limits:', '  serve: "echo $PORT $FORGE_PORT_BASE $FORGE_DB_NAME $FORGE_TMP > ../serve-env.txt; sleep 30"\nlimits:');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001')] });
  let during = 0;
  const e = makeEngine(p, async (_role, _nth, a) => {
    await a.call('forge_claim');
    const r = await a.call('forge_service', { action: 'start', name: 'serve' });
    assert.ok(r.ok, r.text);
    during = listResources(p.dir).length;
    await new Promise((res) => setTimeout(res, 300));
    await a.call('forge_block', { reason: '到此为止' });
  });
  try {
    await e.engine.next(p.flowId);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    const wt = p.store.readTask(p.flowId, 'T-001').worktree!;
    const [port, base, db, tmp] = readFileSync(path.join(path.dirname(wt), 'serve-env.txt'), 'utf8').trim().split(' ');
    const run = p.store.listRuns()[0]!.run_id;
    assert.equal(port, base);
    assert.ok(Number(port) >= 41000);
    assert.equal(db, `forge_${run.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`);
    assert.match(tmp!, new RegExp(`\\.tmp/${run}$`));
    assert.equal(during, 1);
    assert.deepEqual(listResources(p.dir), [], '运行结束后释放');
    assert.ok(!existsSync(tmp!));
  } finally { p.cleanup(); }
});
