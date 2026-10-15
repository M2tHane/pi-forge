// 运行时资源的分配、注入与回收。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import {
  PORT_BLOCK, PORT_RANGE, allocateResources, dbNameFor, isStaleResource, listResources, pickPortBase, portBlockFree, reclaimResources,
  releaseResources, resourceEnv, resourcesPath, withResources, type ResourceEntry,
} from '../../src/core/workspace/resources.ts';
import { runShell } from '../../src/core/workspace/verify-runner.ts';

function project() {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-forge-res-'));
  const root = path.join(base, 'app');
  mkdirSync(root);
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const free = async () => true;

test('pickPortBase：跳过已登记与探测失败的段，按 10 对齐，环绕查找，用完返回 null', () => {
  const u = (...bases: number[]) => bases.map((base) => ({ base, size: 10 }));
  assert.equal(pickPortBase([]), PORT_RANGE.start);
  assert.equal(pickPortBase(u(PORT_RANGE.start, PORT_RANGE.start + 10)), PORT_RANGE.start + 20);
  assert.equal(pickPortBase([{ base: PORT_RANGE.start, size: 25 }]), PORT_RANGE.start + 30, '段长不同的已登记区间按重叠判断');
  assert.equal(pickPortBase([], new Set(), PORT_RANGE.start, PORT_RANGE, 20), PORT_RANGE.start);
  assert.equal(pickPortBase([], new Set([PORT_RANGE.start])), PORT_RANGE.start + 10);
  assert.equal(pickPortBase([], new Set(), PORT_RANGE.start + 37), PORT_RANGE.start + 30);
  const small = { start: 100, end: 130 };
  assert.equal(pickPortBase(u(120), new Set(), 120, small), 100, '从 hint 开始，末尾环绕到开头');
  assert.equal(pickPortBase(u(100, 110, 120), new Set(), 100, small), null);
});

test('dbNameFor 与 resourceEnv：数据库名只含小写字母数字下划线；PORT 等于 FORGE_PORT_BASE', () => {
  assert.equal(dbNameFor('r-MV1v45pma19cc3'), 'forge_r_mv1v45pma19cc3');
  assert.equal(dbNameFor('pc-B-001-T-003.at-2'), 'forge_pc_b_001_t_003_at_2');
  assert.ok(dbNameFor('x'.repeat(100)).length <= 63);
  assert.deepEqual(resourceEnv({ port_base: 41230, db_name: 'forge_r1', tmp: '/t/r1' }), { PORT: '41230', FORGE_PORT_BASE: '41230', FORGE_DB_NAME: 'forge_r1', FORGE_TMP: '/t/r1' });
});

test('分配：两次运行端口段不重叠、各有临时目录；同一 run 重复分配返回原条目；释放后删除目录与登记', async () => {
  const p = project();
  try {
    const a = await allocateResources(p.root, 'r-a', { probe: free });
    const b = await allocateResources(p.root, 'r-b', { probe: free });
    assert.ok(Math.abs(a.port_base - b.port_base) >= PORT_BLOCK);
    assert.equal(a.port_base % PORT_BLOCK, 0);
    assert.ok(existsSync(a.tmp) && existsSync(b.tmp) && a.tmp !== b.tmp);
    assert.ok(!resourcesPath(p.root).startsWith(path.join(p.root, '.forge')), '登记不在 .forge/ 内');
    assert.deepEqual(await allocateResources(p.root, 'r-a', { probe: free }), a);
    assert.deepEqual(listResources(p.root).map((e) => e.run), ['r-a', 'r-b']);
    assert.equal((await releaseResources(p.root, 'r-a'))?.run, 'r-a');
    assert.ok(!existsSync(a.tmp));
    assert.deepEqual(listResources(p.root).map((e) => e.run), ['r-b']);
    assert.equal(await releaseResources(p.root, 'r-a'), null, '重复释放无副作用');
  } finally { p.cleanup(); }
});

test('并发分配（文件锁）：同时分配 8 份，端口段互不相同', async () => {
  const p = project();
  try {
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => allocateResources(p.root, `r-${i}`, { probe: free })));
    assert.equal(new Set(all.map((e) => e.port_base)).size, 8);
    assert.equal(listResources(p.root).length, 8);
  } finally { p.cleanup(); }
});

