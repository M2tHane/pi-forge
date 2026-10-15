// 共享构建环境的引擎级验证：阶段开始时建立共享环境（install 一次），之后任务的 worktree 链接依赖目录而不再 install；
// 追加依赖（forge_add_dependency）装进共享环境；改版本（forge_private_deps）得到私有副本；每次运行有各自的数据库。
// 命令都是写日志的假命令；不使用真实模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject, DIRECT_YAML } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';
import { readSharedEnv, sharedEnvDir } from '../../src/core/workspace/shared-env.ts';

const PKG = (deps: Record<string, string>) => JSON.stringify({ name: 'app', dependencies: deps }, null, 2) + '\n';
const BASE_DEPS = { a: '1.0.0', m: '1.0.0', z: '1.0.0' };

function fixture() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-forge-se-e2e-'));
  const log = path.join(tmp, 'cmd.log');
  const addScript = path.join(tmp, 'add.mjs');
  writeFileSync(addScript, `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const dep = process.env.FORGE_DEP; const i = dep.lastIndexOf('@'); const name = dep.slice(0, i); const v = dep.slice(i + 1);
const j = JSON.parse(readFileSync('package.json', 'utf8')); j.dependencies[name] = v;
j.dependencies = Object.fromEntries(Object.entries(j.dependencies).sort(([x], [y]) => x.localeCompare(y)));
writeFileSync('package.json', JSON.stringify(j, null, 2) + '\\n');
writeFileSync('pnpm-lock.yaml', readFileSync('pnpm-lock.yaml', 'utf8') + 'add ' + dep + '\\n');
mkdirSync('node_modules', { recursive: true }); writeFileSync('node_modules/' + name + '.txt', v);
appendFileSync(${JSON.stringify(log)}, 'add ' + dep + '\\n');
`);
  const yaml = DIRECT_YAML
    .replace('install:   "true"', `install:   "mkdir -p node_modules && touch node_modules/.ok && echo install >> ${log}"`)
    .replace(/  test:      "[^\n]*"/, '  test:      "true"')
    .replace('\nlimits:', `\n  env_up:    "echo env_up >> ${log}"\n  add_dep:   "node ${addScript}"\n  db_create: "echo create $FORGE_DB_NAME >> ${log}"\n  db_drop:   "echo drop $FORGE_DB_NAME >> ${log}"\nlimits:`);
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { yaml, lines };
}
const FILES = { 'package.json': PKG(BASE_DEPS), 'pnpm-lock.yaml': 'lock: 1\n', '.gitignore': 'node_modules/\n' };

