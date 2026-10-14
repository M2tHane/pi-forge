import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACTS } from '../helpers/contracts.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { contractDiff, contractViolationsAt, isNullableColumn } from '../../src/core/plan/contract-diff.ts';
import { tmpRepo } from '../helpers/repo.ts';

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

test('模块文件包在 paths: 下也接受：新增 path 与 operation 允许，path item 下新增非 operation 键仍不允许', () => {
  const wrapped = "paths:\n  /api/boards:\n    get:\n      responses:\n        '200': { description: ok }\n";
  const base = { ...CONTRACTS, 'paths/boards.yaml': wrapped };
  const grown = { ...base, 'paths/boards.yaml': wrapped + "  /api/boards/{id}/archive:\n    post:\n      responses:\n        '200': { description: ok }\n" };
  assert.deepEqual(contractDiff(base, grown, 'boards'), []);
  const op = { ...base, 'paths/boards.yaml': wrapped.replace('    get:', "    post:\n      responses:\n        '201': { description: ok }\n    get:") };
  assert.deepEqual(contractDiff(base, op, 'boards'), []);
  const badKey = { ...base, 'paths/boards.yaml': wrapped.replace('    get:', '    summary: x\n    get:') };
  assert.ok(contractDiff(base, badKey, 'boards').some((v) => /只能新增 operation/.test(v.message)));
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

test('根文件 openapi.yaml：已有路径可追加 operation 与可选参数、components 可追加 schema 与可选字段；改引用、删路径、改已有值、改 info 不允许', () => {
  const root = CONTRACTS['openapi.yaml']!;
  const withPath = (body: string) => ({ 'openapi.yaml': root.replace('paths:\n', `paths:\n  /api/new:\n${body}`) });
  // 新路径：任意模块的 $ref 或内联 path item 都可以；$ref 带多余键不行
  ok(withPath("    $ref: './paths/team.yaml#/~1api~1new'\n"));
  ok(withPath("    get: { responses: { '200': { description: ok } } }\n"));
  bad(withPath("    $ref: './paths/datasource.yaml#/x'\n    summary: s\n"), /paths\.\/api\/new/);
  bad({ 'openapi.yaml': root.replace("./paths/datasource.yaml#/~1api~1datasources", "./paths/datasource.yaml#/~1api~1other") }, /修改已有路径/);
  bad({ 'openapi.yaml': root.replace("  /api/teams:\n    $ref: './paths/team.yaml#/~1api~1teams'\n", '') }, /删除/);
  bad({ 'openapi.yaml': root.replace('required: [code, message]', 'required: [code]') }, /components/);
  bad({ 'openapi.yaml': root.replace('1.0.0', '2.0.0') }, /info/);
  // components：新增 schema、已有 schema 新增可选字段允许；改已有字段不允许
  ok({ 'openapi.yaml': root.replace('paths:\n', '    Extra: { type: string }\npaths:\n') });
  ok({ 'openapi.yaml': root.replace('message: { type: string } }', 'message: { type: string }, hint: { type: string } }') });
  bad({ 'openapi.yaml': root.replace('code: { type: string }', 'code: { type: integer }') }, /components\.schemas\.Error/);
  // 根文件内联的 path item：追加可选参数允许，必填参数不允许
  const inline = root.replace('paths:\n', "paths:\n  /api/inline:\n    get:\n      parameters:\n        - { name: q, in: query, schema: { type: string } }\n      responses: { '200': { description: ok } }\n");
  const base = { ...CONTRACTS, 'openapi.yaml': inline };
  const more = inline.replace("        - { name: q, in: query, schema: { type: string } }\n", "        - { name: q, in: query, schema: { type: string } }\n        - { name: archived, in: query, schema: { type: boolean } }\n");
  assert.deepEqual(contractDiff(base, { ...base, 'openapi.yaml': more }, 'datasource'), []);
  const must = inline.replace("        - { name: q, in: query, schema: { type: string } }\n", "        - { name: q, in: query, schema: { type: string } }\n        - { name: id, in: query, required: true, schema: { type: string } }\n");
  assert.ok(contractDiff(base, { ...base, 'openapi.yaml': must }, 'datasource').some((v) => /必须是可选/.test(v.message)));
  const changed = inline.replace("- { name: q, in: query, schema: { type: string } }", "- { name: q, in: query, schema: { type: integer } }");
  assert.ok(contractDiff(base, { ...base, 'openapi.yaml': changed }, 'datasource').some((v) => /不得修改已有参数/.test(v.message)));
});

test('模块文件的 operation：新增 parameters 键（全部可选）允许；已有 parameters 追加可选参数允许，删参数不允许', () => {
  const file = CONTRACTS['paths/datasource.yaml']!;
  const withParams = file.replace('  post:', "  post:\n    parameters:\n      - { name: dry, in: query, schema: { type: boolean } }");
  ok({ 'paths/datasource.yaml': withParams });
  bad({ 'paths/datasource.yaml': file.replace('  post:', "  post:\n    parameters:\n      - { name: team, in: header, required: true, schema: { type: string } }") }, /必须是可选/);
  const base = { ...CONTRACTS, 'paths/datasource.yaml': withParams };
  assert.deepEqual(contractDiff(base, { ...base, 'paths/datasource.yaml': withParams.replace("{ name: dry, in: query, schema: { type: boolean } }", "{ name: dry, in: query, schema: { type: boolean } }\n      - { name: verbose, in: query, schema: { type: boolean } }") }, 'datasource'), []);
  const two = withParams.replace("{ name: dry, in: query, schema: { type: boolean } }", "{ name: dry, in: query, schema: { type: boolean } }\n      - { name: verbose, in: query, schema: { type: boolean } }");
  const base2 = { ...CONTRACTS, 'paths/datasource.yaml': two };
  assert.ok(contractDiff(base2, { ...base2, 'paths/datasource.yaml': withParams }, 'datasource').some((v) => /不得删除或改名已有参数/.test(v.message)));
  assert.ok(contractDiff(base, { ...base, 'paths/datasource.yaml': file }, 'datasource').some((v) => /不得删除或改名已有内容 parameters/.test(v.message)));
});

test('文件归属：改别的模块的契约文件也可以，只看是否追加', () => {
  const next = { 'paths/team.yaml': CONTRACTS['paths/team.yaml']! + "/api/teams/{id}:\n  get:\n    operationId: g\n    responses:\n      '200': { description: ok }\n" };
  ok(next);
  ok({ 'errors/common.yaml': CONTRACTS['errors/common.yaml']! + 'X: { http: 400, message: x }\n' });
  assert.deepEqual(contractDiff(CONTRACTS, edit(next), undefined), []);
});

test('新建文件：模块文件允许（不限本模块）；删除文件不允许', () => {
  ok({ 'paths/datasource2.yaml': 'x: 1\n' }, 'datasource2');
  ok({ 'paths/datasource2.yaml': 'x: 1\n' });
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

test('contractViolationsAt：读基准提交与 worktree 的 docs/contracts/，未改动时无违规，追加合法、删除被拦下', () => {
  const repo = tmpRepo();
  try {
    for (const [rel, text] of Object.entries(CONTRACTS)) {
      mkdirSync(path.dirname(path.join(repo.dir, 'docs/contracts', rel)), { recursive: true });
      writeFileSync(path.join(repo.dir, 'docs/contracts', rel), text);
    }
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'contracts');
    assert.deepEqual(contractViolationsAt(repo.dir, 'HEAD', repo.dir, 'datasource'), []);
    rmSync(path.join(repo.dir, 'docs/contracts/paths/datasource.yaml'));
    assert.match(JSON.stringify(contractViolationsAt(repo.dir, 'HEAD', repo.dir, 'datasource')), /不得删除已有契约文件/);
  } finally { repo.cleanup(); }
});
