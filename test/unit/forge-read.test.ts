// 分支读取的行为与边界测试，不依赖真实模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { forgeRead, FORGE_READ_MAX_BYTES, FORGE_READ_MAX_LINES } from '../../src/core/workspace/forge-read.ts';
import { commitFilesToBranch } from '../../src/core/spec/intake.ts';
import { setupProject } from '../helpers/project.ts';

const textOf = (r: ReturnType<typeof forgeRead>) => { assert.notEqual(r.kind, 'image'); return 'text' in r ? r.text : ''; };

test('forge_read 默认读活动集成分支，无活动流程时读主分支；不读取工作区', async () => {
  const p = await setupProject({ files: { 'docs/需求.md': '主分支内容' } });
  try {
    const ref = p.store.readFlow(p.flowId).integration_branch;
    commitFilesToBranch(p.dir, ref, [{ rel: 'docs/需求.md', content: '集成分支内容' }], '输入');
    const ctx = { store: p.store, config: p.config };
    assert.equal(textOf(forgeRead(p.dir, { path: 'docs/./需求.md' }, ctx)), '集成分支内容');
    assert.equal(textOf(forgeRead(p.dir, { path: path.join(p.dir, 'docs/需求.md'), ref: 'main' }, ctx)), '主分支内容');
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.equal(forgeRead(p.dir, { path: 'docs/需求.md' }, ctx).ref, 'main');
    assert.equal(textOf(forgeRead(p.dir, { path: 'docs/需求.md' }, ctx)), '主分支内容');
  } finally { p.cleanup(); }
});

test('forge_read 允许已存在的流程分支，拒绝状态 ref、revision、SHA、其他分支与不存在的分支', async () => {
  const p = await setupProject();
  try {
    const ctx = { store: p.store, config: p.config };
    const task = `flow/${p.flowId}/T-001`;
    p.git('branch', task, 'main');
    assert.equal(forgeRead(p.dir, { path: 'README.md', ref: task }, ctx).ref, task);
    p.git('branch', 'other', 'main');
    for (const ref of ['refs/pi-forge/state', 'refs/pi-forge/checkpoints/a/b', 'HEAD', 'HEAD~1', p.git('rev-parse', 'main'), 'main:path', 'main^{tree}', 'other', `${task}/child`, 'flow/a/b~1']) {
      assert.throws(() => forgeRead(p.dir, { path: 'README.md', ref }, ctx), /不允许读取 ref/);
    }
    assert.throws(() => forgeRead(p.dir, { path: 'README.md', ref: 'flow/missing/integration' }, ctx), /分支不存在/);
    // 同名 tag 不得抢占主分支引用。
    p.git('tag', 'main', task);
    assert.equal(textOf(forgeRead(p.dir, { path: 'README.md', ref: 'main' }, ctx)), 'demo');
  } finally { p.cleanup(); }
});

