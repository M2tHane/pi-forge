// 合并后回归测试（引擎）：task 合入后后台跑门禁命令；后合入的 task 弄坏了先合入的功能时，定位到它并建修复任务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask, hard } from '../helpers/tasks.ts';
import { POST_MERGE } from '../../src/core/engine/post-merge-test.ts';
import { statusText } from '../../src/tools/orchestrator-tools.ts';

const YAML = PROJECT_YAML.replace('post_merge_test: false', 'post_merge_test: true');

test('后合入的 task 弄坏先合入的功能：合并后回归测试变红，定位到它并建修复任务；先合入的那次是绿的', async () => {
  const p = await setupProject({ yaml: YAML, tasks: [mkTask('T-001', { verify: [] }), mkTask('T-002', { verify: [], deps: [hard('T-001')] })] });
  try {
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      assert.ok((await a.call('forge_claim')).ok);
      // T-002 改坏了 T-001 的文件（测试命令检查其中没有 FAIL）
      const content = a.env.task === 'T-001' ? 'ok\n' : 'FAIL\n';
      assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content })).ok);
      await a.call('forge_note', { text: '完成' });
      assert.ok((await a.call('forge_submit', { summary: a.env.task })).ok);
    });
    await engine.next(p.flowId);
    await engine.idle();
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
    const ev = p.store.readEvents().filter((e) => e.data?.['kind'] === POST_MERGE);
    assert.ok(ev.some((e) => e.data!['ok'] === true), '先合入 T-001 后是绿的');
    const red = ev.find((e) => e.data!['ok'] === false)!;
    assert.equal(red.data!['culprit'], 'T-002');
    assert.deepEqual(red.data!['fix'], ['T-002.fx-1']);
    const fix = p.store.readTask(p.flowId, 'T-002.fx-1');
    assert.equal(fix.for_task, 'T-002');
    assert.match(p.store.readHandoff(p.flowId, 'T-002.fx-1'), /合并后的全量检查在 T-002 合入/);
    assert.match(statusText(p.store, engine, p.flowId), /合并后回归测试：.*定位到 T-002/);
  } finally { p.cleanup(); }
});
