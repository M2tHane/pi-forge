// F7 第一步：失败提示里引导范围申请。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_HINT_MAX_FILES, scopeHint } from '../../src/core/scope-hint.ts';

const tracked = new Set(['src/a/x.ts', 'src/b/y.ts', 'src/c/z.ts', 'tests/acceptance/T-009/a.test.ts', 'tests/unit/old.test.ts', 'src/shared/routes.ts']);
const task = { writes: ['src/a/**'], shared: ['src/shared/routes.ts'], test_adjustments: [] as string[] };

test('scopeHint：有越界文件时列出文件并说明 forge_request_scope 的三种结果', () => {
  const h = scopeHint('FAIL src/b/y.ts:12 TypeError\n  at src/a/x.ts:3', task, tracked);
  assert.match(h, /- src\/b\/y\.ts/);
  assert.doesNotMatch(h, /- src\/a\/x\.ts/);
  assert.match(h, /forge_request_scope/);
  assert.match(h, /已完成 task 的文件会被直接批准/);
  assert.match(h, /主会话批准/);
  assert.match(h, /正在进行的 task 重叠的会被拒绝/);
});

test('scopeHint：失败文件全在可写范围内（writes、shared）时返回空', () => {
  assert.equal(scopeHint('src/a/x.ts:1 error\nsrc/shared/routes.ts:2 error', task, tracked), '');
  assert.equal(scopeHint('没有文件名的失败输出', task, tracked), '');
});

test('scopeHint：只涉及 tests/acceptance 时返回空（另走第 9.4 节）', () => {
  assert.equal(scopeHint('FAIL tests/acceptance/T-009/a.test.ts', task, tracked), '');
});

test('scopeHint：test_adjustments 里的文件不算越界', () => {
  assert.equal(scopeHint('FAIL tests/unit/old.test.ts', { ...task, test_adjustments: ['tests/unit/old.test.ts'] }, tracked), '');
  assert.match(scopeHint('FAIL tests/unit/old.test.ts', task, tracked), /tests\/unit\/old\.test\.ts/);
});

test('scopeHint：不在已跟踪集合里的名字（版本号、模块名）不算', () => {
  assert.equal(scopeHint('node v24.1.0 foo.bar not/tracked.ts', task, tracked), '');
});

test('scopeHint：最多列 10 个文件，其余只给个数', () => {
  const many = Array.from({ length: 15 }, (_, i) => `src/o/f${String(i).padStart(2, '0')}.ts`);
  const h = scopeHint(many.map((f) => `FAIL ${f}`).join('\n'), task, new Set(many));
  assert.equal((h.match(/^- /gm) ?? []).length, SCOPE_HINT_MAX_FILES);
  assert.match(h, /还有 5 个/);
  assert.match(h, /src\/o\/f09\.ts/);
  assert.doesNotMatch(h, /src\/o\/f10\.ts/);
});
