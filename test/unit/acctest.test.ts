// 第 9.2 节：test-author 的隔离工作区（导出、install 与缓存、codegen、提交检查、acc 分支）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  accBranch, applyToAccBranch, checkAcctestSubmit, exportLayers, exportPatterns, filesAt, lockHash, prepareAcctestWorkspace, revertOutside, scanAcCoverage, testFilesIn,
} from '../../src/core/acctest.ts';
import { parseConfig } from '../../src/core/config.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { mkTask } from '../helpers/tasks.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();

function repo() {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-forge-at-'));
  const root = path.join(base, 'app');
  mkdirSync(root);
  const write = (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    }
  };
  git(root, 'init', '-q', '-b', 'main');
  write({
    'docs/spec/requirements.md': '# 需求\n', 'docs/contracts/openapi.yaml': 'openapi: 3.1.0\n', 'docs/arch/overview.md': '# 架构\n', 'docs/arch/secret-design.md': '内部\n',
    'AGENTS.md': '# 说明\n', 'tests/acceptance/_support/env.ts': 'export const port = process.env.PORT;\n', 'package.json': '{"name":"app"}\n', 'pnpm-lock.yaml': 'lock: 1\n',
    'packages/api/package.json': '{"name":"api"}\n', 'vitest.config.ts': 'export default {};\n',
    'src/server/team.ts': 'export const secret = 42;\n', '.env': 'KEY=1\n', 'tests/unit/a.test.ts': 'x\n',
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'branch', 'flow/B-001/integration');
  return { base, root, write, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function configWith(commands: Record<string, string>) {
  const c = parseConfig(TEST_YAML);
  Object.assign(c.raw.commands, commands);
  for (const k of Object.keys(c.raw.commands)) if (!(k in commands) && ['install', 'codegen', 'acceptance_list'].includes(k)) delete c.raw.commands[k];
  return c;
}

test('lockHash：只看锁文件（任意层级、排除 node_modules），与顺序无关；没有锁文件为 null', () => {
  const a = lockHash([{ path: 'pnpm-lock.yaml', content: 'v1' }, { path: 'package.json', content: 'x' }]);
  assert.ok(a);
  assert.equal(lockHash([{ path: 'package.json', content: 'y' }, { path: 'pnpm-lock.yaml', content: 'v1' }]), a, '清单变化不影响缓存键');
  assert.notEqual(lockHash([{ path: 'pnpm-lock.yaml', content: 'v2' }]), a);
  assert.notEqual(lockHash([{ path: 'pnpm-lock.yaml', content: 'v1' }, { path: 'web/yarn.lock', content: 'z' }]), a);
  assert.equal(lockHash([{ path: 'node_modules/x/yarn.lock', content: 'z' }, { path: 'package.json', content: 'x' }]), null);
});

test('scanAcCoverage 与 checkAcctestSubmit：只认 [REQ-xxx.ACn]；越界、缺 AC、未知编号分别列出', () => {
  const cov = scanAcCoverage([
    { path: 'tests/acceptance/T-003/a.test.ts', content: "test('[REQ-001.AC1] 创建成功', ...)\ntest('[REQ-001.AC1] 名称去空格', ...)\ntest('REQ-001.AC2 没有方括号')" },
    { path: 'tests/acceptance/_support/T-003/h.ts', content: '// [REQ-009.AC1]' },
  ]);
  assert.deepEqual([...cov.keys()].sort(), ['REQ-001.AC1', 'REQ-009.AC1']);
  const r = checkAcctestSubmit(['tests/acceptance/T-003/a.test.ts', 'tests/acceptance/_support/T-003/h.ts', 'tests/acceptance/_support/env.ts', 'tests/acceptance/T-002/x.ts', 'package.json'],
    'T-003', ['REQ-001.AC1', 'REQ-001.AC2'], cov);
  assert.deepEqual(r.outside, ['tests/acceptance/_support/env.ts', 'tests/acceptance/T-002/x.ts', 'package.json']);
  assert.deepEqual(r.missing, ['REQ-001.AC2']);
  assert.deepEqual(r.unknown, ['REQ-009.AC1']);
});

test('导出基准：首个 .at 只有允许的路径（无实现代码、无敏感文件、include 生效）；.at-n 叠加 acc 分支测试与任务分支追加的契约；impl 已 done 只用集成分支', () => {
  const p = repo();
  try {
    const config = configWith({});
    const files = filesAt(p.root, 'flow/B-001/integration', ['docs/spec/**', 'docs/contracts/**', 'docs/arch/overview.md', 'AGENTS.md', 'tests/acceptance/**', 'package.json', 'pnpm-lock.yaml', 'packages/*/package.json', 'vitest.config.*', '.env']);
    assert.ok(!files.includes('.env'), '敏感文件不导出');
    const first = exportLayers(p.root, config, 'B-001', 'flow/B-001/integration', { id: 'T-003.at', for_task: 'T-003' }, false);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]!.files.sort(), ['AGENTS.md', 'docs/arch/overview.md', 'docs/contracts/openapi.yaml', 'docs/spec/requirements.md', 'package.json', 'packages/api/package.json', 'pnpm-lock.yaml', 'tests/acceptance/_support/env.ts', 'vitest.config.ts']);
    // acc 分支上已有本 task 的测试，任务分支追加了契约
    git(p.root, 'checkout', '-q', '-b', accBranch('B-001', 'T-003'));
    p.write({ 'tests/acceptance/T-003/a.test.ts': "test('[REQ-001.AC1] x')\n", 'tests/acceptance/T-002/other.ts': 'x\n' });
    git(p.root, 'add', '-A'); git(p.root, 'commit', '-q', '-m', 'acc');
    git(p.root, 'checkout', '-q', '-b', 'flow/B-001/T-003', 'flow/B-001/integration');
    p.write({ 'docs/contracts/paths/datasource.yaml': '/api/x: {}\n', 'src/server/ds.ts': 'impl\n' });
    git(p.root, 'add', '-A'); git(p.root, 'commit', '-q', '-m', 'impl');
    git(p.root, 'checkout', '-q', 'main');
    const n = exportLayers(p.root, config, 'B-001', 'flow/B-001/integration', { id: 'T-003.at-2', for_task: 'T-003' }, false);
    assert.deepEqual(n.map((l) => [l.ref, l.files]), [
      ['flow/B-001/integration', first[0]!.files],
      [accBranch('B-001', 'T-003'), ['tests/acceptance/T-003/a.test.ts']],
      ['flow/B-001/T-003', ['docs/contracts/paths/datasource.yaml']],
    ]);
    assert.equal(exportLayers(p.root, config, 'B-001', 'flow/B-001/integration', { id: 'T-003.at-2', for_task: 'T-003' }, true).length, 1);
  } finally { p.cleanup(); }
});

