import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { mergeContractThreeWay } from '../../src/core/plan/contract-merge.ts';

const BASE = `# 根文件
openapi: 3.1.0
paths:
  /api/a:
    $ref: './paths/a.yaml#/~1api~1a' # a 的引用
`;

test('YAML：两边在 paths 下各新增不同键 → 合并，保留注释', () => {
  const ours = BASE + `  /api/b:\n    $ref: './paths/b.yaml#/~1api~1b'\n`;
  const theirs = BASE + `  /api/c:\n    $ref: './paths/c.yaml#/~1api~1c'\n`;
  const r = mergeContractThreeWay('openapi.yaml', BASE, ours, theirs);
  assert.ok(r.ok);
  const v = parse(r.text);
  assert.deepEqual(Object.keys(v.paths), ['/api/a', '/api/b', '/api/c']);
  assert.match(r.text, /# 根文件/);
  assert.match(r.text, /# a 的引用/);
});

test('YAML：两边新增同一个键且值不同 → 失败；值相同 → 成功', () => {
  const ours = BASE + `  /api/x:\n    $ref: './paths/a.yaml#/x'\n`;
  const theirs = BASE + `  /api/x:\n    $ref: './paths/b.yaml#/x'\n`;
  const r = mergeContractThreeWay('openapi.yaml', BASE, ours, theirs);
  assert.ok(!r.ok);
  assert.match(r.reason, /双方都新增了 paths\.\/api\/x/);
  const same = mergeContractThreeWay('openapi.yaml', BASE, ours, ours + `  /api/y:\n    $ref: './paths/y.yaml#/y'\n`);
  assert.ok(same.ok);
});

test('YAML：一边修改已有值 → 失败', () => {
  const theirs = BASE.replace('./paths/a.yaml#/~1api~1a', './paths/other.yaml#/z');
  const ours = BASE + `  /api/b:\n    $ref: './paths/b.yaml#/b'\n`;
  const r = mergeContractThreeWay('openapi.yaml', BASE, ours, theirs);
  assert.ok(!r.ok);
  assert.match(r.reason, /theirs 修改了已有的 paths\.\/api\/a\.\$ref/);
  const r2 = mergeContractThreeWay('openapi.yaml', BASE, theirs, ours);
  assert.ok(!r2.ok);
  assert.match(r2.reason, /ours 修改了已有的/);
});

test('YAML：一边删除已有键 → 失败', () => {
  const theirs = `openapi: 3.1.0\n`;
  const ours = BASE + `  /api/b:\n    $ref: './paths/b.yaml#/b'\n`;
  const r = mergeContractThreeWay('openapi.yaml', BASE, ours, theirs);
  assert.ok(!r.ok);
  assert.match(r.reason, /theirs 删除了已有的/);
});

test('data-model.yaml 两边各加一张表 → 成功', () => {
  const base = `tables:\n  user:\n    columns:\n      id: { type: text }\n`;
  const ours = base + `  team:\n    columns:\n      id: { type: text }\n`;
  const theirs = base + `  datasource:\n    columns:\n      id: { type: text }\n      name: { type: text }\n`;
  const r = mergeContractThreeWay('data-model.yaml', base, ours, theirs);
  assert.ok(r.ok);
  const v = parse(r.text);
  assert.deepEqual(Object.keys(v.tables), ['user', 'team', 'datasource']);
  assert.deepEqual(Object.keys(v.tables.datasource.columns), ['id', 'name']);
});

test('嵌套映射：同一个 path 下两边各加一个 operation → 成功', () => {
  const base = `/api/items:\n  get:\n    operationId: list\n`;
  const ours = base + `  post:\n    operationId: create\n`;
  const theirs = base + `  delete:\n    operationId: remove\n`;
  const r = mergeContractThreeWay('paths/items.yaml', base, ours, theirs);
  assert.ok(r.ok);
  const v = parse(r.text);
  assert.deepEqual(Object.keys(v['/api/items']), ['get', 'post', 'delete']);
});

test('YAML：base 里 paths 为空，双方各加一条 → 成功', () => {
  const base = `openapi: 3.1.0\npaths:\n`;
  const ours = `openapi: 3.1.0\npaths:\n  /a:\n    $ref: './a.yaml'\n`;
  const theirs = `openapi: 3.1.0\npaths:\n  /b:\n    $ref: './b.yaml'\n`;
  const r = mergeContractThreeWay('openapi.yaml', base, ours, theirs);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(parse(r.text).paths), ['/a', '/b']);
});

test('YAML：数组改动 → 失败；非法 YAML → 失败', () => {
  const base = `list:\n  - 1\n  - 2\n`;
  const r = mergeContractThreeWay('x.yaml', base, base + `extra: 1\n`, `list:\n  - 1\n  - 2\n  - 3\n`);
  assert.ok(!r.ok);
  assert.match(r.reason, /theirs 修改了已有的 list/);
  const bad = mergeContractThreeWay('x.yaml', base, 'a: [\n', base + 'b: 1\n');
  assert.ok(!bad.ok);
});

const MD_BASE = `# team 模块\n\n简介\n\n## createTeam\n\n创建团队\n`;

test('Markdown：各加一个小节 → 成功；同名小节内容不同 → 失败', () => {
  const ours = MD_BASE + `\n## listTeams\n\n列表\n`;
  const theirs = MD_BASE + `\n## deleteTeam\n\n删除\n`;
  const r = mergeContractThreeWay('modules/team.md', MD_BASE, ours, theirs);
  assert.ok(r.ok);
  assert.match(r.text, /## createTeam/);
  assert.match(r.text, /## listTeams/);
  assert.match(r.text, /## deleteTeam/);
  assert.ok(r.text.indexOf('listTeams') < r.text.indexOf('deleteTeam'));
  const dup = mergeContractThreeWay('modules/team.md', MD_BASE, ours, MD_BASE + `\n## listTeams\n\n另一种写法\n`);
  assert.ok(!dup.ok);
  assert.match(dup.reason, /双方都新增了小节「listTeams」/);
});

test('Markdown：修改已有小节 → 失败', () => {
  const r = mergeContractThreeWay('modules/team.md', MD_BASE, MD_BASE + `\n## a\n\nx\n`, MD_BASE.replace('创建团队', '创建团队（改）'));
  assert.ok(!r.ok);
  assert.match(r.reason, /theirs 修改了已有的小节「createTeam」/);
});

test('其他文件 → 失败', () => {
  const r = mergeContractThreeWay('src/a.ts', 'a', 'b', 'c');
  assert.ok(!r.ok);
});
