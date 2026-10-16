import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acTexts, conventionsSection, effectiveSpec, lintSpec, parseRequirements, UNTESTABLE_WORDS, WARNING_RULES } from '../../src/core/spec/spec.ts';
import type { SpecFiles } from '../../src/core/spec/spec.ts';

const requirement = (id = 'REQ-001', ac = '- AC1：Given 已登录 When 创建看板 Then 返回看板编号', priority = 'MVP'): string =>
  `### ${id} 创建看板 [${priority}]\n角色：管理员、成员\n${ac}`;
const screen = (refs = 'REQ-001', route = '/boards'): string => `## 看板列表 ${route}
REQ：${refs}
字段：名称
交互：创建看板
状态：
| 状态 | 表现 |
| 加载 | 骨架屏 |
| 空 | 创建按钮 |
| 错误 | 错误条和重试 |
| 无权限 | N/A：所有角色均可查看列表 |`;
const matrix = '| 资源 · 操作 | 管理员 | 成员 |\n| --- | --- | --- |\n| 看板 · 创建 | ✓ | 仅本团队 |';
const baseline: SpecFiles = {
  requirements: `# 需求\n\n## 背景与目标\n团队维护看板。\n\n## 需求清单\n${requirement()}\n\n## 范围外\n跨团队访问。`,
  screens: `# 页面\n${screen()}`,
  permissions: `# 权限\n${matrix}`,
  glossary: '# 团队看板\n\n## 术语\n**管理员（Admin）**：\n管理团队的角色。\n_不要叫_：超级用户\n\n**成员（Member）**：\n团队内的普通用户。\n\n**看板（Board）**：\n一组按列排列的卡片。\n_不要叫_：面板、kanban',
};
/** 只警告的规则（WARNING_RULES）在 warnings 里查 */
function checkRule(base: SpecFiles, rule: string, exists: boolean, warning = WARNING_RULES.has(rule)): void {
  const result = lintSpec(base);
  assert.equal((warning ? result.warnings : result.errors).some((issue) => issue.rule === rule), exists, JSON.stringify(result));
}

test('完整规格零错误、零警告；保留需求、页面、权限与术语的结构', () => {
  assert.deepEqual(lintSpec(baseline), { errors: [], warnings: [] });
  const spec = effectiveSpec(baseline);
  assert.equal(spec.reqs[0]!.title, '创建看板');
  assert.deepEqual(spec.reqs[0]!.roles, ['管理员', '成员']);
  assert.equal(spec.reqs[0]!.acs[0]!.given, '已登录');
  assert.equal(spec.reqs[0]!.acs[0]!.when, '创建看板');
  assert.equal(spec.reqs[0]!.acs[0]!.then, '返回看板编号');
  assert.equal(spec.screens[0]!.route, '/boards');
  assert.equal(spec.permissions[0]!.grants['成员'], '仅本团队');
  assert.deepEqual(spec.glossary.at(-1)!.aliases, ['面板', 'kanban']);
  assert.equal(spec.glossary.at(-1)!.english, 'Board');
});

test('空白、CRLF、半角冒号、GWT 大小写和多行 AC 可解析', () => {
  const md = '  ###   REQ-001 创建看板 [MVP]\r\n角色 : 管理员, 成员\r\n- AC1 : gIvEn: 已登录\r\n  WHEN ： 创建看板\r\n  then: 返回编号\r\n- AC2 ( MANUAL ) : 列表显示新看板';
  const parsed = parseRequirements(md, 'custom.md');
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.reqs[0]!.roles, ['管理员', '成员']);
  assert.equal(parsed.reqs[0]!.line, 1);
  assert.equal(parsed.reqs[0]!.file, 'custom.md');
  assert.equal(parsed.reqs[0]!.acs[0]!.then, '返回编号');
  assert.equal(parsed.reqs[0]!.acs[1]!.manual, true);
  const files = { ...baseline, requirements: md, screens: screen().replaceAll('：', ':'), glossary: baseline.glossary.replaceAll('（', '(').replaceAll('）', ')').replaceAll('：', ':') };
  assert.deepEqual(lintSpec(files).errors, []);
});

