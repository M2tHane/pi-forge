// 架构阶段的完整产出（测试用）：PRD、原型、必需文件与 docs/plan.md（两个批次）。
export const ARCH_PRD = [
  '# 进销存 PRD', '', '## 需求', '',
  '### 登录  REQ-001', '- AC1 Given 已注册 When 登录 Then 进入首页', '',
  '### 商品  REQ-002', '- AC1 Given 已登录 When 新建商品 Then 列表里出现', '',
  '### 采购单  REQ-003', '- AC1 Given 有商品 When 下采购单 Then 库存增加', '',
  '### 报表  REQ-004', '- AC1 Given 有单据 When 打开报表 Then 看到汇总', '',
  '## 页面', '', '| 页面 | 原型文件 | 对应需求 |', '|---|---|---|',
  '| login | docs/prototype/login.html | REQ-001 |', '| products | docs/prototype/products.html | REQ-002 |', '| purchase-orders | docs/prototype/purchase-orders.html | REQ-003 |', '',
].join('\n');

export const PLAN_MD_TEXT = [
  '# 计划', '', '## 总览', 'Node + SQLite；后端按 domain 并行，前端一个人按页面做。', '',
  '## 风险与假设', '- 报表留到下一期（REQ-004 不在本计划里）', '- 价格按分存整数', '',
  '## 程序读取的部分', '', '```yaml',
  'max_parallel_backend: 2',
  'batches:',
  '  - id: B1',
  '    title: 基础资料',
  '    reqs: [REQ-001, REQ-002]',
  '    backend:',
  '      - { domain: user, paths: ["src/server/user/**"] }',
  '      - { domain: inventory, after: [catalog] }',
  '      - { domain: catalog, paths: ["src/server/catalog/**"] }',
  '    frontend: [login, products]',
  '  - id: B2',
  '    title: 单据',
  '    reqs: [REQ-003]',
  '    backend:',
  '      - { domain: purchase, after: [inventory] }',
  '    frontend: [purchase-orders]',
  'shared: ["src/shared/**"]',
  '```', '',
].join('\n');

export const ARCH_FILES: Record<string, string> = {
  'docs/PRD.md': ARCH_PRD,
  'docs/prototype/login.html': '<title>登录</title>',
  'docs/prototype/products.html': '<title>商品</title>',
  'docs/prototype/purchase-orders.html': '<title>采购单</title>',
  'AGENTS.md': '# 开发说明\n',
  'docs/arch/overview.md': '# 架构\nNode + SQLite。\n',
  'docs/arch/domains.md': '# domain\n- user、catalog、inventory、purchase\n',
  'docs/contracts/openapi.yaml': 'openapi: 3.0.0\ninfo: { title: 进销存, version: "1" }\npaths: {}\n',
  'docs/contracts/page-api.md': '# 页面与接口\n- login：POST /api/login\n',
  'commands.yaml': 'commands:\n  test: "true"\n',
  'docs/plan.md': PLAN_MD_TEXT,
};
