// 示范用的虚构工程「星港零售云」：多租户零售 SaaS（商家后台、门店收银、顾客商城、开放 API），约 6.8 万行。
// 这里的需求、计划、运行记录与产出都是为演示流程编写的，不是真实运行结果；结构与 pi-forge 的 .forge/ 状态一致。
(function () {
  const START = Date.parse('2026-10-12T09:00:00+08:00');
  const T = (min) => new Date(START + min * 60000).toISOString();

  const prd = `# 星港零售云：需求说明

## 背景
星港是一家给中小连锁零售商做数字化的公司。客户普遍同时经营 **线上商城** 和 **线下门店**，商品、库存、会员分散在三四套系统里，对不上账。
我们要做一个多租户 SaaS，让一个商家用一套系统管住：商品、库存、订单、支付、促销、会员、门店收银。

## 用户
| 角色 | 说明 |
|---|---|
| 平台运营 | 开通租户、配置套餐 |
| 商家管理员 | 管理本租户的员工、商品、价格、促销 |
| 店员 | 在门店用收银台（POS）开单、收款、退货 |
| 顾客 | 在商城浏览、下单、支付、查看订单 |

## 范围（第一期）
- **租户与套餐**：每个商家是一个租户，数据完全隔离；套餐决定门店数和 SKU 上限。
- **员工与权限**：管理员、店长、店员三种角色；权限按门店划分。
- **商品**：SPU / SKU、规格、价格、上下架、分类与品牌。
- **库存**：多仓（总仓 + 门店仓），下单锁库存，取消释放，调拨。
- **交易**：购物车、下单、订单状态机、支付（微信 / 支付宝沙箱）、退款。
- **促销**：优惠券、满减；同一订单的优惠叠加规则要可解释。
- **履约**：发货、物流单号、签收；门店自提。
- **会员**：手机号注册、积分累计与抵扣。
- **门店收银**：扫码开单、挂单、收款、小票、离线时排队补传。
- **前端**：商家后台（Web）、顾客商城（H5）。

## 技术约束
- TypeScript，Node 24；PostgreSQL；前端 React。
- 所有接口带租户上下文；任何查询不得跨租户。
- 金额一律用"分"为单位的整数。

## 不做（第一期）
分销、直播、多币种、开放平台计费。这些以后每项走一次 feature 流程。
`;

  const reqs = [
    ['REQ-001', '租户开通与套餐', '平台运营、商家管理员', [
      ['平台运营开通租户', '生成租户和首个管理员账号，管理员首次登录强制改密'],
      ['租户 A 的管理员查询商品', '只能看到租户 A 的数据，跨租户访问一律 404'],
      ['套餐限制 3 家门店', '新建第 4 家门店失败，提示升级套餐'],
      ['套餐到期', '后台只读，商城和收银照常可用 7 天'],
      ['平台运营修改套餐', '新限制立即生效，已超出的门店保留但不能新增'],
    ]],
    ['REQ-002', '员工与权限', '商家管理员、店长、店员', [
      ['员工用手机号和密码登录', '返回令牌，令牌带租户与门店范围'],
      ['登录失败 5 次', '账号锁定 15 分钟'],
      ['管理员新增店长并指定门店', '店长只能管理被指定的门店'],
      ['店员访问商品价格管理', '被拒绝（403）'],
      ['管理员停用员工', '该员工所有令牌立即失效'],
      ['任何员工的写操作', '记录操作日志（谁、何时、改了什么）'],
    ]],
    ['REQ-003', '商品与 SKU', '商家管理员', [
      ['新建 SPU 并添加两种规格', '自动生成规格组合的 SKU，每个 SKU 单独定价'],
      ['SKU 数达到套餐上限', '新建失败并提示'],
      ['下架商品', '商城立即不可见，收银仍可按条码查到并提示已下架'],
      ['修改价格', '已下单的订单价格不变'],
      ['按条码查商品', '返回 SKU、价格和当前门店库存'],
      ['导入 1000 行商品表', '逐行报告结果，失败行不影响成功行'],
    ]],
    ['REQ-004', '分类与品牌', '商家管理员、顾客', [
      ['建立三级分类', '商城按分类树浏览'],
      ['删除有商品的分类', '失败，提示先迁移商品'],
      ['按品牌筛选商品', '只返回该品牌的上架商品'],
      ['调整分类顺序', '商城导航顺序随之变化'],
    ]],
    ['REQ-005', '库存与多仓', '商家管理员、店长', [
      ['商城下单', '锁定总仓库存；支付超时取消后释放'],
      ['门店收银开单', '扣减该门店仓库存'],
      ['库存不足', '下单失败，提示可售数量'],
      ['发起门店调拨', '调出仓扣减、调入仓在签收后增加'],
      ['两个订单同时抢最后一件', '只有一个成功，库存不出现负数'],
      ['查询库存流水', '每一次增减都有来源单据'],
    ]],
    ['REQ-006', '购物车', '顾客', [
      ['加入购物车', '同 SKU 合并数量'],
      ['购物车中商品下架', '标记失效，不能结算'],
      ['未登录加购后登录', '合并到账号购物车'],
      ['修改数量超过库存', '提示并按可售数量调整'],
      ['勾选部分商品结算', '只结算被勾选的商品'],
    ]],
    ['REQ-007', '下单与订单状态', '顾客、商家管理员', [
      ['提交订单', '生成订单号，状态"待支付"，价格与优惠明细固定'],
      ['30 分钟未支付', '自动取消并释放库存'],
      ['支付成功', '状态变为"待发货"'],
      ['顾客取消待发货订单', '进入退款流程'],
      ['商家查看订单列表', '按状态、时间、门店筛选'],
      ['非法的状态跳转（如已签收再发货）', '被拒绝'],
      ['订单详情', '展示每一步状态变化的时间与操作人'],
    ]],
    ['REQ-008', '支付与退款', '顾客、商家管理员', [
      ['选择微信支付', '跳转沙箱支付并在回调后更新订单'],
      ['重复收到同一支付回调', '只处理一次（幂等）'],
      ['支付回调签名错误', '拒绝并记录'],
      ['全额退款', '原路退回，订单变为"已退款"'],
      ['部分退款', '按商品行退，优惠按比例分摊'],
      ['对账', '每日生成支付与退款对账单'],
    ]],
    ['REQ-009', '优惠券与满减', '商家管理员、顾客', [
      ['创建满 200 减 30 活动', '符合条件的订单自动减免'],
      ['发放优惠券', '顾客领取后在有效期内可用'],
      ['优惠券与满减同时满足', '按"先满减后用券"计算，结果可解释'],
      ['优惠后金额为负', '不允许，最低为 0'],
      ['一张券只能用一次', '并发使用时只有一单成功'],
      ['结算页', '逐行展示每项优惠减了多少'],
    ]],
    ['REQ-010', '门店收银（POS）', '店员', [
      ['扫码开单', '按条码加入商品，显示小计'],
      ['挂单与取单', '挂起的订单可在同一门店取回'],
      ['现金、扫码混合支付', '找零正确，小票打印'],
      ['网络断开时收银', '订单本地排队，恢复后补传且不重复'],
      ['退货', '按原小票退，库存回到本门店仓'],
      ['交班', '生成本班次收款汇总'],
    ]],
    ['REQ-011', '履约与发货', '商家管理员、顾客', [
      ['商家发货并填写物流单号', '订单"已发货"，顾客可见物流单号'],
      ['顾客选择门店自提', '生成自提码，店员核销后完成'],
      ['顾客确认收货', '订单"已完成"，开始计算积分'],
      ['7 天未确认收货', '自动确认'],
      ['拆单发货', '一个订单可分多个包裹'],
    ]],
    ['REQ-012', '会员与积分', '顾客、店员', [
      ['手机号注册会员', '线上线下共用一个会员身份'],
      ['订单完成', '按实付金额累计积分'],
      ['下单时积分抵扣', '100 积分抵 1 元，最多抵 20%'],
      ['订单退款', '扣回已发积分，返还已抵扣积分'],
      ['门店收银输入手机号', '识别会员并累计积分'],
    ]],
    ['REQ-013', '商家后台前端', '商家管理员、店长', [
      ['管理员登录后台', '看到今日销售、待发货、库存预警', true],
      ['在后台完成商品、库存、订单、促销的全部操作', '与接口能力一致', true],
      ['店长登录', '只能看到并操作自己门店的数据', true],
      ['加载、空、错误、无权限', '都有明确提示和重试', true],
    ]],
    ['REQ-014', '顾客商城前端', '顾客', [
      ['浏览分类与搜索商品', '能找到上架商品', true],
      ['从加购到支付完成', '全流程可走通', true],
      ['查看订单与物流', '状态与时间线清楚', true],
      ['在手机上浏览', '布局适配，主要操作单手可及', true],
    ]],
  ].map(([id, title, roles, acs]) => ({
    id, title, tags: ['MVP'], roles,
    ac: acs.map(([g, t, manual], i) => ({ id: `${id}.AC${i + 1}`, text: `Given ${g}，Then ${t}。`, manual: !!manual })),
  }));
  const acs = (req, ...ns) => ns.map((n) => `${req}.AC${n}`);

  const stages = [
    { id: 'S0', goal: '多租户底座与员工登录（骨架）', exit: ['REQ-001', 'REQ-002'] },
    { id: 'S1', goal: '商品、权限与库存', exit: ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004', 'REQ-005'] },
    { id: 'S2', goal: '交易：购物车、订单、支付、促销、履约、会员', exit: ['REQ-006', 'REQ-007', 'REQ-008', 'REQ-009', 'REQ-011', 'REQ-012'] },
    { id: 'S3', goal: '渠道：门店收银、商家后台、顾客商城', exit: ['REQ-010', 'REQ-013', 'REQ-014'] },
  ];
  const dep = (task, type, reason) => ({ task, type, reason });
  const tasks = [
    { id: 'T-001', kind: 'doc', stage: 'P1', role: 'architect', title: '契约与计划', ac: [], writes: ['docs/contracts/**', 'docs/arch/**', 'docs/plan/**'], produces: [], requires: [], depends_on: [] },
    { id: 'T-002', stage: 'S0', title: '租户底座与员工登录', module: 'core', size: 'L', ac: [...acs('REQ-001', 1, 2), ...acs('REQ-002', 1, 2)],
      writes: ['package.json', 'src/server/app/**', 'src/server/tenancy/**', 'src/server/auth/**', 'src/server/db/**', 'migrations/0001_*', 'web/admin/src/shell/**'],
      produces: ['lib:tenancy', 'lib:auth', 'lib:db', 'table:tenants', 'table:staff', 'api:POST /api/sessions', 'api:POST /api/platform/tenants', 'page:/admin/login'], requires: [], depends_on: [dep('T-001', 'hard', '契约与计划')] },
    { id: 'T-003', stage: 'S1', title: '套餐与门店限额', module: 'tenancy', size: 'M', ac: acs('REQ-001', 3, 4, 5), writes: ['src/server/plans/**', 'migrations/0002_*'], produces: ['table:plans', 'fn:plans#checkQuota', 'api:PUT /api/platform/tenants/{id}/plan'], requires: ['lib:tenancy'], depends_on: [dep('T-002', 'hard', 'lib:tenancy')] },
    { id: 'T-004', stage: 'S1', title: '员工、角色与操作日志', module: 'staff', size: 'M', ac: acs('REQ-002', 3, 4, 5, 6), writes: ['src/server/staff/**', 'src/server/audit/**', 'migrations/0003_*'], produces: ['fn:auth#requirePermission', 'table:audit_logs', 'api:POST /api/staff'], requires: ['lib:auth'], depends_on: [dep('T-002', 'hard', 'lib:auth')] },
    { id: 'T-005', stage: 'S1', title: '商品与 SKU', module: 'catalog', size: 'L', ac: acs('REQ-003', 1, 2, 3, 4, 5, 6), writes: ['src/server/catalog/**', 'migrations/0004_*'], produces: ['table:spu', 'table:sku', 'api:POST /api/products', 'api:GET /api/skus/by-barcode/{code}', 'fn:catalog#priceOf'], requires: ['~fn:plans#checkQuota'], depends_on: [dep('T-003', 'soft', 'fn:plans#checkQuota')] },
    { id: 'T-006', stage: 'S1', title: '分类与品牌', module: 'catalog', size: 'S', ac: acs('REQ-004', 1, 2, 3, 4), writes: ['src/server/taxonomy/**', 'migrations/0005_*'], produces: ['table:categories', 'table:brands', 'api:GET /api/categories/tree'], requires: ['~table:spu'], depends_on: [dep('T-005', 'soft', 'table:spu')] },
    { id: 'T-007', stage: 'S1', title: '库存与多仓', module: 'inventory', size: 'L', ac: acs('REQ-005', 1, 2, 3, 4, 5, 6), writes: ['src/server/inventory/**', 'migrations/0006_*'], produces: ['table:stock', 'table:stock_moves', 'fn:inventory#lock', 'fn:inventory#release', 'api:POST /api/transfers'], requires: ['~table:sku'], depends_on: [dep('T-005', 'soft', 'table:sku')] },
    { id: 'T-008', stage: 'S2', title: '购物车', module: 'cart', size: 'M', ac: acs('REQ-006', 1, 2, 3, 4, 5), writes: ['src/server/cart/**', 'migrations/0007_*'], produces: ['table:carts', 'api:POST /api/cart/items', 'fn:cart#checkoutLines'], requires: ['fn:catalog#priceOf', 'fn:inventory#lock'], depends_on: [dep('T-005', 'hard', 'fn:catalog#priceOf'), dep('T-007', 'hard', 'fn:inventory#lock')] },
    { id: 'T-009', stage: 'S2', title: '下单与订单状态机', module: 'orders', size: 'L', ac: acs('REQ-007', 1, 2, 3, 4, 5, 6, 7), writes: ['src/server/orders/**', 'migrations/0008_*'], produces: ['table:orders', 'api:POST /api/orders', 'fn:orders#transition', 'fn:orders#checkout'], requires: ['~fn:cart#checkoutLines', 'fn:inventory#lock'], depends_on: [dep('T-008', 'soft', 'fn:cart#checkoutLines'), dep('T-007', 'hard', 'fn:inventory#lock')] },
    { id: 'T-010', stage: 'S2', title: '支付与退款', module: 'payments', size: 'L', ac: acs('REQ-008', 1, 2, 3, 4, 5, 6), writes: ['src/server/payments/**', 'migrations/0009_*'], produces: ['table:payments', 'api:POST /api/payments/callback/{channel}', 'api:POST /api/orders/{id}/refunds'], requires: ['~fn:orders#transition'], depends_on: [dep('T-009', 'soft', 'fn:orders#transition')] },
    { id: 'T-011', stage: 'S2', title: '优惠券与满减', module: 'promotions', size: 'M', ac: acs('REQ-009', 1, 2, 3, 4, 5, 6), writes: ['src/server/promotions/**', 'migrations/0010_*'], produces: ['table:coupons', 'table:campaigns', 'fn:promotions#applyDiscounts', 'api:POST /api/coupons/{id}/claim'], requires: ['~fn:orders#checkout'], depends_on: [dep('T-009', 'soft', 'fn:orders#checkout')] },
    { id: 'T-012', stage: 'S2', title: '履约与发货', module: 'fulfillment', size: 'M', ac: acs('REQ-011', 1, 2, 3, 4, 5), writes: ['src/server/fulfillment/**', 'migrations/0011_*'], produces: ['table:shipments', 'api:POST /api/orders/{id}/shipments', 'api:POST /api/pickups/{code}/verify'], requires: ['fn:orders#transition'], depends_on: [dep('T-009', 'hard', 'fn:orders#transition')] },
    { id: 'T-013', stage: 'S2', title: '会员与积分', module: 'members', size: 'M', ac: acs('REQ-012', 1, 2, 3, 4, 5), writes: ['src/server/members/**', 'migrations/0012_*'], produces: ['table:members', 'table:points_ledger', 'fn:members#redeem'], requires: ['~fn:orders#transition'], depends_on: [dep('T-009', 'soft', 'fn:orders#transition')] },
    { id: 'T-014', stage: 'S3', title: '门店收银（POS）', module: 'pos', size: 'L', ac: acs('REQ-010', 1, 2, 3, 4, 5, 6), writes: ['src/server/pos/**', 'web/pos/**', 'migrations/0013_*'], produces: ['api:POST /api/pos/tickets', 'api:POST /api/pos/shifts/{id}/close', 'page:/pos'], requires: ['fn:orders#checkout', 'fn:members#redeem'], depends_on: [dep('T-009', 'hard', 'fn:orders#checkout'), dep('T-013', 'hard', 'fn:members#redeem')] },
    { id: 'T-015', stage: 'S3', title: '商家后台前端', module: 'admin-web', size: 'L', ac: [], writes: ['web/admin/**'], produces: ['page:/admin/dashboard', 'page:/admin/products', 'page:/admin/orders', 'page:/admin/promotions'], requires: ['api:POST /api/products', 'api:POST /api/orders'], depends_on: [dep('T-010', 'hard', '订单与支付接口'), dep('T-011', 'hard', '促销接口')] },
    { id: 'T-016', stage: 'S3', title: '顾客商城前端', module: 'shop-web', size: 'L', ac: [], writes: ['web/shop/**'], produces: ['page:/', 'page:/products/{id}', 'page:/cart', 'page:/orders'], requires: ['api:POST /api/cart/items', 'api:POST /api/orders'], depends_on: [dep('T-008', 'hard', '购物车接口'), dep('T-010', 'hard', '支付接口')] },
  ].map((t) => ({ kind: 'impl', role: 'worker', status: 'done', attempts: 0, violations: 0, shared: [], ...t }));
  // 前端任务负责的是人工确认的 AC（界面），计划里写在 manual_checks；这里挂上便于展示
  tasks.find((t) => t.id === 'T-015').manual = acs('REQ-013', 1, 2, 3, 4);
  tasks.find((t) => t.id === 'T-016').manual = acs('REQ-014', 1, 2, 3, 4);
  for (const s of stages) for (const t of tasks.filter((x) => x.stage === s.id)) {
    tasks.push({ id: `${t.id}.rv`, kind: 'review', stage: s.id, role: 'reviewer', status: 'done', title: `审查：${t.title}`, ac: t.ac, writes: [], shared: [], produces: [], requires: [], depends_on: [], attempts: 0, violations: 0 });
  }

  // 运行时间表：[任务, 角色, 开始分钟, 时长分钟, 结果, 花费]
  const M = { planner: 'gpt-6-sol', coder: 'GLM-5.3-Flash' };
  const sched = [
    [null, 'orchestrator', 0, 24, 'noted', 0.42],
    ['T-001', 'architect', 25, 43, 'submitted', 2.31],
    ['T-002', 'worker', 70, 42, 'submitted', 0.38],
    ['T-002.rv', 'reviewer', 114, 5, 'submitted', 0.21],
    ['T-002', 'worker', 120, 11, 'submitted', 0.07],
    ['T-002.rv-2', 'reviewer', 132, 2, 'submitted', 0.05],
    ['T-003', 'worker', 138, 28, 'submitted', 0.14], ['T-004', 'worker', 138, 43, 'submitted', 0.22], ['T-005', 'worker', 138, 50, 'submitted', 0.31],
    ['T-003.rv', 'reviewer', 167, 4, 'submitted', 0.12], ['T-006', 'worker', 168, 18, 'submitted', 0.09],
    ['T-004.rv', 'reviewer', 182, 5, 'submitted', 0.15], ['T-007', 'worker', 183, 48, 'submitted', 0.34],
    ['T-006.rv', 'reviewer', 187, 3, 'submitted', 0.08], ['T-005.rv', 'reviewer', 189, 6, 'submitted', 0.19],
    ['T-007.rv', 'reviewer', 232, 7, 'submitted', 0.22], ['S1.qa', 'stage-qa', 241, 13, 'submitted', 0.35],
    ['T-008', 'worker', 257, 28, 'submitted', 0.16], ['T-009', 'worker', 257, 55, 'submitted', 0.41], ['T-011', 'worker', 257, 46, 'submitted', 0.27],
    ['T-008.rv', 'reviewer', 286, 5, 'submitted', 0.14], ['T-010', 'worker', 287, 43, 'submitted', 0.33],
    ['T-011.rv', 'reviewer', 304, 6, 'submitted', 0.17], ['T-009.rv', 'reviewer', 313, 5, 'submitted', 0.2],
    ['T-012', 'worker', 315, 30, 'submitted', 0.19],
    ['T-011', 'worker', 321, 8, 'submitted', 0.05],
    ['T-010.rv', 'reviewer', 331, 5, 'submitted', 0.16], ['T-013', 'worker', 331, 29, 'submitted', 0.18],
    ['T-012.rv', 'reviewer', 346, 4, 'submitted', 0.12], ['T-013.rv', 'reviewer', 361, 4, 'submitted', 0.13],
    ['S2.qa', 'stage-qa', 366, 15, 'submitted', 0.41],
    ['T-014', 'worker', 383, 53, 'submitted', 0.39], ['T-015', 'worker', 383, 72, 'submitted', 0.52], ['T-016', 'worker', 383, 84, 'submitted', 0.58],
    ['T-014.rv', 'reviewer', 437, 6, 'submitted', 0.18], ['T-015.rv', 'reviewer', 456, 7, 'submitted', 0.24],
    ['T-016.rv', 'reviewer', 468, 7, 'submitted', 0.25], ['T-016', 'worker', 476, 10, 'submitted', 0.08], ['T-016.rv-2', 'reviewer', 487, 2, 'submitted', 0.06],
    ['S3.qa', 'stage-qa', 490, 17, 'submitted', 0.47],
  ];
  const runs = sched.map(([task, role, s, d, outcome, cost], i) => ({
    id: `r-${(i + 1).toString().padStart(3, '0')}`, task, role, model: role === 'worker' ? M.coder : M.planner,
    started_at: T(s), ended_at: T(s + d), outcome, cost, turns: Math.round(d * (role === 'worker' ? 2.6 : 1.4)) + 3,
    tokens: { input: Math.round(d * 41000), output: Math.round(d * 2600), cache_read: Math.round(d * 160000) },
  }));

  // 事件：阶段推进、提交、预检、合并、审查结论、冲突退回
  const ev = (m, type, task, text, extra = {}) => ({ ts: T(m), type, task, text, ...extra });
  const events = [
    ev(1, 'flow', null, '收到需求文档，进入 P0 规格'),
    ev(24, 'gate', null, 'P0 规格通过检查：14 条需求、75 条 AC，用户确认'),
    ev(68, 'merge', 'T-001', '契约与计划合入集成分支（41 个文件）'),
    ev(69, 'gate', null, '计划获批：4 个阶段、15 个实现任务'),
    ev(112, 'submit', 'T-002', 'T-002 提交，预检通过（单元 38/38、验收 4/4）'),
    ev(119, 'review', 'T-002.rv', 'S0 审查：2 条问题（令牌未带门店范围；迁移缺租户索引）'),
    ev(131, 'submit', 'T-002', 'T-002 修复 2 条后重新提交'),
    ev(134, 'review', 'T-002.rv-2', 'S0 复审：全部解决'),
    ev(135, 'merge', 'T-002', 'T-002 合入集成分支（64 个文件）'),
    ev(136, 'gate', null, 'S0 门禁通过，进入 S1：派发 3 个 worker'),
    ev(166, 'submit', 'T-003', 'T-003 提交，预检通过'), ev(172, 'merge', 'T-003', 'T-003 合入'),
    ev(181, 'submit', 'T-004', 'T-004 提交，预检通过'), ev(188, 'merge', 'T-004', 'T-004 合入'),
    ev(186, 'submit', 'T-006', 'T-006 提交，等 T-005 合入后同步'),
    ev(188, 'submit', 'T-005', 'T-005 提交，预检通过'), ev(195, 'merge', 'T-005', 'T-005 合入'), ev(196, 'merge', 'T-006', 'T-006 同步 T-005 后预检通过，合入'),
    ev(231, 'submit', 'T-007', 'T-007 提交，预检通过（含并发抢购测试 200 次）'), ev(239, 'merge', 'T-007', 'T-007 合入'),
    ev(254, 'gate', null, 'S1 阶段验收通过，进入 S2'),
    ev(285, 'submit', 'T-008', 'T-008 提交'), ev(291, 'merge', 'T-008', 'T-008 合入'),
    ev(303, 'submit', 'T-011', 'T-011 提交，等 T-009（软依赖）合入'),
    ev(312, 'submit', 'T-009', 'T-009 提交，预检通过'), ev(318, 'merge', 'T-009', 'T-009 合入（改了 checkout.ts、routes.ts）'),
    ev(319, 'conflict', 'T-011', 'T-011 合并时冲突：src/server/orders/checkout.ts、src/server/app/routes.ts → 退回 T-011 的 worker'),
    ev(329, 'submit', 'T-011', 'T-011 解决冲突后重新提交，预检通过'), ev(330, 'merge', 'T-011', 'T-011 合入'),
    ev(330, 'submit', 'T-010', 'T-010 提交'), ev(336, 'merge', 'T-010', 'T-010 合入'),
    ev(345, 'submit', 'T-012', 'T-012 提交'), ev(350, 'merge', 'T-012', 'T-012 合入'),
    ev(360, 'submit', 'T-013', 'T-013 提交'), ev(365, 'merge', 'T-013', 'T-013 合入'),
    ev(381, 'gate', null, 'S2 阶段验收通过，进入 S3'),
    ev(436, 'submit', 'T-014', 'T-014 提交（离线补传测试 50 轮无重复）'), ev(443, 'merge', 'T-014', 'T-014 合入'),
    ev(455, 'submit', 'T-015', 'T-015 提交'), ev(463, 'merge', 'T-015', 'T-015 合入'),
    ev(467, 'submit', 'T-016', 'T-016 提交'), ev(475, 'review', 'T-016.rv', 'T-016 审查：订单页没有空状态与错误重试'),
    ev(486, 'submit', 'T-016', 'T-016 修复后重新提交'), ev(489, 'merge', 'T-016', 'T-016 合入'),
    ev(507, 'gate', null, 'S3 阶段验收通过，交付：合入 main'),
  ];

  const handoffs = {
    'T-001': `## 做到哪
契约与计划已提交：
- **契约**：\`docs/contracts/openapi.yaml\` 共 86 个接口，按模块拆到 \`paths/*.yaml\`；\`data-model.yaml\` 23 张表；错误码按模块前缀。
- **计划**：4 个阶段、15 个实现任务，75 条 AC 每条恰好归一个任务；前端两条任务负责人工确认项。

## 拆分思路
1. S0 只做骨架：租户上下文、员工登录、数据库访问层、后台外壳。后面所有任务都依赖它，所以单独一个阶段先做稳。
2. S1 是"被交易依赖的东西"：商品、库存、权限。三条并行。
3. S2 是交易链路。订单是中心，购物车、支付、促销、会员对它是**软依赖**：先对着契约写，订单合入后程序再同步。
4. S3 是渠道和界面，等接口齐了再做，避免前端反复返工。

## 注意
- 路由注册入口 \`src/server/app/routes.ts\` 每个模块都会改一行。按现在的规则 worker 可以直接改，冲突由后合并的那个 worker 解决。
- 金额全部用"分"的整数；\`fn:promotions#applyDiscounts\` 返回逐项明细，结算页要用。`,
    'T-002': `## 做到哪
骨架完成并合入：
- \`src/server/tenancy/context.ts\`：每个请求从令牌解析租户，注入查询层；**没有租户上下文的查询直接抛错**。
- \`src/server/auth/\`：手机号 + 密码登录，令牌带 \`tenantId\` 与 \`storeIds\`。
- 数据库访问层 \`src/server/db/\`，迁移工具，后台外壳页面。
- 测试：单元 38 个，验收 4 个（REQ-001.AC1–2、REQ-002.AC1–2）。

## 审查后修改
1. 令牌原来没带门店范围，补上了，店长权限要用。
2. 给所有业务表加了 \`(tenant_id, id)\` 复合索引。

## 下一步
- 新模块在 \`src/server/app/routes.ts\` 里 \`register(app, xxxRoutes)\` 一行即可挂载。`,
    'T-005': `## 做到哪
商品与 SKU 完成：SPU / SKU、规格组合自动生成、按条码查询、批量导入。

## 关键实现
- 规格组合用笛卡尔积生成，SKU 编码 = SPU 编码 + 规格值序号。
- 改价只影响新订单：订单保存下单时的价格快照，这里不需要做额外处理。
- 导入逐行在独立事务里执行，返回每行结果。

## 测试
验收 6 个场景覆盖 REQ-003 全部 AC；导入 1000 行用时 1.8 秒。`,
    'T-007': `## 做到哪
库存与多仓完成：锁定、释放、扣减、调拨、流水。

## 关键实现
- 锁库存用 \`UPDATE stock SET locked = locked + $n WHERE sku_id = $1 AND available - locked >= $n\`，**靠一条带条件的更新保证不超卖**，不用应用层锁。
- 每次增减写一条 \`stock_moves\`，带来源单据类型与编号。

## 测试
并发场景：两个订单抢最后一件，循环 200 次，每次只有一个成功、库存不为负。`,
    'T-009': `## 做到哪
订单与状态机完成：下单、超时取消、支付成功回写、取消转退款、非法跳转拒绝、状态时间线。

## 关键实现
- 状态机是一张转移表（\`orders/state.ts\`），不在表里的跳转一律拒绝。
- 下单在一个事务里：校验购物车行 → 锁库存 → 写订单与价格快照。
- 超时取消由定时任务扫描，取消时释放库存。

## 对其他任务的影响
- 我在 \`checkout.ts\` 里留了 \`beforePricing\` 钩子位置，促销（T-011）应挂在这里。
- 在 \`routes.ts\` 注册了订单路由。`,
    'T-011': `## 做到哪
优惠券与满减完成，已合入。

## 关键实现
- \`applyDiscounts(lines, ctx)\` 返回逐项明细：\`[{ kind: 'campaign', amount: 3000 }, { kind: 'coupon', amount: 500 }]\`，结算页直接展示。
- 计算顺序：先满减、后用券；优惠后金额最低为 0。
- 用券用条件更新 \`used_at IS NULL\`，并发时只有一单成功。

## 合并冲突（已解决）
合并时和 T-009 在两个文件冲突：
1. \`src/server/app/routes.ts\`：两边各加了一行路由注册，**两行都保留**。
2. \`src/server/orders/checkout.ts\`：T-009 改写了下单流程并留了 \`beforePricing\` 钩子；我原来把优惠计算直接插在旧代码里。按 T-009 的新结构，把 \`applyDiscounts\` 挂到 \`beforePricing\`，删掉我旧的插入。

解决后全量测试 412/412 通过，重新提交。`,
    'T-014': `## 做到哪
门店收银完成：扫码开单、挂单取单、混合支付找零、退货、交班汇总、离线排队补传。

## 关键实现
- 离线时订单写入浏览器 IndexedDB 队列，带客户端生成的幂等键；恢复后按顺序补传，服务端按幂等键去重。
- 退货按原小票行退，库存回到本门店仓。

## 测试
断网补传测试 50 轮，无重复、无丢单。`,
    'T-016': `## 做到哪
顾客商城完成：分类浏览、搜索、商品详情、购物车、下单、支付（沙箱）、订单与物流。

## 审查后修改
订单页没有空状态和加载失败的重试，已补上；商品列表滚动加载失败时也加了重试。

## 需要你在界面上确认（人工 AC）
- 手机上从加购到支付完成走一遍（REQ-014.AC2、AC4）。`,
  };
  for (const t of tasks.filter((x) => x.kind === 'impl' && !handoffs[x.id])) {
    handoffs[t.id] = `## 做到哪\n${t.title}完成并合入，负责的 ${t.ac.length || (t.manual ?? []).length} 条 AC 都有验收场景覆盖。\n\n## 产出\n${t.produces.map((p) => `- \`${p}\``).join('\n')}\n\n## 下一步\n无。`;
  }

  // 产出：每个任务改动的文件与主要文件的预览
  const preview = {
    'T-001': ['docs/plan/plan.yaml', `stages:
  - id: S0
    goal: 多租户底座与员工登录（骨架）
  - id: S2
    goal: 交易：购物车、订单、支付、促销、履约、会员
tasks:
  - id: T-011
    title: 优惠券与满减
    module: promotions
    ac: [REQ-009.AC1, REQ-009.AC2, REQ-009.AC3, REQ-009.AC4, REQ-009.AC5, REQ-009.AC6]
    writes: [src/server/promotions/**, migrations/0010_*]   # 计划的改动范围，用于调度
    produces: [table:coupons, table:campaigns, fn:promotions#applyDiscounts]
    requires: ["~fn:orders#checkout"]                      # ~ 表示软依赖：可以先对着契约写
    size: M`],
    'T-002': ['src/server/tenancy/context.ts', `import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenError } from '../app/errors.ts';

export interface TenantContext { tenantId: string; staffId: string; storeIds: string[] }
const store = new AsyncLocalStorage<TenantContext>();

/** 每个请求在这里进入租户上下文；令牌校验在 auth 中间件里完成 */
export function withTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

/** 查询层取租户：没有上下文直接抛错，杜绝跨租户查询 */
export function currentTenant(): TenantContext {
  const ctx = store.getStore();
  if (!ctx) throw new ForbiddenError('TENANT_CONTEXT_MISSING');
  return ctx;
}`],
    'T-005': ['src/server/catalog/sku.ts', `/** 规格组合：颜色 × 尺码 → 每个组合一个 SKU */
export function expandSkus(spu: Spu, specs: Spec[]): NewSku[] {
  const combos = specs.reduce<SpecValue[][]>(
    (acc, s) => acc.flatMap((c) => s.values.map((v) => [...c, v])), [[]]);
  return combos.map((values, i) => ({
    spuId: spu.id,
    code: \`\${spu.code}-\${String(i + 1).padStart(3, '0')}\`,
    specValues: values,
    priceCents: spu.basePriceCents,
  }));
}`],
    'T-007': ['src/server/inventory/lock.ts', `/** 锁库存：一条带条件的更新，可售不足时影响行数为 0，不会超卖 */
export async function lock(tx: Tx, skuId: string, warehouseId: string, qty: number, ref: SourceRef) {
  const { rowCount } = await tx.query(
    \`UPDATE stock SET locked = locked + $3
       WHERE sku_id = $1 AND warehouse_id = $2 AND available - locked >= $3\`,
    [skuId, warehouseId, qty]);
  if (rowCount === 0) throw new ConflictError('STOCK_INSUFFICIENT', { skuId, available: await availableOf(tx, skuId, warehouseId) });
  await recordMove(tx, { skuId, warehouseId, delta: -qty, kind: 'lock', ref });
}`],
    'T-009': ['src/server/orders/checkout.ts', `export async function checkout(tx: Tx, cart: CheckoutLines, hooks: CheckoutHooks = {}) {
  const lines = await priceSnapshot(tx, cart);           // 下单时的价格快照
  const adjusted = hooks.beforePricing ? await hooks.beforePricing(lines) : { lines, discounts: [] };
  for (const l of adjusted.lines) await inventory.lock(tx, l.skuId, l.warehouseId, l.qty, { kind: 'order' });
  const order = await insertOrder(tx, {
    status: 'pending_payment',
    totalCents: sum(adjusted.lines) - sum(adjusted.discounts),
    discounts: adjusted.discounts,
    expiresAt: minutesFromNow(30),
  });
  await recordTransition(tx, order.id, null, 'pending_payment');
  return order;
}`],
    'T-011': ['src/server/promotions/apply.ts', `/** 先满减、后用券；返回逐项明细，结算页逐行展示 */
export async function applyDiscounts(lines: PricedLine[], ctx: DiscountContext): Promise<Adjusted> {
  const subtotal = sum(lines);
  const discounts: Discount[] = [];
  const campaign = await bestCampaign(ctx.tenantId, subtotal);
  if (campaign) discounts.push({ kind: 'campaign', id: campaign.id, amount: campaign.offCents });
  if (ctx.couponId) {
    const coupon = await claimForOrder(ctx.couponId, ctx.memberId);   // 条件更新 used_at IS NULL
    const left = subtotal - sum(discounts);
    discounts.push({ kind: 'coupon', id: coupon.id, amount: Math.min(coupon.offCents, left) });
  }
  return { lines, discounts };   // 优惠后金额最低为 0
}`],
    'T-014': ['web/pos/src/offline-queue.ts', `/** 断网时把小票放进本地队列；恢复后按顺序补传，服务端按幂等键去重 */
export async function submitTicket(ticket: Ticket) {
  const item = { ...ticket, idempotencyKey: ticket.idempotencyKey ?? crypto.randomUUID() };
  if (!navigator.onLine) return queue.push(item);
  try { await api.post('/api/pos/tickets', item); }
  catch (e) { if (isNetworkError(e)) await queue.push(item); else throw e; }
}

window.addEventListener('online', async () => {
  for (const item of await queue.drain()) await api.post('/api/pos/tickets', item);
});`],
    'T-016': ['web/shop/src/pages/Orders.tsx', `export function OrdersPage() {
  const { data, error, isLoading, retry } = useOrders();
  if (isLoading) return <Skeleton rows={4} />;
  if (error) return <ErrorState message="订单加载失败" onRetry={retry} />;
  if (!data.length) return <EmptyState title="还没有订单" action={<Link to="/">去逛逛</Link>} />;
  return (
    <ul className="orders">
      {data.map((o) => <OrderCard key={o.id} order={o} />)}
    </ul>
  );
}`],
  };
  const fileSets = {
    'T-001': [['docs/contracts/openapi.yaml', 412], ['docs/contracts/paths/orders.yaml', 388], ['docs/contracts/paths/catalog.yaml', 341], ['docs/contracts/data-model.yaml', 526], ['docs/plan/plan.yaml', 298], ['docs/arch/overview.md', 164]],
    'T-002': [['src/server/tenancy/context.ts', 86], ['src/server/auth/login.ts', 214], ['src/server/db/pool.ts', 132], ['src/server/app/routes.ts', 41], ['migrations/0001_init.sql', 188], ['web/admin/src/shell/Layout.tsx', 236], ['tests/unit/auth/login.test.ts', 241], ['tests/acceptance/T-002/tenancy.test.ts', 196]],
    'T-005': [['src/server/catalog/sku.ts', 168], ['src/server/catalog/routes.ts', 412], ['src/server/catalog/import.ts', 236], ['src/server/app/routes.ts', 1], ['migrations/0004_catalog.sql', 96], ['tests/acceptance/T-005/catalog.test.ts', 388]],
    'T-007': [['src/server/inventory/lock.ts', 142], ['src/server/inventory/transfer.ts', 211], ['src/server/inventory/routes.ts', 268], ['src/server/app/routes.ts', 1], ['migrations/0006_stock.sql', 74], ['tests/unit/inventory/lock.test.ts', 186], ['tests/acceptance/T-007/stock.test.ts', 342]],
    'T-009': [['src/server/orders/checkout.ts', 196], ['src/server/orders/state.ts', 158], ['src/server/orders/routes.ts', 344], ['src/server/orders/expire-job.ts', 88], ['src/server/app/routes.ts', 1], ['migrations/0008_orders.sql', 112], ['tests/unit/orders/state.test.ts', 214], ['tests/acceptance/T-009/orders.test.ts', 476]],
    'T-011': [['src/server/promotions/apply.ts', 118], ['src/server/promotions/coupons.ts', 236], ['src/server/promotions/routes.ts', 284], ['src/server/orders/checkout.ts', 6], ['src/server/app/routes.ts', 1], ['migrations/0010_promotions.sql', 81], ['tests/unit/promotions/apply.test.ts', 263], ['tests/acceptance/T-011/promotions.test.ts', 392]],
    'T-014': [['src/server/pos/tickets.ts', 286], ['src/server/pos/shifts.ts', 174], ['web/pos/src/offline-queue.ts', 96], ['web/pos/src/pages/Register.tsx', 512], ['web/pos/src/pages/Shift.tsx', 248], ['tests/acceptance/T-014/pos.test.ts', 431]],
    'T-016': [['web/shop/src/pages/Orders.tsx', 142], ['web/shop/src/pages/Product.tsx', 386], ['web/shop/src/pages/Cart.tsx', 341], ['web/shop/src/pages/Checkout.tsx', 418], ['web/shop/src/components/**', 1260], ['tests/e2e/shop.spec.ts', 312]],
  };
  const outputs = {};
  for (const [id, files] of Object.entries(fileSets)) outputs[id] = { merged: true, files: files.map(([file, add]) => ({ file, add, del: Math.round(add / 12) })), preview: { file: preview[id][0], text: preview[id][1] } };

  // 合并冲突：T-009 先合入，T-011 合并时在两个文件冲突，退回 T-011 自己的 worker 解决
  const conflict = {
    task: 'T-011', other: 'T-009', at: T(319), resolved_at: T(329), merged_at: T(330),
    files: ['src/server/app/routes.ts', 'src/server/orders/checkout.ts'],
    steps: [
      { title: 'T-009 先合入', caption: '订单任务改写了下单流程，留出 beforePricing 钩子，并注册了订单路由。', code: `// src/server/app/routes.ts
  register(app, inventoryRoutes);
+ register(app, orderRoutes);` },
      { title: 'T-011 合并时冲突', caption: '促销任务也在同两个文件里改了东西。程序把集成分支合进它的工作区，冲突标记原样留着。', code: `// src/server/app/routes.ts
  register(app, inventoryRoutes);
<<<<<<< T-011
+ register(app, promotionRoutes);
=======
+ register(app, orderRoutes);
>>>>>>> 集成分支` },
      { title: '退回给 T-011 的 worker', caption: '谁合并谁解决：它最清楚自己的改动。按 T-009 的新结构，把优惠计算挂到钩子上。', code: `// src/server/app/routes.ts：两行都保留
  register(app, orderRoutes);
  register(app, promotionRoutes);

// src/server/orders/checkout.ts
- const total = applyCouponInline(lines, couponId);
+ hooks.beforePricing = (l) => applyDiscounts(l, ctx);` },
      { title: '重新预检、合入', caption: '解决冲突用了 8 分钟。全量测试 412/412 通过后合入，S2 继续。', code: `预检  单元 286/286  验收 126/126
合并  T-011 → 集成分支 ✓
用时  冲突 → 合入 11 分钟` },
    ],
  };

  // 隐藏测试（交付后由不可见的测试集打分）
  const hiddenGroups = [['租户与权限', 24, 24], ['商品', 22, 22], ['库存', 18, 17], ['购物车', 12, 12], ['订单', 26, 26], ['支付与退款', 20, 19], ['促销', 16, 16], ['履约', 12, 12], ['会员积分', 12, 12], ['门店收银', 18, 17], ['商家后台（界面）', 14, 13], ['顾客商城（界面）', 16, 15]];
  const hidden = hiddenGroups.flatMap(([group, n, ok]) => Array.from({ length: n }, (_, i) => ({ group, label: `${group} 用例 ${i + 1}`, ok: i < ok })));

  window.DEMO = {
    example: true,
    project: { name: '星港零售云', tagline: '多租户零售 SaaS：商家后台、门店收银、顾客商城、开放 API', loc: 68400, loc_parts: [['后端', 31200], ['前端', 18900], ['测试', 15100], ['契约与文档', 3200]] },
    generated_from: '虚构示例',
    summary: { run_id: '示例：星港零售云 第一次 build', started_at: T(0), ended_at: T(508), models: { planner: M.planner, coder: M.coder, main: M.planner }, status: 'delivered', agent_min: 508, cost: runs.reduce((s, r) => s + r.cost, 0), base: { passed: hidden.filter((h) => h.ok).length, total: hidden.length } },
    prd, reqs, plan: { stages }, tasks, runs, events, handoffs, outputs, conflict, hidden,
    interventions: [
      ['同一个顾客在商城和门店是一个会员吗？', '是，按手机号统一（推荐）'],
      ['优惠券和满减能同时用吗？顺序怎么算？', '能，先满减后用券（推荐），结算页逐项展示'],
      ['积分抵扣上限？', '最多抵实付的 20%，100 积分抵 1 元'],
      ['门店断网时还要能收银吗？', '要，本地排队，恢复后补传且不能重复'],
      ['套餐到期后怎么办？', '后台只读，商城和收银继续可用 7 天（推荐）'],
      ['价格修改会影响已下的订单吗？', '不影响，订单保存价格快照'],
      ['支付渠道第一期接哪些？', '微信、支付宝的沙箱'],
      ['部分退款时优惠怎么分摊？', '按商品行金额比例分摊（推荐）'],
      ['超时未支付多久取消？', '30 分钟'],
      ['自动确认收货的天数？', '7 天'],
      ['店长能看其他门店的数据吗？', '不能，只看被指定的门店'],
      ['需要导入商品吗？量级多大？', '需要，单次 1000 行以内'],
      ['以上范围确认后提交规格？', '确认，第一期只做核心模块；分销、直播等以后逐个走 feature 流程'],
    ].map(([q, a]) => ({ category: 'p0_question', note: q, answer: a })),
    backlog: ['分销与佣金', '直播带货', '多币种与跨境', '开放平台计费', '智能补货建议', '电子发票'],
  };
})();