test('REQ 全局重复报错，编号不同通过', () => {
  checkRule({ ...baseline, requirements: `${requirement()}\n${requirement('REQ-002')}` }, 'req-duplicate', false);
  checkRule({ ...baseline, requirements: `${requirement()}\n${requirement()}` }, 'req-duplicate', true);
});

test('新增 REQ 连续时无警告，跳号只有警告', () => {
  checkRule({ ...baseline, requirements: `${requirement()}\n${requirement('REQ-002')}` }, 'req-sequence', false, true);
  const result = lintSpec({ ...baseline, requirements: `${requirement()}\n${requirement('REQ-003')}` });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((item) => item.rule === 'req-sequence'));
});

test('优先级仅允许 MVP、LATER、NO，缺失或其他值报错', () => {
  for (const priority of ['MVP', 'LATER', 'NO']) checkRule({ ...baseline, requirements: requirement('REQ-001', undefined, priority) }, 'priority', false);
  checkRule({ ...baseline, requirements: requirement().replace('[MVP]', '[ MVP ]') }, 'priority', false);
  for (const priority of ['P0', 'mvp', '']) checkRule({ ...baseline, requirements: requirement('REQ-001', undefined, priority) }, 'priority', true);
  checkRule({ ...baseline, requirements: requirement().replace(' [MVP]', '') }, 'priority', true);
  assert.ok(parseRequirements('### REQ-001 创建看板 [P0]').issues.some((item) => item.rule === 'priority'));
});

test('MVP 必须有 AC，LATER 和 NO 可无 AC', () => {
  checkRule(baseline, 'ac-required', false);
  checkRule({ ...baseline, requirements: requirement('REQ-001', '') }, 'ac-required', true);
  for (const priority of ['LATER', 'NO']) assert.deepEqual(lintSpec({ ...baseline, requirements: requirement('REQ-001', '', priority) }).errors, []);
});

for (const keyword of ['Given', 'When', 'Then']) {
  test(`自动 AC 缺 ${keyword} 警告，完整三段通过`, () => {
    checkRule(baseline, 'ac-gwt', false);
    checkRule({ ...baseline, requirements: requirement().replace(keyword, '') }, 'ac-gwt', true);
  });
}

test('GWT 空段或顺序错误警告，manual 可不用 GWT 但不能空白', () => {
  for (const ac of ['Given When 创建 Then 成功', 'Given 已登录 When Then 成功', 'Given 已登录 When 创建 Then', 'When 创建 Given 已登录 Then 成功']) {
    checkRule({ ...baseline, requirements: requirement('REQ-001', `- AC1：${ac}`) }, 'ac-gwt', true);
  }
  assert.deepEqual(lintSpec({ ...baseline, requirements: requirement('REQ-001', '- AC1（manual）：列表第一行显示新看板') }).errors, []);
  checkRule({ ...baseline, requirements: requirement('REQ-001', '- AC1（manual）：') }, 'ac-format', true);
});

test('AC 编号在单个 REQ 内不得重复，不同 REQ 可复用 AC1', () => {
  checkRule({ ...baseline, requirements: `${requirement()}\n${requirement('REQ-002')}` }, 'ac-duplicate', false);
  checkRule({ ...baseline, requirements: `${requirement()}\n- AC1（manual）：检查列表` }, 'ac-duplicate', true);
  checkRule({ ...baseline, requirements: `${requirement()}\n- AC2（manual）：检查列表` }, 'ac-duplicate', false);
});

