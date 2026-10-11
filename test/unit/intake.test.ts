// intake 原件入库与幂等性测试，不依赖真实模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importInputs, prepareInputs } from '../../src/core/spec/intake.ts';
import { setupProject } from '../helpers/project.ts';

const write = (root: string, rel: string, content: string | Buffer) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const show = (root: string, ref: string, rel: string) => execFileSync('git', ['show', `refs/heads/${ref}:${rel}`], { cwd: root });

test('intake 接收单个 PRD 与图片原型，返回路径、字节数和类型，原件只在集成分支', async () => {
  const p = await setupProject();
  try {
    const image = Buffer.from([0, 255, 1, 2, 3]);
    write(p.dir, 'incoming/需求.md', '# 中文 PRD\r\n正文\r\n');
    write(p.dir, 'incoming/screen.png', image);
    const result = await importInputs(p.dir, p.store, p.flowId, { prd: 'incoming/需求.md', prototype: 'incoming/screen.png' });
    const ref = p.store.readFlow(p.flowId).integration_branch;
    assert.equal(result.prd, 'docs/spec/inputs/prd/需求.md');
    assert.equal(result.prototype, 'docs/spec/inputs/prototype/screen.png');
    assert.deepEqual(result.files, [
      { path: result.prd, size: Buffer.byteLength('# 中文 PRD\r\n正文\r\n'), type: 'text' },
      { path: result.prototype, size: image.length, type: 'image/png' },
    ]);
    assert.deepEqual(show(p.dir, ref, result.prd), readFileSync(path.join(p.dir, 'incoming/需求.md')));
    assert.deepEqual(show(p.dir, ref, result.prototype!), image);
    assert.equal(p.git('ls-tree', '-r', '--name-only', 'main', '--', 'docs/spec/inputs'), '');
    assert.equal(p.store.readFlow(p.flowId).intake?.prd, result.prd);
  } finally { p.cleanup(); }
});

test('intake 接收目录时保持相对路径、隐藏文件、DESIGN.md、原型 INDEX.md 与可执行权限', async () => {
  const p = await setupProject({ files: { '.gitattributes': '*.md text eol=lf\n' } });
  try {
    for (const [rel, text] of Object.entries({
      'source/prd/a.md': 'PRD\r\n', 'source/prd/nested/b.txt': '补充', 'source/prd/.hidden': '隐藏原件',
      'source/prototype/INDEX.md': '用户原始索引\r\n', 'source/prototype/DESIGN.md': '用户设计\r\n',
      'source/prototype/nested/page.html': '<title>页面</title>', 'source/prototype/assets/app.js': 'console.log(1)',
    })) write(p.dir, rel, text);
    chmodSync(path.join(p.dir, 'source/prototype/assets/app.js'), 0o755);
    const result = await importInputs(p.dir, p.store, p.flowId, { prd: 'source/prd', prototype: 'source/prototype' });
    assert.equal(result.prd, 'docs/spec/inputs/prd');
    assert.equal(result.prototype, 'docs/spec/inputs/prototype');
    assert.equal(result.files.length, 7);
    const ref = p.store.readFlow(p.flowId).integration_branch;
    for (const file of result.files) {
      const source = file.path.replace('docs/spec/inputs/', 'source/');
      assert.deepEqual(show(p.dir, ref, file.path), readFileSync(path.join(p.dir, source)));
    }
    assert.equal(p.git('ls-tree', ref, '--', 'DESIGN.md'), '');
    assert.match(p.git('ls-tree', ref, '--', 'docs/spec/inputs/prototype/assets/app.js'), /^100755/);
    assert.deepEqual(p.store.readFlow(p.flowId).intake?.files.map((f) => f.path), result.files.map((f) => f.path));
  } finally { p.cleanup(); }
});

test('intake 重复执行不产生新提交，主工作区、主索引与活动分支不变', async () => {
  const p = await setupProject();
  try {
    write(p.dir, 'inputs/prd.md', 'PRD');
    write(p.dir, 'staged.txt', '已暂存');
    p.git('add', 'staged.txt');
    write(p.dir, 'README.md', '主工作区修改');
    const head = p.git('rev-parse', 'HEAD');
    const index = p.git('diff', '--cached');
    const status = p.git('status', '--porcelain');
    const result = await importInputs(p.dir, p.store, p.flowId, { prd: 'inputs/prd.md' });
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const first = p.git('rev-parse', ref);
    const version = p.store.readFlow(p.flowId).version;
    assert.deepEqual(await importInputs(p.dir, p.store, p.flowId, { prd: 'inputs/prd.md' }), result);
    assert.equal(p.git('rev-parse', ref), first);
    assert.equal(p.store.readFlow(p.flowId).version, version);
    assert.equal(p.git('rev-parse', 'HEAD'), head);
    assert.equal(p.git('diff', '--cached'), index);
    assert.equal(p.git('status', '--porcelain'), status);
    assert.equal(p.git('branch', '--show-current'), 'main');
  } finally { p.cleanup(); }
});

test('intake 可接收仓库外的普通输入；输入不存在、空目录或符号链接时拒绝', async () => {
  const p = await setupProject();
  const outside = mkdtempSync(path.join(tmpdir(), 'forge-input-'));
  try {
    write(outside, 'prd.md', '仓库外 PRD');
    const result = await importInputs(p.dir, p.store, p.flowId, { prd: path.join(outside, 'prd.md') });
    assert.equal(result.files.length, 1);
    mkdirSync(path.join(p.dir, 'empty'));
    assert.throws(() => prepareInputs(p.dir, { prd: 'missing' }), /找不到PRD/);
    assert.throws(() => prepareInputs(p.dir, { prd: 'empty' }), /空目录/);
    assert.throws(() => prepareInputs(p.dir, { prd: path.join(outside, 'prd.md'), prototype: 'missing' }), /找不到原型/);
    symlinkSync(path.join(outside, 'prd.md'), path.join(p.dir, 'linked'));
    assert.throws(() => prepareInputs(p.dir, { prd: 'linked' }), /符号链接/);
    write(p.dir, 'nested/prd.md', '正文');
    symlinkSync('..', path.join(p.dir, 'nested/loop'));
    assert.throws(() => prepareInputs(p.dir, { prd: 'nested' }), /符号链接/);
  } finally { p.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('intake 拒绝敏感路径、状态目录与超限目录，失败不更新集成分支', async () => {
  const p = await setupProject();
  try {
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const before = p.git('rev-parse', ref);
    // 测试只有占位内容，不使用任何密钥。
    write(p.dir, 'input/.env.test', '占位');
    write(p.dir, 'secrets/prd.md', '占位');
    assert.throws(() => prepareInputs(p.dir, { prd: 'input' }), /敏感文件/);
    assert.throws(() => prepareInputs(p.dir, { prd: 'secrets/prd.md' }), /敏感文件/);
    assert.throws(() => prepareInputs(p.dir, { prd: '.forge' }), /状态目录/);
    for (let i = 0; i < 501; i++) write(p.dir, `many/${i}.txt`, 'a');
    assert.throws(() => prepareInputs(p.dir, { prd: 'many' }), /超过 500 个/);
    write(p.dir, 'large.bin', Buffer.alloc(30 * 1024 * 1024 + 1));
    assert.throws(() => prepareInputs(p.dir, { prd: 'large.bin' }), /超过 30 MiB/);
    await assert.rejects(importInputs(p.dir, p.store, p.flowId, { prd: 'missing' }), /找不到PRD/);
    assert.equal(p.git('rev-parse', ref), before);
    assert.equal(p.store.readFlow(p.flowId).intake, undefined);
  } finally { p.cleanup(); }
});
