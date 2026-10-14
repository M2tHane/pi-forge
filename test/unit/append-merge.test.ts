import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAppendOnlyThreeWay } from '../../src/core/plan/append-merge.ts';

const BASE = 'export const A = 1;\nexport const B = 2;\n';

function ok(r: ReturnType<typeof mergeAppendOnlyThreeWay>): string {
  assert.ok(r.ok, r.ok ? '' : r.reason);
  return r.text;
}

test('双方都在末尾追加：集成分支（ours）在前', () => {
  const text = ok(mergeAppendOnlyThreeWay(BASE, BASE + 'export const C = 3;\n', BASE + 'export const D = 4;\n'));
  assert.equal(text, BASE + 'export const C = 3;\nexport const D = 4;\n');
});

test('在不同位置插入', () => {
  const ours = 'export const A = 1;\nexport const X = 9;\nexport const B = 2;\n';
  const theirs = BASE + 'export const D = 4;\n';
  assert.equal(ok(mergeAppendOnlyThreeWay(BASE, ours, theirs)), 'export const A = 1;\nexport const X = 9;\nexport const B = 2;\nexport const D = 4;\n');
  assert.equal(ok(mergeAppendOnlyThreeWay(BASE, theirs, ours)), 'export const A = 1;\nexport const X = 9;\nexport const B = 2;\nexport const D = 4;\n');
});

test('同一锚点双方插入：ours 在前', () => {
  const ours = 'export const A = 1;\no1\no2\nexport const B = 2;\n';
  const theirs = 'export const A = 1;\nt1\nexport const B = 2;\n';
  assert.equal(ok(mergeAppendOnlyThreeWay(BASE, ours, theirs)), 'export const A = 1;\no1\no2\nt1\nexport const B = 2;\n');
});

test('开头插入', () => {
  assert.equal(ok(mergeAppendOnlyThreeWay(BASE, 'o\n' + BASE, 't\n' + BASE)), 'o\nt\n' + BASE);
});

test('一方未改 → 取另一方；完全相同 → 原样', () => {
  const changed = BASE + 'x\n';
  assert.equal(ok(mergeAppendOnlyThreeWay(BASE, BASE, changed)), changed);
  assert.equal(ok(mergeAppendOnlyThreeWay(BASE, changed, BASE)), changed);
  assert.equal(ok(mergeAppendOnlyThreeWay(BASE, changed, changed)), changed);
});

test('一方修改了某行 → 失败，reason 指明哪一方', () => {
  const modified = 'export const A = 100;\nexport const B = 2;\n';
  const added = BASE + 'x\n';
  const o = mergeAppendOnlyThreeWay(BASE, modified, added);
  assert.ok(!o.ok);
  assert.match(o.reason, /ours/);
  assert.match(o.reason, /第 1 行/);
  const t = mergeAppendOnlyThreeWay(BASE, added, modified);
  assert.ok(!t.ok);
  assert.match(t.reason, /theirs/);
});

test('一方删除了某行 → 失败', () => {
  const deleted = 'export const B = 2;\n';
  const added = BASE + 'x\n';
  const r = mergeAppendOnlyThreeWay(BASE, added, deleted);
  assert.ok(!r.ok);
  assert.match(r.reason, /theirs/);
  assert.match(r.reason, /第 1 行/);
});

test('base 为空：双方各自新增内容', () => {
  assert.equal(ok(mergeAppendOnlyThreeWay('', 'a\nb\n', 'c\n')), 'a\nb\nc\n');
});

test('末尾换行风格保持 ours', () => {
  assert.equal(ok(mergeAppendOnlyThreeWay('a', 'a\nb', 'a\nc')), 'a\nb\nc');
  assert.equal(ok(mergeAppendOnlyThreeWay('a\n', 'a\nb\n', 'a\nc')), 'a\nb\nc\n');
  assert.equal(ok(mergeAppendOnlyThreeWay('a', 'a\nb', 'a\nc\n')), 'a\nb\nc');
});

test('base 中重复的行也能按顺序嵌入', () => {
  const base = 'x\n\nx\n';
  assert.equal(ok(mergeAppendOnlyThreeWay(base, base + 'o\n', 'x\n\nt\nx\n')), 'x\n\nt\nx\no\n');
});

test('超过 20000 行不合并', () => {
  const big = Array.from({ length: 20001 }, (_, i) => `l${i}`).join('\n') + '\n';
  const r = mergeAppendOnlyThreeWay(big, big + 'o\n', big + 't\n');
  assert.ok(!r.ok);
  assert.match(r.reason, /20000/);
});