test('非法 REQ 与 AC 格式报告可修复的错误与行号', () => {
  for (const md of ['## REQ-001 标题 [MVP]', '### REQ-1 标题 [MVP]', '### REQ-abc 标题 [MVP]', '### REQ-001 [MVP]']) {
    assert.ok(parseRequirements(md, 'input.md').issues.some((item) => item.rule === 'req-format' && item.line === 1));
  }
  const acIssue = parseRequirements(`${requirement()}\n- AC2 内容没有冒号`, 'input.md').issues.find((item) => item.rule === 'ac-format')!;
  assert.equal(acIssue.line, 4);
  assert.match(acIssue.message, /input\.md:4.*ac-format.*AC1/);
  assert.ok(parseRequirements('- AC1：Given 条件 When 操作 Then 结果').issues.some((item) => item.rule === 'ac-format'));
  checkRule({ ...baseline, requirements: '' }, 'req-format', true);
});

test('页面必须有 REQ 行并引用生效需求；非法编号不被猜测', () => {
  checkRule(baseline, 'screen-req', false);
  for (const screens of [screen().replace('REQ：REQ-001', ''), screen('REQ-999'), screen('REQ-001、REQ-2'), screen('')]) {
    checkRule({ ...baseline, screens }, 'screen-req', true);
  }
  assert.deepEqual(lintSpec({ ...baseline, requirements: `${requirement()}\n${requirement('REQ-002')}`, screens: screen('REQ-001、REQ-002') }).errors, []);
});

for (const state of ['加载', '空', '错误', '无权限']) {
  test(`页面缺少 ${state} 状态警告，有四态且无溢出行通过`, () => {
    checkRule(baseline, 'screen-state', false);
    const screens = screen().split('\n').filter((line) => !line.startsWith(`| ${state} |`)).join('\n');
    checkRule({ ...baseline, screens }, 'screen-state', true);
  });
}

test('状态 N/A 必须有理由，全半角冒号与大小写均可', () => {
  for (const value of ['N/A：所有角色可访问', 'n/a: 公共页面', 'N/A : 无']) {
    checkRule({ ...baseline, screens: screen().replace('N/A：所有角色均可查看列表', value) }, 'screen-na', false);
  }
  checkRule({ ...baseline, screens: `${screen()}\n| 溢出 | N/A |` }, 'screen-na', true);
  for (const value of ['N/A', 'N/A：', 'N/A:   ', 'N/A 没有冒号']) {
    checkRule({ ...baseline, screens: screen().replace('N/A：所有角色均可查看列表', value) }, 'screen-na', true);
  }
});

test('页面路由或状态表无法解析时警告，溢出行可选', () => {
  checkRule({ ...baseline, screens: screen().replace('/boards', 'boards') }, 'screen-format', true);
  checkRule({ ...baseline, screens: screen().replace('| 加载 | 骨架屏 |', '| 加载 | 骨架屏 | 多余列 |') }, 'screen-state', true);
  checkRule({ ...baseline, screens: `${screen()}\n| 加载 | 再次加载 |` }, 'screen-state', true);
  assert.deepEqual(lintSpec({ ...baseline, screens: `${screen()}\n| 溢出 | 分页 |` }).errors, []);
});

test('权限表无法解析、列数不齐、空单元格、重复角色均警告；空文件不警告', () => {
  checkRule(baseline, 'permissions-table', false);
  checkRule({ ...baseline, permissions: '' }, 'permissions-table', false);
  for (const permissions of ['管理员能创建', '| 资源 |', '| 资源 | 管理员 |\n看板 ✓', '| 资源 | 管理员 |\n| 看板 | ✓ | 多余列 |', '| 资源 | 管理员 |\n| 看板 | |', '| 资源 | 管理员 | 管理员 |', '| --- | --- |', '| 资源 | 管理员 |\n| --- | --- | --- |']) {
    checkRule({ ...baseline, permissions }, 'permissions-table', true);
  }
});

test('权限可包含多个矩阵，转义竖线作为条件正文保留', () => {
  const permissions = `${matrix}\n\n| 资源 · 操作 | 管理员 |\n| --- | --- |\n| 看板 · 删除 | 所有者 \\| 团队负责人 |`;
  const spec = effectiveSpec({ ...baseline, permissions });
  assert.deepEqual(spec.issues, []);
  assert.equal(spec.permissions.at(-1)!.grants['管理员'], '所有者 | 团队负责人');
});

