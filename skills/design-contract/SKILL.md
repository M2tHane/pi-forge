---
name: design-contract
description: 写前后端之间的契约：openapi.yaml 只写前端调用的 HTTP 接口，page-api.md 写每个页面用哪些接口；domain 之间的接口写成代码
---

# 设计契约

契约让后端 agent 和前端 agent 不必等对方写完就能并行开发：后端严格按 openapi.yaml 实现，前端对着从它生成的 mock 开发。
所以契约必须**精确**（字段名、类型、状态码、错误码都写死），同时必须**克制**：每多写一条，就多一处可能要改契约、要找你返工的地方。

## 三处约定

| 约定 | 放在哪 | 写什么 |
|---|---|---|
| 前后端之间的 HTTP 接口 | `docs/contracts/openapi.yaml` | 只写前端会调用的接口。domain 之间的内部调用不写在这里 |
| 页面和接口的对照 | `docs/contracts/page-api.md` | 每个页面用哪些接口、哪个按钮调哪个接口 |
| domain 之间的接口 | 代码（接口与 DTO，先放空实现） | 写明由哪个 domain 实现；docs/arch/domains.md 里列出每个 domain 对外提供哪些 |

## 原则

- **只写 PRD 里有的。** 每个接口都能追溯到 REQ 或 AC，用 `x-req: [REQ-012]` 标注。不新增需求没有的能力（没要求就不做批量操作、导出、多版本 API）。
- **区分三类内容**：用户明确要求的、互操作必需的、可替换的实现选择。前两类写进契约；第三类（示例文案、没要求的排序、未知参数怎么处理）不写，留给实现。错误信息文字只有 PRD 明确要求时才算契约。
- **行为细则看 PRD。** 逐条校验规则、状态转换、边界取值以 PRD 的 AC 为准，契约不重复。
- 契约批准后，开发 agent 不能改它；需要修改时由你改。所以拿不准的细节宁可不写。

## openapi.yaml

- OpenAPI 3.1。公共 components（统一错误响应 `Error`、分页、通用参数）只定义一次，各处引用。
- 每个 operation 写 `operationId`、请求与响应 schema、所有可能的状态码；错误响应引用 `Error`，在 description 里列出可能的错误码（与公共代码里的错误码常量一致）。
- 用 `x-roles: [admin, staff]` 标注允许的角色，与 PRD 的用户与角色一致。
- 文件太长时可以按 domain 拆到 `docs/contracts/paths/<domain>.yaml`，根文件的 paths 下每个路径写一条 `$ref`。

## page-api.md

写完 openapi.yaml 后，逐页打开原型核对，每个页面一节：

```md
## products（docs/prototype/products.html）
- 列表：GET /api/products（分页、按名称搜索）
- 「新建」按钮 → 弹窗表单 → POST /api/products；名称重复时显示 PRODUCT_NAME_TAKEN
- 「停用」按钮 → PATCH /api/products/{id}/status
- 无权限：staff 看不到「新建」与「停用」
```

页面要显示的数据、每个按钮的操作都要有接口，字段要能对上；对不上的改 openapi.yaml，不要留到开发时再发现。

## 自查

- 原型里每个页面、每个按钮都在 page-api.md 里，用到的接口都在 openapi.yaml 里。
- openapi.yaml 里每个接口都被某个页面用到，都有 x-req。没有页面用的删掉（domain 之间的调用写成代码接口）。
- 配置了 contract_lint 时运行它，确认契约合法。
