import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { contractFilesAt, contractFilesInDir, errorPrefix, parseContracts } from '../../src/core/contract-check.ts';
import { CONTRACTS } from '../helpers/contracts.ts';
import { tmpRepo } from '../helpers/repo.ts';

const check = (patch: Record<string, string | null> = {}) => {
  const files: Record<string, string> = { ...CONTRACTS };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete files[k]; else files[k] = v; }
  return parseContracts(files);
};
const messages = (r: ReturnType<typeof check>) => r.errors.map((e) => `${e.file}: ${e.message}`).join('\n');

test('合格的契约零错误，符号目录包含接口、表、错误码与跨模块函数', () => {
  const r = check();
  assert.deepEqual(r.errors, []);
  assert.deepEqual([...r.catalog.apis.keys()].sort(), ['GET /api/datasources', 'GET /api/teams', 'POST /api/datasources']);
  assert.equal(r.catalog.apis.get('POST /api/datasources')!.module, 'datasource');
  assert.deepEqual([...r.catalog.tables.keys()], ['teams', 'datasources']);
  assert.deepEqual([...r.catalog.errors.keys()].sort(), ['DATASOURCE_NAME_TAKEN', 'FORBIDDEN']);
  assert.equal(r.catalog.errors.get('DATASOURCE_NAME_TAKEN')!.http, 409);
  assert.deepEqual([...r.catalog.fns.keys()], ['team#currentTeam']);
});

test('YAML 语法错误与缺少根文件', () => {
  assert.match(messages(check({ 'paths/team.yaml': '/api/teams:\n  get: [unclosed' })), /paths\/team\.yaml: 不是合法的 YAML/);
  assert.match(messages(check({ 'openapi.yaml': null })), /缺少根文件 openapi\.yaml/);
  assert.match(messages(check({ 'openapi.yaml': CONTRACTS['openapi.yaml']!.replace('openapi: 3.1.0', 'swagger: "2.0"') })), /openapi: 3\.1\.0/);
});

test('根文件 paths 只能写指向 paths/<模块>.yaml 的 $ref', () => {
  const inline = CONTRACTS['openapi.yaml']!.replace("    $ref: './paths/team.yaml#/~1api~1teams'", '    get: { responses: { "200": { description: ok } } }');
  assert.match(messages(check({ 'openapi.yaml': inline })), /\/api\/teams 只能写一条 \$ref/);
  const other = CONTRACTS['openapi.yaml']!.replace('./paths/team.yaml', './components/datasource.yaml');
  assert.match(messages(check({ 'openapi.yaml': other })), /\/api\/teams 只能写一条 \$ref/);
});

test('$ref 指向不存在的文件、找不到的位置、或 docs/contracts 之外都报错', () => {
  assert.match(messages(check({ 'openapi.yaml': CONTRACTS['openapi.yaml']!.replace('./paths/team.yaml', './paths/teams.yaml') })), /引用的文件 paths\/teams\.yaml 不存在/);
  assert.match(messages(check({ 'openapi.yaml': CONTRACTS['openapi.yaml']!.replace('~1api~1teams', '~1api~1team') })), /找不到 \/~1api~1team/);
  assert.match(messages(check({ 'paths/datasource.yaml': CONTRACTS['paths/datasource.yaml']!.replace('#/Datasource', '#/Missing') })), /components\/datasource\.yaml 中找不到 \/Missing/);
  assert.match(messages(check({ 'paths/datasource.yaml': CONTRACTS['paths/datasource.yaml']!.replace('../components/datasource.yaml', '../../src/x.yaml') })), /docs\/contracts\/ 之外/);
});

test('operation 必须有 responses；没有 operation 的 path item 报错；缺 operationId 只警告', () => {
  const noResp = '/api/teams:\n  get:\n    description: x\n';
  const r = check({ 'paths/team.yaml': noResp });
  assert.match(messages(r), /GET \/api\/teams 必须写 responses/);
  assert.match(r.warnings.map((w) => w.message).join(), /GET \/api\/teams 缺少 operationId/);
  assert.match(messages(check({ 'paths/team.yaml': '/api/teams:\n  summary: 无操作\n' })), /\/api\/teams 没有任何 operation/);
});

