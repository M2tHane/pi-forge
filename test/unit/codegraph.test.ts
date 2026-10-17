import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codegraphInit, codegraphSync } from '../../src/core/ops/codegraph.ts';

// 用假的 codegraph 可执行文件验证调用与降级，不依赖本机安装
function fakeBin(dir: string, script: string): string {
  const p = path.join(dir, 'codegraph');
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}


test('codegraphSync：未索引时不调用；已索引时执行 sync；出错或缺少可执行文件时忽略', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-cg-'));
  try {
    const mark = path.join(dir, 'called');
    process.env['PI_FORGE_CODEGRAPH_BIN'] = fakeBin(dir, `echo "$@" > ${mark}`);
    await codegraphSync(dir);
    assert.ok(!existsSync(mark), '没有 .codegraph 时不调用');
    mkdirSync(path.join(dir, '.codegraph'));
    await codegraphSync(dir);
    assert.match(readFileSync(mark, 'utf8'), /^sync -q /);
    process.env['PI_FORGE_CODEGRAPH_BIN'] = fakeBin(dir, 'exit 3');
    await codegraphSync(dir);
    process.env['PI_FORGE_CODEGRAPH_BIN'] = path.join(dir, 'missing');
    await codegraphSync(dir);
  } finally {
    delete process.env['PI_FORGE_CODEGRAPH_BIN'];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codegraphInit：执行 init -y <root>；失败与缺少可执行文件时只返回提示', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-cg-'));
  try {
    const mark = path.join(dir, 'called');
    process.env['PI_FORGE_CODEGRAPH_BIN'] = fakeBin(dir, `echo "$@" > ${mark}`);
    assert.match(await codegraphInit(dir), /已建立/);
    assert.equal(readFileSync(mark, 'utf8').trim(), `init -y ${dir}`);
    process.env['PI_FORGE_CODEGRAPH_BIN'] = fakeBin(dir, 'exit 3');
    assert.match(await codegraphInit(dir), /失败（退出码 3）.*codegraph init -y/);
    process.env['PI_FORGE_CODEGRAPH_BIN'] = path.join(dir, 'missing');
    assert.match(await codegraphInit(dir), /没有找到 codegraph.*安装后执行 codegraph init -y/);
  } finally {
    delete process.env['PI_FORGE_CODEGRAPH_BIN'];
    rmSync(dir, { recursive: true, force: true });
  }
});