test('阶段开始建立共享环境；任务 worktree 链接依赖（不再 install）；追加依赖装进共享环境；改版本得到私有副本；每次运行各有数据库', async () => {
  const f = fixture();
  const p = await setupProject({ yaml: f.yaml, files: FILES, tasks: ['T-001', 'T-002', 'T-003'].map((id) => mkTask(id, { verify: ['test'] })) });
  const seen: Record<string, string> = {};
  const e = engineEnv(p, async (_role, _n, a) => {
    const id = a.env.task;
    await a.call('forge_claim');
    seen[`${id}:link`] = (await a.call('bash', { command: 'test -L node_modules && echo LINK || echo REAL' })).text.trim();
    if (id === 'T-001') {
      // guard：依赖目录是共享链接时用包管理器改依赖，放行但提醒用 forge_add_dependency（--help 不会真的装）
      const r = await a.call('bash', { command: 'pnpm add --help > /dev/null 2>&1 || true' });
      assert.match(r.text, /forge_add_dependency/);
    }
    if (id === 'T-002') {
      const r = await a.call('forge_add_dependency', { name: 'extra', version: '1.0.0' });
      assert.ok(r.ok, r.text);
      assert.match(r.text, /已装进共享环境：extra@1\.0\.0/);
      seen['T-002:pkg'] = readFileSync(path.join(a.spec.cwd, 'package.json'), 'utf8');
    }
    if (id === 'T-003') {
      const file = path.join(a.spec.cwd, 'package.json');
      writeFileSync(file, PKG({ ...BASE_DEPS, z: '2.0.0' }));
      const r = await a.call('forge_private_deps', {});
      assert.ok(r.ok, r.text);
      seen['T-003:after'] = (await a.call('bash', { command: 'test -L node_modules && echo LINK || echo REAL' })).text.trim();
    }
    await writeFiles(a, { [`src/server/${id.toLowerCase()}/a.ts`]: id });
    await a.call('forge_note', { text: '完成' });
    assert.ok((await a.call('forge_submit', { summary: id })).ok);
  });
  try {
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    for (const id of ['T-001', 'T-002', 'T-003']) assert.equal(p.store.readTask(p.flowId, id).status, 'done', id);

    assert.equal(seen['T-001:link'], 'LINK');
    assert.equal(seen['T-002:link'], 'LINK');
    assert.equal(seen['T-003:link'], 'LINK', '改版本之前依赖目录也是链接');
    assert.equal(seen['T-003:after'], 'REAL', 'forge_private_deps 之后是私有副本');
    assert.match(seen['T-002:pkg']!, /"extra": "1\.0\.0"/, '依赖清单的改动同步回任务 worktree，随任务提交');

    const lines = f.lines();
    // install：共享环境一次 + T-003 的私有副本一次 + 阶段门禁（集成分支上 z 已是 2.0.0，与共享环境不同，走私有副本）一次；T-001、T-002 只链接
    assert.equal(lines.filter((l) => l === 'install').length, 3, lines.join(' | '));
    assert.equal(lines.filter((l) => l === 'env_up').length, 1);
    assert.deepEqual(lines.filter((l) => l.startsWith('add ')), ['add extra@1.0.0']);
    const meta = readSharedEnv(p.dir)!;
    assert.equal(meta.snapshot['npm:.:extra'], '1.0.0');
    assert.equal(meta.snapshot['npm:.:z'], '1.0.0', '共享环境里 z 的版本没被改');
    assert.ok(existsSync(path.join(sharedEnvDir(p.dir), 'node_modules', 'extra.txt')));

    // 每个 run 独立数据库：建库与删库一一对应、名字互不相同
    const creates = lines.filter((l) => l.startsWith('create ')).map((l) => l.slice(7));
    const drops = lines.filter((l) => l.startsWith('drop ')).map((l) => l.slice(5));
    assert.ok(creates.length >= 3, creates.join());
    assert.equal(new Set(creates).size, creates.length, '数据库名互不相同');
    assert.deepEqual([...drops].sort(), [...creates].sort(), '每个库都被删除');

    // 观测：事件里记了建立共享环境，工作区准备记了 shared 模式
    const notes = p.store.readEvents().filter((x) => x.type === 'note');
    assert.ok(notes.some((x) => x.data?.['kind'] === 'shared_env' && x.data['status'] === 'built'));
    const modes = notes.filter((x) => x.data?.['kind'] === 'workspace_prepare').map((x) => x.data!['shared']);
    assert.ok(modes.includes('linked'), JSON.stringify(modes));
    // 任务 worktree 的 git 状态不含符号链接
    const wt = p.store.readTask(p.flowId, 'T-001').worktree;
    if (wt && existsSync(wt)) assert.ok(!lstatSync(path.join(wt, 'node_modules')).isDirectory());
  } finally { p.cleanup(); }
});

test('第一个 S 阶段之前没有共享环境（S0 期间）：沿用原来的做法，worktree 自己 install', async () => {
  const f = fixture();
  // 阶段 S0：不建共享环境
  const p = await setupProject({ yaml: f.yaml, files: FILES, stages: ['S0'], tasks: [mkTask('T-001', { stage: 'S0', verify: ['test'] })] });
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    assert.match((await a.call('bash', { command: 'test -L node_modules && echo LINK || echo REAL' })).text, /REAL/);
    return submitWork(a, '骨架', { 'src/server/t-001/a.ts': 'ok\n' });
  });
  try {
    await drive(e, p.flowId, 10);
    assert.deepEqual(e.errors, []);
    assert.equal(readSharedEnv(p.dir), null);
    assert.equal(f.lines().filter((l) => l === 'install').length, 2, 'worker 的 worktree 一次、阶段门禁的 worktree 一次，没有共享环境');
  } finally { p.cleanup(); }
});