test('权限表的角色不必在术语表里', () => {
  assert.deepEqual(lintSpec({ ...baseline, permissions: matrix.replace('管理员', '访客') }), { errors: [], warnings: [] });
});

test('术语格式：缺中文主名、英文名或定义时警告', () => {
  checkRule(baseline, 'glossary-format', false);
  for (const glossary of ['**管理员**：\n管理团队。', '**管理员（Admin）**：']) checkRule({ ...baseline, glossary }, 'glossary-format', true);
});

for (const file of ['requirements', 'screens', 'permissions', 'glossary'] as const) {
  test(`${file} 的 TODO、TBD、待定均警告且有行号`, () => {
    checkRule(baseline, 'placeholder', false);
    for (const word of ['TODO', 'TBD：价格', '（TODO）', '待定']) {
      const content = `${baseline[file]}\n${word}`;
      const result = lintSpec({ ...baseline, [file]: content });
      assert.ok(!result.errors.some((item) => item.rule === 'placeholder'));
      const found = result.warnings.find((item) => item.rule === 'placeholder')!;
      assert.equal(found.file, `docs/spec/${file}.md`);
      assert.equal(found.line, content.split('\n').length);
      assert.match(found.message, /替换/);
    }
  });
}

test('Todo、TodoCollection、todo list 这类合法术语不是占位词（只认大写独立的 TODO/TBD）', () => {
  for (const word of ['**待办（Todo）**：清单项。', 'TodoCollection', 'a todo list', 'TBDX', 'Stbd']) checkRule({ ...baseline, glossary: `${baseline.glossary}\n${word}` }, 'placeholder', false);
});

for (const word of UNTESTABLE_WORDS) {
  test(`AC 中的 ${word} 只给警告，具体行为没有警告`, () => {
    checkRule(baseline, 'ac-untestable', false, true);
    const result = lintSpec({ ...baseline, requirements: requirement('REQ-001', `- AC1：Given 已登录 When 创建 Then ${word}返回编号`) });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((item) => item.rule === 'ac-untestable'));
  });
}

test('单条 REQ 的 AC 超过 6 条只给警告 ac-too-many，6 条及以下没有', () => {
  const acs = (n: number) => Array.from({ length: n }, (_, i) => `- AC${i + 1}：Given 已登录 When 创建看板 Then 返回编号${i + 1}`).join('\n');
  const seven = lintSpec({ ...baseline, requirements: requirement('REQ-001', acs(7)) });
  assert.deepEqual(seven.errors, []);
  assert.ok(seven.warnings.some((item) => item.rule === 'ac-too-many' && item.message.includes('通用约定')));
  assert.ok(!lintSpec({ ...baseline, requirements: requirement('REQ-001', acs(6)) }).warnings.some((item) => item.rule === 'ac-too-many'));
});

test('acTexts 返回指定生效 AC 原文，跳过缺失编号并去重', () => {
  const spec = effectiveSpec({ ...baseline, requirements: requirement('REQ-001', '- AC2（manual）：新看板出现在第一行') });
  assert.deepEqual(acTexts(spec, ['REQ-001.AC2', 'REQ-001.AC1', 'REQ-999.AC1', 'REQ-001.AC2']), { 'REQ-001.AC2': '新看板出现在第一行' });
  assert.deepEqual(acTexts(spec, []), {});
});

test('「通用约定」一节：到下一个二级标题为止，三级标题照留；没有这一节为空', () => {
  const md = '# 需求\n\n## 需求清单\n- AC1：x\n\n## 通用约定 \r\n- 金额是整数分。\n\n### 原文字段规则\n- sku 保存为大写\n\n## 范围外\n- 打印\n';
  assert.equal(conventionsSection(md), '- 金额是整数分。\n\n### 原文字段规则\n- sku 保存为大写');
  assert.equal(conventionsSection('# 需求\n\n## 通用约定\n- 最后一节\n'), '- 最后一节');
  assert.equal(conventionsSection('# 需求\n\n## 需求清单\n- AC1：x\n'), '');
});
