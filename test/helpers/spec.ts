// P0 与修订流程共用的合格规格：对应 spec-from-prd 与 domain-modeling 格式。
import type { SpecFiles } from '../../src/core/spec.ts';
export const P0_SPEC: SpecFiles = {
  requirements: '# 需求\n\n## 背景与目标\n团队维护看板。\n\n## 需求清单\n### REQ-001 创建看板 [MVP]\n角色：管理员、成员\n- AC1：Given 已登录 When 创建看板 Then 返回看板编号\n\n## 范围外\n跨团队访问。',
  screens: '# 页面\n## 看板列表 /boards\nREQ：REQ-001\n字段：名称\n交互：创建看板\n状态：\n| 状态 | 表现 |\n| 加载 | 骨架屏 |\n| 空 | 创建按钮 |\n| 错误 | 错误条和重试 |\n| 无权限 | N/A：所有角色均可查看列表 |',
  permissions: '# 权限\n| 资源 · 操作 | 管理员 | 成员 |\n| --- | --- | --- |\n| 看板 · 创建 | ✓ | 仅本团队 |',
  glossary: '# 团队看板\n\n## 术语\n**管理员（Admin）**：\n管理团队的角色。\n_不要叫_：超级用户\n\n**成员（Member）**：\n团队内的普通用户。\n\n**看板（Board）**：\n一组按列排列的卡片。\n_不要叫_：面板、kanban',
};
export const P0_AMEND = '# 增量规格\n\n## 需求\n### REQ-001（修订）创建看板 [MVP]\n角色：管理员、成员\n- AC1：Given 已登录 When 创建看板 Then 返回唯一看板编号\n- AC2：Given 看板名称为空 When 创建看板 Then 返回 400\n\n## 页面\n\n## 权限\n| 资源 · 操作 | 管理员 | 成员 |\n| --- | --- | --- |';