test('端口被别的程序占用时换一段', async () => {
  const p = project();
  const srv = createServer();
  await new Promise<void>((r) => srv.listen({ port: 0, host: '127.0.0.1' }, () => r()));
  const busy = (srv.address() as { port: number }).port;
  try {
    assert.equal(await portBlockFree(busy - (busy % PORT_BLOCK)), false);
    const taken = new Set<number>();
    const e = await allocateResources(p.root, 'r-x', { probe: async (b) => { taken.add(b); return taken.size > 1; } });
    assert.equal(taken.size, 2, '第一段探测失败后换下一段');
    assert.notEqual(e.port_base, [...taken][0]);
  } finally { srv.close(); p.cleanup(); }
});

test('db_create / db_drop：分配时按 FORGE_DB_NAME 建库，释放时删库；建库失败不留登记', async () => {
  const p = project();
  try {
    const log = path.join(p.root, '..', 'db.log');
    const commands = { db_create: `echo "create $FORGE_DB_NAME $PORT" >> ${log}`, db_drop: `echo "drop $FORGE_DB_NAME" >> ${log}` };
    const e = await allocateResources(p.root, 'r-db', { probe: free, commands });
    assert.equal(e.db_created, true);
    await releaseResources(p.root, 'r-db', commands);
    assert.equal(readFileSync(log, 'utf8'), `create forge_r_db ${e.port_base}\ndrop forge_r_db\n`);
    await assert.rejects(allocateResources(p.root, 'r-bad', { probe: free, commands: { db_create: 'echo 没有权限 >&2; exit 3' } }), /db_create 失败（forge_r_bad，退出码 3）[\s\S]*没有权限/);
    assert.deepEqual(listResources(p.root), []);
  } finally { p.cleanup(); }
});

test('回收：run 已结束或分配进程已不存在的条目被回收（删除临时目录），本会话仍在运行的保留', async () => {
  const p = project();
  try {
    const ended = await allocateResources(p.root, 'r-ended', { probe: free });
    const dead = await allocateResources(p.root, 'pc-dead', { probe: free, pid: 999_999 });
    await allocateResources(p.root, 'r-live', { probe: free });
    await allocateResources(p.root, 'r-active', { probe: free, pid: 999_998 });
    const alive = (pid: number) => pid === process.pid;
    const e = (run: string, pid = process.pid): ResourceEntry => ({ run, pid, port_base: 0, db_name: '', tmp: '', allocated_at: '' });
    assert.equal(isStaleResource(e('r-ended'), new Set(['r-ended']), alive), true);
    assert.equal(isStaleResource(e('x', 999_999), new Set(), alive), true);
    assert.equal(isStaleResource(e('r-live'), new Set(), alive), false);
    assert.equal(isStaleResource(e('r-active', 999_998), new Set(), alive, new Set(['r-active'])), false);
    const runs = await reclaimResources(p.root, (x) => isStaleResource(x, new Set(['r-ended']), alive, new Set(['r-active'])));
    assert.deepEqual(runs.sort(), ['pc-dead', 'r-ended']);
    assert.ok(!existsSync(ended.tmp) && !existsSync(dead.tmp));
    assert.deepEqual(listResources(p.root).map((x) => x.run).sort(), ['r-active', 'r-live']);
  } finally { p.cleanup(); }
});

test('withResources：命令拿到四个变量；结束（包括抛错）后释放', async () => {
  const p = project();
  try {
    const out = await withResources(p.root, 'gate-B-001-S0', {}, async (env) => (await runShell('echo "$PORT $FORGE_PORT_BASE $FORGE_DB_NAME $FORGE_TMP"', tmpdir(), 10_000, env)).output.trim());
    const [port, base, db, tmp] = out.split(' ');
    assert.equal(port, base);
    assert.equal(db, 'forge_gate_b_001_s0');
    assert.match(tmp!, /\.tmp\/gate-B-001-S0$/);
    assert.deepEqual(listResources(p.root), []);
    await assert.rejects(withResources(p.root, 'pc-x', { block: 5 }, async () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(listResources(p.root), []);
  } finally { p.cleanup(); }
});

test('登记文件损坏时按空登记处理，不阻塞分配', async () => {
  const p = project();
  try {
    await allocateResources(p.root, 'r-1', { probe: free });
    writeFileSync(resourcesPath(p.root), '{坏');
    const e = await allocateResources(p.root, 'r-2', { probe: free });
    assert.deepEqual(listResources(p.root).map((x) => x.run), ['r-2']);
    assert.ok(e.port_base >= PORT_RANGE.start);
  } finally { p.cleanup(); }
});
