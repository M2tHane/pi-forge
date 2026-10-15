# 小仓库进销存（stock）

给一家有两三个仓库的小商贸公司用的进销存系统：维护商品和往来单位，记录采购入库、销售出库、仓库之间调拨和盘点，随时查库存、看报表。
有网页界面（原型见 `docs/prototype/`，打开 `docs/prototype/index.html`），后端提供 JSON API，页面通过 API 工作。

**分三期交付。** 第一期是登录、用户和基础资料（第 1–5 节）；第二期是库存与单据（第 6–10 节）；第三期是报表、导出和看板（第 11–13 节）。每一期都要有对应的页面。

## 技术约束

- Node.js 22 及以上，ES 模块（`package.json` 里 `"type": "module"`）。**后端运行时只用 Node 自带模块**（`node:http`、`node:sqlite`、`node:fs`、`node:crypto` 等），不使用第三方运行时依赖；开发依赖（测试工具）可以用。
- 前端是原生 HTML、CSS、JavaScript（浏览器原生 ES 模块），**不用框架、不需要构建步骤**，由同一个服务托管静态文件。
- `npm start` 启动服务：监听环境变量 `PORT`（默认 3000）；数据存在环境变量 `DATA_DIR` 指定的目录（默认 `./data`，不存在时自动创建），存储方式自选（`node:sqlite` 或 JSON 文件都可以）。写操作成功返回前数据已经落盘；重启后数据、编号计数和单号计数都保留。
- `npm test` 运行项目自己的测试。
- `GET /api/health` 返回 `200 {"ok": true}`，不需要登录。
- 第一次启动、还没有任何用户时，自动创建管理员：用户名 `admin`，密码 `admin123`，角色 `admin`。

## 通用约定

- API 都在 `/api/` 下。请求与响应都是 JSON，响应头 `Content-Type: application/json; charset=utf-8`（导出接口除外）。
- 成功：创建返回 `201` 与新对象；查询返回 `200`；修改（PATCH）和单据操作返回 `200` 与修改后的对象；删除返回 `204`，没有响应体。
- 失败统一返回 `{"error": {"code": "<代码>", "message": "<中文说明>"}}`：
  - `invalid_json`（400）：请求体不是合法 JSON，或不是 JSON 对象。
  - `validation_failed`（400）：字段缺失、类型或取值不对、查询参数不合法、引用的对象不存在。
  - `unauthorized`（401）：没有登录、令牌无效或已退出、用户名密码不对、用户已停用。
  - `forbidden`（403）：角色没有权限。
  - `not_found`（404）：路径里的对象不存在（包括路径里的 id 不是正整数）；没有这个 API 路径或方法。
  - `conflict`（409）：违反唯一性、状态不允许这个操作、库存不足，或删除仍被引用的对象。
- 先检查登录（401），再检查权限（403），再检查对象是否存在（404），最后校验请求（400、409）。
- 编号 `id` 是正整数，每种资源各自从 1 递增，删除后不复用。列表默认按 `id` 升序，另有说明的除外。
- 金额一律是**整数，单位是分**。数量是整数。时间是 ISO 8601 的 UTC 时间字符串（例如 `2026-10-15T08:30:00.000Z`）；日期参数是 `YYYY-MM-DD`（必须是真实存在的日期），按 UTC 日期比较。
- 字符串字段先去掉首尾空白再校验长度。请求体里多余的字段忽略；只读字段（`id`、`no`、`status`、`total`、时间）在请求里给了也忽略。
- 基础资料都有 `POST` 创建、`GET` 列表、`GET /:id`、`PATCH /:id`（只改请求里给出的字段，校验同创建）、`DELETE /:id`。

## 登录与权限

