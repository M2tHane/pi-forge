---
name: design-contract
description: 写 task 之间的边界契约：共享的数据、公共错误码、跨 task 调用的接口与函数；不重复规格，每条可追溯到需求
---

# 设计契约

契约是 task 之间的约定：一个 task 要用另一个 task 做的东西（数据、接口、函数）时，双方照契约对接，不必等对方写完。
模块自己对外的行为以规格为准：worker 照规格实现并自己写验收测试，reviewer 对着规格审查，契约不重复规格。
所以契约必须**精确**（字段名、类型、状态码、错误码都写死），同时必须**克制**：每多写一条，就多一处可能被锁死、引发修订的地方。

## 原则

- **只写需求里有的。** 每条都能追溯到 REQ 或 AC。不新增需求没有的能力（没要求就不做回滚、通用插件机制、多版本 API）。
  安全或数据完整性上不得不做的，写进 forge_propose_plan 的 extras，逐条写明是什么、为什么，由用户确认。
- **区分三类内容**：用户明确要求的、互操作必需的、可替换的实现选择。前两类可以成为验收条件，第三类（示例文案、未要求的排序、未知参数策略、GET 载荷拒绝等）不锁进契约；确有必要时写进 assumptions/extras 并说明依据。错误信息文字只有明确标为固定要求时才算契约。
- **只写边界。** 判断标准：另一个 task 会调用或读写它。只被本 task 自己（和它自己写的验收测试）用到的接口不写，规格已经写了它的行为。模块内部的函数、前端组件之间的回调、状态管理都不写。
  （实测：前端内部回调被写进契约并锁定后，来回修订了三次，耗时 1.5 小时；92 行的需求写出约 2100 行契约，同一条字段规则在规格、data-model、components 里各写一遍，而各模块的接口都没有别的 task 调用。）
- **默认只写这些**：
  - `errors/common.yaml` 与 openapi.yaml 里的统一错误响应 `Error`：所有 task 共用；
  - `data-model.yaml`：几个 task 都会读写的数据，只写表名、字段名与类型、引用关系、唯一约束；长度、取值范围这类校验以规格为准，不重复；
  - `modules/<m>.md`：被别的 task 直接调用的函数（例如 S0 骨架提供的存储、错误类）；
  - `paths/<模块>.yaml` 与 `components/<模块>.yaml`：只写别的 task 会调用的 HTTP 接口（例如前端 task 调后端接口、后一阶段调前一阶段的接口）。
- 行为细则（逐条状态转换、边界取值、文案）不写进契约，以规格为准。
- 契约批准后，实施中只能追加（新增接口、已有接口新增 operation 或可选参数、新增可选字段、新增错误码、新增 schema），不能修改（改已有参数、改 required、改 enum、新增必填字段或必填参数都算修改）。根文件与模块文件同一套规则。所以拿不准的细节宁可不写，留给 worker 在实现时追加。

## 文件与顺序

1. **data-model.yaml**（先定；只写几个 task 都会读写的数据）

```yaml
tables:
  datasources:
    req: [REQ-012, REQ-013]
    columns:
      id:         { type: uuid, pk: true }
      team_id:    { type: uuid, fk: teams.id, on_delete: cascade }
      name:       { type: string, null: false }
      kind:       { type: enum, values: [mysql, postgresql, excel, csv] }
      status:     { type: enum, values: [untested, ok, failed], default: untested }
      created_at: { type: timestamp, default: now }
    unique: [[team_id, name]]
```

   主键、时间、软删除等通用约定写进 rules/database.md，不必每张表重复。

2. **errors/common.yaml**（通用错误）；某个模块的错误码只有别的 task 也要用时，才写 errors/<模块>.yaml（错误码以模块前缀开头）

```yaml
# errors/datasource.yaml
DATASOURCE_NAME_TAKEN: { http: 409, message: 数据源名称已存在, req: [REQ-012.AC2] }
# errors/common.yaml
FORBIDDEN:             { http: 403, message: 没有权限 }
```

   统一的错误响应格式写在 openapi.yaml 的 `components.schemas.Error` 中，所有错误都用它。S0 会把错误码和统一错误响应结构落成代码常量与类型，契约是来源。

3. **openapi.yaml 与 paths/<模块>.yaml**（OpenAPI 3.1；paths 只写别的 task 会调用的接口，没有就只留根文件的 Error）
   - openapi.yaml 是根文件，只放 info、**公共** components（Error、分页、通用参数）和 paths。OpenAPI 3.1 的 paths 不能整体引用另一个文件，所以根文件的 paths 下每个路径写一条引用：
     ```yaml
     paths:
       /api/datasources:
         $ref: './paths/datasource.yaml#/~1api~1datasources'
     ```
   - 每个模块的 path item 写在 paths/<模块>.yaml（顶层直接写 path item，或包在 `paths:` 下，两种都可以，$ref 的片段路径随之不同）；模块自己的 schema 写在 components/<模块>.yaml，由 paths 文件用 `$ref` 引用。
     这样并行的 worker 只追加自己模块的文件，以及根文件 paths 下的一行引用。模块名与 plan.yaml 中 task 的 `module` 一致。
   - 公共 components 在 P1 定好，实施中不能改；拿不准是否公共的 schema，先放模块自己的文件。
   - 每个 operation 写 `operationId`、请求与响应 schema、所有可能的状态码；错误响应引用 `Error`，在 description 中列出可能的错误码。
   - 用 `x-req: [REQ-012]` 标注来源；用 `x-roles: [admin, team_lead]` 标注允许的角色（与 permissions.md 一致）。
   - 分页、排序、时间格式只定义一次（`components`），各处引用。
   - 字段名用 glossary 的英文名。

4. **modules/<m>.md**：只在有跨 task 的函数调用时写（没有就不建）。

```md
## checkConnection
参数：datasourceId: string（uuid）
返回：{ ok: boolean, latencyMs?: number, error?: string }
错误：DATASOURCE_NOT_FOUND（不存在或不属于当前团队）
调用方：T-005 查询执行
```

## 自查

- 计划里每个 requires 用到的接口、数据、函数，在契约里都有；契约里每个接口都有 x-req。
- 写了 openapi 接口的，permissions.md 对应的格子在 x-roles 中能对上。
- 有没有只被本 task 自己用到的接口、模块内部的东西、照抄规格的校验规则？删掉。
- 配置了 contract_lint 时运行它，确认契约合法。
