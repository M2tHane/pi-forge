// 样例契约与计划：两个模块（team、datasource），与 test/helpers/spec.ts 的规格对应。
export const CONTRACTS: Record<string, string> = {
  'openapi.yaml': `openapi: 3.1.0
info: { title: 数据平台, version: 1.0.0 }
components:
  schemas:
    Error:
      type: object
      required: [code, message]
      properties: { code: { type: string }, message: { type: string } }
paths:
  /api/teams:
    $ref: './paths/team.yaml#/~1api~1teams'
  /api/datasources:
    $ref: './paths/datasource.yaml#/~1api~1datasources'
`,
  'paths/team.yaml': `/api/teams:
  get:
    operationId: listTeams
    responses:
      '200': { description: 团队列表 }
`,
  'paths/datasource.yaml': `/api/datasources:
  get:
    operationId: listDatasources
    responses:
      '200':
        description: 数据源列表
        content:
          application/json:
            schema: { $ref: '../components/datasource.yaml#/Datasource' }
  post:
    operationId: createDatasource
    responses:
      '201': { description: 已创建 }
      '409':
        description: DATASOURCE_NAME_TAKEN
        content:
          application/json:
            schema: { $ref: '../openapi.yaml#/components/schemas/Error' }
`,
  'components/datasource.yaml': `Datasource:
  type: object
  properties: { id: { type: string }, name: { type: string } }
`,
  'errors/common.yaml': `FORBIDDEN: { http: 403, message: 没有权限 }
`,
  'errors/datasource.yaml': `DATASOURCE_NAME_TAKEN: { http: 409, message: 数据源名称已存在, req: [REQ-001.AC2] }
`,
  'data-model.yaml': `tables:
  teams:
    columns: { id: { type: uuid, pk: true }, name: { type: string } }
  datasources:
    columns: { id: { type: uuid, pk: true }, team_id: { type: uuid, fk: teams.id }, name: { type: string } }
`,
  'modules/team.md': `# team

## currentTeam
参数：无
返回：{ id: string }
`,
};

/** 与 CONTRACTS 对应的规格：REQ-001 数据源（MVP）、REQ-002 团队（MVP）、REQ-003 导出（LATER） */
export const P1_SPEC = {
  requirements: `# 需求

## 背景与目标
团队管理数据源。

## 需求清单

### REQ-001 团队负责人可以创建数据源 [MVP]
角色：团队负责人
- AC1：Given 已登录的团队负责人 When 提交合法配置 Then 创建成功
- AC2：Given 已有同名数据源 When 再次创建 Then 失败，错误码 DATASOURCE_NAME_TAKEN
- AC3（manual）：新增后列表第一行出现新项

### REQ-002 成员可以查看团队 [MVP]
角色：成员
- AC1：Given 已登录的成员 When 打开团队列表 Then 看到自己所在的团队

### REQ-003 导出数据源 [LATER]
角色：团队负责人
- AC1：Given 已登录 When 导出 Then 下载文件
`,
  screens: `# 页面

## 数据源列表 /datasources
REQ：REQ-001
状态：
| 状态 | 表现 |
| 加载 | 骨架屏 |
| 空 | 还没有数据源 |
| 错误 | 错误条 |
| 无权限 | N/A：成员也能查看 |

## 团队 /teams
REQ：REQ-002
状态：
| 状态 | 表现 |
| 加载 | 骨架屏 |
| 空 | 还没有团队 |
| 错误 | 错误条 |
| 无权限 | N/A：所有人可见 |
`,
  permissions: `| 资源 · 操作 | 团队负责人 | 成员 |
|---|---|---|
| 数据源 · 创建 | ✓ | ✗ |
`,
  glossary: `# 数据平台

## 术语

**团队负责人（TeamLead）**：
管理一个团队的人。

**成员（Member）**：
团队里的普通用户。

**数据源（Datasource）**：
外部数据库连接。
`,
};

/** 合格的计划：S0 骨架（团队），S1 数据源（软依赖团队接口） */
export const PLAN_YAML = `size_estimate: { loc: 9000, modules: 2 }
mode: standard
stages:
  - { id: S0, goal: 骨架：登录后看到团队列表, exit: [REQ-002] }
  - { id: S1, goal: 数据源管理, exit: [REQ-001] }
tasks:
  - id: T-002
    stage: S0
    module: team
    title: 骨架与团队列表
    size: M
    layers: [backend, database, frontend]
    ac: [REQ-002.AC1]
    writes: [server/src/team/**, web/src/pages/team/**, package.json]
    produces: [table:teams, api:GET /api/teams, page:/teams, fn:team#currentTeam, error:FORBIDDEN]
    requires: []
    test_interface: [HTTP /api/teams, page /teams]
  - id: T-003
    stage: S1
    module: datasource
    title: 数据源管理
    size: M
    layers: [backend, database, frontend]
    ac: [REQ-001.AC1, REQ-001.AC2]
    writes: [server/src/datasource/**, web/src/pages/datasource/**]
    shared: [server/src/routes.ts]
    produces: [table:datasources, api:POST /api/datasources, api:GET /api/datasources, error:DATASOURCE_NAME_TAKEN, page:/datasources]
    requires: [table:teams, ~api:GET /api/teams, fn:team#currentTeam]
    test_interface: [HTTP /api/datasources*, page /datasources]
    manual_checks: [新增后列表第一行出现新项]
`;