- `POST /api/login`，请求体 `{"username", "password"}`：成功返回 `200 {"token": "<字符串>", "user": {"id", "username", "role"}}`；用户名或密码不对、用户已停用 → 401。
- 其余 API（`/api/health`、`/api/login` 除外）都要带请求头 `Authorization: Bearer <token>`，否则 401。令牌在服务重启后仍然有效。
- `POST /api/logout`：令牌作废，返回 204。
- `GET /api/me`：返回当前用户 `{"id", "username", "role"}`。
- 三种角色：
  - `admin`：全部操作。
  - `clerk`（仓管员）：除用户管理（`/api/users`）以外的全部操作。
  - `viewer`（只读）：只能用 `GET`（以及 `POST /api/logout`），其他方法 → 403。
- 页面：没登录时任何页面都跳到登录页；按钮按角色显示（只读用户看不到新建、编辑、删除和单据操作按钮）。

# 第一期：登录、用户与基础资料

## 1. 用户 `/api/users`（只有 admin）

字段：`id`、`username`（3–20 个字符，只能是小写字母、数字、下划线，唯一）、`password`（只写不读，6–64 个字符；创建时必填，PATCH 时可选，给了就改密码）、`role`（`admin` | `clerk` | `viewer`，必填）、`active`（布尔，默认 `true`）。

- 响应里**永远不带** `password` 或它的散列。
- `username` 重复 → 409。
- 不能删除自己，也不能把自己停用或改成非 admin → 409。
- 停用的用户已经发出的令牌立即失效（之后的请求 401）。

## 2. 商品分类 `/api/categories`

字段：`id`、`name`（1–30 个字符，不区分大小写唯一）、`parent_id`（上级分类编号或 `null`，默认 `null`）。

- `parent_id` 指向不存在的分类 → 400；指向自己或自己的下级（会成环）→ 400。
- 有下级分类或有商品的分类不能删除 → 409。

## 3. 商品 `/api/products`

字段：`id`、`sku`（1–32 个字符，只能是字母、数字和 `-`，保存为大写，唯一）、`name`（1–60 个字符）、`category_id`（分类编号或 `null`，默认 `null`）、`unit`（1–10 个字符，默认 `"个"`）、`price`（售价，整数分，0–100000000）、`cost`（参考进价，整数分，0–100000000，默认 0）、`safety_stock`（安全库存，整数 0–1000000，默认 0）、`active`（布尔，默认 `true`）。

- `sku` 重复 → 409；`category_id` 不存在 → 400。
- `GET /api/products` 可选查询参数：`q`（`sku` 或 `name` 包含它，不区分大小写；去掉首尾空白后为空 → 400）、`category_id`（这个分类**及其所有下级分类**的商品）、`active`（`true` | `false`，取值不对 → 400）。
- 出现在任何单据里、或任何仓库有库存的商品不能删除 → 409（可以停用）。

## 4. 往来单位 `/api/partners`

字段：`id`、`name`（1–60 个字符，不区分大小写唯一）、`type`（`supplier` | `customer` | `both`）、`contact`（0–30 个字符，默认 `""`）、`phone`（0–20 个字符，只能有数字、空格、`-`、`+`，默认 `""`）。

- `name` 重复 → 409。
- `GET /api/partners` 可选查询参数 `type`：`supplier` 返回 `supplier` 和 `both`；`customer` 返回 `customer` 和 `both`；取值不对 → 400。
- 出现在任何单据里的往来单位不能删除 → 409。

## 5. 仓库 `/api/warehouses`

字段：`id`、`code`（1–10 个字符，只能是字母和数字，保存为大写，唯一）、`name`（1–30 个字符）、`active`（布尔，默认 `true`）。

- `code` 重复 → 409。
- 有库存或出现在任何单据里的仓库不能删除 → 409。
- 停用的仓库不能用在新建或修改的单据里 → 400。

# 第二期：库存与单据

## 6. 库存与流水（只读）

