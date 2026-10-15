// 共享构建环境：依赖清单的追加/改动判断（纯函数）、建立与对齐、worktree 链接/追加/私有副本、
// forge_add_dependency 的同步、每次运行独立的数据库。命令都是计数用的假命令，不依赖真实包管理器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../../src/core/state/config.ts';
import { addableToShared, classifyDeps, defaultAddCommand, depNameOfKey, depSnapshot, depSpecProblem } from '../../src/core/workspace/dep-files.ts';
import {
  addDependencyForWorktree, decideSharedDeps, linkedDeps, readSharedEnv, sharedDepsDirs, sharedEnvDir, syncSharedEnv, withSharedEnv,
} from '../../src/core/workspace/shared-env.ts';
import { prepareWorkspace } from '../../src/core/workspace/workspace.ts';
import { worktreesRoot } from '../../src/core/workspace/worktree.ts';
import { changesDeps } from '../../src/core/security/guard.ts';
import { TEST_YAML } from '../helpers/config.ts';

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => ({ path: 'package.json', content: JSON.stringify({ name: 'app', dependencies: deps, ...extra }) });

test('depSnapshot / classifyDeps：相同、纯追加、版本变化、overrides 变化、其他生态', () => {
  const base = depSnapshot([pkg({ a: '1.0.0', b: '^2.0.0' }), { path: 'pnpm-lock.yaml', content: 'x' }]);
  assert.deepEqual(Object.keys(base).sort(), ['npm:.:a', 'npm:.:b']);
  assert.equal(classifyDeps(base, depSnapshot([pkg({ a: '1.0.0', b: '^2.0.0' })])).kind, 'same');
  // 任务分支比共享环境旧（少了别的任务追加的依赖）：不算改动
  assert.equal(classifyDeps(base, depSnapshot([pkg({ a: '1.0.0' })])).kind, 'same');
  const add = classifyDeps(base, depSnapshot([pkg({ a: '1.0.0', b: '^2.0.0', c: '3.0.0' })]));
  assert.equal(add.kind, 'additive');
  assert.deepEqual(add.added, ['npm:.:c']);
  assert.equal(addableToShared(add.added), true);
  assert.equal(depNameOfKey('npm:.:@scope/pkg'), '@scope/pkg');
  const up = classifyDeps(base, depSnapshot([pkg({ a: '1.1.0', b: '^2.0.0' })]));
  assert.equal(up.kind, 'changed');
  assert.deepEqual(up.changed, ['npm:.:a']);
  assert.equal(classifyDeps(base, depSnapshot([pkg({ a: '1.0.0', b: '^2.0.0' }, { overrides: { a: '1.0.1' } })])).kind, 'changed');
  // 子包的追加、其他生态的清单：保守，不自动装进共享环境
  const sub = classifyDeps(base, depSnapshot([pkg({ a: '1.0.0', b: '^2.0.0' }), { path: 'web/package.json', content: '{"dependencies":{"z":"1"}}' }]));
  assert.equal(sub.kind, 'additive');
  assert.equal(addableToShared(sub.added), false);
  assert.equal(decideSharedDeps(base, depSnapshot([pkg({ a: '1.0.0', b: '^2.0.0' }), { path: 'web/package.json', content: '{"dependencies":{"z":"1"}}' }])).action, 'private');
  const cargo = depSnapshot([{ path: 'Cargo.toml', content: '[dependencies]\nx = "1"\n' }]);
  assert.equal(classifyDeps(cargo, depSnapshot([{ path: 'Cargo.toml', content: '[dependencies]\nx = "1"\ny = "2"\n' }])).kind, 'changed');
  assert.equal(classifyDeps(cargo, cargo).kind, 'same');
  // requirements.txt 逐项比较（保守地走私有副本，因为程序不自动装 Python 依赖）
  const py = depSnapshot([{ path: 'requirements.txt', content: 'Flask==2.0\n# c\nrequests>=2\n' }]);
  assert.deepEqual(Object.keys(py).sort(), ['py:requirements.txt:flask', 'py:requirements.txt:requests']);
  const pyAdd = classifyDeps(py, depSnapshot([{ path: 'requirements.txt', content: 'Flask==2.0\nrequests>=2\nnumpy\n' }]));
  assert.equal(pyAdd.kind, 'additive');
  assert.equal(addableToShared(pyAdd.added), false);
  assert.equal(decideSharedDeps(base, depSnapshot([pkg({ a: '1.2.0', b: '^2.0.0' })])).action, 'private');
  assert.equal(decideSharedDeps(base, depSnapshot([pkg({ a: '1.0.0', b: '^2.0.0', c: '1' })])).action, 'install-shared');
});

