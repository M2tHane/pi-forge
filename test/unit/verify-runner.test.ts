// 来源：pi-flow test/unit/verify-runner.test.ts @ 31f3f15
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectToolMissing, evidenceText, failureSummary } from '../../src/core/workspace/verify-runner.ts';
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

test('detectToolMissing（偏离 108）：明确的工具层报错格式', () => {
  const tool = (code: number, out: string) => detectToolMissing(code, out)?.tool ?? null;
  // 证据：pnpm exec 找不到 redocly
  assert.equal(tool(1, ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "redocly" not found\n'), 'redocly');
  // 真实运行（m9b STD）里的输出：错误码带方括号，前面还有一行 undefined
  assert.equal(tool(1, 'undefined\n[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "redocly" not found\n'), 'redocly');
  assert.equal(tool(1, 'Command "redocly" not found'), 'redocly');
  assert.equal(tool(1, '> p@1 lint\n> redocly lint x\n\nsh: 1: redocly: not found\n ELIFECYCLE  Command failed with exit code 127.'), 'redocly');
  assert.equal(tool(127, 'sh: 1: redocly: not found'), 'redocly');
  assert.equal(tool(127, '/bin/sh: schemathesis: command not found'), 'schemathesis');
  assert.equal(tool(127, 'bash: line 1: foo: command not found'), 'foo');
  assert.equal(tool(127, 'zsh: command not found: foo'), 'foo');
  assert.equal(tool(1, 'npm error could not determine executable to run'), 'npx');
  assert.equal(tool(1, 'npm ERR! could not determine executable to run'), 'npx');
  assert.equal(tool(127, 'npx: not found'), 'npx');
  assert.equal(tool(127, '\x1b[31msh: 1: tsc: not found\x1b[0m'), 'tsc');
  assert.equal(tool(127, '随便什么输出'), '未知', '退出码 127 本身就是信号');
  assert.equal(tool(127, ''), '未知');
});

test('detectToolMissing：反例——测试失败、断言里的 not found 字样、退出码 0', () => {
  // 普通测试失败
  assert.equal(detectToolMissing(1, 'not ok 1 - works\n  ---\n  error: expected 1 got 2'), null);
  // 断言文本里恰好有 not found / Command not found
  assert.equal(detectToolMissing(1, 'AssertionError: expected "user not found" to equal "ok"\n    at test.js:3'), null);
  assert.equal(detectToolMissing(1, '  ✖ returns 404 when user: not found (3ms)\nError: sh: 1: foo: not found'), null, '测试输出标记在前，后面的 not found 属于测试');
  assert.equal(detectToolMissing(1, 'TAP version 13\n# Subtest: a\nnot ok 1\nsh: 1: foo: not found'), null);
  assert.equal(detectToolMissing(1, 'FAIL src/a.test.ts\n  Command "x" not found'), null);
  // 行中间出现，不是整行格式
  assert.equal(detectToolMissing(1, 'Error: the Command "x" not found in registry'), null);
  assert.equal(detectToolMissing(2, 'error: file not found: a.txt'), null);
  assert.equal(detectToolMissing(1, 'page not found'), null);
  // 排在前 10 行之后的不看
  assert.equal(detectToolMissing(1, `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')}\nsh: 1: foo: not found`), null);
  // 退出码 0 永远不是
  assert.equal(detectToolMissing(0, 'sh: 1: foo: not found'), null);
});

test('evidenceText 在工具缺失时写明已跳过', () => {
  const r = { command: 'contract_lint', exit_code: 1, output: ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "redocly" not found', duration_ms: 5, timed_out: false };
  assert.match(evidenceText(r, 'pnpm exec redocly lint'), /工具缺失，已跳过：contract_lint（redocly）/);
  assert.doesNotMatch(evidenceText({ ...r, output: 'not ok 1' }, 'x'), /工具缺失/);
});
