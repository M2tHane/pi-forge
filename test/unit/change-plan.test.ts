// 小改动（change）模式的迷你计划校验：纯函数，逐条规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChangePlan, type ChangePlanInput } from '../../src/core/plan/change-plan.ts';
import { forbiddenWriteOf } from '../../src/core/plan/plan.ts';

const task = (o: Partial<ChangePlanInput['tasks'][number]> = {}): ChangePlanInput['tasks'][number] => ({ title: '加导出', writes: ['src/export/**'], ac: ['能导出 CSV'], ...o });
const input = (tasks: ChangePlanInput['tasks'], o: Partial<ChangePlanInput> = {}): ChangePlanInput => ({ title: '加导出功能', tasks, ...o });
const opts = { maxTasks: 3, scopes: ['code'], verify: ['typecheck', 'lint', 'test'] };

test('task 数量：1 到 maxTasks', () => {
  assert.match(checkChangePlan(input([]), opts).errors.join(), /至少需要 1 个 task/);
  const four = checkChangePlan(input([task(), task(), task(), task()]), opts);
  assert.match(four.errors.join(), /最多 3 个/);
  assert.deepEqual(four.tasks, []);
  assert.deepEqual(checkChangePlan(input([task(), task(), task()]), opts).errors, []);
  assert.match(checkChangePlan(input([task(), task()]), { ...opts, maxTasks: 1 }).errors.join(), /最多 1 个/);
});

test('title 与 ac 非空', () => {
  assert.match(checkChangePlan(input([task()], { title: '  ' }), opts).errors.join(), /title 不能为空/);
  assert.match(checkChangePlan(input([task({ title: '' })]), opts).errors.join(), /T-001 的 title 不能为空/);
  assert.match(checkChangePlan(input([task({ ac: [] })]), opts).errors.join(), /T-001 的 ac 不能为空/);
  assert.match(checkChangePlan(input([task({ ac: ['  '] })]), opts).errors.join(), /T-001 的 ac 不能为空/);
});

test('id：缺省按顺序 T-001…；给了必须是 T-数字且不重复', () => {
  const ok = checkChangePlan(input([task(), task({ title: '第二个' })]), opts);
  assert.deepEqual(ok.tasks.map((t) => t.id), ['T-001', 'T-002']);
  assert.match(checkChangePlan(input([task({ id: 'task1' })]), opts).errors.join(), /task1 必须写成 T-数字/);
  assert.match(checkChangePlan(input([task({ id: 'T-1' })]), opts).errors.join(), /T-1 必须写成 T-数字/);
  assert.match(checkChangePlan(input([task({ id: 'T-007' }), task({ id: 'T-007' })]), opts).errors.join(), /T-007 重复/);
  // 缺省编号与显式编号冲突也算重复
  assert.match(checkChangePlan(input([task(), task({ id: 'T-001' })]), opts).errors.join(), /T-001 重复/);
  assert.deepEqual(checkChangePlan(input([task({ id: 'T-010' })]), opts).tasks.map((t) => t.id), ['T-010']);
});

test('writes：非空，且不与 FORBIDDEN_WRITES 重叠', () => {
  assert.match(checkChangePlan(input([task({ writes: [] })]), opts).errors.join(), /T-001 的 writes 不能为空/);
  for (const w of ['tests/acceptance/**', 'docs/spec/glossary.md', 'docs/contracts/api.md', 'rules/global.md', '.forge/state.json', 'workflow.yaml', '**']) {
    const r = checkChangePlan(input([task({ writes: ['src/a.ts', w] })]), opts);
    assert.match(r.errors.join(), new RegExp(`writes ${w.replace(/[*.]/g, '\\$&')} 与 .* 重叠`), w);
    assert.ok(forbiddenWriteOf(w), w);
  }
  assert.equal(forbiddenWriteOf('src/**'), undefined);
  assert.deepEqual(checkChangePlan(input([task({ writes: ['src/a.ts', 'docs/arch/overview.md'] })]), opts).errors, []);
});

test('depends_on：引用必须存在，不能依赖自己，不能有环', () => {
  assert.match(checkChangePlan(input([task({ depends_on: [{ task: 'T-009', type: 'hard' }] })]), opts).errors.join(), /引用了不存在的 task T-009/);
  assert.match(checkChangePlan(input([task({ depends_on: [{ task: 'T-001', type: 'hard' }] })]), opts).errors.join(), /不能依赖自己/);
  const cyc = checkChangePlan(input([task({ depends_on: [{ task: 'T-002', type: 'hard' }] }), task({ depends_on: [{ task: 'T-001', type: 'soft' }] })]), opts);
  assert.match(cyc.errors.join(), /依赖存在环：.*T-001.*T-002/);
  assert.deepEqual(cyc.tasks, []);
  const fine = checkChangePlan(input([task(), task({ depends_on: [{ task: 'T-001', type: 'hard' }] })]), opts);
  assert.deepEqual(fine.errors, []);
});

test('派生的 TaskInput：X1、impl、worker、scopes/verify 取参数、writes 加自己的验收目录、ac 原文、layers/module 透传、不设 review', () => {
  const r = checkChangePlan(input([
    task({ id: 'T-003', title: ' 加导出 ', writes: ['src/export/**', 'src/export/**'], ac: ['能导出 CSV', '空数据导出表头'], layers: ['api'], module: 'export' }),
    task({ title: '页面按钮', writes: ['src/ui/**'], depends_on: [{ task: 'T-003', type: 'hard' }] }),
  ]), opts);
  assert.deepEqual(r.errors, []);
  const [a, b] = r.tasks;
  assert.deepEqual([a!.id, a!.stage, a!.kind, a!.role, a!.title], ['T-003', 'X1', 'impl', 'worker', '加导出']);
  assert.deepEqual(a!.scopes, ['code']);
  assert.deepEqual(a!.verify, ['typecheck', 'lint', 'test']);
  assert.deepEqual(a!.writes, ['src/export/**', 'tests/acceptance/T-003/**']);
  assert.deepEqual(a!.ac, ['能导出 CSV', '空数据导出表头']);
  assert.deepEqual(a!.layers, ['api']);
  assert.equal(a!.module, 'export');
  assert.equal('review' in a!, false);
  assert.deepEqual(a!.depends_on, []);
  assert.deepEqual([b!.id, b!.writes, b!.depends_on], ['T-002', ['src/ui/**', 'tests/acceptance/T-002/**'], [{ task: 'T-003', type: 'hard' }]]);
  assert.equal('layers' in b!, false);
  // 参数缺省
  const bare = checkChangePlan(input([task()]), { maxTasks: 3 });
  assert.deepEqual([bare.tasks[0]!.scopes, bare.tasks[0]!.verify], [[], []]);
});
