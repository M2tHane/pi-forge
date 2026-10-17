// 小仓库进销存的隐藏测试（requirement.md 的验收）：在交付的项目上 `npm start`，按需求逐条调用 HTTP 接口，并检查页面路径返回 HTML。
// 用法：node hidden.mjs <项目目录>
// 输出格式给 scripts/real-build/common.ts 的 parseHidden：每组 "## 组名（通过/总数）"，每条 "✓ 标题" 或 "✗ 标题：原因"，最后 "合计：x/y"。
// 用例按顺序共用同一份数据，前面的创建失败时后面的会跟着失败。组名带期数，便于按期统计。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const project = path.resolve(process.argv[2] ?? '.');
const dataDir = mkdtempSync(path.join(tmpdir(), 'stock-hidden-'));
let port = 0;
let server = null;
let base = '';

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  server = spawn('npm', ['start'], { cwd: project, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.status === 200) return; } catch { /* 还没起来 */ }
    if (server.exitCode !== null) throw new Error(`服务退出（${server.exitCode}）：${log.slice(-300)}`);
    await sleep(200);
  }
  throw new Error(`30 秒内 /api/health 没有返回 200：${log.slice(-300)}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  await Promise.race([exited, sleep(5000)]);
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

let token = null; // 当前用户的令牌（默认 admin）
async function req(method, url, body, { raw = false, as } = {}) {
  const headers = {};
  const t = as === undefined ? token : as;
  if (t) headers.authorization = `Bearer ${t}`;
  let payload;
  if (body !== undefined) { payload = raw ? body : JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await fetch(`${base}${url}`, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 不是 JSON */ }
  return { status: r.status, type: r.headers.get('content-type') ?? '', text, json };
}
const errCode = (r) => r.json?.error?.code;
function expectError(r, status, code) {
  assert.equal(r.status, status, `状态码 ${r.status}，响应 ${r.text.slice(0, 160)}`);
  assert.equal(errCode(r), code, `error.code 是 ${errCode(r)}`);
}
const ok = (r, status = 200) => { assert.equal(r.status, status, `状态码 ${r.status}，响应 ${r.text.slice(0, 160)}`); return r.json; };
const post = async (url, body, opt) => ok(await req('POST', url, body, opt), 201);
const login = async (username, password) => ok(await req('POST', '/api/login', { username, password }, { as: null })).token;

const groups = [];
let current = null;
const group = (name) => { current = { name, cases: [] }; groups.push(current); };
async function check(label, fn) {
  try { await fn(); current.cases.push({ label, ok: true }); }
  catch (e) { current.cases.push({ label, ok: false, why: String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200) }); }
}

const ids = {};
const tokens = {};
const today = new Date().toISOString().slice(0, 10);

async function run() {
  group('一期·基础与登录');
  await check('GET /api/health 不用登录，返回 {ok:true}', async () => { assert.deepEqual(ok(await req('GET', '/api/health', undefined, { as: null })), { ok: true }); });
  await check('默认管理员 admin/admin123 能登录，返回 token 与 user', async () => {
    const r = ok(await req('POST', '/api/login', { username: 'admin', password: 'admin123' }, { as: null }));
    assert.equal(typeof r.token, 'string'); assert.equal(r.user.username, 'admin'); assert.equal(r.user.role, 'admin'); assert.equal(r.user.password, undefined);
    token = tokens.admin = r.token;
  });
  await check('密码不对 401 unauthorized', async () => expectError(await req('POST', '/api/login', { username: 'admin', password: 'x' }, { as: null }), 401, 'unauthorized'));
  await check('不带令牌、令牌无效 401', async () => {
    expectError(await req('GET', '/api/products', undefined, { as: null }), 401, 'unauthorized');
    expectError(await req('GET', '/api/products', undefined, { as: 'bogus' }), 401, 'unauthorized');
  });
  await check('GET /api/me 返回当前用户', async () => { const r = ok(await req('GET', '/api/me')); assert.equal(r.username, 'admin'); });
  await check('没有的 API 路径 404；请求体不是 JSON 400 invalid_json；路径 id 不是正整数 404', async () => {
    expectError(await req('GET', '/api/nope'), 404, 'not_found');
    expectError(await req('POST', '/api/categories', '{bad', { raw: true }), 400, 'invalid_json');
    expectError(await req('POST', '/api/categories', []), 400, 'invalid_json');
    expectError(await req('GET', '/api/products/abc'), 404, 'not_found');
  });

  group('一期·用户与权限');
  await check('创建用户：响应不带密码；用户名重复 409；用户名格式不对 400', async () => {
    const u = await post('/api/users', { username: 'clerk1', password: 'secret1', role: 'clerk' });
    assert.equal(u.password, undefined); assert.equal(u.active, true); ids.clerk = u.id;
    ids.viewer = (await post('/api/users', { username: 'viewer1', password: 'secret1', role: 'viewer' })).id;
    expectError(await req('POST', '/api/users', { username: 'clerk1', password: 'secret1', role: 'clerk' }), 409, 'conflict');
    expectError(await req('POST', '/api/users', { username: 'Bad Name', password: 'secret1', role: 'clerk' }), 400, 'validation_failed');
    expectError(await req('POST', '/api/users', { username: 'ok_name', password: '123', role: 'clerk' }), 400, 'validation_failed');
    assert.ok(!JSON.stringify(ok(await req('GET', '/api/users'))).includes('secret1'));
  });
  await check('clerk 不能访问用户管理 403；viewer 不能写 403、能读', async () => {
    tokens.clerk = await login('clerk1', 'secret1'); tokens.viewer = await login('viewer1', 'secret1');
    expectError(await req('GET', '/api/users', undefined, { as: tokens.clerk }), 403, 'forbidden');
    expectError(await req('POST', '/api/categories', { name: 'x' }, { as: tokens.viewer }), 403, 'forbidden');
    ok(await req('GET', '/api/categories', undefined, { as: tokens.viewer }));
  });
  await check('不能删除或停用自己 409', async () => {
    expectError(await req('DELETE', '/api/users/1'), 409, 'conflict');
    expectError(await req('PATCH', '/api/users/1', { active: false }), 409, 'conflict');
  });
  await check('停用用户后它的令牌立即失效，也不能再登录', async () => {
    const tmp = await post('/api/users', { username: 'temp_user', password: 'secret1', role: 'clerk' });
    const t = await login('temp_user', 'secret1');
    ok(await req('PATCH', `/api/users/${tmp.id}`, { active: false }));
    expectError(await req('GET', '/api/me', undefined, { as: t }), 401, 'unauthorized');
    expectError(await req('POST', '/api/login', { username: 'temp_user', password: 'secret1' }, { as: null }), 401, 'unauthorized');
  });
  await check('退出后令牌失效', async () => {
    const t = await login('clerk1', 'secret1');
    assert.equal((await req('POST', '/api/logout', undefined, { as: t })).status, 204);
    expectError(await req('GET', '/api/me', undefined, { as: t }), 401, 'unauthorized');
  });

  group('一期·分类与商品');
  await check('分类：创建、名称不区分大小写重复 409、上级不存在 400', async () => {
    ids.c1 = (await post('/api/categories', { name: '办公用品' })).id;
    ids.c2 = (await post('/api/categories', { name: '纸张', parent_id: ids.c1 })).id;
    ids.c3 = (await post('/api/categories', { name: '清洁用品' })).id;
    expectError(await req('POST', '/api/categories', { name: '纸张 ' }), 409, 'conflict');
    expectError(await req('POST', '/api/categories', { name: 'x', parent_id: 999 }), 400, 'validation_failed');
  });
  await check('分类不能成环 400；有下级的分类不能删 409', async () => {
    expectError(await req('PATCH', `/api/categories/${ids.c1}`, { parent_id: ids.c2 }), 400, 'validation_failed');
    expectError(await req('PATCH', `/api/categories/${ids.c1}`, { parent_id: ids.c1 }), 400, 'validation_failed');
    expectError(await req('DELETE', `/api/categories/${ids.c1}`), 409, 'conflict');
  });
  await check('商品：sku 存大写、默认值；sku 重复 409；字段越界 400', async () => {
    const p = await post('/api/products', { sku: 'a-1001', name: ' A4 打印纸 ', category_id: ids.c2, price: 2500, cost: 1850, safety_stock: 50 });
    assert.equal(p.sku, 'A-1001'); assert.equal(p.name, 'A4 打印纸'); assert.equal(p.unit, '个'); assert.equal(p.active, true); ids.p1 = p.id;
    ids.p2 = (await post('/api/products', { sku: 'B-2003', name: '中性笔', category_id: ids.c1, price: 300, cost: 120, safety_stock: 100, unit: '支' })).id;
    ids.p3 = (await post('/api/products', { sku: 'C-3001', name: '抹布, 大号', category_id: ids.c3, price: 500 })).id;
    expectError(await req('POST', '/api/products', { sku: 'A-1001', name: 'x', price: 1 }), 409, 'conflict');
    expectError(await req('POST', '/api/products', { sku: 'a b', name: 'x', price: 1 }), 400, 'validation_failed');
    expectError(await req('POST', '/api/products', { sku: 'X-1', name: 'x', price: -1 }), 400, 'validation_failed');
    expectError(await req('POST', '/api/products', { sku: 'X-2', name: 'x', price: 1.5 }), 400, 'validation_failed');
    expectError(await req('POST', '/api/products', { sku: 'X-3', name: 'x', price: 1, category_id: 999 }), 400, 'validation_failed');
  });
  await check('商品筛选：q 不区分大小写、category_id 含下级分类、active；参数不合法 400', async () => {
    assert.deepEqual(ok(await req('GET', '/api/products?q=a4')).map((p) => p.id), [ids.p1]);
    assert.deepEqual(ok(await req('GET', `/api/products?category_id=${ids.c1}`)).map((p) => p.id), [ids.p1, ids.p2]);
    ok(await req('PATCH', `/api/products/${ids.p3}`, { active: false }));
    assert.deepEqual(ok(await req('GET', '/api/products?active=false')).map((p) => p.id), [ids.p3]);
    ok(await req('PATCH', `/api/products/${ids.p3}`, { active: true }));
    expectError(await req('GET', '/api/products?active=yes'), 400, 'validation_failed');
    expectError(await req('GET', '/api/products?q=%20'), 400, 'validation_failed');
  });
  await check('有商品的分类不能删 409', async () => expectError(await req('DELETE', `/api/categories/${ids.c3}`), 409, 'conflict'));

  group('一期·往来单位与仓库');
  await check('往来单位：创建、重复 409、type 过滤含 both、电话格式 400', async () => {
    ids.sup = (await post('/api/partners', { name: '晨光文具批发', type: 'supplier', phone: '021-5555 1234' })).id;
    ids.cus = (await post('/api/partners', { name: '城东小学', type: 'customer' })).id;
    ids.both = (await post('/api/partners', { name: '联华商贸', type: 'both' })).id;
    expectError(await req('POST', '/api/partners', { name: '城东小学', type: 'customer' }), 409, 'conflict');
    expectError(await req('POST', '/api/partners', { name: 'x', type: 'customer', phone: 'abc' }), 400, 'validation_failed');
    assert.deepEqual(ok(await req('GET', '/api/partners?type=supplier')).map((p) => p.id), [ids.sup, ids.both]);
    expectError(await req('GET', '/api/partners?type=vip'), 400, 'validation_failed');
  });
  await check('仓库：code 存大写、重复 409', async () => {
    const w = await post('/api/warehouses', { code: 'main', name: '总仓' }); assert.equal(w.code, 'MAIN'); ids.w1 = w.id;
    ids.w2 = (await post('/api/warehouses', { code: 'EAST', name: '东区仓' })).id;
    ids.w3 = (await post('/api/warehouses', { code: 'OLD', name: '旧仓' })).id;
    expectError(await req('POST', '/api/warehouses', { code: 'Main', name: 'x' }), 409, 'conflict');
    expectError(await req('POST', '/api/warehouses', { code: 'A-1', name: 'x' }), 400, 'validation_failed');
  });

  group('二期·采购单');
  await check('创建采购单：单号 PO000001、草稿、合计', async () => {
    const o = await post('/api/purchase-orders', { partner_id: ids.sup, warehouse_id: ids.w1, lines: [{ product_id: ids.p1, quantity: 100, price: 1850 }, { product_id: ids.p2, quantity: 50, price: 120 }] });
    assert.equal(o.no, 'PO000001'); assert.equal(o.status, 'draft'); assert.equal(o.total, 100 * 1850 + 50 * 120); assert.equal(o.received_at, null); ids.po1 = o.id;
  });
  await check('采购单校验：客户不能做供应商 400、空明细 400、重复商品 400、停用仓库 400', async () => {
    expectError(await req('POST', '/api/purchase-orders', { partner_id: ids.cus, warehouse_id: ids.w1, lines: [{ product_id: ids.p1, quantity: 1, price: 1 }] }), 400, 'validation_failed');
    expectError(await req('POST', '/api/purchase-orders', { partner_id: ids.sup, warehouse_id: ids.w1, lines: [] }), 400, 'validation_failed');
    expectError(await req('POST', '/api/purchase-orders', { partner_id: ids.sup, warehouse_id: ids.w1, lines: [{ product_id: ids.p1, quantity: 1, price: 1 }, { product_id: ids.p1, quantity: 2, price: 1 }] }), 400, 'validation_failed');
    ok(await req('PATCH', `/api/warehouses/${ids.w3}`, { active: false }));
    expectError(await req('POST', '/api/purchase-orders', { partner_id: ids.sup, warehouse_id: ids.w3, lines: [{ product_id: ids.p1, quantity: 1, price: 1 }] }), 400, 'validation_failed');
  });
  await check('草稿可改明细；确认后不能改、不能删 409；没确认不能入库 409', async () => {
    const r = ok(await req('PATCH', `/api/purchase-orders/${ids.po1}`, { lines: [{ product_id: ids.p1, quantity: 100, price: 1800 }, { product_id: ids.p2, quantity: 50, price: 120 }] }));
    assert.equal(r.total, 100 * 1800 + 50 * 120);
    expectError(await req('POST', `/api/purchase-orders/${ids.po1}/receive`), 409, 'conflict');
    assert.equal(ok(await req('POST', `/api/purchase-orders/${ids.po1}/confirm`)).status, 'confirmed');
    expectError(await req('PATCH', `/api/purchase-orders/${ids.po1}`, { note: 'x' }), 409, 'conflict');
    expectError(await req('DELETE', `/api/purchase-orders/${ids.po1}`), 409, 'conflict');
  });
  await check('入库：状态 received、库存增加、记 purchase 流水', async () => {
    const r = ok(await req('POST', `/api/purchase-orders/${ids.po1}/receive`)); assert.equal(r.status, 'received'); assert.ok(r.received_at);
    assert.deepEqual(ok(await req('GET', `/api/stock?warehouse_id=${ids.w1}`)).map((s) => [s.product_id, s.quantity]), [[ids.p1, 100], [ids.p2, 50]]);
    const mv = ok(await req('GET', `/api/movements?product_id=${ids.p1}`));
    assert.equal(mv.length, 1); assert.equal(mv[0].delta, 100); assert.equal(mv[0].reason, 'purchase'); assert.equal(mv[0].ref_type, 'purchase_order'); assert.equal(mv[0].ref_id, ids.po1);
    expectError(await req('POST', `/api/purchase-orders/${ids.po1}/cancel`), 409, 'conflict');
  });
  await check('第二张采购单 PO000002 可以取消；列表按 id 降序；status 过滤', async () => {
    const o = await post('/api/purchase-orders', { partner_id: ids.both, warehouse_id: ids.w2, lines: [{ product_id: ids.p3, quantity: 10, price: 200 }] });
    assert.equal(o.no, 'PO000002'); ids.po2 = o.id;
    assert.equal(ok(await req('POST', `/api/purchase-orders/${ids.po2}/cancel`)).status, 'cancelled');
    assert.deepEqual(ok(await req('GET', '/api/purchase-orders')).map((x) => x.id), [ids.po2, ids.po1]);
    assert.deepEqual(ok(await req('GET', '/api/purchase-orders?status=received')).map((x) => x.id), [ids.po1]);
  });

  group('二期·销售单');
  await check('供应商不能做客户 400；创建 SO000001', async () => {
    expectError(await req('POST', '/api/sales-orders', { partner_id: ids.sup, warehouse_id: ids.w1, lines: [{ product_id: ids.p1, quantity: 1, price: 2500 }] }), 400, 'validation_failed');
    const o = await post('/api/sales-orders', { partner_id: ids.cus, warehouse_id: ids.w1, lines: [{ product_id: ids.p1, quantity: 90, price: 2500 }, { product_id: ids.p2, quantity: 60, price: 300 }] });
    assert.equal(o.no, 'SO000001'); ids.so1 = o.id;
  });
  await check('库存不足出库 409，整张单都不出库', async () => {
    ok(await req('POST', `/api/sales-orders/${ids.so1}/confirm`));
    expectError(await req('POST', `/api/sales-orders/${ids.so1}/ship`), 409, 'conflict');
    assert.deepEqual(ok(await req('GET', `/api/stock?warehouse_id=${ids.w1}`)).map((s) => s.quantity), [100, 50]);
    assert.equal(ok(await req('GET', `/api/sales-orders/${ids.so1}`)).status, 'confirmed');
  });
  await check('库存足够时出库：库存减少、sale 流水为负、填 shipped_at', async () => {
    const o = await post('/api/sales-orders', { partner_id: ids.both, warehouse_id: ids.w1, lines: [{ product_id: ids.p1, quantity: 90, price: 2500 }, { product_id: ids.p2, quantity: 10, price: 300 }] });
    ids.so2 = o.id;
    ok(await req('POST', `/api/sales-orders/${ids.so2}/confirm`));
    const r = ok(await req('POST', `/api/sales-orders/${ids.so2}/ship`)); assert.equal(r.status, 'shipped'); assert.ok(r.shipped_at);
    assert.deepEqual(ok(await req('GET', `/api/stock?warehouse_id=${ids.w1}`)).map((s) => s.quantity), [10, 40]);
    const sale = ok(await req('GET', `/api/movements?product_id=${ids.p1}`)).find((m) => m.reason === 'sale');
    assert.equal(sale.delta, -90); assert.equal(sale.ref_type, 'sales_order');
  });
  await check('出库后取消 409；有单据的商品、往来单位、仓库不能删 409', async () => {
    expectError(await req('POST', `/api/sales-orders/${ids.so2}/cancel`), 409, 'conflict');
    expectError(await req('DELETE', `/api/products/${ids.p1}`), 409, 'conflict');
    expectError(await req('DELETE', `/api/partners/${ids.cus}`), 409, 'conflict');
    expectError(await req('DELETE', `/api/warehouses/${ids.w1}`), 409, 'conflict');
  });
  await check('viewer 不能确认或出库 403', async () => expectError(await req('POST', `/api/sales-orders/${ids.so1}/cancel`, undefined, { as: tokens.viewer }), 403, 'forbidden'));

  group('二期·调拨与盘点');
  await check('调拨：同一仓库 400；库存不足执行 409 且不生效', async () => {
    expectError(await req('POST', '/api/transfers', { from_warehouse_id: ids.w1, to_warehouse_id: ids.w1, lines: [{ product_id: ids.p1, quantity: 1 }] }), 400, 'validation_failed');
    const t = await post('/api/transfers', { from_warehouse_id: ids.w1, to_warehouse_id: ids.w2, lines: [{ product_id: ids.p1, quantity: 5 }, { product_id: ids.p2, quantity: 41 }] });
    assert.equal(t.no, 'TR000001'); assert.equal(t.status, 'draft'); ids.tr1 = t.id;
    expectError(await req('POST', `/api/transfers/${ids.tr1}/execute`), 409, 'conflict');
    assert.deepEqual(ok(await req('GET', '/api/stock')).map((s) => [s.warehouse_id, s.product_id, s.quantity]), [[ids.w1, ids.p1, 10], [ids.w1, ids.p2, 40]]);
  });
  await check('调拨执行：两边库存变化、两条流水；之后不能再执行 409', async () => {
    ok(await req('PATCH', `/api/transfers/${ids.tr1}`, { lines: [{ product_id: ids.p1, quantity: 5 }, { product_id: ids.p2, quantity: 40 }] }));
    assert.equal(ok(await req('POST', `/api/transfers/${ids.tr1}/execute`)).status, 'done');
    assert.deepEqual(ok(await req('GET', '/api/stock')).map((s) => [s.warehouse_id, s.product_id, s.quantity]), [[ids.w1, ids.p1, 5], [ids.w2, ids.p1, 5], [ids.w2, ids.p2, 40]]);
    const mv = ok(await req('GET', `/api/movements?product_id=${ids.p2}`)).filter((m) => m.ref_type === 'transfer');
    assert.deepEqual(mv.map((m) => [m.reason, m.delta]).sort(), [['transfer_in', 40], ['transfer_out', -40]]);
    expectError(await req('POST', `/api/transfers/${ids.tr1}/execute`), 409, 'conflict');
  });
  await check('盘点：库存改成实数、返回 before 与 delta、记 adjust 流水；不能修改 404', async () => {
    const a = await post('/api/adjustments', { warehouse_id: ids.w2, product_id: ids.p2, counted: 38, note: '破损' });
    assert.equal(a.before, 40); assert.equal(a.counted, 38); assert.equal(a.delta, -2); ids.adj1 = a.id;
    assert.equal(ok(await req('GET', `/api/stock?warehouse_id=${ids.w2}&product_id=${ids.p2}`))[0].quantity, 38);
    const mv = ok(await req('GET', `/api/movements?product_id=${ids.p2}&warehouse_id=${ids.w2}`)).at(-1);
    assert.equal(mv.reason, 'adjust'); assert.equal(mv.delta, -2); assert.equal(mv.ref_type, 'adjustment');
    expectError(await req('PATCH', `/api/adjustments/${ids.adj1}`, { counted: 1 }), 404, 'not_found');
    expectError(await req('POST', '/api/adjustments', { warehouse_id: ids.w2, product_id: ids.p2, counted: -1 }), 400, 'validation_failed');
  });
  await check('盘点新商品入库（原来没有库存）', async () => {
    const a = await post('/api/adjustments', { warehouse_id: ids.w1, product_id: ids.p3, counted: 200, note: '' });
    assert.equal(a.before, 0); assert.equal(a.delta, 200);
  });
  await check('库存汇总：合计、low 标记、?low=true', async () => {
    const s = ok(await req('GET', '/api/stock/summary'));
    const p1 = s.find((x) => x.product_id === ids.p1);
    assert.equal(p1.quantity, 10); assert.equal(p1.low, true); assert.equal(p1.sku, 'A-1001');
    assert.deepEqual(ok(await req('GET', '/api/stock/summary?low=true')).map((x) => x.product_id), [ids.p1, ids.p2]);
  });

  group('三期·报表、导出与看板');
  await check('看板数字', async () => {
    const d = ok(await req('GET', '/api/reports/dashboard'));
    assert.equal(d.products, 3); assert.equal(d.warehouses, 2); assert.equal(d.low_stock, 2);
    assert.equal(d.open_purchase_orders, 0); assert.equal(d.open_sales_orders, 1);
    assert.equal(d.stock_value, 10 * 1850 + 38 * 120 + 200 * 0);
  });
  await check('销售报表：合计与 top_products', async () => {
    const r = ok(await req('GET', `/api/reports/sales?from=${today}&to=${today}`));
    assert.equal(r.orders, 1); assert.equal(r.quantity, 100); assert.equal(r.amount, 90 * 2500 + 10 * 300);
    assert.deepEqual(r.top_products.map((p) => [p.product_id, p.quantity, p.amount]), [[ids.p1, 90, 225000], [ids.p2, 10, 3000]]);
  });
  await check('销售报表参数：缺少、日期不存在、from 晚于 to 都是 400；范围外没有数据', async () => {
    expectError(await req('GET', '/api/reports/sales?from=2026-01-01'), 400, 'validation_failed');
    expectError(await req('GET', '/api/reports/sales?from=2026-02-30&to=2026-03-01'), 400, 'validation_failed');
    expectError(await req('GET', '/api/reports/sales?from=2026-03-02&to=2026-03-01'), 400, 'validation_failed');
    const r = ok(await req('GET', '/api/reports/sales?from=2000-01-01&to=2000-01-31'));
    assert.equal(r.orders, 0); assert.deepEqual(r.top_products, []);
  });
  await check('商品导出 CSV：表头、行数、含逗号的字段加引号', async () => {
    const r = await req('GET', '/api/products/export.csv');
    assert.equal(r.status, 200); assert.match(r.type, /text\/csv/);
    const lines = r.text.trim().split(/\r?\n/);
    assert.equal(lines[0], 'sku,name,category,unit,price,cost,safety_stock,active');
    assert.equal(lines.length, 4);
    assert.ok(lines[3].startsWith('C-3001,"抹布, 大号",清洁用品,'), lines[3]);
  });
  await check('库存导出 CSV', async () => {
    const r = await req('GET', '/api/stock/export.csv');
    assert.equal(r.status, 200); assert.match(r.type, /text\/csv/);
    const lines = r.text.trim().split(/\r?\n/);
    assert.equal(lines[0], 'warehouse,sku,name,quantity'); assert.equal(lines.length, 5); assert.equal(lines[1], 'MAIN,A-1001,A4 打印纸,5');
  });

  group('页面');
  for (const p of ['/login', '/', '/products', '/categories', '/partners', '/warehouses', '/users', '/stock', '/purchase-orders', `/purchase-orders/${ids.po1 ?? 1}`, '/sales-orders', '/transfers', '/reports']) {
    await check(`GET ${p} 返回 HTML`, async () => {
      const r = await req('GET', p, undefined, { as: null });
      assert.equal(r.status, 200); assert.match(r.type, /text\/html/);
    });
  }

  group('持久化');
  await check('重启后数据、令牌与编号计数保留', async () => {
    await stop(); await start();
    assert.equal(ok(await req('GET', '/api/me')).username, 'admin');
    assert.equal(ok(await req('GET', `/api/stock?warehouse_id=${ids.w2}&product_id=${ids.p2}`))[0].quantity, 38);
    const o = await post('/api/purchase-orders', { partner_id: ids.sup, warehouse_id: ids.w1, lines: [{ product_id: ids.p1, quantity: 1, price: 1 }] });
    assert.equal(o.no, 'PO000003');
  });
}

let crashed = null;
try {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await start();
  await run();
} catch (e) { crashed = String(e?.message ?? e); }
finally { await stop(); rmSync(dataDir, { recursive: true, force: true }); }

if (crashed && !groups.length) { group('启动'); current.cases.push({ label: '服务启动', ok: false, why: crashed }); }
let pass = 0;
let total = 0;
for (const g of groups) {
  const okN = g.cases.filter((c) => c.ok).length;
  pass += okN; total += g.cases.length;
  console.log(`## ${g.name}（${okN}/${g.cases.length}）`);
  for (const c of g.cases) console.log(c.ok ? `✓ ${c.label}` : `✗ ${c.label}：${c.why}`);
}
if (crashed && groups.length) console.log(`（中途出错：${crashed}）`);
console.log(`合计：${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
