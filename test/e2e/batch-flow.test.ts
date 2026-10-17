// 批次阶段的调度：后端按 domain 并行（backend 池），前端按页面串行（frontend 池固定 1 个），最后都经审查合并完成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject } from '../helpers/project.ts';
import { drive, engineEnv, submitWork } from '../helpers/commands.ts';
import { deriveBatchTasks, parseBatchPlan } from '../../src/core/plan/batches.ts';
import { parsePrd } from '../../src/core/spec/prd.ts';
import { ARCH_PRD } from '../helpers/arch.ts';

const PLAN = [
  '## 程序读取的部分', '```yaml', 'batches:', '  - id: B1', '    title: 基础资料', '    reqs: [REQ-001, REQ-002]',
  '    backend:', '      - { domain: user, paths: ["src/server/user/**"] }', '      - { domain: catalog, paths: ["src/server/catalog/**"] }',
  '    frontend: [login, products]', '```', '',
].join('\n');

test('一个批次：两个 domain 同时开发，前端基础与页面一个接一个；全部审查后合并完成', async () => {
  const { stages, tasks } = deriveBatchTasks(parseBatchPlan(PLAN).plan!, parsePrd(ARCH_PRD), 1);
  assert.deepEqual(stages.map((s) => s.id), ['S1']);
  const p = await setupProject({ stages: ['S1'], tasks });
  const running = { backend: 0, frontend: 0 };
  const peak = { backend: 0, frontend: 0 };
  const order: string[] = [];
  const e = engineEnv(p, async (role, _nth, a) => {
    if (role !== 'backend' && role !== 'frontend') return;
    running[role]++;
    peak[role] = Math.max(peak[role], running[role]);
    try {
      await a.call('forge_claim');
      // 后端等另一个 domain 也开工（并行），最多等 3 秒
      for (const end = Date.now() + 3000; role === 'backend' && running.backend < 2 && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
      order.push(a.env.task);
      await submitWork(a, `${a.env.task} 完成`, { [`src/${a.env.task.toLowerCase()}/index.ts`]: `export const id = '${a.env.task}';\n` });
    } finally { running[role]--; }
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    const all = p.store.listTasks(p.flowId).filter((t) => t.kind === 'impl');
    assert.deepEqual(all.map((t) => [t.id, t.role, t.title, t.status]), [
      ['T-001', 'backend', '后端 user', 'done'], ['T-002', 'backend', '后端 catalog', 'done'],
      ['T-003', 'frontend', '前端基础', 'done'], ['T-004', 'frontend', '页面 login', 'done'], ['T-005', 'frontend', '页面 products', 'done'],
      ['T-006', 'frontend', '接入真实接口（B1）', 'done'],
    ]);
    assert.equal(peak.backend, 2, '两个 domain 同时开发');
    assert.equal(peak.frontend, 1, '前端同一时间只有 1 个');
    assert.deepEqual(order.filter((id) => ['T-003', 'T-004', 'T-005', 'T-006'].includes(id)), ['T-003', 'T-004', 'T-005', 'T-006']);
    // 页面接着上一个前端任务的会话；domain、页面都审查，"接入真实接口"不单独审查
    assert.deepEqual(['T-004', 'T-005', 'T-006'].map((id) => p.store.readTask(p.flowId, id).fork_from_task), ['T-003', 'T-004', 'T-005']);
    const reviewed = p.store.listTasks(p.flowId).filter((t) => t.kind === 'review').map((t) => t.for_task).sort();
    assert.deepEqual(reviewed, ['T-001', 'T-002', 'T-003', 'T-004', 'T-005']);
    const integ = p.store.readFlow(p.flowId).integration_branch;
    for (const id of ['t-001', 't-002', 't-003', 't-004', 't-005', 't-006']) assert.match(p.git('show', `${integ}:src/${id}/index.ts`), /export const id/);
  } finally { p.cleanup(); }
});