- 库存只由单据和盘点改变，不能直接修改。任何时候库存都不能是负数。
- `GET /api/stock`：有库存的记录 `[{"warehouse_id", "product_id", "quantity"}]`，只列 `quantity > 0` 的，按 `warehouse_id`、再按 `product_id` 升序；可选查询参数 `warehouse_id`、`product_id`（不合法 → 400）。
- `GET /api/stock/summary`：每个**启用**的商品一项 `{"product_id", "sku", "name", "quantity", "safety_stock", "low"}`，`quantity` 是所有仓库合计，`low` 是 `quantity < safety_stock`；按 `product_id` 升序；可选查询参数 `low=true` 只返回 `low` 为真的。
- `GET /api/movements`：库存流水 `[{"id", "product_id", "warehouse_id", "delta", "reason", "ref_type", "ref_id", "created_at"}]`，按 `id` 升序。`reason` 是 `purchase` | `sale` | `transfer_out` | `transfer_in` | `adjust`；`ref_type` 是 `purchase_order` | `sales_order` | `transfer` | `adjustment`，`ref_id` 是对应单据的编号。可选查询参数 `product_id`、`warehouse_id`。
- 一张单据造成的库存变化要么全部生效，要么全部不生效。

## 7. 采购单 `/api/purchase-orders`

字段：`id`、`no`（单号，`PO` 加 6 位序号，如 `PO000001`，自动生成）、`partner_id`（必须是 `supplier` 或 `both`，否则 400）、`warehouse_id`（入库仓库）、`note`（0–200 个字符，默认 `""`）、`lines`（明细数组，至少一行）、`total`（只读，各行 `quantity × price` 之和）、`status`、`created_at`、`received_at`（入库时间，入库前为 `null`）。

明细行：`{"product_id", "quantity", "price"}`，`quantity` 是 1–1000000 的整数，`price` 是进价（整数分，0–100000000）；同一张单里同一个商品只能出现一次（否则 400）；停用的商品不能用 → 400。

- 新建的单据 `status` 是 `draft`。只有 `draft` 能 PATCH（给了 `lines` 就整体替换）和 DELETE，否则 409。
- `POST /api/purchase-orders/:id/confirm`：`draft` → `confirmed`。
- `POST /api/purchase-orders/:id/receive`：`confirmed` → `received`，每行商品在入库仓库加上 `quantity`，记 `purchase` 流水，填 `received_at`。
- `POST /api/purchase-orders/:id/cancel`：`draft` 或 `confirmed` → `cancelled`。
- 状态不允许的操作 → 409。
- `GET /api/purchase-orders` 按 `id` 降序；可选查询参数 `status`、`partner_id`。

## 8. 销售单 `/api/sales-orders`

与采购单相同的字段和规则，区别：

- 单号前缀 `SO`；`partner_id` 必须是 `customer` 或 `both`；`warehouse_id` 是出库仓库；明细行的 `price` 是售价。
- 状态：`draft` → `confirmed` → `shipped`，`draft`、`confirmed` 可以 `cancelled`。时间字段是 `shipped_at`。
- `POST /api/sales-orders/:id/ship`：`confirmed` → `shipped`，每行商品在出库仓库减去 `quantity`，记 `sale` 流水（`delta` 为负）。**任何一行库存不足 → 409，整张单都不出库。**
- `GET /api/sales-orders` 按 `id` 降序；可选查询参数 `status`、`partner_id`。

## 9. 调拨单 `/api/transfers`

字段：`id`、`no`（前缀 `TR`）、`from_warehouse_id`、`to_warehouse_id`（两个必须不同，否则 400）、`note`、`lines`（`[{"product_id", "quantity"}]`，规则同上，没有价格）、`status`（`draft` | `done` | `cancelled`）、`created_at`、`done_at`。

- 只有 `draft` 能 PATCH、DELETE、执行和取消，否则 409。
- `POST /api/transfers/:id/execute`：调出仓库减、调入仓库加，记 `transfer_out` 和 `transfer_in` 流水；任何一行调出仓库库存不足 → 409，全部不生效。
- `POST /api/transfers/:id/cancel`：`draft` → `cancelled`。
- `GET /api/transfers` 按 `id` 降序。

