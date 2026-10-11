import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acTexts, diffAcs, effectiveSpec, lintSpec, parseRequirements, UNTESTABLE_WORDS } from '../../src/core/spec/spec.ts';
import type { SpecFiles, SpecFeature } from '../../src/core/spec/spec.ts';

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
function feature(reqs: string, screens = '', permissions = '| 资源 · 操作 | 管理员 |\n| --- | --- |'): SpecFeature {
  return { name: '2026-01-01-01-change.md', content: `# 增量规格\n\n## 需求\n${reqs}\n\n## 页面\n${screens}\n\n## 权限\n${permissions}` };
}
function checkRule(base: SpecFiles, rule: string, exists: boolean, features: SpecFeature[] = [], warning = false): void {
  const result = lintSpec(base, features);
  assert.equal((warning ? result.warnings : result.errors).some((issue) => issue.rule === rule), exists, JSON.stringify(result));
}

test('完整规格零错误、零警告；保留需求、页面、权限与术语的结构', () => {
  assert.deepEqual(lintSpec(baseline), { errors: [], warnings: [] });
  const spec = effectiveSpec(baseline, []);
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
  checkRule(baseline, 'req-duplicate', true, [feature(requirement())]);
  checkRule(baseline, 'req-duplicate', true, [feature(requirement('REQ-002')), { ...feature(requirement('REQ-002')), name: 'later.md' }]);
});

test('修订和删除必须指向当前存在的 REQ；合法标记允许重复编号', () => {
  for (const marker of ['修订', '删除']) {
    const req = marker === '删除' ? '### REQ-001（删除）' : requirement('REQ-001（修订）');
    checkRule(baseline, 'req-target', false, [feature(req)]);
    checkRule(baseline, 'req-duplicate', false, [feature(req)]);
    checkRule(baseline, 'req-target', true, [feature(req.replace('REQ-001', 'REQ-002'))]);
  }
});

test('新增 REQ 连续时无警告，跳号只有警告；删除后不复用旧编号', () => {
  checkRule(baseline, 'req-sequence', false, [feature(requirement('REQ-002'))], true);
  const result = lintSpec(baseline, [feature(requirement('REQ-003'))]);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((item) => item.rule === 'req-sequence'));
  const highBase = { ...baseline, requirements: `${requirement()}\n${requirement('REQ-002', '', 'NO')}` };
  const amendments = [feature('### REQ-002（删除）'), { ...feature(requirement('REQ-003')), name: 'z.md' }];
  checkRule(highBase, 'req-sequence', false, amendments, true);
  checkRule(highBase, 'req-duplicate', true, [feature('### REQ-002（删除）'), { ...feature(requirement('REQ-002')), name: 'z.md' }]);
});

test('优先级仅允许 MVP、LATER、NO，缺失或其他值报错', () => {
  for (const priority of ['MVP', 'LATER', 'NO']) checkRule({ ...baseline, requirements: requirement('REQ-001', undefined, priority) }, 'priority', false);
  checkRule({ ...baseline, requirements: requirement().replace('[MVP]', '[ MVP ]') }, 'priority', false);
  for (const priority of ['P0', 'mvp', '']) checkRule({ ...baseline, requirements: requirement('REQ-001', undefined, priority) }, 'priority', true);
  checkRule({ ...baseline, requirements: requirement().replace(' [MVP]', '') }, 'priority', true);
  assert.deepEqual(parseRequirements('### REQ-001（删除）').issues, []);
  assert.ok(parseRequirements('### REQ-001（删除） [P0]').issues.some((item) => item.rule === 'priority'));
});

test('MVP 必须有 AC，LATER 和 NO 可无 AC', () => {
  checkRule(baseline, 'ac-required', false);
  checkRule({ ...baseline, requirements: requirement('REQ-001', '') }, 'ac-required', true);
  for (const priority of ['LATER', 'NO']) assert.deepEqual(lintSpec({ ...baseline, requirements: requirement('REQ-001', '', priority) }).errors, []);
});

