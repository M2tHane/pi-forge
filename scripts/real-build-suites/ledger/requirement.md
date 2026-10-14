# 家庭记账 API（ledger）

一个给家庭用的记账后端：记录各个账户的收入与支出，按月设预算，看月度报表，用 CSV 导入导出交易。只做 HTTP JSON API，不做网页界面，不做登录（单用户）。

## 技术约束

- Node.js 22 及以上，ES 模块（`package.json` 里 `"type": "module"`），只用 Node 自带模块（`node:http`、`node:fs` 等），**不使用第三方运行时依赖**。
- `npm start` 启动服务：监听环境变量 `PORT`（默认 3000）；数据存在环境变量 `DATA_DIR` 指定的目录（默认 `./data`，不存在时自动创建），用 JSON 文件即可。每次写操作成功返回前数据已经落盘；重启服务后数据与编号计数都保留。
- `npm test` 运行项目自己的测试（`node --test`）。
- `GET /health` 返回 `200 {"ok": true}`。

## 通用约定

- 请求与响应都是 JSON（CSV 接口除外），响应头 `Content-Type: application/json; charset=utf-8`。
- 成功：创建返回 `201` 与新对象；查询返回 `200`；修改（PATCH）返回 `200` 与修改后的对象；删除返回 `204`，没有响应体。
- 失败统一返回 `{"error": {"code": "<代码>", "message": "<中文说明>"}}`：
  - `invalid_json`（400）：请求体不是合法 JSON，或不是 JSON 对象。
  - `validation_failed`（400）：字段缺失、类型或取值不对、查询参数不合法、引用的对象不存在。
  - `not_found`（404）：路径里的对象不存在；没有这个路径或方法。
  - `conflict`（409）：违反唯一性，或删除仍被引用的对象。
- 编号 `id` 是正整数，每种资源各自从 1 递增，删除后不复用。
- 金额一律是整数，单位为分。日期是 `YYYY-MM-DD`（必须是真实存在的日期），月份是 `YYYY-MM`。
- 字符串字段先去掉首尾空白再校验长度。请求体里多余的字段忽略。

## 1. 账户 `/accounts`

字段：`id`、`name`（1–50 个字符，不区分大小写唯一）、`type`（`cash` | `bank` | `credit`）、`initial_balance`（整数，可为负，默认 0）。

- `POST /accounts` 创建；`name` 重复 → 409。
- `GET /accounts` 返回数组，按 `id` 升序。
- `GET /accounts/:id`、`PATCH /accounts/:id`（可改 `name`、`type`、`initial_balance`，校验同创建）、`DELETE /accounts/:id`。
- 删除时还有交易引用这个账户 → 409。

## 2. 分类 `/categories`

字段：`id`、`name`（1–30 个字符）、`kind`（`income` | `expense`）。同一 `kind` 下 `name` 不区分大小写唯一（收入和支出可以各有一个同名分类）。

- `POST /categories` 创建；重复 → 409。
- `GET /categories` 返回数组，按 `id` 升序；可选查询参数 `kind` 过滤（取值不对 → 400）。
- `GET /categories/:id`、`PATCH /categories/:id`（只能改 `name`；请求里带了 `kind` 且与原值不同 → 400）、`DELETE /categories/:id`。
- 删除时还有交易或预算引用这个分类 → 409。

## 3. 交易 `/transactions`

字段：`id`、`account_id`、`category_id`、`amount`（正整数，最大 100000000）、`date`、`note`（0–200 个字符，默认空字符串）、`kind`（只读，等于所属分类的 `kind`，响应里总是带上）。

- `POST /transactions` 创建；`account_id` 或 `category_id` 指向不存在的对象 → 400 `validation_failed`。
- `GET /transactions/:id`、`PATCH /transactions/:id`（可改 `account_id`、`category_id`、`amount`、`date`、`note`，校验同创建；改分类后 `kind` 随之变化）、`DELETE /transactions/:id`。
- `GET /transactions` 列表，返回 `{"items": [...], "total": <过滤后、分页前的条数>}`：
  - 过滤（都可选，可组合）：`from`、`to`（日期，含两端）、`account_id`、`category_id`、`kind`。
  - 排序：`date` 降序，同一天按 `id` 降序。
  - 分页：`limit`（1–200，默认 50）、`offset`（≥0，默认 0）。
  - 任何查询参数取值不合法 → 400。

## 4. 预算 `/budgets`

字段：`id`、`category_id`（必须是 `expense` 分类，否则 400）、`month`、`amount`（正整数）。同一分类同一月份只能有一个预算 → 重复 409。

- `POST /budgets` 创建。
- `GET /budgets?month=YYYY-MM`（`month` 必填，缺少或不合法 → 400）：返回该月的预算数组，按 `category_id` 升序，每项是 `{id, category_id, month, amount, spent, remaining}`，`spent` 是该分类在该月的交易金额合计，`remaining = amount - spent`（可以是负数）。
- `PATCH /budgets/:id`（只能改 `amount`）、`DELETE /budgets/:id`。

## 5. 报表 `/reports`

- `GET /reports/monthly?month=YYYY-MM`（`month` 必填，不合法 → 400）：
  `{"month", "income", "expense", "net", "by_category": [{"category_id", "name", "kind", "total"}]}`。
  `income`、`expense` 是该月收入、支出交易的金额合计，`net = income - expense`；`by_category` 只列该月有交易的分类，按 `total` 降序，相同时按 `category_id` 升序。
- `GET /reports/balances`：每个账户一项 `{"account_id", "name", "balance"}`，按 `account_id` 升序；`balance = initial_balance + 该账户收入合计 - 该账户支出合计`。

## 6. CSV 导入导出

CSV 的规则：逗号分隔，换行用 `\n`；字段里有逗号、双引号或换行时整个字段用双引号括起来，字段里的双引号写成两个双引号（RFC 4180）。

- `GET /export/transactions.csv`：`200`，`Content-Type: text/csv; charset=utf-8`。第一行是表头 `id,date,account,category,kind,amount,note`，之后每笔交易一行，按 `date` 升序、同一天按 `id` 升序；`account`、`category` 写名称，`amount` 写分。
- `POST /import/transactions`：请求体是 CSV（`Content-Type: text/csv`），表头必须是 `date,account,category,kind,amount,note`。账户按名称匹配，分类按名称与 `kind` 匹配（名称都不区分大小写）；每行按创建交易的规则校验。
  - 全部合法才导入，返回 `201 {"imported": <行数>}`；只有表头时导入 0 行。
  - 任何一行不合法（找不到账户或分类、金额或日期不对、列数不对）→ 400 `validation_failed`，一行也不导入；错误对象里多一个字段 `line`，是第一个出错的行号（表头是第 1 行），`message` 说明原因。
  - 表头不对 → 400 `validation_failed`，`line` 为 1。

## 不做的

登录与多用户、多币种、定时任务、网页界面。
