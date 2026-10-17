// 测试用的 docs/PRD.md 与原型：一条需求 REQ-001、一个页面。
export const PRD_MD = [
  '# 团队看板 PRD', '', '## 需求', '',
  '### 创建看板  REQ-001', '角色：管理员、成员', '',
  '- AC1 Given 已登录 When 创建看板 Then 返回看板编号', '',
  '## 页面', '', '| 页面 | 原型文件 | 对应需求 |', '|---|---|---|', '| boards | docs/prototype/boards.html | REQ-001 |', '',
].join('\n');
/** 在 AC1 后面再加一条 AC2（名称为空返回 400） */
export const PRD_MD_AC2 = PRD_MD.replace('- AC1 Given 已登录 When 创建看板 Then 返回看板编号', '- AC1 Given 已登录 When 创建看板 Then 返回看板编号\n- AC2 Given 名称为空 When 创建看板 Then 返回 400');
export const PRD_FILES: Record<string, string> = { 'docs/PRD.md': PRD_MD, 'docs/prototype/boards.html': '<title>看板</title>' };