## 10. 盘点 `/api/adjustments`

- `POST /api/adjustments`，请求体 `{"warehouse_id", "product_id", "counted", "note"}`（`counted` 是盘点实数，0–1000000 的整数；`note` 0–200 个字符）：把这个仓库这个商品的库存改成 `counted`，返回 `201 {"id", "warehouse_id", "product_id", "before", "counted", "delta", "note", "created_at"}`；`delta` 不为 0 时记 `adjust` 流水。
- `GET /api/adjustments` 按 `id` 降序；`GET /api/adjustments/:id`。盘点记录不能修改或删除（PATCH、DELETE → 404）。

# 第三期：报表、导出与看板

## 11. 看板 `GET /api/reports/dashboard`

返回 `{"products", "warehouses", "low_stock", "open_purchase_orders", "open_sales_orders", "stock_value"}`：启用的商品数、启用的仓库数、`low` 为真的商品数、`draft` 加 `confirmed` 的采购单数和销售单数、库存金额（所有库存 `quantity × 商品 cost` 之和，分）。

## 12. 销售报表 `GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD`

- `from`、`to` 必填，`from` 不能晚于 `to`，否则 400。只统计 `shipped_at` 的 UTC 日期在 `[from, to]` 内的已出库销售单。
- 返回 `{"from", "to", "orders", "quantity", "amount", "top_products"}`：单数、商品数量合计、金额合计（分）；`top_products` 是金额最高的至多 5 个商品 `[{"product_id", "sku", "name", "quantity", "amount"}]`，按 `amount` 降序，相同时按 `product_id` 升序。

## 13. 导出

- `GET /api/products/export.csv`：`Content-Type: text/csv; charset=utf-8`，第一行是表头 `sku,name,category,unit,price,cost,safety_stock,active`，之后每个商品一行（按 `id` 升序），`category` 是分类名称（没有就空），`price`、`cost` 是分，`active` 是 `true`/`false`；含逗号、双引号或换行的字段用双引号包起来，里面的双引号写两次。
- `GET /api/stock/export.csv`：表头 `warehouse,sku,name,quantity`，`warehouse` 是仓库代码，内容同 `GET /api/stock`。

# 页面

原型在 `docs/prototype/`，是低保真线框，样式可以自己定，**布局、字段、按钮和交互以原型为准**。每个页面一个路径，直接在浏览器打开这些路径都能看到对应页面（服务对这些路径返回 HTML）：

| 路径 | 页面 | 期 |
|---|---|---|
| `/login` | 登录 | 一 |
| `/` | 看板（第一期先放欢迎语和导航，第三期补数字） | 一、三 |
| `/products` | 商品列表、搜索、筛选、新建与编辑 | 一 |
| `/categories` | 分类树 | 一 |
| `/partners` | 往来单位 | 一 |
| `/warehouses` | 仓库 | 一 |
| `/users` | 用户管理（只有 admin 能看到入口） | 一 |
| `/stock` | 库存查询、库存流水、盘点 | 二 |
| `/purchase-orders`、`/purchase-orders/:id` | 采购单列表与详情 | 二 |
| `/sales-orders`、`/sales-orders/:id` | 销售单列表与详情 | 二 |
| `/transfers` | 调拨单 | 二 |
| `/reports` | 销售报表与导出 | 三 |

- 所有页面有统一的顶栏（系统名、当前用户、退出）和左侧导航。
- 列表页的空状态、加载中、出错都要有提示；表单校验失败时在对应字段下显示错误信息（来自 API 的 `message`）。
- 金额在页面上显示为元（两位小数），提交时换算成分。

## 不做的

多币种、税、批次与保质期、打印、移动端适配、找回密码、操作日志页面。
