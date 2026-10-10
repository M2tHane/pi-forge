// M5：契约文件冲突的结构化三方合并（第 12.2 节）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine, commitToBranch } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';

const ROOT = `openapi: 3.1.0
info: { title: demo, version: 1.0.0 }
paths:
  /api/a:
    $ref: './paths/a.yaml#/~1api~1a'
`;

test('根 openapi.yaml 的 paths 并行追加：预检前同步集成分支时冲突，被结构化合并后合入', async () => {
  const p = await setupProject({
    yaml: PROJECT_YAML,
    files: { 'docs/contracts/openapi.yaml': ROOT },
    tasks: [mkTask('T-001', { writes: ['src/server/t-001/**', 'docs/contracts/openapi.yaml'], verify: [] })],
  });
  try {
    const integ = `flow/${p.flowId}/integration`;
    const { engine, merges, errors } = makeEngine(p, async (_role, _n, a) => {
      await a.call('forge_claim');
      assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' })).ok);
      assert.ok((await a.call('write', { path: 'docs/contracts/openapi.yaml', content: ROOT + `  /api/t1:\n    $ref: './paths/t1.yaml#/~1api~1t1'\n` })).ok);
      await a.call('forge_note', { text: '完成' });
      // 另一个并行任务先把自己的引用合入了集成分支
      commitToBranch(p.dir, integ, { 'docs/contracts/openapi.yaml': ROOT + `  /api/t2:\n    $ref: './paths/t2.yaml#/~1api~1t2'\n` }, '并行任务追加');
      const r = await a.call('forge_submit', { summary: '追加 /api/t1' });
      assert.ok(r.ok, r.text);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.ok(!merges.some((m) => m.kind === 'merge_fix' || m.kind === 'blocked'), JSON.stringify(merges));
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    const merged = parse(p.git('show', `${integ}:docs/contracts/openapi.yaml`));
    assert.deepEqual(Object.keys(merged.paths), ['/api/a', '/api/t2', '/api/t1']);
    assert.ok(p.store.readEvents().some((e) => e.type === 'note' && /契约文件冲突已结构化合并/.test(e.reason ?? '')));
  } finally { p.cleanup(); }
});
