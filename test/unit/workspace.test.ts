// F1：工作区的依赖准备（install → codegen，readonly 走缓存，writable 直接 install）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../../src/core/state/config.ts';
import { acctestCacheRoot, cacheKey, hasManifest, prepareWorkspace } from '../../src/core/workspace/workspace.ts';
import { workspaceStats } from '../../src/core/stage/signoff.ts';
import { TEST_YAML } from '../helpers/config.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** 项目根 app/ 与同级的一个工作区目录（普通 git 仓库即可）；files 写进工作区 */
function setup(files: Record<string, string>) {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-forge-ws-'));
  const root = path.join(base, 'app');
  const ws = path.join(base, 'ws');
  mkdirSync(root);
  mkdirSync(ws);
  git(ws, 'init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  }
  const fresh = () => { const d = path.join(base, `ws-${readdirSync(base).length}`); mkdirSync(d); git(d, 'init', '-q', '-b', 'main'); for (const [rel, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); writeFileSync(path.join(d, rel), content); } return d; };
  return { base, root, ws, fresh, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function configWith(commands: Record<string, string>) {
  const c = parseConfig(TEST_YAML);
  for (const k of ['install', 'codegen']) delete c.raw.commands[k];
  Object.assign(c.raw.commands, commands);
  c.raw.acctest_workspace = { cache: ['node_modules'] };
  return c;
}

const PKG = { 'package.json': '{"name":"app"}\n', 'pnpm-lock.yaml': 'lock: 1\n', '.gitignore': 'node_modules/\n' };

test('没有包清单与锁文件（S0 刚开始）：跳过 install 与 codegen，不报错', async () => {
  const p = setup({ 'README.md': 'x\n' });
  try {
    const log = path.join(p.base, 'cmd.log');
    const config = configWith({ install: `echo install >> ${log}`, codegen: `echo codegen >> ${log}` });
    const r = await prepareWorkspace(p.root, config, p.ws, { mode: 'readonly' });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.match(r.reason ?? '', /包清单与锁文件/);
    assert.ok(!existsSync(log), '什么命令都没跑');
    // node_modules 下的清单不算
    assert.equal(hasManifest(['node_modules/x/package.json', 'src/a.ts']), false);
    assert.equal(hasManifest(['web/package.json']), true);
    assert.equal(hasManifest(['go.sum']), true);
  } finally { p.cleanup(); }
});

test('没有 install 命令：跳过', async () => {
  const p = setup(PKG);
  try {
    const r = await prepareWorkspace(p.root, configWith({}), p.ws, { mode: 'writable' });
    assert.deepEqual([r.ok, r.skipped], [true, true]);
  } finally { p.cleanup(); }
});

test('readonly：第二次命中缓存（依赖文件与缓存是同一个 inode），跳过 install；codegen 照跑', async () => {
  const p = setup(PKG);
  try {
    const log = path.join(p.base, 'cmd.log');
    const config = configWith({ install: `echo install >> ${log} && mkdir -p node_modules/dep && echo v1 > node_modules/dep/index.js`, codegen: `echo codegen >> ${log}` });
    const r1 = await prepareWorkspace(p.root, config, p.ws, { mode: 'readonly' });
    assert.deepEqual([r1.ok, r1.cached], [true, undefined]);
    const ws2 = p.fresh();
    const r2 = await prepareWorkspace(p.root, config, ws2, { mode: 'readonly' });
    assert.deepEqual([r2.ok, r2.cached], [true, true]);
    assert.equal(readFileSync(log, 'utf8'), 'install\ncodegen\ncodegen\n');
    const entries = readdirSync(acctestCacheRoot(p.root)).filter((n) => !n.includes('.tmp-'));
    assert.equal(entries.length, 1);
    const cachedFile = path.join(acctestCacheRoot(p.root), entries[0]!, 'node_modules/dep/index.js');
    assert.equal(statSync(path.join(ws2, 'node_modules/dep/index.js')).ino, statSync(cachedFile).ino, '硬链接');
    assert.equal(statSync(path.join(p.ws, 'node_modules/dep/index.js')).ino, statSync(cachedFile).ino);
  } finally { p.cleanup(); }
});

test('readonly：install 命令变了缓存未命中；锁文件变了也未命中', async () => {
  const p = setup(PKG);
  try {
    const log = path.join(p.base, 'cmd.log');
    const mk = (tag: string) => configWith({ install: `echo ${tag} >> ${log} && mkdir -p node_modules && echo x > node_modules/f` });
    await prepareWorkspace(p.root, mk('a'), p.ws, { mode: 'readonly' });
    const r2 = await prepareWorkspace(p.root, mk('b'), p.fresh(), { mode: 'readonly' });
    assert.equal(r2.cached, undefined);
    assert.equal(readFileSync(log, 'utf8'), 'a\nb\n', '命令变了重新 install');
    const r3 = await prepareWorkspace(p.root, mk('a'), p.fresh(), { mode: 'readonly' });
    assert.equal(r3.cached, true, '原命令仍命中');
    assert.notEqual(cacheKey('h1', 'a'), cacheKey('h1', 'b'));
    assert.notEqual(cacheKey('h1', 'a'), cacheKey('h2', 'a'));
    assert.equal(cacheKey(null, 'a'), null);
  } finally { p.cleanup(); }
});

test('没有锁文件（只有清单）：readonly 每次都 install，不写缓存', async () => {
  const p = setup({ 'package.json': '{}\n', '.gitignore': 'node_modules/\n' });
  try {
    const config = configWith({ install: 'mkdir -p node_modules && echo x > node_modules/f' });
    const r1 = await prepareWorkspace(p.root, config, p.ws, { mode: 'readonly' });
    const r2 = await prepareWorkspace(p.root, config, p.fresh(), { mode: 'readonly' });
    assert.deepEqual([r1.ok, r1.cached, r2.ok, r2.cached], [true, undefined, true, undefined]);
    assert.ok(!existsSync(acctestCacheRoot(p.root)));
  } finally { p.cleanup(); }
});

test('writable：每次都运行 install，不产生缓存，也不用缓存', async () => {
  const p = setup(PKG);
  try {
    const log = path.join(p.base, 'cmd.log');
    const config = configWith({ install: `echo install >> ${log} && mkdir -p node_modules && echo x > node_modules/f` });
    // 先用 readonly 造出缓存，writable 也不能用它
    await prepareWorkspace(p.root, config, p.ws, { mode: 'readonly' });
    const cacheBefore = readdirSync(acctestCacheRoot(p.root));
    const w1 = p.fresh();
    const r1 = await prepareWorkspace(p.root, config, w1, { mode: 'writable' });
    const r2 = await prepareWorkspace(p.root, config, p.fresh(), { mode: 'writable' });
    assert.deepEqual([r1.ok, r1.cached, r2.ok, r2.cached], [true, undefined, true, undefined]);
    assert.equal(readFileSync(log, 'utf8'), 'install\ninstall\ninstall\n');
    assert.deepEqual(readdirSync(acctestCacheRoot(p.root)), cacheBefore, '没有新增缓存');
    assert.equal(statSync(path.join(w1, 'node_modules/f')).nlink, 1, '不是硬链接');
  } finally { p.cleanup(); }
});

test('codegen 在 install 之后运行；失败各自返回 ok:false 与原因，不抛异常', async () => {
  const p = setup(PKG);
  try {
    const ok = configWith({ install: 'echo i > order.txt', codegen: 'echo c >> order.txt' });
    const r = await prepareWorkspace(p.root, ok, p.ws, { mode: 'writable' });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(path.join(p.ws, 'order.txt'), 'utf8'), 'i\nc\n');
    assert.deepEqual(r.log.map((l) => l.step), ['install', 'codegen']);

    const badInstall = await prepareWorkspace(p.root, configWith({ install: 'echo 网络不通 >&2; exit 7', codegen: 'echo c > ran.txt' }), p.fresh(), { mode: 'readonly' });
    assert.equal(badInstall.ok, false);
    assert.match(badInstall.reason ?? '', /install 失败（退出码 7）[\s\S]*网络不通/);

    const w = p.fresh();
    const badCodegen = await prepareWorkspace(p.root, configWith({ install: 'true', codegen: 'echo 生成失败 >&2; exit 3' }), w, { mode: 'writable' });
    assert.equal(badCodegen.ok, false);
    assert.match(badCodegen.reason ?? '', /codegen 失败（退出码 3）[\s\S]*生成失败/);
  } finally { p.cleanup(); }
});

test('workspaceStats：汇总 workspace_prepare 事件（次数、总耗时、缓存命中），只数本流程', () => {
  const ev = (flow: string, data: Record<string, unknown> | undefined, type = 'note') => ({ flow, type, data } as never);
  const s = workspaceStats([
    ev('B-001', { kind: 'workspace_prepare', mode: 'readonly', cached: true, skipped: false, ok: true, ms: 120 }),
    ev('B-001', { kind: 'workspace_prepare', mode: 'writable', cached: false, skipped: false, ok: true, ms: 800 }),
    ev('B-001', { kind: 'workspace_prepare', mode: 'readonly', cached: false, skipped: true, ok: true, ms: 3 }),
    ev('B-001', { kind: 'workspace_prepare', mode: 'readonly', cached: false, skipped: false, ok: false, ms: 50 }),
    ev('B-001', { kind: 'other' }),
    ev('B-002', { kind: 'workspace_prepare', ms: 999, cached: true }),
  ], 'B-001');
  assert.deepEqual(s, { count: 4, total_ms: 973, cache_hits: 1, skipped: 1, failed: 1 });
});
