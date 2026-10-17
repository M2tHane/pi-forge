// 社团管理 API 的隐藏测试（requirement.md 的验收）：在交付的项目上 `npm start`，按需求逐条调用 HTTP 接口。
// 用法：node hidden.mjs <项目目录>
// 输出格式给 scripts/real-build/common.ts 的 parseHidden：每组 "## 组名（通过/总数）"，每条 "✓ 标题" 或 "✗ 标题：原因"，最后 "合计：x/y"。
// 用例按顺序共用同一份数据，前面的创建失败时后面的会跟着失败。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const project = path.resolve(process.argv[2] ?? '.');
const dataDir = mkdtempSync(path.join(tmpdir(), 'club-hidden-'));
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
const post = async (url, body) => { const r = await req('POST', url, body); assert.equal(r.status, 201, `创建 ${url} 返回 ${r.status}：${r.text.slice(0, 120)}`); return r.json; };

async function run() {
  group('基础');
  await check('GET /health 返回 {ok:true}', async () => { const r = await req('GET', '/health'); assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true }); });
  await check('没有的路径返回 404 not_found', async () => expectError(await req('GET', '/nope'), 404, 'not_found'));
  await check('请求体不是 JSON 返回 400 invalid_json', async () => expectError(await req('POST', '/members', '{bad', { raw: true }), 400, 'invalid_json'));
  await check('请求体是数组返回 400 invalid_json', async () => expectError(await req('POST', '/rooms', []), 400, 'invalid_json'));
  await check('路径里的 id 不是正整数返回 404', async () => expectError(await req('GET', '/tags/abc'), 404, 'not_found'));

  group('成员');
  await check('创建成员：201，email 存小写，role 默认 member，名称去首尾空白', async () => {
    const r = await req('POST', '/members', { name: '  张三 ', email: 'ZhangSan@Example.com' });
    assert.equal(r.status, 201); assert.match(r.type, /application\/json/);
    assert.equal(r.json.name, '张三'); assert.equal(r.json.email, 'zhangsan@example.com'); assert.equal(r.json.role, 'member');
    ids.m1 = r.json.id;
    ids.m2 = (await post('/members', { name: '李四', email: 'lisi@example.com', role: 'admin' })).id;
    ids.m3 = (await post('/members', { name: '王五', email: 'wangwu@example.com' })).id;
    assert.deepEqual([ids.m1, ids.m2, ids.m3], [1, 2, 3]);
  });
  await check('email 不区分大小写重复返回 409', async () => expectError(await req('POST', '/members', { name: 'x', email: 'LISI@example.com' }), 409, 'conflict'));
  await check('email 格式不对返回 400', async () => {
    for (const email of ['a@@b', 'nope', 'a b@c', '@b', 'a@']) expectError(await req('POST', '/members', { name: 'x', email }), 400, 'validation_failed');
  });
  await check('role 取值不对、name 超长返回 400', async () => {
    expectError(await req('POST', '/members', { name: 'x', email: 'r@x', role: 'owner' }), 400, 'validation_failed');
    expectError(await req('POST', '/members', { name: 'x'.repeat(41), email: 'l@x' }), 400, 'validation_failed');
  });
  await check('GET /members?role=admin 过滤；取值不对 400', async () => {
    const r = await req('GET', '/members?role=admin'); assert.equal(r.status, 200); assert.deepEqual(r.json.map((m) => m.id), [ids.m2]);
    expectError(await req('GET', '/members?role=boss'), 400, 'validation_failed');
  });
  await check('PATCH 只改给出的字段；改成别人的 email 409', async () => {
    const r = await req('PATCH', `/members/${ids.m3}`, { name: '王五五' }); assert.equal(r.status, 200);
    assert.equal(r.json.name, '王五五'); assert.equal(r.json.email, 'wangwu@example.com');
    expectError(await req('PATCH', `/members/${ids.m3}`, { email: 'zhangsan@example.com' }), 409, 'conflict');
  });

  group('场地');
  await check('创建场地：floor 默认 1', async () => {
    const r = await post('/rooms', { name: '活动室A', capacity: 2 }); assert.equal(r.floor, 1); ids.r1 = r.id;
    ids.r2 = (await post('/rooms', { name: '大厅', capacity: 100, floor: -1 })).id;
  });
  await check('名称不区分大小写重复 409；capacity、floor 越界 400', async () => {
    await post('/rooms', { name: 'Studio', capacity: 10 });
    expectError(await req('POST', '/rooms', { name: 'studio', capacity: 5 }), 409, 'conflict');
    expectError(await req('POST', '/rooms', { name: 'x1', capacity: 0 }), 400, 'validation_failed');
    expectError(await req('POST', '/rooms', { name: 'x2', capacity: 501 }), 400, 'validation_failed');
    expectError(await req('POST', '/rooms', { name: 'x3', capacity: 5, floor: 51 }), 400, 'validation_failed');
    expectError(await req('POST', '/rooms', { name: 'x4', capacity: 2.5 }), 400, 'validation_failed');
  });
  await check('GET /rooms?min_capacity 过滤；不合法 400', async () => {
    const r = await req('GET', '/rooms?min_capacity=10'); assert.equal(r.status, 200); assert.deepEqual(r.json.map((x) => x.name), ['大厅', 'Studio']);
    expectError(await req('GET', '/rooms?min_capacity=0'), 400, 'validation_failed');
    expectError(await req('GET', '/rooms?min_capacity=abc'), 400, 'validation_failed');
  });

  group('器材');
  await check('创建器材：condition 默认 good；名称可重复', async () => {
    const a = await post('/items', { name: '投影仪', quantity: 2 }); assert.equal(a.condition, 'good'); ids.i1 = a.id;
    await post('/items', { name: '投影仪', quantity: 1, condition: 'broken' });
  });
  await check('quantity 越界、condition 取值不对 400；GET ?condition 过滤', async () => {
    expectError(await req('POST', '/items', { name: 'x', quantity: -1 }), 400, 'validation_failed');
    expectError(await req('POST', '/items', { name: 'x', quantity: 1, condition: 'new' }), 400, 'validation_failed');
    const r = await req('GET', '/items?condition=broken'); assert.equal(r.status, 200); assert.equal(r.json.length, 1);
    expectError(await req('GET', '/items?condition=bad'), 400, 'validation_failed');
  });
  await check('adjust：加减数量返回 200；结果越界 409 且数量不变；delta 为 0 返回 400', async () => {
    const r = await req('POST', `/items/${ids.i1}/adjust`, { delta: 3 }); assert.equal(r.status, 200); assert.equal(r.json.quantity, 5);
    expectError(await req('POST', `/items/${ids.i1}/adjust`, { delta: -6 }), 409, 'conflict');
    assert.equal((await req('GET', `/items/${ids.i1}`)).json.quantity, 5);
    expectError(await req('POST', `/items/${ids.i1}/adjust`, { delta: 0 }), 400, 'validation_failed');
    expectError(await req('POST', '/items/999/adjust', { delta: 1 }), 404, 'not_found');
  });

  group('公告');
  await check('创建公告：body 默认空、pinned 默认 false', async () => {
    const a = await post('/notices', { title: '欢迎新成员' }); assert.equal(a.body, ''); assert.equal(a.pinned, false); ids.n1 = a.id;
    ids.n2 = (await post('/notices', { title: '场地维修', body: '大厅周末 Closed' })).id;
    ids.n3 = (await post('/notices', { title: '年会', body: '', pinned: true })).id;
  });
  await check('列表：置顶在前，同组 id 降序', async () => {
    assert.deepEqual((await req('GET', '/notices')).json.map((n) => n.id), [ids.n3, ids.n2, ids.n1]);
  });
  await check('?q 不区分大小写匹配标题或正文；q 为空 400', async () => {
    assert.deepEqual((await req('GET', `/notices?q=${encodeURIComponent('closed')}`)).json.map((n) => n.id), [ids.n2]);
    assert.deepEqual((await req('GET', `/notices?q=${encodeURIComponent('年')}`)).json.map((n) => n.id), [ids.n3]);
    expectError(await req('GET', '/notices?q=%20'), 400, 'validation_failed');
  });
  await check('title 超长、pinned 不是布尔 400', async () => {
    expectError(await req('POST', '/notices', { title: 'x'.repeat(81) }), 400, 'validation_failed');
    expectError(await req('POST', '/notices', { title: 'x', pinned: 'yes' }), 400, 'validation_failed');
  });

  group('标签');
  await check('创建标签：color 默认 #888888，给出的存小写', async () => {
    const a = await post('/tags', { name: '户外' }); assert.equal(a.color, '#888888'); ids.t1 = a.id;
    const b = await post('/tags', { name: 'Music', color: '#A1B2C3' }); assert.equal(b.color, '#a1b2c3'); ids.t2 = b.id;
    ids.t3 = (await post('/tags', { name: '临时' })).id;
  });
  await check('名称重复 409；color 格式不对 400', async () => {
    expectError(await req('POST', '/tags', { name: 'music' }), 409, 'conflict');
    for (const color of ['#12345', 'red', '#12345g', '123456']) expectError(await req('POST', '/tags', { name: `c${color}`, color }), 400, 'validation_failed');
  });
  await check('删除标签 204，再查 404', async () => {
    const r = await req('DELETE', `/tags/${ids.t3}`); assert.equal(r.status, 204); assert.equal(r.text, '');
    expectError(await req('GET', `/tags/${ids.t3}`), 404, 'not_found');
  });

  group('活动');
  await check('创建活动：tag_ids 去重升序，signup_count 为 0', async () => {
    const r = await post('/events', { title: '吉他夜', room_id: ids.r1, date: '2026-11-07', start: '19:00', end: '21:00', tag_ids: [ids.t2, ids.t1, ids.t2] });
    assert.deepEqual(r.tag_ids, [ids.t1, ids.t2]); assert.equal(r.signup_count, 0); ids.e1 = r.id;
    const b = await post('/events', { title: '晨跑', room_id: ids.r2, date: '2026-11-07', start: '07:00', end: '08:00' }); assert.deepEqual(b.tag_ids, []); ids.e2 = b.id;
  });
  await check('end 不晚于 start、日期或时间不合法 400', async () => {
    const base = { title: 'x', room_id: ids.r2, date: '2026-11-08' };
    expectError(await req('POST', '/events', { ...base, start: '10:00', end: '10:00' }), 400, 'validation_failed');
    expectError(await req('POST', '/events', { ...base, date: '2026-02-30', start: '10:00', end: '11:00' }), 400, 'validation_failed');
    expectError(await req('POST', '/events', { ...base, start: '24:00', end: '24:30' }), 400, 'validation_failed');
  });
  await check('引用不存在的场地或标签 400', async () => {
    expectError(await req('POST', '/events', { title: 'x', room_id: 999, date: '2026-11-08', start: '10:00', end: '11:00' }), 400, 'validation_failed');
    expectError(await req('POST', '/events', { title: 'x', room_id: ids.r2, date: '2026-11-08', start: '10:00', end: '11:00', tag_ids: [999] }), 400, 'validation_failed');
  });
  await check('同场地同天时间重叠 409；首尾相接不算重叠', async () => {
    expectError(await req('POST', '/events', { title: '冲突', room_id: ids.r1, date: '2026-11-07', start: '20:00', end: '22:00' }), 409, 'conflict');
    ids.e3 = (await post('/events', { title: '接着吉他夜', room_id: ids.r1, date: '2026-11-07', start: '21:00', end: '22:00', tag_ids: [ids.t2] })).id;
  });
  await check('修改时也检查重叠，不和自己比', async () => {
    const r = await req('PATCH', `/events/${ids.e1}`, { start: '18:30' }); assert.equal(r.status, 200); assert.equal(r.json.start, '18:30');
    expectError(await req('PATCH', `/events/${ids.e3}`, { start: '20:30' }), 409, 'conflict');
  });
  await check('列表排序与 date、room_id、tag_id 过滤', async () => {
    assert.deepEqual((await req('GET', '/events')).json.map((e) => e.id), [ids.e2, ids.e1, ids.e3]);
    assert.deepEqual((await req('GET', `/events?room_id=${ids.r1}`)).json.map((e) => e.id), [ids.e1, ids.e3]);
    assert.deepEqual((await req('GET', `/events?tag_id=${ids.t1}`)).json.map((e) => e.id), [ids.e1]);
    assert.deepEqual((await req('GET', '/events?date=2026-11-08')).json, []);
    expectError(await req('GET', '/events?date=2026-13-01'), 400, 'validation_failed');
  });
  await check('被活动引用的场地、标签不能删 409', async () => {
    expectError(await req('DELETE', `/rooms/${ids.r1}`), 409, 'conflict');
    expectError(await req('DELETE', `/tags/${ids.t1}`), 409, 'conflict');
  });

  group('报名');
  await check('报名 201 并更新 signup_count', async () => {
    const r = await req('POST', `/events/${ids.e1}/signups`, { member_id: ids.m1 }); assert.equal(r.status, 201);
    assert.deepEqual(r.json, { event_id: ids.e1, member_id: ids.m1 });
    assert.equal((await req('GET', `/events/${ids.e1}`)).json.signup_count, 1);
  });
  await check('重复报名 409；成员不存在 400；活动不存在 404', async () => {
    expectError(await req('POST', `/events/${ids.e1}/signups`, { member_id: ids.m1 }), 409, 'conflict');
    expectError(await req('POST', `/events/${ids.e1}/signups`, { member_id: 999 }), 400, 'validation_failed');
    expectError(await req('POST', '/events/999/signups', { member_id: ids.m1 }), 404, 'not_found');
  });
  await check('名额达到场地容量后 409', async () => {
    assert.equal((await req('POST', `/events/${ids.e1}/signups`, { member_id: ids.m3 })).status, 201);
    expectError(await req('POST', `/events/${ids.e1}/signups`, { member_id: ids.m2 }), 409, 'conflict');
  });
  await check('报名列表按成员 id 升序；成员的活动列表', async () => {
    assert.deepEqual((await req('GET', `/events/${ids.e1}/signups`)).json.map((m) => m.id), [ids.m1, ids.m3]);
    assert.equal((await req('POST', `/events/${ids.e2}/signups`, { member_id: ids.m1 })).status, 201);
    assert.deepEqual((await req('GET', `/members/${ids.m1}/events`)).json.map((e) => e.id), [ids.e2, ids.e1]);
    expectError(await req('GET', '/members/999/events'), 404, 'not_found');
  });
  await check('有报名的成员不能删 409；取消报名 204，不存在的报名 404', async () => {
    expectError(await req('DELETE', `/members/${ids.m3}`), 409, 'conflict');
    assert.equal((await req('DELETE', `/events/${ids.e1}/signups/${ids.m3}`)).status, 204);
    expectError(await req('DELETE', `/events/${ids.e1}/signups/${ids.m3}`), 404, 'not_found');
    assert.equal((await req('DELETE', `/members/${ids.m3}`)).status, 204);
  });

  group('统计');
  await check('GET /stats 各资源条数', async () => {
    const r = await req('GET', '/stats'); assert.equal(r.status, 200);
    assert.deepEqual(r.json, { members: 2, rooms: 3, items: 2, notices: 3, tags: 2, events: 3, signups: 2 });
  });
  await check('GET /stats/rooms?date 每个场地都列出；date 缺少或不合法 400', async () => {
    const r = await req('GET', '/stats/rooms?date=2026-11-07'); assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((x) => [x.room_id, x.events, x.signups]), [[ids.r1, 2, 1], [ids.r2, 1, 1], [3, 0, 0]]);
    assert.equal(r.json[0].name, '活动室A');
    expectError(await req('GET', '/stats/rooms'), 400, 'validation_failed');
    expectError(await req('GET', '/stats/rooms?date=2026-11-31'), 400, 'validation_failed');
  });
  await check('删除活动一并删除报名', async () => {
    assert.equal((await req('DELETE', `/events/${ids.e2}`)).status, 204);
    assert.equal((await req('GET', '/stats')).json.signups, 1);
    assert.deepEqual((await req('GET', `/members/${ids.m1}/events`)).json.map((e) => e.id), [ids.e1]);
  });

  group('持久化');
  await check('重启后数据保留，编号不复用', async () => {
    await stop(); await start();
    assert.deepEqual((await req('GET', '/members')).json.map((m) => m.id), [ids.m1, ids.m2]);
    assert.equal((await req('GET', `/events/${ids.e1}`)).json.signup_count, 1);
    const m = await post('/members', { name: '赵六', email: 'zhaoliu@example.com' });
    assert.equal(m.id, 4, `重启后新成员编号 ${m.id} 应为 4`);
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