for (const keyword of ['Given', 'When', 'Then']) {
  test(`自动 AC 缺 ${keyword} 报错，完整三段通过`, () => {
    checkRule(baseline, 'ac-gwt', false);
    checkRule({ ...baseline, requirements: requirement().replace(keyword, '') }, 'ac-gwt', true);
  });
}

test('GWT 空段或顺序错误报错，manual 可不用 GWT 但不能空白', () => {
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
  test(`页面缺少 ${state} 状态报错，有四态且无溢出行通过`, () => {
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

test('页面路由或状态表无法解析时报错，溢出行可选', () => {
  checkRule({ ...baseline, screens: screen().replace('/boards', 'boards') }, 'screen-format', true);
  checkRule({ ...baseline, screens: screen().replace('| 加载 | 骨架屏 |', '| 加载 | 骨架屏 | 多余列 |') }, 'screen-state', true);
  checkRule({ ...baseline, screens: `${screen()}\n| 加载 | 再次加载 |` }, 'screen-state', true);
  assert.deepEqual(lintSpec({ ...baseline, screens: `${screen()}\n| 溢出 | 分页 |` }).errors, []);
});

test('权限表无法解析、列数不齐、空单元格、重复角色均报错', () => {
  checkRule(baseline, 'permissions-table', false);
  for (const permissions of ['', '管理员能创建', '| 资源 |', '| 资源 | 管理员 |\n看板 ✓', '| 资源 | 管理员 |\n| 看板 | ✓ | 多余列 |', '| 资源 | 管理员 |\n| 看板 | |', '| 资源 | 管理员 | 管理员 |', '| --- | --- |', '| 资源 | 管理员 |\n| --- | --- | --- |']) {
    checkRule({ ...baseline, permissions }, 'permissions-table', true);
  }
});

test('权限可包含多个矩阵，转义竖线作为条件正文保留', () => {
  const permissions = `${matrix}\n\n| 资源 · 操作 | 管理员 |\n| --- | --- |\n| 看板 · 删除 | 所有者 \\| 团队负责人 |`;
  const spec = effectiveSpec({ ...baseline, permissions }, []);
  assert.deepEqual(spec.issues, []);
  assert.equal(spec.permissions.at(-1)!.grants['管理员'], '所有者 | 团队负责人');
});

test('权限角色必须匹配术语主名，英文名与废弃别名不作为角色', () => {
  checkRule(baseline, 'permissions-role', false);
  for (const role of ['访客', 'Admin', '超级用户']) checkRule({ ...baseline, permissions: matrix.replace('管理员', role) }, 'permissions-role', true);
  const glossary = `${baseline.glossary}\n\n**访客（Guest）**：\n受邀查看页面的人。`;
  assert.deepEqual(lintSpec({ ...baseline, glossary, permissions: matrix.replace('管理员', '访客') }).errors, []);
  checkRule(baseline, 'permissions-role', true, [feature(requirement('REQ-002'), '', '| 资源 | 访客 |\n| 看板 · 查看 | ✓ |')]);
});

test('术语格式严格要求中文主名、英文名与定义', () => {
  checkRule(baseline, 'glossary-format', false);
  for (const glossary of ['**管理员**：\n管理团队。', '**管理员（Admin）**：']) checkRule({ ...baseline, glossary }, 'glossary-format', true);
});

for (const file of ['requirements', 'screens', 'permissions', 'glossary'] as const) {
  test(`${file} 的 TODO、TBD、待定均报错且有行号`, () => {
    checkRule(baseline, 'placeholder', false);
    for (const word of ['TODO', 'TBD：价格', '（TODO）', '待定']) {
      const content = `${baseline[file]}\n${word}`;
      const result = lintSpec({ ...baseline, [file]: content });
      const found = result.errors.find((item) => item.rule === 'placeholder')!;
      assert.equal(found.file, `docs/spec/${file}.md`);
      assert.equal(found.line, content.split('\n').length);
      assert.match(found.message, /替换/);
    }
  });
}

test('Todo、TodoCollection、todo list 这类合法术语不是占位词（只认大写独立的 TODO/TBD，偏离 88）', () => {
  for (const word of ['**待办（Todo）**：清单项。', 'TodoCollection', 'a todo list', 'TBDX', 'Stbd']) checkRule({ ...baseline, glossary: `${baseline.glossary}\n${word}` }, 'placeholder', false);
});

test('feature 中任意位置的占位词报错', () => {
  const amendment = feature(requirement('REQ-002'));
  checkRule(baseline, 'placeholder', false, [amendment]);
  checkRule(baseline, 'placeholder', true, [{ ...amendment, content: `TODO\n${amendment.content}` }]);
});

for (const word of UNTESTABLE_WORDS) {
  test(`AC 中的 ${word} 只给警告，具体行为没有警告`, () => {
    checkRule(baseline, 'ac-untestable', false, [], true);
    const result = lintSpec({ ...baseline, requirements: requirement('REQ-001', `- AC1：Given 已登录 When 创建 Then ${word}返回编号`) });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((item) => item.rule === 'ac-untestable'));
  });
}

test('feature 必须包含需求、页面、权限三节，重复章节报错', () => {
  const amendment = feature(requirement('REQ-002'));
  assert.deepEqual(lintSpec(baseline, [amendment]).errors, []);
  for (const section of ['需求', '页面', '权限']) checkRule(baseline, 'feature-section', true, [{ ...amendment, content: amendment.content.replace(`## ${section}`, `# ${section}`) }]);
  checkRule(baseline, 'feature-section', true, [{ ...amendment, content: `${amendment.content}\n## 需求\n${requirement('REQ-003')}` }]);
});

test('feature 按文件名排序整条修订、删除；不修改输入', () => {
  const first = { ...feature(requirement('REQ-001（修订）', '- AC2（manual）：第一版显示编号')), name: 'a.md' };
  const second = { ...feature(requirement('REQ-001(修订)', '- AC3（manual）：第二版显示编号')), name: 'b.md' };
  const features = [second, first];
  const original = structuredClone({ baseline, features });
  const spec = effectiveSpec(baseline, features);
  assert.deepEqual(spec.issues, []);
  assert.deepEqual(spec.reqs[0]!.acs.map((ac) => ac.id), ['AC3']);
  assert.equal(spec.reqs[0]!.file, 'docs/spec/features/b.md');
  assert.equal(spec.reqs[0]!.line, 4);
  assert.deepEqual({ baseline, features }, original);
  const deletion = { ...feature('### REQ-001（删除）'), name: 'c.md' };
  const deleted = effectiveSpec(baseline, [...features, deletion]);
  assert.deepEqual(deleted.reqs, []);
  assert.ok(deleted.issues.some((item) => item.rule === 'screen-req'));
  checkRule(baseline, 'req-target', true, [deletion, { ...first, name: 'd.md' }]);
});

test('新增页面合并、已有路由整页替换；权限只替换指定资源的角色单元格', () => {
  const amendment = feature(requirement('REQ-002'), `${screen('REQ-002')}\n${screen('REQ-002', '/archive')}`, '| 资源 · 操作 | 管理员 |\n| --- | --- |\n| 看板 · 创建 | ✗ |\n| 看板 · 删除 | ✓ |');
  const spec = effectiveSpec(baseline, [amendment]);
  assert.deepEqual(spec.issues, []);
  assert.equal(spec.screens.length, 2);
  assert.deepEqual(spec.screens[0]!.reqs, ['REQ-002']);
  assert.equal(spec.permissions.length, 2);
  assert.deepEqual(spec.permissions[0]!.grants, { 管理员: '✗', 成员: '仅本团队' });
});

test('后续新增需求可被页面引用；需求删除后引用应一起修订', () => {
  const files = { ...baseline, requirements: `${requirement()}\n${requirement('REQ-002')}` };
  const amendment = feature('### REQ-001（删除）', screen('REQ-002'));
  assert.deepEqual(lintSpec(files, [amendment]).errors, []);
  const forward = { ...feature('', screen('REQ-002')), name: 'a.md' };
  const later = { ...feature(requirement('REQ-002')), name: 'b.md' };
  assert.deepEqual(lintSpec(baseline, [later, forward]).errors, []);
});

test('feature 错误使用原始文件行号，重复文件名不能静默叠加', () => {
  const amendment = feature(requirement('REQ-002', '- AC1：Given 条件 Then 结果'));
  const error = lintSpec(baseline, [amendment]).errors.find((item) => item.rule === 'ac-gwt')!;
  assert.equal(error.file, 'docs/spec/features/2026-01-01-01-change.md');
  assert.equal(error.line, 6);
  checkRule(baseline, 'feature-duplicate', true, [amendment, amendment]);
});

test('整条删除不能包含 AC', () => {
  checkRule(baseline, 'req-delete', false, [feature('### REQ-001（删除）')]);
  checkRule(baseline, 'req-delete', true, [feature('### REQ-001（删除）\n- AC1（manual）：删除内容')]);
});

test('diffAcs 精确区分新增、改文、删除与 manual 变化', () => {
  const files = { ...baseline, requirements: requirement('REQ-001', '- AC1：Given 已登录 When 创建 Then 成功\n- AC2（manual）：显示新看板\n- AC3（manual）：人工确认') };
  const before = effectiveSpec(files, []);
  const after = effectiveSpec(files, [feature(requirement('REQ-001（修订）', '- AC1：Given 已登录 When 创建 Then 返回编号\n- AC3：Given 条件 When 操作 Then 结果\n- AC4（manual）：显示新布局'))]);
  assert.deepEqual(diffAcs(before, after), { added: ['REQ-001.AC4'], changed: ['REQ-001.AC1', 'REQ-001.AC3'], removed: ['REQ-001.AC2'] });
  assert.deepEqual(diffAcs(before, before), { added: [], changed: [], removed: [] });
  const manualBefore = effectiveSpec(baseline, []);
  const manualAfter = effectiveSpec(baseline, [feature(requirement('REQ-001（修订）', '- AC1（manual）：Given 已登录 When 创建看板 Then 返回看板编号'))]);
  assert.deepEqual(diffAcs(manualBefore, manualAfter).changed, ['REQ-001.AC1']);
  assert.deepEqual(diffAcs(before, effectiveSpec(files, [feature('### REQ-001（删除）')])).removed, ['REQ-001.AC1', 'REQ-001.AC2', 'REQ-001.AC3']);
});

test('diffAcs 忽略标题、角色、文件位置变动，新增 REQ 的 AC 使用全局编号', () => {
  const before = effectiveSpec(baseline, []);
  const after = effectiveSpec(baseline, [feature(requirement('REQ-001（修订）').replace('创建看板 [MVP]', '创建团队看板 [MVP]').replace('管理员、成员', '管理员'))]);
  assert.deepEqual(diffAcs(before, after), { added: [], changed: [], removed: [] });
  assert.deepEqual(diffAcs(before, effectiveSpec(baseline, [feature(requirement('REQ-002'))])).added, ['REQ-002.AC1']);
});

test('acTexts 返回指定生效 AC 原文，跳过缺失编号并去重', () => {
  const spec = effectiveSpec(baseline, [feature(requirement('REQ-001（修订）', '- AC2（manual）：新看板出现在第一行'))]);
  assert.deepEqual(acTexts(spec, ['REQ-001.AC2', 'REQ-001.AC1', 'REQ-999.AC1', 'REQ-001.AC2']), { 'REQ-001.AC2': '新看板出现在第一行' });
  assert.deepEqual(acTexts(spec, []), {});
});
