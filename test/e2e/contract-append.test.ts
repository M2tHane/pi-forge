// M5 验收：契约只能追加（第 12.1、12.2 节）的流程级测试——fake-subagent 经真实引擎与工具。
// 覆盖 forge_submit 的拒绝与预检、合并的接线（纯函数 contract-diff 另有单元测试）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { CONTRACTS } from '../helpers/contracts.ts';

const files = Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [`docs/contracts/${k}`, v]));
const C = (k: string) => `docs/contracts/${k}`;
const team = () => mkTask('T-001', { module: 'team', writes: ['src/server/t-001/**'], verify: [] });
const NEW_PATH = `/api/teams/{id}:\n  get:\n    operationId: getTeam\n    responses:\n      '200': { description: 团队 }\n`;

test('worker 改本模块已有契约：forge_submit 被拒并点出文件与位置；还原后只追加则提交成功并合入', async () => {
  const p = await setupProject({ yaml: PROJECT_YAML, files, tasks: [team()] });
  try {
    const integ = `flow/${p.flowId}/integration`;
    const texts: string[] = [];
    const { engine, merges, errors } = makeEngine(p, async (_role, _n, a) => {
      await a.call('forge_claim');
      assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' })).ok);
      // 改已有值 + 删除已有内容
      assert.ok((await a.call('write', { path: C('paths/team.yaml'), content: CONTRACTS['paths/team.yaml']!.replace('listTeams', 'listAllTeams') })).ok);
      assert.ok((await a.call('write', { path: C('modules/team.md'), content: '# team\n' })).ok);
      await a.call('forge_note', { text: '完成' });
      const bad = await a.call('forge_submit', { summary: '改契约' });
      texts.push(bad.text);
      assert.ok(!bad.ok);
      // 还原后只追加
      assert.ok((await a.call('write', { path: C('modules/team.md'), content: CONTRACTS['modules/team.md']! })).ok);
      assert.ok((await a.call('write', { path: C('paths/team.yaml'), content: CONTRACTS['paths/team.yaml']! + NEW_PATH })).ok);
      const r = await a.call('forge_submit', { summary: '追加 /api/teams/{id}' });
      assert.ok(r.ok, r.text);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.match(texts[0]!, /契约只能追加/);
    assert.match(texts[0]!, /docs\/contracts\/paths\/team\.yaml/);
    assert.match(texts[0]!, /operationId/);
    assert.match(texts[0]!, /docs\/contracts\/modules\/team\.md/);
    assert.ok(!merges.some((m) => m.kind === 'merge_fix' || m.kind === 'blocked'), JSON.stringify(merges));
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    const merged = parse(p.git('show', `${integ}:docs/contracts/paths/team.yaml`));
    assert.deepEqual(Object.keys(merged), ['/api/teams', '/api/teams/{id}']);
    assert.equal(merged['/api/teams'].get.operationId, 'listTeams');
  } finally { p.cleanup(); }
});

test('worker 改别的模块的契约文件：forge_submit 被拒；还原后提交成功', async () => {
  const p = await setupProject({ yaml: PROJECT_YAML, files, tasks: [team()] });
  try {
    const texts: string[] = [];
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      await a.call('forge_claim');
      assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' })).ok);
      // 即使只是追加，别的模块（datasource）的文件也不能动
      assert.ok((await a.call('write', { path: C('errors/datasource.yaml'), content: CONTRACTS['errors/datasource.yaml']! + 'DATASOURCE_GONE: { http: 410, message: 已删除 }\n' })).ok);
      await a.call('forge_note', { text: '完成' });
      const bad = await a.call('forge_submit', { summary: '越界改契约' });
      texts.push(bad.text);
      assert.ok(!bad.ok);
      assert.ok((await a.call('write', { path: C('errors/datasource.yaml'), content: CONTRACTS['errors/datasource.yaml']! })).ok);
      const r = await a.call('forge_submit', { summary: '只改本模块代码' });
      assert.ok(r.ok, r.text);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.match(texts[0]!, /docs\/contracts\/errors\/datasource\.yaml/);
    assert.match(texts[0]!, /team/);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
  } finally { p.cleanup(); }
});

test('worker 合法追加新 path（含根 openapi.yaml 的 $ref 一行）：提交成功，预检通过并合入集成分支', async () => {
  const p = await setupProject({ yaml: PROJECT_YAML, files, tasks: [team()] });
  try {
    const integ = `flow/${p.flowId}/integration`;
    const { engine, merges, errors } = makeEngine(p, async (_role, _n, a) => {
      await a.call('forge_claim');
      assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' })).ok);
      assert.ok((await a.call('write', { path: C('paths/team.yaml'), content: CONTRACTS['paths/team.yaml']! + NEW_PATH })).ok);
      assert.ok((await a.call('write', { path: C('openapi.yaml'), content: CONTRACTS['openapi.yaml']! + `  /api/teams/{id}:\n    $ref: './paths/team.yaml#/~1api~1teams~1{id}'\n` })).ok);
      await a.call('forge_note', { text: '完成' });
      const r = await a.call('forge_submit', { summary: '追加 /api/teams/{id}' });
      assert.ok(r.ok, r.text);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.ok(!merges.some((m) => m.kind === 'merge_fix' || m.kind === 'blocked'), JSON.stringify(merges));
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    const root = parse(p.git('show', `${integ}:docs/contracts/openapi.yaml`));
    assert.deepEqual(Object.keys(root.paths), ['/api/teams', '/api/datasources', '/api/teams/{id}']);
  } finally { p.cleanup(); }
});