test('隔离工作区：独立仓库读不到实现提交；install 后 codegen；锁文件不变时第二次命中缓存（硬链接）跳过 install；依赖目录不进基线', async () => {
  const p = repo();
  try {
    const log = path.join(p.base, 'setup.log');
    const config = configWith({
      install: `echo install >> ${log} && mkdir -p node_modules/dep && echo v1 > node_modules/dep/index.js`,
      codegen: `echo codegen >> ${log} && mkdir -p gen && echo client > gen/client.ts`,
    });
    const implSha = git(p.root, 'rev-parse', 'HEAD');
    const t1 = mkTask('T-003.at', { kind: 'acctest', role: 'test-author', for_task: 'T-003', ac: ['REQ-001.AC1'] });
    const ws1 = await prepareAcctestWorkspace(p.root, config, 'B-001', 'flow/B-001/integration', t1, 'r-one', false);
    assert.ok(!existsSync(path.join(ws1.path, 'src')), '没有实现代码');
    assert.ok(existsSync(path.join(ws1.path, 'docs/spec/requirements.md')) && existsSync(path.join(ws1.path, 'node_modules/dep/index.js')) && existsSync(path.join(ws1.path, 'gen/client.ts')));
    assert.throws(() => git(ws1.path, 'cat-file', '-e', implSha), '不共享对象库');
    assert.equal(git(ws1.path, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(ws1.base_sha, git(ws1.path, 'rev-parse', 'HEAD'));
    assert.ok(!git(ws1.path, 'ls-files').includes('node_modules'), '依赖目录不提交');
    assert.ok(git(ws1.path, 'ls-files').includes('gen/client.ts'), 'codegen 产物进入基线，提交 diff 只看测试目录');
    assert.equal(git(ws1.path, 'status', '--porcelain'), '');
    const t2 = mkTask('T-004.at', { kind: 'acctest', role: 'test-author', for_task: 'T-004' });
    const ws2 = await prepareAcctestWorkspace(p.root, config, 'B-001', 'flow/B-001/integration', t2, 'r-two', false);
    assert.equal(readFileSync(log, 'utf8'), 'install\ncodegen\ncodegen\n', '第二次命中缓存：跳过 install，codegen 照跑');
    assert.match(ws2.log.map((l) => l.detail ?? '').join(), /命中缓存/);
    assert.equal(statSync(path.join(ws2.path, 'node_modules/dep/index.js')).ino, statSync(path.join(ws1.path, 'node_modules/dep/index.js')).ino, '硬链接复制');
    // 已有工作区：复用，不重新导出
    const again = await prepareAcctestWorkspace(p.root, config, 'B-001', 'flow/B-001/integration', { ...t1, worktree: ws1.path }, 'r-three', false);
    assert.deepEqual([again.path, again.base_sha], [ws1.path, ws1.base_sha]);
  } finally { p.cleanup(); }
});

test('install 失败：清理半成品工作区并报出失败输出', async () => {
  const p = repo();
  try {
    const config = configWith({ install: 'echo 网络不通 >&2; exit 7' });
    const t = mkTask('T-003.at', { kind: 'acctest', role: 'test-author', for_task: 'T-003' });
    await assert.rejects(prepareAcctestWorkspace(p.root, config, 'B-001', 'flow/B-001/integration', t, 'r-x', false), /install 失败（退出码 7）[\s\S]*网络不通/);
    assert.ok(!existsSync(path.join(p.base, 'app.worktrees', 'r-x-at')));
  } finally { p.cleanup(); }
});

test('提交：越界改动由程序还原；测试目录的改动以补丁应用到 acc 分支（不存在时从集成分支建；impl 已 done 时重建）', async () => {
  const p = repo();
  try {
    const config = configWith({});
    const t = mkTask('T-003.at', { kind: 'acctest', role: 'test-author', for_task: 'T-003' });
    const ws = await prepareAcctestWorkspace(p.root, config, 'B-001', 'flow/B-001/integration', t, 'r-a', false);
    writeFileSync(path.join(ws.path, 'tests/acceptance/_support/env.ts'), 'changed\n');
    mkdirSync(path.join(ws.path, 'tests/acceptance/T-003'), { recursive: true });
    writeFileSync(path.join(ws.path, 'tests/acceptance/T-003/a.test.ts'), "test('[REQ-001.AC1] x')\n");
    writeFileSync(path.join(ws.path, 'stray.ts'), 'x\n');
    git(ws.path, 'add', '-A'); git(ws.path, 'commit', '-q', '-m', 'work');
    revertOutside(ws.path, ws.base_sha, ['tests/acceptance/_support/env.ts', 'stray.ts']);
    assert.equal(readFileSync(path.join(ws.path, 'tests/acceptance/_support/env.ts'), 'utf8'), 'export const port = process.env.PORT;\n');
    assert.ok(!existsSync(path.join(ws.path, 'stray.ts')));
    assert.deepEqual(testFilesIn(ws.path, 'T-003').map((f) => f.path), ['tests/acceptance/T-003/a.test.ts']);
    const sha = applyToAccBranch(p.root, ws.path, ws.base_sha, 'B-001', 'T-003.at', 'T-003', 'flow/B-001/integration', false)!;
    const branch = accBranch('B-001', 'T-003');
    assert.equal(git(p.root, 'rev-parse', branch), sha);
    assert.deepEqual(git(p.root, 'diff', '--name-only', 'flow/B-001/integration', branch).split('\n'), ['tests/acceptance/T-003/a.test.ts']);
    assert.equal(applyToAccBranch(p.root, ws.path, git(ws.path, 'rev-parse', 'HEAD'), 'B-001', 'T-003.at', 'T-003', 'flow/B-001/integration', false), null, '没有改动');
    // 第二轮（.at-2）：在 acc 分支上叠加
    const t2 = mkTask('T-003.at-2', { kind: 'acctest', role: 'test-author', for_task: 'T-003' });
    const ws2 = await prepareAcctestWorkspace(p.root, config, 'B-001', 'flow/B-001/integration', t2, 'r-b', false);
    assert.ok(existsSync(path.join(ws2.path, 'tests/acceptance/T-003/a.test.ts')), '.at-n 看得到上一轮的测试');
    writeFileSync(path.join(ws2.path, 'tests/acceptance/T-003/a.test.ts'), "test('[REQ-001.AC1] y')\n");
    git(ws2.path, 'commit', '-qam', 'fix');
    applyToAccBranch(p.root, ws2.path, ws2.base_sha, 'B-001', 'T-003.at-2', 'T-003', 'flow/B-001/integration', false);
    assert.equal(git(p.root, 'show', `${branch}:tests/acceptance/T-003/a.test.ts`), "test('[REQ-001.AC1] y')");
    assert.equal(git(p.root, 'rev-list', '--count', `flow/B-001/integration..${branch}`), '2');
    // impl 已 done：从集成分支重建
    applyToAccBranch(p.root, ws.path, ws.base_sha, 'B-001', 'T-003.at-3', 'T-003', 'flow/B-001/integration', true);
    assert.equal(git(p.root, 'rev-list', '--count', `flow/B-001/integration..${branch}`), '1');
    assert.equal(git(p.root, 'worktree', 'list').split('\n').length, 1, '临时 worktree 已清理');
  } finally { p.cleanup(); }
});

test('导出路径默认含 scripts/** 与根目录 tsconfig（S0 的验收运行器与 codegen 常放在 scripts/，偏离 85）；不含实现目录', () => {
  const pats = exportPatterns({ raw: {} } as unknown as Parameters<typeof exportPatterns>[0]);
  for (const p of ['scripts/**', 'tsconfig.json', 'tsconfig.*.json', 'tests/acceptance/**']) assert.ok(pats.includes(p), p);
  assert.ok(!pats.some((p) => p.startsWith('src')));
});
