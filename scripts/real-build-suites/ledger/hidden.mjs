// 家庭记账 API 的隐藏测试（requirement.md 的验收）：在交付的项目上 `npm start`，按需求逐条调用 HTTP 接口。
// 用法：node hidden.mjs <项目目录>
// 输出格式给 scripts/m9/common.ts 的 parseHidden：每组 "## 组名（通过/总数）"，每条 "✓ 标题" 或 "✗ 标题：原因"，最后 "合计：x/y"。
// 用例按顺序共用同一份数据，前面的创建失败时后面的会跟着失败。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const project = path.resolve(process.argv[2] ?? '.');
const dataDir = mkdtempSync(path.join(tmpdir(), 'ledger-hidden-'));
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
    try { const r = await fetch(`${base}/health`); if (r.status === 200) return; } catch { /* 还没起来 */ }
    if (server.exitCode !== null) throw new Error(`服务退出（${server.exitCode}）：${log.slice(-300)}`);
    await sleep(200);
  }
  throw new Error(`30 秒内 /health 没有返回 200：${log.slice(-300)}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  await Promise.race([exited, sleep(5000)]);
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

async function req(method, url, body, { raw = false, type } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) { payload = raw ? body : JSON.stringify(body); headers['content-type'] = type ?? 'application/json'; }
  const r = await fetch(`${base}${url}`, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 不是 JSON */ }
  return { status: r.status, type: r.headers.get('content-type') ?? '', text, json };
}
const errCode = (r) => r.json?.error?.code;
function expectError(r, status, code) {
  assert.equal(r.status, status, `状态码 ${r.status}，响应 ${r.text.slice(0, 120)}`);
  assert.equal(errCode(r), code, `error.code 是 ${errCode(r)}`);
}

// —— 用例 ——

const groups = [];
let current = null;
const group = (name) => { current = { name, cases: [] }; groups.push(current); };
async function check(label, fn) {
  try { await fn(); current.cases.push({ label, ok: true }); }
  catch (e) { current.cases.push({ label, ok: false, why: String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200) }); }
}

const ids = {};
const tx = {};

async function run() {
  group('基础');
  await check('GET /health 返回 {ok:true}', async () => { const r = await req('GET', '/health'); assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true }); });
  await check('没有的路径返回 404 not_found', async () => expectError(await req('GET', '/nope'), 404, 'not_found'));
  await check('请求体不是 JSON 返回 400 invalid_json', async () => expectError(await req('POST', '/accounts', '{bad', { raw: true }), 400, 'invalid_json'));

  group('账户');
  await check('创建账户返回 201，initial_balance 默认 0，名称去首尾空白', async () => {
    const a = await req('POST', '/accounts', { name: '  现金 ', type: 'cash', initial_balance: 10000 });
    assert.equal(a.status, 201);
    assert.match(a.type, /application\/json/);
    assert.deepEqual([a.json.name, a.json.type, a.json.initial_balance], ['现金', 'cash', 10000]);
    const b = await req('POST', '/accounts', { name: '招商银行', type: 'bank' });
    assert.equal(b.status, 201);
    assert.equal(b.json.initial_balance, 0);
    assert.ok(Number.isInteger(a.json.id) && b.json.id > a.json.id);
    ids.cash = a.json.id; ids.bank = b.json.id;
  });
  await check('字段不合法返回 400 validation_failed', async () => {
    expectError(await req('POST', '/accounts', { type: 'cash' }), 400, 'validation_failed');
    expectError(await req('POST', '/accounts', { name: 'x', type: 'gold' }), 400, 'validation_failed');
    expectError(await req('POST', '/accounts', { name: 'x'.repeat(51), type: 'cash' }), 400, 'validation_failed');
    expectError(await req('POST', '/accounts', { name: 'x', type: 'cash', initial_balance: 1.5 }), 400, 'validation_failed');
  });
  await check('账户名不区分大小写重复返回 409', async () => {
    assert.equal((await req('POST', '/accounts', { name: 'Wallet', type: 'cash' })).status, 201);
    expectError(await req('POST', '/accounts', { name: 'wallet', type: 'bank' }), 409, 'conflict');
  });
  await check('列表按 id 升序；按 id 查询；不存在返回 404', async () => {
    const r = await req('GET', '/accounts');
    assert.equal(r.status, 200);
    const list = r.json.map((x) => x.id);
    assert.deepEqual(list, [...list].sort((x, y) => x - y));
    assert.equal(list.length, 3);
    assert.equal((await req('GET', `/accounts/${ids.bank}`)).json.name, '招商银行');
    expectError(await req('GET', '/accounts/9999'), 404, 'not_found');
  });
  await check('PATCH 改名返回 200；取值不对 400；删除未被引用的账户 204', async () => {
    const wallet = (await req('GET', '/accounts')).json.find((x) => x.name === 'Wallet');
    const r = await req('PATCH', `/accounts/${wallet.id}`, { name: '零钱包' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.name, r.json.type], ['零钱包', 'cash']);
    expectError(await req('PATCH', `/accounts/${wallet.id}`, { type: 'gold' }), 400, 'validation_failed');
    const d = await req('DELETE', `/accounts/${wallet.id}`);
    assert.equal(d.status, 204);
    assert.equal(d.text, '');
    expectError(await req('GET', `/accounts/${wallet.id}`), 404, 'not_found');
  });

  group('分类');
  await check('创建分类；收入和支出可以同名，同类同名（不区分大小写）409', async () => {
    const mk = async (name, kind) => { const r = await req('POST', '/categories', { name, kind }); assert.equal(r.status, 201, `${name}/${kind}: ${r.text.slice(0, 100)}`); assert.equal(r.json.kind, kind); return r.json.id; };
    ids.salary = await mk('工资', 'income');
    ids.food = await mk('餐饮', 'expense');
    ids.traffic = await mk('交通', 'expense');
    ids.otherIn = await mk('Other', 'income');
    ids.otherOut = await mk('Other', 'expense');
    expectError(await req('POST', '/categories', { name: 'other', kind: 'income' }), 409, 'conflict');
    expectError(await req('POST', '/categories', { name: '房租', kind: 'cost' }), 400, 'validation_failed');
  });
  await check('按 kind 过滤；kind 取值不对 400', async () => {
    const r = await req('GET', '/categories?kind=expense');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((x) => x.id), [ids.food, ids.traffic, ids.otherOut]);
    assert.equal((await req('GET', '/categories')).json.length, 5);
    expectError(await req('GET', '/categories?kind=xx'), 400, 'validation_failed');
  });
  await check('PATCH 可改名，改 kind 返回 400', async () => {
    const r = await req('PATCH', `/categories/${ids.traffic}`, { name: '出行' });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, '出行');
    expectError(await req('PATCH', `/categories/${ids.traffic}`, { kind: 'income' }), 400, 'validation_failed');
    assert.equal((await req('PATCH', `/categories/${ids.traffic}`, { name: '交通', kind: 'expense' })).status, 200);
  });

  group('交易');
  await check('创建交易：kind 取自分类，note 默认空字符串', async () => {
    const mk = async (b) => { const r = await req('POST', '/transactions', b); assert.equal(r.status, 201, r.text.slice(0, 120)); return r.json; };
    tx.t1 = await mk({ account_id: ids.bank, category_id: ids.salary, amount: 1000000, date: '2026-03-05' });
    tx.t2 = await mk({ account_id: ids.cash, category_id: ids.food, amount: 3500, date: '2026-03-05', note: 'lunch, "noodles"' });
    tx.t3 = await mk({ account_id: ids.cash, category_id: ids.traffic, amount: 600, date: '2026-03-07' });
    tx.t4 = await mk({ account_id: ids.bank, category_id: ids.food, amount: 12000, date: '2026-03-10' });
    tx.t5 = await mk({ account_id: ids.cash, category_id: ids.food, amount: 2000, date: '2026-04-01' });
    assert.deepEqual([tx.t1.kind, tx.t2.kind, tx.t1.note], ['income', 'expense', '']);
    assert.equal(tx.t2.note, 'lunch, "noodles"');
  });
  await check('引用不存在的账户或分类返回 400 validation_failed', async () => {
    expectError(await req('POST', '/transactions', { account_id: 9999, category_id: ids.food, amount: 1, date: '2026-03-01' }), 400, 'validation_failed');
    expectError(await req('POST', '/transactions', { account_id: ids.cash, category_id: 9999, amount: 1, date: '2026-03-01' }), 400, 'validation_failed');
  });
  await check('金额与日期校验（0、负数、小数、超上限、不存在的日期）', async () => {
    const b = { account_id: ids.cash, category_id: ids.food, date: '2026-03-01' };
    for (const amount of [0, -5, 1.5, 100000001, '100']) expectError(await req('POST', '/transactions', { ...b, amount }), 400, 'validation_failed');
    for (const date of ['2026-02-30', '2026-3-01', '20260301']) expectError(await req('POST', '/transactions', { ...b, amount: 1, date }), 400, 'validation_failed');
    expectError(await req('POST', '/transactions', { ...b, amount: 1, note: 'x'.repeat(201) }), 400, 'validation_failed');
    assert.equal((await req('POST', '/transactions', { ...b, amount: 100000000, date: '2024-02-29' })).status, 201);
    const all = (await req('GET', '/transactions?from=2024-02-29&to=2024-02-29')).json.items;
    for (const t of all) assert.equal((await req('DELETE', `/transactions/${t.id}`)).status, 204);
  });
  await check('列表按日期降序、同日按 id 降序，返回 total', async () => {
    const r = await req('GET', '/transactions');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 5);
    assert.deepEqual(r.json.items.map((t) => t.id), [tx.t5.id, tx.t4.id, tx.t3.id, tx.t2.id, tx.t1.id]);
  });
  await check('过滤：from/to 含两端、kind、account_id、category_id', async () => {
    const ids_ = async (q) => (await req('GET', `/transactions?${q}`)).json.items.map((t) => t.id);
    assert.deepEqual(await ids_('from=2026-03-05&to=2026-03-07'), [tx.t3.id, tx.t2.id, tx.t1.id]);
    assert.deepEqual(await ids_('kind=income'), [tx.t1.id]);
    assert.deepEqual(await ids_(`account_id=${ids.cash}`), [tx.t5.id, tx.t3.id, tx.t2.id]);
    assert.deepEqual(await ids_(`category_id=${ids.food}&from=2026-03-01&to=2026-03-31`), [tx.t4.id, tx.t2.id]);
  });
  await check('分页：limit/offset，total 是分页前的条数；不合法的参数 400', async () => {
    const r = await req('GET', '/transactions?limit=2&offset=1');
    assert.deepEqual([r.json.items.map((t) => t.id), r.json.total], [[tx.t4.id, tx.t3.id], 5]);
    for (const q of ['limit=0', 'limit=201', 'offset=-1', 'from=2026-13-01', 'kind=other', 'limit=abc']) expectError(await req('GET', `/transactions?${q}`), 400, 'validation_failed');
  });
  await check('PATCH 改分类后 kind 随之变化；删除后查不到；编号不复用', async () => {
    const t = (await req('POST', '/transactions', { account_id: ids.cash, category_id: ids.traffic, amount: 100, date: '2026-05-01' })).json;
    const r = await req('PATCH', `/transactions/${t.id}`, { category_id: ids.otherIn, note: '退款' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.kind, r.json.note, r.json.amount], ['income', '退款', 100]);
    expectError(await req('PATCH', `/transactions/${t.id}`, { amount: 0 }), 400, 'validation_failed');
    assert.equal((await req('DELETE', `/transactions/${t.id}`)).status, 204);
    expectError(await req('GET', `/transactions/${t.id}`), 404, 'not_found');
    const n = (await req('POST', '/transactions', { account_id: ids.cash, category_id: ids.traffic, amount: 100, date: '2026-05-01' })).json;
    assert.ok(n.id > t.id, `新编号 ${n.id} 应大于已删除的 ${t.id}`);
    assert.equal((await req('DELETE', `/transactions/${n.id}`)).status, 204);
  });
  await check('删除被交易引用的账户、分类返回 409', async () => {
    expectError(await req('DELETE', `/accounts/${ids.cash}`), 409, 'conflict');
    expectError(await req('DELETE', `/categories/${ids.food}`), 409, 'conflict');
  });

  group('预算');
  await check('创建预算；收入分类 400；同分类同月重复 409', async () => {
    assert.equal((await req('POST', '/budgets', { category_id: ids.food, month: '2026-03', amount: 10000 })).status, 201);
    assert.equal((await req('POST', '/budgets', { category_id: ids.traffic, month: '2026-03', amount: 5000 })).status, 201);
    expectError(await req('POST', '/budgets', { category_id: ids.salary, month: '2026-03', amount: 100 }), 400, 'validation_failed');
    expectError(await req('POST', '/budgets', { category_id: ids.food, month: '2026-03', amount: 1 }), 409, 'conflict');
    expectError(await req('POST', '/budgets', { category_id: ids.food, month: '2026-3', amount: 1 }), 400, 'validation_failed');
  });
  await check('按月查询：spent 是当月该分类的交易合计，remaining 可为负', async () => {
    const r = await req('GET', '/budgets?month=2026-03');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((b) => [b.category_id, b.amount, b.spent, b.remaining]), [[ids.food, 10000, 15500, -5500], [ids.traffic, 5000, 600, 4400]]);
    assert.deepEqual((await req('GET', '/budgets?month=2026-04')).json, []);
  });
  await check('month 缺少或不合法 400', async () => {
    expectError(await req('GET', '/budgets'), 400, 'validation_failed');
    expectError(await req('GET', '/budgets?month=2026-13'), 400, 'validation_failed');
  });
  await check('PATCH 改金额；删除被预算引用的分类 409', async () => {
    const b = (await req('POST', '/budgets', { category_id: ids.otherOut, month: '2026-06', amount: 300 })).json;
    const r = await req('PATCH', `/budgets/${b.id}`, { amount: 500 });
    assert.deepEqual([r.status, r.json.amount, r.json.spent ?? 0], [200, 500, 0]);
    expectError(await req('DELETE', `/categories/${ids.otherOut}`), 409, 'conflict');
    assert.equal((await req('DELETE', `/budgets/${b.id}`)).status, 204);
  });

  group('报表');
  await check('月度报表：收入、支出、净额', async () => {
    const r = await req('GET', '/reports/monthly?month=2026-03');
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.month, r.json.income, r.json.expense, r.json.net], ['2026-03', 1000000, 16100, 983900]);
  });
  await check('月度报表：by_category 只列有交易的分类，按合计降序', async () => {
    const r = await req('GET', '/reports/monthly?month=2026-03');
    assert.deepEqual(r.json.by_category.map((c) => [c.category_id, c.name, c.kind, c.total]),
      [[ids.salary, '工资', 'income', 1000000], [ids.food, '餐饮', 'expense', 15500], [ids.traffic, '交通', 'expense', 600]]);
    const empty = (await req('GET', '/reports/monthly?month=2025-01')).json;
    assert.deepEqual([empty.income, empty.expense, empty.net, empty.by_category], [0, 0, 0, []]);
  });
  await check('账户余额 = 初始余额 + 收入 - 支出', async () => {
    const r = await req('GET', '/reports/balances');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((b) => [b.account_id, b.name, b.balance]), [[ids.cash, '现金', 3900], [ids.bank, '招商银行', 988000]]);
  });
  await check('month 不合法 400', async () => expectError(await req('GET', '/reports/monthly?month=March'), 400, 'validation_failed'));

  group('CSV');
  await check('导出：Content-Type 与表头', async () => {
    const r = await req('GET', '/export/transactions.csv');
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/csv/);
    assert.equal(r.text.split('\n')[0], 'id,date,account,category,kind,amount,note');
  });
  await check('导出：按日期升序，名称代替编号，含逗号与引号的字段加引号', async () => {
    const lines = (await req('GET', '/export/transactions.csv')).text.split('\n').filter(Boolean);
    assert.equal(lines.length, 6);
    assert.equal(lines[1], `${tx.t1.id},2026-03-05,招商银行,工资,income,1000000,`);
    assert.equal(lines[2], `${tx.t2.id},2026-03-05,现金,餐饮,expense,3500,"lunch, ""noodles"""`);
    assert.equal(lines[5], `${tx.t5.id},2026-04-01,现金,餐饮,expense,2000,`);
  });
  await check('导入：全部合法时导入，分类按名称与 kind 匹配，引号字段正确解析', async () => {
    const csv = 'date,account,category,kind,amount,note\n2026-04-02,现金,餐饮,expense,1500,"dinner, ""hotpot"""\n2026-04-03,招商银行,other,income,800,\n';
    const r = await req('POST', '/import/transactions', csv, { raw: true, type: 'text/csv' });
    assert.equal(r.status, 201, r.text.slice(0, 160));
    assert.deepEqual(r.json, { imported: 2 });
    const items = (await req('GET', '/transactions?from=2026-04-02&to=2026-04-03')).json.items;
    assert.deepEqual(items.map((t) => [t.date, t.account_id, t.category_id, t.kind, t.amount, t.note]),
      [['2026-04-03', ids.bank, ids.otherIn, 'income', 800, ''], ['2026-04-02', ids.cash, ids.food, 'expense', 1500, 'dinner, "hotpot"']]);
  });
  await check('导入：有一行不合法时一行都不导入，返回出错的行号', async () => {
    const before = (await req('GET', '/transactions')).json.total;
    const csv = 'date,account,category,kind,amount,note\n2026-04-04,现金,餐饮,expense,100,ok\n2026-04-05,不存在的账户,餐饮,expense,100,bad\n';
    const r = await req('POST', '/import/transactions', csv, { raw: true, type: 'text/csv' });
    expectError(r, 400, 'validation_failed');
    assert.equal(r.json.error.line, 3);
    const r2 = await req('POST', '/import/transactions', 'date,account,category,kind,amount,note\n2026-04-04,现金,餐饮,expense,-1,x\n', { raw: true, type: 'text/csv' });
    assert.equal(r2.json?.error?.line, 2);
    assert.equal((await req('GET', '/transactions')).json.total, before);
  });
  await check('导入：表头不对 400（line 1）；只有表头导入 0 行', async () => {
    const r = await req('POST', '/import/transactions', 'date,amount\n2026-04-04,1\n', { raw: true, type: 'text/csv' });
    expectError(r, 400, 'validation_failed');
    assert.equal(r.json.error.line, 1);
    const e = await req('POST', '/import/transactions', 'date,account,category,kind,amount,note\n', { raw: true, type: 'text/csv' });
    assert.deepEqual([e.status, e.json], [201, { imported: 0 }]);
  });

  group('持久化');
  await check('重启服务后数据还在，编号接着递增', async () => {
    const before = (await req('GET', '/transactions')).json;
    const cats = (await req('GET', '/categories')).json;
    await stop();
    await start();
    assert.deepEqual((await req('GET', '/accounts')).json.map((a) => a.name), ['现金', '招商银行']);
    const after = (await req('GET', '/transactions')).json;
    assert.deepEqual(after, before);
    const c = await req('POST', '/categories', { name: '医疗', kind: 'expense' });
    assert.equal(c.status, 201);
    assert.ok(c.json.id > Math.max(...cats.map((x) => x.id)), `重启后新分类编号 ${c.json.id} 不应复用`);
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
  const ok = g.cases.filter((c) => c.ok).length;
  pass += ok; total += g.cases.length;
  console.log(`## ${g.name}（${ok}/${g.cases.length}）`);
  for (const c of g.cases) console.log(c.ok ? `✓ ${c.label}` : `✗ ${c.label}：${c.why}`);
}
if (crashed && groups.length) console.log(`（中途出错：${crashed}）`);
console.log(`合计：${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
