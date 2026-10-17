// 入库 docs/PRD.md 与 docs/prototype/、开始前的输入检查，不依赖真实模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importInputs, prepareInputs } from '../../src/core/spec/intake.ts';
import { buildInputProblems } from '../../src/core/spec/preflight.ts';
import { setupProject } from '../helpers/project.ts';

const write = (root: string, rel: string, content: string | Buffer) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const show = (root: string, ref: string, rel: string) => execFileSync('git', ['show', `refs/heads/${ref}:${rel}`], { cwd: root });

test('buildInputProblems：缺 PRD、缺原型目录、原型里没有 .html 时分别提示；齐全时为空', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-inputs-'));
  try {
    assert.deepEqual(buildInputProblems(dir).map((p) => p.split('：')[0]), ['缺少 docs/PRD.md', '缺少 docs/prototype/']);
    write(dir, 'docs/PRD.md', '# PRD');
    write(dir, 'docs/prototype/README.md', '说明');
    assert.match(buildInputProblems(dir).join('\n'), /docs\/prototype\/ 里没有 \.html 文件/);
    write(dir, 'docs/prototype/pages/list.html', '<title>列表</title>');
    assert.deepEqual(buildInputProblems(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('intake 把 docs/PRD.md 与 docs/prototype/ 原样提交到集成分支：路径、类型、可执行权限不变，主分支不动', async () => {
  const p = await setupProject({ files: { '.gitattributes': '*.md text eol=lf\n' } });
  try {
    const image = Buffer.from([0, 255, 1, 2, 3]);
    write(p.dir, 'docs/PRD.md', '# 中文 PRD\r\n正文\r\n');
    write(p.dir, 'docs/prototype/index.html', '<title>首页</title>');
    write(p.dir, 'docs/prototype/img/logo.png', image);
    write(p.dir, 'docs/prototype/assets/app.js', 'console.log(1)');
    write(p.dir, 'docs/prototype/.DS_Store', 'x');
    write(p.dir, 'docs/other.md', '不入库');
    chmodSync(path.join(p.dir, 'docs/prototype/assets/app.js'), 0o755);
    const files = await importInputs(p.dir, p.store, p.flowId);
    const ref = p.store.readFlow(p.flowId).integration_branch;
    assert.deepEqual(files.map((f) => [f.path, f.type]), [
      ['docs/PRD.md', 'text'], ['docs/prototype/assets/app.js', 'text'], ['docs/prototype/img/logo.png', 'image/png'], ['docs/prototype/index.html', 'text'],
    ]);
    for (const f of files) assert.deepEqual(show(p.dir, ref, f.path), readFileSync(path.join(p.dir, f.path)));
    assert.match(p.git('ls-tree', ref, '--', 'docs/prototype/assets/app.js'), /^100755/);
    assert.equal(p.git('ls-tree', '-r', '--name-only', ref, '--', 'docs/other.md'), '');
    assert.equal(p.git('ls-tree', '-r', '--name-only', 'main', '--', 'docs'), '');
    assert.deepEqual(p.store.readFlow(p.flowId).intake?.files.map((f) => f.path), files.map((f) => f.path));
  } finally { p.cleanup(); }
});

test('intake 重复执行不产生新提交，主工作区、主索引与活动分支不变', async () => {
  const p = await setupProject();
  try {
    write(p.dir, 'docs/PRD.md', 'PRD');
    write(p.dir, 'docs/prototype/a.html', '<p>a</p>');
    write(p.dir, 'staged.txt', '已暂存');
    p.git('add', 'staged.txt');
    write(p.dir, 'README.md', '主工作区修改');
    const head = p.git('rev-parse', 'HEAD');
    const index = p.git('diff', '--cached');
    const status = p.git('status', '--porcelain');
    const result = await importInputs(p.dir, p.store, p.flowId);
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const first = p.git('rev-parse', ref);
    const version = p.store.readFlow(p.flowId).version;
    assert.deepEqual(await importInputs(p.dir, p.store, p.flowId), result);
    assert.equal(p.git('rev-parse', ref), first);
    assert.equal(p.store.readFlow(p.flowId).version, version);
    assert.equal(p.git('rev-parse', 'HEAD'), head);
    assert.equal(p.git('diff', '--cached'), index);
    assert.equal(p.git('status', '--porcelain'), status);
    assert.equal(p.git('branch', '--show-current'), 'main');
  } finally { p.cleanup(); }
});

test('intake 拒绝符号链接、敏感文件与超限目录，失败不更新集成分支', async () => {
  const p = await setupProject();
  const outside = mkdtempSync(path.join(tmpdir(), 'forge-input-'));
  try {
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const before = p.git('rev-parse', ref);
    write(outside, 'prd.md', '仓库外 PRD');
    mkdirSync(path.join(p.dir, 'docs'), { recursive: true });
    symlinkSync(path.join(outside, 'prd.md'), path.join(p.dir, 'docs/PRD.md'));
    write(p.dir, 'docs/prototype/a.html', '<p>a</p>');
    assert.throws(() => prepareInputs(p.dir), /符号链接/);
    rmSync(path.join(p.dir, 'docs/PRD.md'));
    write(p.dir, 'docs/PRD.md', 'PRD');
    symlinkSync('..', path.join(p.dir, 'docs/prototype/loop'));
    assert.throws(() => prepareInputs(p.dir), /符号链接/);
    rmSync(path.join(p.dir, 'docs/prototype/loop'));
    // 测试只有占位内容，不使用任何密钥。
    write(p.dir, 'docs/prototype/.env.test', '占位');
    assert.throws(() => prepareInputs(p.dir), /敏感文件/);
    rmSync(path.join(p.dir, 'docs/prototype/.env.test'));
    for (let i = 0; i < 500; i++) write(p.dir, `docs/prototype/many/${i}.txt`, 'a');
    assert.throws(() => prepareInputs(p.dir), /超过 500 个/);
    rmSync(path.join(p.dir, 'docs/prototype/many'), { recursive: true });
    write(p.dir, 'docs/prototype/large.bin', Buffer.alloc(30 * 1024 * 1024 + 1));
    await assert.rejects(importInputs(p.dir, p.store, p.flowId), /超过 30 MiB/);
    assert.equal(p.git('rev-parse', ref), before);
    assert.equal(p.store.readFlow(p.flowId).intake, undefined);
  } finally { p.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});
