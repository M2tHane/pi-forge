// 来源：pi-flow test/unit/verify-runner.test.ts @ 31f3f15
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureSummary } from '../../src/core/workspace/verify-runner.ts';
import { failureSignature } from '../../src/core/state/failure-signature.ts';

test('failureSummary：优先错误行与上下文，去掉 ANSI', () => {
  const out = [
    '> tsc --noEmit',
    ...Array.from({ length: 50 }, (_, i) => `compiling file ${i}`),
    '\x1b[31msrc/a.ts(3,5): error TS2322: Type string is not assignable to type number.\x1b[0m',
    '  3 | const x: number = "a";',
    ...Array.from({ length: 50 }, (_, i) => `ok ${i}`),
  ].join('\n');
  const s = failureSummary(out);
  assert.match(s, /error TS2322/);
  assert.match(s, /const x: number/);
  assert.doesNotMatch(s, /\x1b/);
  assert.doesNotMatch(s, /compiling file 10/);
});

test('failureSummary：没有错误标记时取尾部；超长时截断保留首尾', () => {
  const tail = failureSummary(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
  assert.match(tail, /line 99/);
  assert.doesNotMatch(tail, /line 10\n/);
  const long = failureSummary(Array.from({ length: 500 }, (_, i) => `FAIL test ${i} expected 1`).join('\n'), 300);
  assert.ok(long.length <= 300);
  assert.match(long, /FAIL test 0/);
  assert.match(long, /FAIL test 499/);
});

test('failureSignature：耗时、行号、临时路径不同时签名相同；内容不同时不同', () => {
  const a = failureSignature('FAIL tests/a.test.ts (123 ms)\n  expected 3 at /tmp/pi-forge-x1/a.ts:10');
  const b = failureSignature('FAIL tests/a.test.ts (98 ms)\n  expected 3 at /tmp/pi-forge-y2/a.ts:12');
  const c = failureSignature('FAIL tests/b.test.ts (98 ms)\n  cannot read property');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
