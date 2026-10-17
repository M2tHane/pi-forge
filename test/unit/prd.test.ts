// docs/PRD.md 的解析与检查（纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acMap, acTexts, checkPrd, conventionsSection, pageOf, parsePrd, prototypePath } from '../../src/core/spec/prd.ts';

const PRD = [
  '# 库存管理 PRD',
  '',
  '## 6. 需求',
  '',
  '### 6.1 登录  REQ-001',
  '用户用账号密码登录。',
  '',
  '- AC1 Given 已注册 When 输入正确的密码 Then 进入首页',
  '- AC2：Given 密码错误 When 登录 Then 提示"账号或密码错误"',
  '  补充说明不算 AC',
  '',
  '### 6.3 商品  REQ-003',
  '- AC1 Given 有商品 When 打开列表 Then 按名称排序',
  '```',
  '- AC9 代码块里的不算',
  '```',
  '#### 字段',
  '- AC2 Given 名称为空 When 保存 Then 提示必填',
  '',
  '## 7. 页面',
  '',
  '| 页面 | 原型文件 | 对应需求 |',
  '|---|---|---|',
  '| login | docs/prototype/login.html | REQ-001 |',
  '| 商品列表 | `products.html` | REQ-003、REQ-004 |',
  '',
  '- AC3 页面表之后、下一个需求之前的 AC 不属于任何需求',
  '',
  '## 8. 通用约定',
  '- 名称最长 50 个字符',
  '- 金额保留两位小数',
  '',
  '## 9. 不做的',
  '- 导出',
].join('\n');

test('parsePrd：标题里的 REQ 编号、需求下以 - ACn 开头的行、页面表', () => {
  const prd = parsePrd(PRD);
  assert.deepEqual(prd.reqs.map((r) => [r.id, r.title, r.acs.map((a) => a.id)]), [
    ['REQ-001', '6.1 登录', ['AC1', 'AC2']],
    ['REQ-003', '6.3 商品', ['AC1', 'AC2']],
  ]);
  assert.equal(prd.reqs[0]!.acs[1]!.text, 'Given 密码错误 When 登录 Then 提示"账号或密码错误"');
  assert.equal(prd.reqs[0]!.line, 5);
  assert.deepEqual(prd.pages.map((p) => [p.name, p.file, p.reqs]), [
    ['login', 'docs/prototype/login.html', ['REQ-001']],
    ['商品列表', 'docs/prototype/products.html', ['REQ-003', 'REQ-004']],
  ]);
  assert.equal(acMap(prd).get('REQ-003.AC2'), 'Given 名称为空 When 保存 Then 提示必填');
  assert.deepEqual(acTexts(prd, ['REQ-001.AC1', 'REQ-404.AC1']), { 'REQ-001.AC1': 'Given 已注册 When 输入正确的密码 Then 进入首页' });
});

test('checkPrd：没有 REQ、REQ 没有 AC、编号重复、原型文件缺失或没写时只给警告', () => {
  assert.match(checkPrd(parsePrd('# 只有标题\n正文'), () => true).join('\n'), /没有解析出任何需求/);
  const md = [
    '### 登录 REQ-001', '- AC1 a', '- AC1 b',
    '### 登录 REQ-001', '- AC1 c',
    '### 注册 REQ-002', '说明但没有 AC',
    '| 页面 | 原型文件 |', '| --- | --- |', '| 登录 | login.html |', '| 注册 | |',
  ].join('\n');
  const warnings = checkPrd(parsePrd(md), (rel) => rel !== 'docs/prototype/login.html');
  assert.deepEqual(warnings, [
    'REQ-001.AC1 出现了两次（第 3 行）',
    'REQ-001 出现了两次（第 1 行与第 4 行）',
    'REQ-002「注册」没有验收标准：在需求下面每条一行，以「- AC1」开头',
    '页面「登录」的原型文件 docs/prototype/login.html 不存在',
    '页面表第 11 行「注册」没有写原型文件',
  ]);
  assert.deepEqual(checkPrd(parsePrd(PRD), () => true), []);
});

test('prototypePath、pageOf、conventionsSection', () => {
  assert.equal(prototypePath('[商品](docs/prototype/p/list.html)'), 'docs/prototype/p/list.html');
  assert.equal(prototypePath('./a.html'), 'docs/prototype/a.html');
  assert.equal(prototypePath(' '), '');
  const prd = parsePrd(PRD);
  assert.equal(pageOf(prd, 'login')?.file, 'docs/prototype/login.html');
  assert.equal(pageOf(prd, 'products')?.name, '商品列表');
  assert.equal(pageOf(prd, 'nope'), undefined);
  assert.equal(conventionsSection(PRD), '- 名称最长 50 个字符\n- 金额保留两位小数');
  assert.equal(conventionsSection('# 无'), '');
});
