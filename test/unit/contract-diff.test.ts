import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACTS } from '../helpers/contracts.ts';
import { contractDiff, isNullableColumn } from '../../src/core/contract-diff.ts';

const edit = (over: Record<string, string | null>): Record<string, string> => {
  const out: Record<string, string> = { ...CONTRACTS };
  for (const [k, v] of Object.entries(over)) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
};
const ok = (over: Record<string, string | null>, module: string | undefined = 'datasource') => assert.deepEqual(contractDiff(CONTRACTS, edit(over), module), []);
const bad = (over: Record<string, string | null>, re: RegExp, module: string | undefined = 'datasource') => {
  const vs = contractDiff(CONTRACTS, edit(over), module);
  assert.ok(vs.length > 0, '应有违规');
  assert.ok(vs.some((v) => re.test(`${v.path} ${v.message}`)), JSON.stringify(vs));
};
const add = (file: string, extra: string) => ({ [file]: CONTRACTS[file]! + extra });

test('没有改动：无违规', () => ok({}));

test('允许：新增 path、operation、响应状态码', () => {
  ok(add('paths/datasource.yaml', `/api/datasources/{id}:
  get:
    operationId: getDatasource
    responses:
      '200': { description: ok }
`));
  ok({ 'paths/datasource.yaml': CONTRACTS['paths/datasource.yaml']!.replace("  post:", "  put:\n    operationId: putDs\n    responses:\n      '200': { description: ok }\n  post:") });
  ok({ 'paths/datasource.yaml': CONTRACTS['paths/datasource.yaml']!.replace("      '201': { description: 已创建 }", "      '201': { description: 已创建 }\n      '400': { description: 参数错误 }") });
});

test('允许：响应与请求 schema 新增可选字段，新增 schema', () => {
  ok({ 'components/datasource.yaml': CONTRACTS['components/datasource.yaml']!.replace('name: { type: string } }', 'name: { type: string }, note: { type: string } }') + 'Extra:\n  type: object\n  required: [a]\n  properties: { a: { type: string } }\n' });
  const inline = `/api/datasources:
  post:
    operationId: createDatasource
    requestBody:
      content:
        application/json:
          schema:
            type: object
            required: [name]
            properties: { name: { type: string } }
    responses:
      '201': { description: ok }
`;
  const base = { ...CONTRACTS, 'paths/datasource.yaml': inline };
  const next = { ...base, 'paths/datasource.yaml': inline.replace('properties: { name: { type: string } }', 'properties: { name: { type: string }, tag: { type: string } }') };
  assert.deepEqual(contractDiff(base, next, 'datasource'), []);
});

test('允许：新错误码；不允许改 http/message', () => {
  ok(add('errors/datasource.yaml', 'DATASOURCE_GONE: { http: 404, message: 已删除 }\n'));
  bad({ 'errors/datasource.yaml': CONTRACTS['errors/datasource.yaml']!.replace('409', '400') }, /DATASOURCE_NAME_TAKEN\.http/);
  bad({ 'errors/datasource.yaml': CONTRACTS['errors/datasource.yaml']!.replace('数据源名称已存在', '重名') }, /message/);
  bad({ 'errors/datasource.yaml': '' }, /DATASOURCE_NAME_TAKEN/);
});

test('允许：modules/*.md 新增小节；不允许改旧小节或删除', () => {
  ok(add('modules/team.md', '\n## listTeams\n参数：无\n'), 'team');
  bad({ 'modules/team.md': CONTRACTS['modules/team.md']!.replace('string', 'number') }, /currentTeam/, 'team');
  bad({ 'modules/team.md': '# team\n' }, /currentTeam/, 'team');
  bad({ 'modules/team.md': CONTRACTS['modules/team.md']!.replace('# team', '# teams') }, /开头/, 'team');
});

test('data-model：新表、可空列、带默认值的列允许', () => {
  ok(add('data-model.yaml', '  audits:\n    columns: { id: { type: uuid, pk: true } }\n'));
  const dm = CONTRACTS['data-model.yaml']!;
  const withCol = (col: string) => ({ 'data-model.yaml': dm.replace('name: { type: string } }\n  datasources', `name: { type: string }, ${col} }\n  datasources`) });
  ok(withCol('memo: { type: string, nullable: true }'));
  ok(withCol('level: { type: int, default: 0 }'));
});

