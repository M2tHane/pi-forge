---
name: design-contract
description: 写边界契约：数据模型、OpenAPI、错误码、跨模块调用；只写边界，按需写细，每条可追溯到需求
---

# 设计契约

（改编自 pi-flow 第四轮的 design-contract 技能，吸收了三次真实冒烟的教训。）

契约有两个读者：worker 照它实现，test-author 只看它和规格写验收测试。两人看不到对方的东西，契约就是他们唯一的约定。
所以契约必须**精确**（字段名、类型、状态码、错误码都写死），同时必须**克制**：每多写一条，就多一处可能被锁死、引发修订的地方。

## 原则

- **只写需求里有的。** 每条都能追溯到 REQ 或 AC。不新增需求没有的能力（没要求就不做回滚、通用插件机制、多版本 API）。
  安全或数据完整性上不得不做的，写进 forge_propose_plan 的 extras，逐条写明是什么、为什么，由用户确认。
- **只写边界。** 判断标准：另一个 task 的 worker，或 test-author，需要调用它。模块内部的函数、前端组件之间的回调、状态管理都不写。
  （实测：前端内部回调被写进契约并锁定后，来回修订了三次，耗时 1.5 小时。）
- **按需写细。** 被别的 task 直接调用的函数写到函数级；只通过 REST 对外的模块，只写接口和数据模型。
- 契约批准后，实施中只能追加（新增接口、新增可选字段、新增错误码），不能修改（改 required、改 enum、新增必填字段都算修改）。所以拿不准的细节宁可不写，留给 worker 在实现时追加。
- glossary 在 P1 只能追加新条目；要改已有条目，在 assumptions 里写明，由用户通过规格修订确认。

## 文件与顺序

1. **data-model.yaml**（先定）

```yaml
tables:
  datasources:
    req: [REQ-012, REQ-013]
    columns:
      id:         { type: uuid, pk: true }
      team_id:    { type: uuid, fk: teams.id, on_delete: cascade }
      name:       { type: string, max: 50, null: false }
      kind:       { type: enum, values: [mysql, postgresql, excel, csv] }
      status:     { type: enum, values: [untested, ok, failed], default: untested }
      created_at: { type: timestamp, default: now }
    unique: [[team_id, name]]
```

   主键、时间、软删除等通用约定写进 rules/database.md，不必每张表重复。

2. **errors/<模块>.yaml**（按模块拆文件，错误码以模块前缀开头；通用错误放 errors/common.yaml）

```yaml
# errors/datasource.yaml
DATASOURCE_NAME_TAKEN: { http: 409, message: 数据源名称已存在, req: [REQ-012.AC2] }
# errors/common.yaml
FORBIDDEN:             { http: 403, message: 没有权限 }
```

   统一的错误响应格式写在 openapi.yaml 的 `components.schemas.Error` 中，所有错误都用它。

3. **openapi.yaml 与 paths/<模块>.yaml**（OpenAPI 3.1）
   - openapi.yaml 是根文件，只放 info、**公共** components（Error、分页、通用参数）和 paths。OpenAPI 3.1 的 paths 不能整体引用另一个文件，所以根文件的 paths 下每个路径写一条引用：
     ```yaml
     paths:
       /api/datasources:
         $ref: './paths/datasource.yaml#/~1api~1datasources'
     ```
   - 每个模块的 path item 写在 paths/<模块>.yaml；模块自己的 schema 写在 components/<模块>.yaml，由 paths 文件用 `$ref` 引用。
     这样并行的 worker 只追加自己模块的文件，以及根文件 paths 下的一行引用。模块名与 plan.yaml 中 task 的 `module` 一致。
   - 公共 components 在 P1 定好，实施中不能改；拿不准是否公共的 schema，先放模块自己的文件。
   - 每个 operation 写 `operationId`、请求与响应 schema、所有可能的状态码；错误响应引用 `Error`，在 description 中列出可能的错误码。
   - 用 `x-req: [REQ-012]` 标注来源；用 `x-roles: [admin, team_lead]` 标注允许的角色（与 permissions.md 一致）。
   - 分页、排序、时间格式只定义一次（`components`），各处引用。
   - 字段名用 glossary 的英文名。

4. **modules/<m>.md**：只在有跨 task 的函数调用时写。

```md
## checkConnection
参数：datasourceId: string（uuid）
返回：{ ok: boolean, latencyMs?: number, error?: string }
错误：DATASOURCE_NOT_FOUND（不存在或不属于当前团队）
调用方：T-005 查询执行
```

## 自查

- 规格里每条 MVP AC 涉及的接口与错误码，在契约里都有；契约里每个接口都有 x-req。
- permissions.md 的每一格，在 openapi 的 x-roles 中都能对上。
- test-author 只看契约和规格，能写出每条 AC 的测试吗？写不出的地方就是契约还缺的。
- 有没有写进模块内部的东西？删掉。
- 运行 commands.yaml 里的 contract_lint，确认契约合法。
