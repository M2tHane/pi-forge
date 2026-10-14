// failingFiles：从失败输出里找出仓库里的文件（门禁生成修复任务时用）。原先的范围申请提示随写入范围放开一并删除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingFiles } from '../../src/core/workspace/scope-hint.ts';

const tracked = new Set(['src/a/x.ts', 'src/b/y.ts', 'tests/unit/old.test.ts']);

test('failingFiles：列出失败输出里出现的已跟踪文件，去掉 ./ 前缀', () => {
  assert.deepEqual(failingFiles('FAIL src/b/y.ts:12 TypeError\n  at ./src/a/x.ts:3', tracked), ['src/b/y.ts', 'src/a/x.ts']);
});

test('failingFiles：绝对路径按后缀匹配已跟踪文件', () => {
  assert.deepEqual(failingFiles('at /tmp/wt/src/a/x.ts:3', tracked), ['src/a/x.ts']);
});

test('failingFiles：不在已跟踪集合里的名字（版本号、模块名）不算；没有文件名时为空', () => {
  assert.deepEqual(failingFiles('node v24.1.0 foo.bar not/tracked.ts', tracked), []);
  assert.deepEqual(failingFiles('没有文件名的失败输出', tracked), []);
});

test('failingFiles：最多返回 20 个', () => {
  const many = Array.from({ length: 25 }, (_, i) => `src/o/f${String(i).padStart(2, '0')}.ts`);
  assert.equal(failingFiles(many.map((f) => `FAIL ${f}`).join('\n'), new Set(many)).length, 20);
});