test('forge_read 列出目录，目录名带 /，根目录与目录提示不泄露受限路径', async () => {
  const p = await setupProject({ files: { 'docs/中文 文件.md': '正文', 'docs/nested/file.txt': '正文', 'docs/.env.test': '占位', 'secrets/example.txt': '占位' } });
  try {
    const ctx = { store: p.store, config: p.config };
    const r = forgeRead(p.dir, { path: 'docs' }, ctx);
    assert.equal(r.kind, 'directory');
    assert.equal(textOf(r), 'nested/\n中文 文件.md');
    const root = textOf(forgeRead(p.dir, { path: '.' }, ctx));
    assert.match(root, /docs\//);
    assert.doesNotMatch(root, /\.forge|\.git|secrets/);
    assert.throws(() => forgeRead(p.dir, { path: 'docs/missing.txt' }, ctx), /路径不存在[\s\S]*上级目录 docs：[\s\S]*nested\/[\s\S]*中文 文件\.md/);
    assert.throws(() => forgeRead(p.dir, { path: 'missing.txt' }, ctx), /上级目录 \.[\s\S]*README\.md/);
    assert.throws(() => forgeRead(p.dir, { path: 'docs/no/such/file' }, ctx), /上级目录 docs/);
  } finally { p.cleanup(); }
});

test('forge_read 文本支持 offset 与 limit，并给出可连续读取的下一行', async () => {
  const p = await setupProject({ files: { 'lines.txt': '一\n二\n三\n四', 'empty.txt': '' } });
  try {
    const ctx = { store: p.store, config: p.config };
    const r = forgeRead(p.dir, { path: 'lines.txt', offset: 2, limit: 2 }, ctx);
    assert.match(textOf(r), /^二\n三\n\n\[.*offset=4/);
    assert.equal('nextOffset' in r && r.nextOffset, 4);
    assert.equal(textOf(forgeRead(p.dir, { path: 'lines.txt', offset: 4 }, ctx)), '四');
    assert.equal(textOf(forgeRead(p.dir, { path: 'empty.txt' }, ctx)), '');
    assert.throws(() => forgeRead(p.dir, { path: 'lines.txt', offset: 5 }, ctx), /超出文件末尾/);
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      for (const name of ['offset', 'limit']) assert.throws(() => forgeRead(p.dir, { path: 'lines.txt', [name]: value }, ctx), /正整数/);
    }
  } finally { p.cleanup(); }
});

test('forge_read 默认最多 2000 行或 50 KiB，按完整 UTF-8 行截断', async () => {
  const p = await setupProject({ files: {
    'many.txt': Array.from({ length: 2002 }, (_, i) => String(i + 1)).join('\n'),
    'bytes.txt': Array.from({ length: 100 }, () => '中'.repeat(300)).join('\n'),
    'huge.txt': '中'.repeat(FORGE_READ_MAX_BYTES),
  } });
  try {
    const ctx = { store: p.store, config: p.config };
    const many = forgeRead(p.dir, { path: 'many.txt', limit: 5000 }, ctx);
    assert.equal('nextOffset' in many && many.nextOffset, FORGE_READ_MAX_LINES + 1);
    assert.equal(textOf(forgeRead(p.dir, { path: 'many.txt', offset: 2001 }, ctx)), '2001\n2002');
    const bytes = forgeRead(p.dir, { path: 'bytes.txt' }, ctx);
    assert.equal('nextOffset' in bytes && bytes.nextOffset, 57);
    const body = textOf(bytes).split('\n\n[')[0]!;
    assert.ok(Buffer.byteLength(body) <= FORGE_READ_MAX_BYTES);
    assert.ok(body.split('\n').every((line) => line === '中'.repeat(300)));
    assert.match(textOf(forgeRead(p.dir, { path: 'huge.txt' }, ctx)), /第 1 行超过 50 KiB/);
  } finally { p.cleanup(); }
});

test('forge_read 返回图片的原始 base64 与 MIME；其他二进制无法显示', async () => {
  const p = await setupProject();
  try {
    const data = Buffer.from([0, 255, 128, 1, 2, 3]);
    const ref = p.store.readFlow(p.flowId).integration_branch;
    const images = { 'PNG': 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    commitFilesToBranch(p.dir, ref, [...Object.keys(images).map((ext) => ({ rel: `image.${ext}`, content: data })), { rel: 'file.bin', content: data }, { rel: 'invalid.txt', content: Buffer.from([255]) }], '二进制夹具');
    const ctx = { store: p.store, config: p.config };
    for (const [ext, mime] of Object.entries(images)) {
      const r = forgeRead(p.dir, { path: `image.${ext}` }, ctx);
      assert.equal(r.kind, 'image');
      if (r.kind === 'image') { assert.equal(r.mimeType, mime); assert.deepEqual(Buffer.from(r.data, 'base64'), data); }
    }
    for (const file of ['file.bin', 'invalid.txt']) {
      const r = forgeRead(p.dir, { path: file }, ctx);
      assert.equal(r.kind, 'binary');
      assert.equal(textOf(r), '二进制文件，无法显示');
    }
  } finally { p.cleanup(); }
});

test('forge_read 拒绝越界、状态目录及现有敏感文件规则', async () => {
  const p = await setupProject();
  try {
    const ctx = { store: p.store, config: p.config };
    for (const file of ['../outside', path.join(p.dir, '..', 'outside')]) assert.throws(() => forgeRead(p.dir, { path: file }, ctx), /不能越出仓库/);
    for (const file of ['.forge', '.forge/state.json', 'docs/../.forge/state.json', '.FORGE/state.json', '.git/config', '.env', 'docs/.env.local', 'key.pem', 'secrets', 'secrets/file', 'docs/secrets/file']) {
      assert.throws(() => forgeRead(p.dir, { path: file }, ctx), /禁止读取/);
    }
    assert.throws(() => forgeRead(p.dir, { path: '' }, ctx), /path 必须/);
    assert.throws(() => forgeRead(p.dir, { path: 'a\0b' }, ctx), /path 必须/);
  } finally { p.cleanup(); }
});