test('data-model：非空无默认列、修改列、删列、简写列不允许', () => {
  const dm = CONTRACTS['data-model.yaml']!;
  const withCol = (col: string) => ({ 'data-model.yaml': dm.replace('name: { type: string } }\n  datasources', `name: { type: string }, ${col} }\n  datasources`) });
  bad(withCol('memo: { type: string }'), /memo/);
  bad(withCol('memo: { type: string, nullable: false }'), /memo/);
  bad(withCol('memo: string'), /memo/);
  bad({ 'data-model.yaml': dm.replace('type: uuid, pk: true }, name', 'type: string, pk: true }, name') }, /tables\.teams\.columns\.id\.type/);
  bad({ 'data-model.yaml': dm.replace(', name: { type: string } }\n  datasources', ' }\n  datasources') }, /name/);
  bad({ 'data-model.yaml': dm.replace('  datasources:', '  sources:') }, /datasources/);
  assert.equal(isNullableColumn({ nullable: true }), true);
  assert.equal(isNullableColumn({ type: 'int', default: 0 }), true);
  assert.equal(isNullableColumn({ type: 'int' }), false);
});

test('不允许：删除、改名、改标量', () => {
  bad({ 'paths/datasource.yaml': CONTRACTS['paths/datasource.yaml']!.replace("      '201': { description: 已创建 }\n", '') }, /201/);
  bad({ 'paths/datasource.yaml': CONTRACTS['paths/datasource.yaml']!.replace('/api/datasources:', '/api/ds:') }, /\/api\/datasources/);
  bad({ 'paths/datasource.yaml': CONTRACTS['paths/datasource.yaml']!.replace('listDatasources', 'list') }, /operationId/);
  bad({ 'components/datasource.yaml': CONTRACTS['components/datasource.yaml']!.replace('type: object', 'type: array') }, /Datasource\.type/);
  bad({ 'components/datasource.yaml': CONTRACTS['components/datasource.yaml']!.replace('id: { type: string }', 'id: { type: integer }') }, /properties\.id\.type/);
  bad({ 'components/datasource.yaml': CONTRACTS['components/datasource.yaml']!.replace('type: object', 'type: object, format: x') }, /./);
  bad({ 'components/datasource.yaml': CONTRACTS['components/datasource.yaml']!.replace('id: { type: string }, ', '') }, /properties\.id/);
});

test('不允许：required 与 enum 的任何改动', () => {
  const sch = 'S:\n  type: object\n  required: [a]\n  properties: { a: { type: string }, b: { type: string, enum: [x, y] } }\n';
  const base = { ...CONTRACTS, 'components/datasource.yaml': sch };
  const run = (next: string) => contractDiff(base, { ...base, 'components/datasource.yaml': next }, 'datasource');
  assert.ok(run(sch.replace('[a]', '[a, b]')).some((v) => /required/.test(v.message)), '请求/通用 schema 新增必填');
  assert.ok(run(sch.replace('required: [a]\n  ', '')).some((v) => /required|删除/.test(v.message)));
  assert.ok(run(sch.replace('[x, y]', '[x, y, z]')).some((v) => /enum/.test(v.message)));
  assert.ok(run(sch.replace('[x, y]', '[y]')).some((v) => /enum/.test(v.message)));
  assert.ok(run(sch.replace('b: { type: string, enum: [x, y] }', 'b: { type: string }')).length > 0);
  // 已有 schema 上新增 required / enum 键
  const none = 'S:\n  type: object\n  properties: { a: { type: string } }\n';
  const b2 = { ...CONTRACTS, 'components/datasource.yaml': none };
  const v = contractDiff(b2, { ...b2, 'components/datasource.yaml': none.replace('type: object', 'type: object\n  required: [a]') }, 'datasource');
  assert.ok(v.some((x) => /required/.test(x.message)));
  // 新增必填字段（连同 required 一起改）与新 schema 里的 required 区分
  const added = sch.replace('[a]', '[a, c]').replace('b: {', 'c: { type: string }, b: {');
  assert.ok(run(added).some((x) => /required/.test(x.path)));
});

