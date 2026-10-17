import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDag, computeReady, dagStats, remainingPath, type DagCatalog,
  dagReport, serialHeads } from '../../src/core/state/dag.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

const catalog: DagCatalog = {
  roles: {
    worker: { scopes: ['code'] },
    architect: { scopes: ['plan'] },
    'test-author': { scopes: ['acctest'] },
    reviewer: { scopes: ['review'] },
    'stage-qa': { scopes: ['qa'] },
    orchestrator: { scopes: [] },
  },
  scopes: {
    code: ['**'],
    plan: ['docs/contracts/**', 'docs/arch/**', 'docs/plan/**', 'docs/spec/glossary.md', 'docs/rules-draft/**', 'AGENTS.md'],
    acctest: ['tests/acceptance/**'],
    review: [], qa: [],
  },
  commands: ['typecheck', 'test', 'e2e'],
  maxTaskFiles: 12,
};

test('合法 DAG 通过校验', () => {
  const tasks = [
    mkTask('T-001', { writes: ['src/server/teams/**'] }),
    mkTask('T-002', { writes: ['src/server/orders/**', 'src/web/orders/**', 'migrations/*_orders.sql'], deps: [hard('T-001', '先有团队')] }),
  ];
  const r = validateDag(tasks, catalog);
  assert.deepEqual(r.errors, []);
});

test('检出环', () => {
  const tasks = [mkTask('T-001', { deps: [hard('T-002')] }), mkTask('T-002', { deps: [hard('T-001')] })];
  const r = validateDag(tasks, catalog);
  assert.ok(r.errors.some((e) => e.includes('环')), r.errors.join('\n'));
});

test('检出引用不存在的依赖与重复 id', () => {
  const r = validateDag([mkTask('T-001', { deps: [hard('T-009')] }), mkTask('T-001')], catalog);
  assert.ok(r.errors.some((e) => e.includes('T-009')));
  assert.ok(r.errors.some((e) => e.includes('重复')));
});

test('硬依赖可以不写 reason', () => {
  const r = validateDag([mkTask('T-001'), mkTask('T-002', { deps: [{ task: 'T-001', type: 'hard' }] })], catalog);
  assert.ok(!r.errors.some((e) => e.includes('reason')));
});

test('检出非法角色、scope、命令与越出 scope 的 writes', () => {
  const r = validateDag([
    mkTask('T-001', { role: 'nobody' }),
    mkTask('T-002', { scopes: ['plan'] }),
    mkTask('T-003', { verify: ['deploy'] }),
    mkTask('T-004', { role: 'architect', scopes: ['plan'], writes: ['src/web/**'] }),
    mkTask('T-005', { scopes: ['ghost'] }),
  ], catalog);
  const all = r.errors.join('\n');
  assert.match(all, /T-001.*nobody/);
  assert.match(all, /T-002.*plan/);
  assert.match(all, /T-003.*deploy/);
  assert.match(all, /T-004.*src\/web/);
  assert.match(all, /T-005.*ghost/);
});

test('writes 过多给出警告而非错误', () => {
  const writes = Array.from({ length: 13 }, (_, i) => `src/server/f${i}.ts`);
  const r = validateDag([mkTask('T-001', { writes })], catalog);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
});

test('依赖 done 之后才 ready（跨阶段的依赖也一样）；只看当前阶段', () => {
  const tasks = [
    mkTask('T-001', { status: 'in_progress', stage: 'S2' }),
    mkTask('T-002', { deps: [hard('T-001')] }),
    mkTask('T-003'),
    mkTask('T-004', { stage: 'S4' }),
  ];
  assert.deepEqual(computeReady(tasks, 'S3'), ['T-003']);
  tasks[0]!.status = 'done';
  assert.deepEqual(computeReady(tasks, 'S3'), ['T-002', 'T-003']);
});

test('依赖阻塞或取消时后继不会 ready', () => {
  for (const status of ['blocked', 'cancelled'] as const) {
    assert.deepEqual(computeReady([mkTask('T-001', { status }), mkTask('T-002', { deps: [hard('T-001')] })], 'S3'), []);
  }
});

test('关键路径与宽度', () => {
  // T1 -> T2 -> T4；T1 -> T3 -> T5
  const tasks = [
    mkTask('T-001'), mkTask('T-002', { deps: [hard('T-001')] }), mkTask('T-003', { deps: [hard('T-001')] }),
    mkTask('T-004', { deps: [hard('T-002')] }), mkTask('T-005', { deps: [hard('T-003')] }),
  ];
  const s = dagStats(tasks);
  assert.equal(s.taskCount, 5);
  assert.equal(s.criticalPathLength, 3);
  assert.deepEqual(s.criticalPath, ['T-001', 'T-002', 'T-004']);
  assert.equal(s.maxWidth, 2);
  const rp = remainingPath(tasks);
  assert.equal(rp.get('T-001'), 3);
  assert.equal(rp.get('T-004'), 1);
});

test('DAG 报告：同一阶段开头连续两层只能串行时提醒；关键路径占比超过一半时提醒', () => {
  // S3：T-001（底座验收测试）→ T-002（底座实现）→ T-003、T-004、T-005 三条切片
  const serial = [
    mkTask('T-001'), mkTask('T-002', { deps: [hard('T-001')] }),
    mkTask('T-003', { deps: [hard('T-002')] }), mkTask('T-004', { deps: [hard('T-002')] }), mkTask('T-005', { deps: [hard('T-002')] }),
  ];
  assert.deepEqual(serialHeads(serial), [{ stage: 'S3', chain: ['T-001', 'T-002'], total: 5 }]);
  assert.ok(dagReport(serial).warnings.some((w) => /阶段 S3 开头 2 层只能串行（T-001 → T-002）/.test(w)));
  // 底座合并成一个任务、切片对着契约开发：开头就能并行
  const wide = [
    mkTask('T-001'), mkTask('T-002'), mkTask('T-003'),
    mkTask('T-004', { deps: [hard('T-001'), hard('T-002'), hard('T-003')] }),
  ];
  assert.deepEqual(serialHeads(wide), []);
  assert.deepEqual(dagReport(wide).warnings, []);
  // 其他阶段的前驱不算本阶段的层；任务少于 4 个的阶段不检查
  const staged = [
    mkTask('T-001', { stage: 'S2' }),
    ...['T-002', 'T-003', 'T-004', 'T-005'].map((id) => mkTask(id, { deps: [hard('T-001')] })),
  ];
  assert.deepEqual(serialHeads(staged), []);
  // 关键路径 3 / 任务数 5 = 0.6 > 0.5
  const longPath = [
    mkTask('T-001'), mkTask('T-002'), mkTask('T-003', { deps: [hard('T-001')] }), mkTask('T-004', { deps: [hard('T-003')] }), mkTask('T-005'),
  ];
  assert.ok(dagReport(longPath).warnings.some((w) => /关键路径 3 \/ 任务数 5/.test(w)));
});

