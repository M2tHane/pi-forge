# 需求

## 背景与目标
一个极简的团队看板 API（内存存储），用来验证多 agent 工作流。

## 需求清单
### REQ-001 创建看板 [MVP]
角色：成员
- AC1：Given 已登录 When 创建看板 Then 返回看板编号
- AC2：Given 名称为空 When 创建看板 Then 返回 400 与错误码 E_VALIDATION

### REQ-002 归档看板 [MVP]
角色：成员
- AC1：Given 看板存在 When 归档它 Then 看板列表不再返回它，带 archived=true 参数时返回
- AC2：Given 看板不存在 When 归档 Then 返回 404 与错误码 E_NOT_FOUND

### REQ-003 看板卡片 [MVP]
角色：成员
- AC1：Given 看板存在 When 在看板上新增标题为「买牛奶」的卡片 Then 返回卡片编号与所属看板编号
- AC2：Given 看板上有 2 张卡片 When 查看该看板的卡片 Then 按创建顺序返回 2 张
- AC3：Given 标题超过 100 个字符 When 新增卡片 Then 返回 400 与错误码 E_VALIDATION

### REQ-004 健康检查 [MVP]
角色：运维
- AC1：Given 服务运行中 When 请求 GET /health Then 返回 200，正文含 ok=true 与 package.json 里的 version

### REQ-005 导出看板 [MVP]
角色：成员
- AC1：Given 看板上有卡片 When 请求 GET /boards/{id}/export Then 返回 text/csv，首行是表头 id,title，之后每张卡片一行
- AC2：Given 看板不存在 When 导出 Then 返回 404 与错误码 E_NOT_FOUND

### REQ-006 测试报告 [MVP]
角色：运维
- AC1：Given 运行验收测试命令 When 完成 Then 在 reports/junit.xml 生成 JUnit 格式的报告

## 范围外
用户登录、持久化存储、前端页面。
