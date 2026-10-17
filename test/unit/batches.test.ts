// docs/plan.md 的 yaml 区块：解析、校验、生成批次阶段与任务（纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBatchPlan, deriveBatchTasks, parseBatchPlan, risksSection, splitPlan } from '../../src/core/plan/batches.ts';
import { parsePrd } from '../../src/core/spec/prd.ts';
import { ARCH_PRD, PLAN_MD_TEXT } from '../helpers/arch.ts';

const prd = parsePrd(ARCH_PRD);
const planOf = (yaml: string) => parseBatchPlan(`# 计划\n\n## 程序读取的部分\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n`);

test('splitPlan 与 risksSection：说明部分、yaml 区块、风险与假设', () => {
  const { prose, yaml } = splitPlan(PLAN_MD_TEXT);
  assert.match(prose, /^# 计划[\s\S]*价格按分存整数$/);
  assert.match(yaml!, /^max_parallel_backend: 2\nbatches:/);
  assert.equal(risksSection(prose), '- 报表留到下一期（REQ-004 不在本计划里）\n- 价格按分存整数');
  assert.deepEqual(splitPlan('# 没有程序读取的部分'), { prose: '# 没有程序读取的部分', yaml: null });
});

test('parseBatchPlan：字段与默认值；backend 可以只写 domain 名；形状不对是错误', () => {
  const ok = parseBatchPlan(PLAN_MD_TEXT);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.plan!.max_parallel_backend, 2);
  assert.deepEqual(ok.plan!.shared, ['src/shared/**']);
  assert.deepEqual(ok.plan!.batches[0]!.backend.map((d) => [d.domain, d.after, d.paths]), [['user', [], ['src/server/user/**']], ['inventory', ['catalog'], []], ['catalog', [], ['src/server/catalog/**']]]);
  assert.deepEqual(planOf('batches:\n  - id: B1\n    backend: [user]').plan!.batches[0], { id: 'B1', title: '', reqs: [], backend: [{ domain: 'user', after: [], paths: [] }], frontend: [] });
  assert.match(parseBatchPlan('# 计划').errors.join(), /缺少「## 程序读取的部分」/);
  assert.match(planOf('batches: [').errors.join(), /不是合法的 YAML/);
  assert.match(planOf('batches: []').errors.join(), /至少要有一个批次/);
  assert.deepEqual(planOf('batches:\n  - title: x\n    frontend: login\n    backend:\n      - { after: [a] }').errors, ['batches[0] 缺少 id', 'batches[0].frontend 应是页面 id 的列表', 'batches[0].backend[0] 缺少 domain']);
  assert.deepEqual(planOf('max_parallel_backend: 0\nbatches:\n  - id: B1\n    frontend: [a]').warnings, ['max_parallel_backend 应是正整数，已忽略']);
});

test('checkBatchPlan：只拦调度做不下去的（批次与 domain 重名、after 不存在、指向更晚批次、成环、空批次）', () => {
  const bad = planOf([
    'batches:',
    '  - id: B1',
    '    backend: [{ domain: a, after: [b] }, { domain: b, after: [a] }, { domain: c, after: [ghost] }, { domain: d, after: [e] }]',
    '  - id: B1',
    '    backend: [{ domain: a }]',
    '  - id: B2',
    '    backend: [{ domain: e }]',
    '  - id: B3',
  ].join('\n')).plan!;
  assert.deepEqual(checkBatchPlan(bad, prd).errors, [
    '批次 id B1 重复',
    'domain a 重名（批次 B1 与 B1）',
    '批次 B3 既没有 backend 也没有 frontend',
    'domain c 的 after 指向不存在的 domain ghost',
    'domain d（批次 B1）的 after 指向更晚批次 B2 的 domain e',
    'domain 的 after 形成环：a → b → a',
  ]);
});

test('checkBatchPlan：没进批次的需求、PRD 里没有的需求与页面只提醒', () => {
  const plan = planOf('batches:\n  - id: B1\n    reqs: [REQ-001, REQ-404]\n    frontend: [login, nope]').plan!;
  const r = checkBatchPlan(plan, prd);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [
    'PRD 里这些需求没有出现在任何批次：REQ-002、REQ-003、REQ-004',
    '批次里这些需求编号在 PRD 里找不到：REQ-404',
    '这些页面 id 在 PRD 的页面表里找不到对应项：nope',
  ]);
});

test('deriveBatchTasks：每批一个阶段；domain 任务按 after 排序与依赖；前端基础只在第一批；页面串成链；接入真实接口依赖本批全部任务且不审查', () => {
  const plan = parseBatchPlan(PLAN_MD_TEXT).plan!;
  const { stages, tasks } = deriveBatchTasks(plan, prd, 2, { verify: ['test'] });
  assert.deepEqual(stages, [{ id: 'S1', goal: 'B1 基础资料', exit: ['REQ-001', 'REQ-002'] }, { id: 'S2', goal: 'B2 单据', exit: ['REQ-003'] }]);
  const row = (id: string) => {
    const t = tasks.find((x) => x.id === id)!;
    return [t.stage, t.title, t.depends_on.map((d) => d.task), t.fork_from_task ?? null, t.review ?? null];
  };
  assert.deepEqual(tasks.map((t) => t.id), ['T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007', 'T-008', 'T-009', 'T-010', 'T-011']);
  assert.deepEqual(row('T-002'), ['S1', '后端 user', [], null, null]);
  assert.deepEqual(row('T-003'), ['S1', '后端 catalog', [], null, null]);
  assert.deepEqual(row('T-004'), ['S1', '后端 inventory', ['T-003'], null, null]);
  assert.deepEqual(row('T-005'), ['S1', '前端基础', [], null, null]);
  assert.deepEqual(row('T-006'), ['S1', '页面 login', ['T-005'], 'T-005', null]);
  assert.deepEqual(row('T-007'), ['S1', '页面 products', ['T-006'], 'T-006', null]);
  assert.deepEqual(row('T-008'), ['S1', '接入真实接口（B1）', ['T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007'], 'T-007', 'skip']);
  assert.deepEqual(row('T-009'), ['S2', '后端 purchase', [], null, null], '依赖前面批次的 domain 视为已满足');
  assert.deepEqual(row('T-010'), ['S2', '页面 purchase-orders', [], null, null]);
  assert.deepEqual(row('T-011'), ['S2', '接入真实接口（B2）', ['T-009', 'T-010'], 'T-010', 'skip']);
  const user = tasks.find((t) => t.id === 'T-002')!;
  assert.deepEqual(user.writes, ['src/server/user/**', 'tests/acceptance/T-002/**']);
  assert.deepEqual(user.shared, ['src/shared/**']);
  assert.deepEqual(user.verify, ['test']);
  assert.match(tasks.find((t) => t.id === 'T-006')!.description!, /原型：docs\/prototype\/login\.html；对应需求：REQ-001/);
  assert.ok(tasks.every((t) => t.kind === 'impl'));
  // 角色决定调度池：domain 任务是 backend（带 domain），前端基础、页面（带 page）、接入真实接口是 frontend
  assert.deepEqual(tasks.map((t) => t.role), ['backend', 'backend', 'backend', 'frontend', 'frontend', 'frontend', 'frontend', 'backend', 'frontend', 'frontend']);
  assert.deepEqual(tasks.map((t) => t.layers![0]), tasks.map((t) => t.role));
  assert.deepEqual(tasks.map((t) => t.domain ?? t.page ?? null), ['user', 'catalog', 'inventory', null, 'login', 'products', null, 'purchase', 'purchase-orders', null]);
});