test('根文件 openapi.yaml：新增本模块 $ref 允许', () => {
  const root = CONTRACTS['openapi.yaml']!;
  ok({
    'openapi.yaml': root.replace("paths:\n", "paths:\n  /api/datasources/{id}:\n    $ref: './paths/datasource.yaml#/~1api~1datasources~1{id}'\n"),
    ...add('paths/datasource.yaml', "/api/datasources/{id}:\n  get:\n    operationId: g\n    responses:\n      '200': { description: ok }\n"),
  });
});

test('根文件 openapi.yaml：指向别的模块、带多余键、改已有键、删键、改 components 不允许', () => {
  const root = CONTRACTS['openapi.yaml']!;
  const withPath = (body: string) => ({ 'openapi.yaml': root.replace('paths:\n', `paths:\n  /api/new:\n${body}`) });
  bad(withPath("    $ref: './paths/team.yaml#/~1api~1new'\n"), /paths\.\/api\/new/);
  bad(withPath("    get: { responses: { '200': { description: ok } } }\n"), /paths\.\/api\/new/);
  bad(withPath("    $ref: './paths/datasource.yaml#/x'\n    summary: s\n"), /paths\.\/api\/new/);
  bad({ 'openapi.yaml': root.replace("./paths/datasource.yaml#/~1api~1datasources", "./paths/datasource.yaml#/~1api~1other") }, /修改已有路径/);
  bad({ 'openapi.yaml': root.replace("  /api/teams:\n    $ref: './paths/team.yaml#/~1api~1teams'\n", '') }, /删除/);
  bad({ 'openapi.yaml': root.replace('required: [code, message]', 'required: [code]') }, /components/);
  bad({ 'openapi.yaml': root.replace('paths:\n', '    Extra: { type: string }\npaths:\n') }, /components/);
  bad({ 'openapi.yaml': root.replace('1.0.0', '2.0.0') }, /info/);
  // 未指定 module 时，任意 ./paths/*.yaml 引用都可以
  assert.deepEqual(contractDiff(CONTRACTS, edit(withPath("    $ref: './paths/team.yaml#/~1api~1new'\n")), undefined), []);
});

test('文件归属：改别的模块的文件不允许；未指定 module 时不检查', () => {
  const next = { 'paths/team.yaml': CONTRACTS['paths/team.yaml']! + "/api/teams/{id}:\n  get:\n    operationId: g\n    responses:\n      '200': { description: ok }\n" };
  bad(next, /datasource|变更请求/);
  bad({ 'errors/common.yaml': CONTRACTS['errors/common.yaml']! + 'X: { http: 400, message: x }\n' }, /common/);
  assert.deepEqual(contractDiff(CONTRACTS, edit(next), undefined), []);
});

test('新建文件：本模块允许，别的模块不允许；删除文件不允许', () => {
  ok({ 'paths/datasource2.yaml': 'x: 1\n' }, 'datasource2');
  bad({ 'paths/datasource2.yaml': 'x: 1\n' }, /变更请求/);
  ok({ 'modules/datasource.md': '# datasource\n\n## f\n' });
  bad({ 'paths/team.yaml': null }, /.*/, undefined);
  bad({ 'errors/datasource.yaml': null }, /删除/);
  bad({ 'README.md': 'x' }, /不得新建/);
});

test('YAML 解析失败', () => {
  bad({ 'paths/datasource.yaml': 'a: [unclosed\n' }, /合法的 YAML/);
  bad({ 'openapi.yaml': 'a: [unclosed\n' }, /合法的 YAML/);
  bad({ 'data-model.yaml': ': : :\n  - [' }, /合法的 YAML/);
});

test('违规带文件与路径', () => {
  const vs = contractDiff(CONTRACTS, edit({ 'paths/datasource.yaml': CONTRACTS['paths/datasource.yaml']!.replace('listDatasources', 'list') }), 'datasource');
  assert.equal(vs[0]!.file, 'docs/contracts/paths/datasource.yaml');
  assert.equal(vs[0]!.path, '/api/datasources.get.operationId');
});