test('paths 文件里没有被根文件引用的路径给出警告', () => {
  const r = check({ 'paths/team.yaml': `${CONTRACTS['paths/team.yaml']}/api/teams/{id}:\n  get:\n    operationId: getTeam\n    responses: { '200': { description: ok } }\n` });
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.map((w) => w.message).join(), /\/api\/teams\/\{id\} 没有在 openapi\.yaml 的 paths 中引用/);
  assert.ok(!r.catalog.apis.has('GET /api/teams/{id}'), '未引用的路径不算契约里的接口');
});

test('错误码：模块前缀、格式、http 与 message、全局唯一', () => {
  assert.equal(errorPrefix('data-source'), 'DATA_SOURCE_');
  assert.match(messages(check({ 'errors/datasource.yaml': 'NAME_TAKEN: { http: 409, message: x }\n' })), /NAME_TAKEN 必须以模块前缀 DATASOURCE_ 开头/);
  assert.match(messages(check({ 'errors/datasource.yaml': 'DATASOURCE_bad: { http: 409, message: x }\n' })), /只能用大写字母/);
  assert.match(messages(check({ 'errors/datasource.yaml': 'DATASOURCE_X: { http: 999, message: x }\n' })), /http（100–599 的整数）与 message/);
  assert.match(messages(check({ 'errors/datasource.yaml': 'DATASOURCE_X: { http: 400 }\n' })), /http（100–599 的整数）与 message/);
  assert.match(messages(check({ 'errors/team.yaml': 'FORBIDDEN: { http: 403, message: x }\n' })), /FORBIDDEN 必须以模块前缀 TEAM_ 开头[\s\S]*FORBIDDEN 与 docs\/contracts\/errors\/common\.yaml 重复/);
});

test('数据模型：必须有 tables，每张表要写 columns', () => {
  assert.match(messages(check({ 'data-model.yaml': 'models: {}\n' })), /必须有 tables 映射/);
  assert.match(messages(check({ 'data-model.yaml': 'tables:\n  teams: { comment: x }\n' })), /表 teams 必须写 columns/);
  assert.deepEqual(check({ 'data-model.yaml': null }).errors, [], '没有数据库的项目可以不写 data-model.yaml');
});

test('modules/<m>.md：## 标题即函数，同一文件内重复报错；文件位置与模块名受限', () => {
  assert.match(messages(check({ 'modules/team.md': '## a\n## a\n' })), /函数 a 重复定义/);
  assert.match(messages(check({ 'paths/sub/x.yaml': 'a: 1\n' })), /paths\/ 下只能放 <模块>\.yaml/);
  assert.match(messages(check({ 'errors/Bad_Mod.yaml': 'BAD_MOD_X: { http: 400, message: x }\n' })), /模块名 Bad_Mod/);
});

test('从 git 引用与工作区读取契约文件', () => {
  const r = tmpRepo();
  try {
    for (const [rel, text] of Object.entries(CONTRACTS)) {
      mkdirSync(path.dirname(path.join(r.dir, 'docs/contracts', rel)), { recursive: true });
      writeFileSync(path.join(r.dir, 'docs/contracts', rel), text);
    }
    writeFileSync(path.join(r.dir, 'README.md'), 'x\n');
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'contracts');
    assert.deepEqual(contractFilesAt(r.dir, 'HEAD'), CONTRACTS);
    assert.deepEqual(contractFilesInDir(r.dir), CONTRACTS);
    assert.deepEqual(contractFilesAt(r.dir, 'no-such-branch'), {});
  } finally { r.cleanup(); }
});

test('空文件（含 /forge init 留下的 .gitkeep）视为不存在；其他多余文件的报错提示清空即可（偏离 83）', () => {
  assert.deepEqual(check({ 'paths/.gitkeep': '', 'components/.gitkeep': '', 'errors/.gitkeep': '\n', 'errors/records.yaml': '  \n' }).errors, []);
  assert.match(messages(check({ 'paths/notes.txt': 'x' })), /不能有子目录或其他文件（不需要的文件把内容清空即可/);
});