test('defaultAddCommand 按锁文件推断；depSpecProblem 拒绝带 shell 字符的名字与版本；changesDeps 认出改依赖的命令', () => {
  assert.equal(defaultAddCommand(['pnpm-lock.yaml', 'package.json'], false), 'pnpm add "$FORGE_DEP"');
  assert.equal(defaultAddCommand(['yarn.lock'], true), 'yarn add -D "$FORGE_DEP"');
  assert.equal(defaultAddCommand(['package-lock.json'], false), 'npm install "$FORGE_DEP"');
  assert.equal(defaultAddCommand(['bun.lock'], true), 'bun add -d "$FORGE_DEP"');
  assert.equal(defaultAddCommand(['README.md'], false), null);
  assert.equal(depSpecProblem('left-pad', '^1.3.0'), null);
  assert.equal(depSpecProblem('@scope/pkg'), null);
  assert.match(depSpecProblem('a; rm -rf /') ?? '', /格式不对/);
  assert.match(depSpecProblem('ok', '1.0 && x') ?? '', /格式不对/);
  assert.equal(changesDeps(['pnpm', 'add', 'x']), true);
  assert.equal(changesDeps(['npm', '--silent', 'install']), true);
  assert.equal(changesDeps(['pip', 'install', '-r', 'r.txt']), true);
  assert.equal(changesDeps(['pnpm', 'test']), false);
  assert.equal(changesDeps(['npm', 'run', 'build']), false);
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

/** 项目 app/（main 分支，有 package.json、锁文件）；命令全是写日志的假命令 */
function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-forge-se-'));
  const root = path.join(base, 'app');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { a: '1.0.0' } }, null, 2) + '\n');
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock: 1\n');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const log = path.join(base, 'cmd.log');
  // 假的"包管理器"：追加依赖时改共享环境的 package.json；用 .adding 标记检查两次安装有没有重叠
  writeFileSync(path.join(base, 'add.mjs'), `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const dep = process.env.FORGE_DEP; const i = dep.lastIndexOf('@'); const name = i > 0 ? dep.slice(0, i) : dep; const v = i > 0 ? dep.slice(i + 1) : '9.9.9';
if (existsSync('.adding')) appendFileSync(${JSON.stringify(log)}, 'OVERLAP\\n');
writeFileSync('.adding', '');
await new Promise((r) => setTimeout(r, 150));
const j = JSON.parse(readFileSync('package.json', 'utf8')); (j.dependencies ??= {})[name] = v; writeFileSync('package.json', JSON.stringify(j, null, 2) + '\\n');
writeFileSync('pnpm-lock.yaml', readFileSync('pnpm-lock.yaml', 'utf8') + 'add ' + dep + '\\n');
mkdirSync('node_modules', { recursive: true }); writeFileSync('node_modules/' + name.replace('/', '_') + '.txt', v);
appendFileSync(${JSON.stringify(log)}, 'add ' + dep + '\\n'); rmSync('.adding');
`);
  const config = parseConfig(TEST_YAML);
  Object.assign(config.raw.commands!, {
    install: `mkdir -p node_modules && echo installed > node_modules/base.txt && echo install >> ${log}`,
    env_up: `echo env_up >> ${log}`,
    add_dep: `node ${path.join(base, 'add.mjs')}`,
    db_create: `echo create $FORGE_DB_NAME >> ${log}`,
    db_drop: `echo drop $FORGE_DB_NAME >> ${log}`,
  });
  delete config.raw.commands!['codegen'];
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  const wt = (name: string) => { const d = path.join(worktreesRoot(root), name); git(root, 'worktree', 'add', '-q', '--detach', d, 'main'); return d; };
  return { base, root, config, lines, wt, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('建立共享环境：install 与 env_up 各一次；同一阶段再对齐不重复；链接后 worktree 干净、不再 install', async () => {
  const p = setup();
  try {
    assert.equal(readSharedEnv(p.root), null);
    const r = await syncSharedEnv(p.root, p.config, 'main', 'F:S1');
    assert.equal(r.status, 'built', r.reason);
    assert.deepEqual(p.lines(), ['install', 'env_up']);
    const meta = readSharedEnv(p.root)!;
    assert.deepEqual(meta.deps, ['node_modules']);
    assert.equal(meta.env_up, 'ok');
    assert.ok(existsSync(path.join(sharedEnvDir(p.root), 'node_modules', 'base.txt')));
    assert.ok(existsSync(path.join(sharedEnvDir(p.root), 'package.json')), '导出了集成分支的文件树');

    assert.equal((await syncSharedEnv(p.root, p.config, 'main', 'F:S2')).status, 'unchanged');
    assert.deepEqual(p.lines(), ['install', 'env_up'], '依赖清单没变，不重复 install');

    const w = p.wt('F-T-001');
    const prep = await prepareWorkspace(p.root, p.config, w, { mode: 'writable' });
    assert.equal(prep.ok, true);
    assert.equal(prep.shared, 'linked');
    assert.ok(lstatSync(path.join(w, 'node_modules')).isSymbolicLink());
    assert.deepEqual(linkedDeps(p.root, p.config, w), ['node_modules']);
    assert.ok(existsSync(path.join(w, 'node_modules', 'base.txt')));
    assert.deepEqual(p.lines(), ['install', 'env_up'], '链接，没有再 install');
    assert.equal(git(w, 'status', '--porcelain'), '', '符号链接被本地 exclude 忽略，不进任务快照');
    // 删除 worktree 不会动共享环境
    git(p.root, 'worktree', 'remove', '--force', w);
    assert.ok(existsSync(path.join(sharedEnvDir(p.root), 'node_modules', 'base.txt')));
  } finally { p.cleanup(); }
});

test('没有共享环境（S0 之前）：照旧在 worktree 里 install；shared_env.enabled=false 也一样', async () => {
  const p = setup();
  try {
    const w = p.wt('F-T-001');
    const r = await prepareWorkspace(p.root, p.config, w, { mode: 'writable' });
    assert.equal(r.shared, undefined);
    assert.deepEqual(p.lines(), ['install']);
    assert.ok(!lstatSync(path.join(w, 'node_modules')).isSymbolicLink());
    p.config.raw.shared_env = { enabled: false };
    assert.equal((await syncSharedEnv(p.root, p.config, 'main', 'F:S1')).status, 'skipped');
  } finally { p.cleanup(); }
});

test('worktree 追加依赖 → 在锁内装进共享环境再链接（并发追加不重叠）；改版本 → 私有副本，共享环境不变', async () => {
  const p = setup();
  try {
    await syncSharedEnv(p.root, p.config, 'main', 'F:S1');
    const editPkg = (w: string, f: (j: { dependencies: Record<string, string> }) => void) => {
      const file = path.join(w, 'package.json');
      const j = JSON.parse(readFileSync(file, 'utf8')) as { dependencies: Record<string, string> };
      f(j);
      writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
    };
    const w1 = p.wt('F-T-001'); editPkg(w1, (j) => { j.dependencies['b'] = '2.0.0'; });
    const w2 = p.wt('F-T-002'); editPkg(w2, (j) => { j.dependencies['c'] = '3.0.0'; });
    const [r1, r2] = await Promise.all([prepareWorkspace(p.root, p.config, w1, { mode: 'writable' }), prepareWorkspace(p.root, p.config, w2, { mode: 'writable' })]);
    assert.equal(r1.shared, 'added', r1.reason);
    assert.equal(r2.shared, 'added', r2.reason);
    assert.deepEqual(p.lines().filter((l) => l !== 'install' && l !== 'env_up').sort(), ['add b@2.0.0', 'add c@3.0.0'], '没有 OVERLAP');
    const meta = readSharedEnv(p.root)!;
    assert.equal(meta.snapshot['npm:.:b'], '2.0.0');
    assert.equal(meta.snapshot['npm:.:c'], '3.0.0');
    assert.ok(existsSync(path.join(w1, 'node_modules', 'c.txt')), '共享依赖目录里也有别的任务追加的包');

    const w3 = p.wt('F-T-003'); editPkg(w3, (j) => { j.dependencies['a'] = '1.5.0'; });
    const r3 = await prepareWorkspace(p.root, p.config, w3, { mode: 'writable' });
    assert.equal(r3.shared, 'private');
    assert.ok(r3.log.some((l) => /私有依赖副本/.test(l.detail ?? '')));
    assert.ok(!lstatSync(path.join(w3, 'node_modules')).isSymbolicLink(), '私有副本是真实目录');
    assert.equal(p.lines().filter((l) => l === 'install').length, 2, '建立共享环境一次 + 私有副本一次');
    assert.equal(readSharedEnv(p.root)!.snapshot['npm:.:a'], '1.0.0', '共享环境里 a 的版本没被改');
  } finally { p.cleanup(); }
});

test('forge_add_dependency 的实现：装进共享环境，并把 package.json 与锁文件同步回 worktree；私有副本的任务被拒绝；非法名字被拒绝', async () => {
  const p = setup();
  try {
    await syncSharedEnv(p.root, p.config, 'main', 'F:S1');
    const w = p.wt('F-T-001');
    await prepareWorkspace(p.root, p.config, w, { mode: 'writable' });
    const text = await addDependencyForWorktree(p.root, p.config, w, { name: 'left-pad', version: '1.3.0' }, 'T-001');
    assert.match(text, /已装进共享环境：left-pad@1\.3\.0/);
    const j = JSON.parse(readFileSync(path.join(w, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    assert.equal(j.dependencies['left-pad'], '1.3.0');
    assert.match(readFileSync(path.join(w, 'pnpm-lock.yaml'), 'utf8'), /add left-pad@1\.3\.0/);
    assert.ok(existsSync(path.join(w, 'node_modules', 'left-pad.txt')));
    assert.match(git(w, 'status', '--porcelain'), /package\.json/);
    // 再装一次：共享环境里已经有了
    assert.match(await addDependencyForWorktree(p.root, p.config, w, { name: 'left-pad', version: '1.3.0' }, 'T-001'), /已经有了/);
    await assert.rejects(addDependencyForWorktree(p.root, p.config, w, { name: 'x; rm -rf /' }, 'T-001'), /格式不对/);
    // 私有副本的 worktree
    const w2 = p.wt('F-T-002');
    await prepareWorkspace(p.root, p.config, w2, { mode: 'writable', forcePrivate: true });
    assert.deepEqual(linkedDeps(p.root, p.config, w2), []);
    await assert.rejects(addDependencyForWorktree(p.root, p.config, w2, { name: 'y' }, 'T-002'), /私有依赖副本/);
  } finally { p.cleanup(); }
});

test('阶段开始时对齐：集成分支合入了依赖改动 → 刷新（再 install 一次），env_up 不重复', async () => {
  const p = setup();
  try {
    await syncSharedEnv(p.root, p.config, 'main', 'F:S1');
    writeFileSync(path.join(p.root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { a: '2.0.0' } }, null, 2) + '\n');
    git(p.root, 'commit', '-q', '-am', 'upgrade a');
    const r = await syncSharedEnv(p.root, p.config, 'main', 'F:S2');
    assert.equal(r.status, 'refreshed', r.reason);
    assert.deepEqual(p.lines(), ['install', 'env_up', 'install']);
    assert.equal(readSharedEnv(p.root)!.snapshot['npm:.:a'], '2.0.0');
    assert.equal(readSharedEnv(p.root)!.synced, 'F:S2');
  } finally { p.cleanup(); }
});

test('withSharedEnv：并行的两次运行各有独立端口段和独立数据库，结束后各自删库', async () => {
  const p = setup();
  try {
    await syncSharedEnv(p.root, p.config, 'main', 'F:S1');
    const seen: Record<string, string>[] = [];
    await Promise.all(['rv-F-T-001', 'rv-F-T-002'].map((label) => withSharedEnv(p.root, p.config, label, async (env) => {
      seen.push(env);
      await new Promise((r) => setTimeout(r, 100));
    })));
    assert.equal(new Set(seen.map((e) => e['FORGE_DB_NAME'])).size, 2);
    assert.equal(new Set(seen.map((e) => e['FORGE_PORT_BASE'])).size, 2);
    assert.ok(seen.every((e) => e['FORGE_SHARED_ENV'] === sharedEnvDir(p.root)));
    const creates = p.lines().filter((l) => l.startsWith('create ')).map((l) => l.slice(7)).sort();
    const drops = p.lines().filter((l) => l.startsWith('drop ')).map((l) => l.slice(5)).sort();
    assert.deepEqual(creates, ['forge_rv_f_t_001', 'forge_rv_f_t_002']);
    assert.deepEqual(drops, creates);
    // 没有配置 db_create：静默跳过
    delete p.config.raw.commands!['db_create'];
    delete p.config.raw.commands!['db_drop'];
    await withSharedEnv(p.root, p.config, 'rv-none', async (env) => { assert.ok(env['FORGE_DB_NAME']); });
    assert.equal(p.lines().filter((l) => l.startsWith('create ')).length, 2);
  } finally { p.cleanup(); }
});

test('sharedDepsDirs：shared_env.deps，默认 node_modules；拒绝绝对路径与 ..', () => {
  const c = parseConfig(TEST_YAML);
  delete c.raw.shared_env;
  assert.deepEqual(sharedDepsDirs(c), ['node_modules']);
  c.raw.shared_env = { deps: ['node_modules', '/etc', '../x', 'web/node_modules'] };
  assert.deepEqual(sharedDepsDirs(c), ['node_modules', 'web/node_modules']);
});
