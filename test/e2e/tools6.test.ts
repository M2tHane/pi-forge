// 改编自 pi-flow test/e2e/tools6.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
// 第六轮 D1–D3：forge_service 启动并在运行结束时清理服务；forge_request_scope 程序批准或交给主会话；guard 拒绝时给出可行做法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { alive } from '../../src/core/engine/services.ts';
import { flowResolveScope } from '../../src/tools/orchestrator-tools.ts';
import { nextStep } from '../../src/core/engine/context-injector.ts';

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
});

test('forge_service：只能启动 serve 命令；ready 等端口就绪；本次运行结束时程序结束服务（连同它的子进程）', async () => {
  const port = await freePort();
  const server = `node -e "require('http').createServer((q,s)=>s.end('pong')).listen(${port})"`;
  const yaml = PROJECT_YAML.replace(/  e2e:       "true"/, `  e2e:       "true"\n  serve:     "${server.replace(/"/g, '\\"')}"`);
  const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: [] })] });
  try {
    assert.ok(p.config.role('worker').tools.has('forge_service'), 'worker 按模板显式拥有 forge_service');
    let pid = 0;
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      await a.call('forge_claim');
      const bg = await a.call('bash', { command: 'sleep 100 &' });
      assert.match(bg.text, /forge_service start/, '后台 & 被拦下时提示用 forge_service');
      assert.match((await a.call('forge_service', { action: 'start', name: 'test' })).text, /只能启动 workflow.yaml commands 里 serve/);
      const r = await a.call('forge_service', { action: 'start', name: 'serve', ready: port, timeout_s: 20 });
      assert.ok(r.ok, r.text);
      assert.match(r.text, /已就绪/);
      pid = Number(/pid (\d+)/.exec(r.text)![1]);
      assert.match((await a.call('bash', { command: `curl -s http://localhost:${port}/` })).text, /pong/);
      assert.match((await a.call('forge_service', { action: 'status' })).text, /serve（运行中/);
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok\n' });
      await a.call('forge_note', { text: '完成' });
      await a.call('forge_submit', { summary: '完成' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.ok(pid > 0);
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!alive(pid), '运行结束后服务已被结束');
    assert.ok(p.store.readEvents().some((e) => /启动的服务：serve/.test(e.reason ?? '')));
  } finally { p.cleanup(); }
});

test('forge_request_scope：task writes 外无重叠的直接批准；与其他 task 的 writes 或 shared 重叠交给主会话，拒绝写入 handoff、批准后可写', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: [] }), mkTask('T-002', { verify: [], shared: ['src/shared/date.ts'], deps: [{ task: 'T-001', type: 'hard', reason: 'x' }] })] });
  try {
    const settled = async () => { while (p.store.readTask(p.flowId, 'T-001').scope_request) await new Promise((r) => setTimeout(r, 20)); };
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      await a.call('forge_claim');
      const denied = await a.call('write', { path: 'src/server/common/date.ts', content: 'x\n' });
      assert.match(denied.text, /forge_request_scope/, '越界写被拦下时提示申请范围');
      assert.match((await a.call('forge_request_scope', { paths: ['.forge/**'], reason: '想改状态' })).text, /受保护路径/);
      assert.match((await a.call('forge_request_scope', { paths: ['src/server/common/date.ts'], reason: '日期格式化要共用' })).text, /已批准/);
      assert.ok((await a.call('write', { path: 'src/server/common/date.ts', content: 'x\n' })).ok);
      assert.match((await a.call('forge_request_scope', { paths: ['src/server/t-002/util.ts'], reason: '顺手加个工具函数' })).text, /已交给主会话决定：src\/server\/t-002\/util.ts（与 T-002 的范围重叠）/);
      await settled();
      assert.match((await a.call('forge_request_scope', { paths: ['src/shared/date.ts'], reason: '前后端共用' })).text, /已交给主会话决定：src\/shared\/date.ts（与 T-002 的范围重叠）/);
      await settled();
      assert.ok((await a.call('write', { path: 'src/shared/date.ts', content: 'x\n' })).ok, '主会话批准后可写');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok\n' });
      await a.call('forge_note', { text: '完成' });
      await a.call('forge_submit', { summary: '完成' });
    });
    const pending = async () => { for (let i = 0; i < 300 && !p.store.readTask(p.flowId, 'T-001').scope_request; i++) await new Promise((r) => setTimeout(r, 20)); };
    await engine.next(p.flowId);
    await pending();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.ok(t.writes.includes('src/server/common/date.ts'));
    assert.equal(t.scope_grants?.[0]?.by, 'program');
    assert.equal(nextStep(p.store, 2).tool, 'forge_resolve_scope');
    await assert.rejects(flowResolveScope(p.store, { task_id: 'T-001', decision: 'reject' }), /reject 需要 note/);
    await flowResolveScope(p.store, { task_id: 'T-001', decision: 'reject', note: '属于 T-002，写进 handoff 让它做' });
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /拒绝了范围申请[\s\S]*属于 T-002/);
    await pending();
    await flowResolveScope(p.store, { task_id: 'T-001', decision: 'approve' });
    await engine.idle();
    assert.deepEqual(errors, []);
    const done = p.store.readTask(p.flowId, 'T-001');
    assert.equal(done.status, 'done', '追加的文件随任务一起合入');
    assert.deepEqual(done.scope_grants?.map((g) => g.by), ['program', 'orchestrator']);
  } finally { p.cleanup(); }
});
