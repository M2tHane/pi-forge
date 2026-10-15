# 社团管理 API（club）

一个给兴趣社团用的后端：管理成员、场地、器材、公告和标签，在场地里安排活动，成员报名参加活动。只做 HTTP JSON API，不做网页界面，不做登录。

**分两期交付。** 第一期是 5 个互不依赖的基础模块（第 1–5 节），彼此之间没有引用，可以同时开发；第二期（第 6–8 节）在它们之上做活动、报名和统计。

## 技术约束

- Node.js 22 及以上，ES 模块（`package.json` 里 `"type": "module"`），只用 Node 自带模块（`node:http`、`node:fs` 等），**不使用第三方运行时依赖**。
- `npm start` 启动服务：监听环境变量 `PORT`（默认 3000）；数据存在环境变量 `DATA_DIR` 指定的目录（默认 `./data`，不存在时自动创建），用 JSON 文件即可。每次写操作成功返回前数据已经落盘；重启服务后数据与编号计数都保留。
- `npm test` 运行项目自己的测试（`node --test`）。
- `GET /health` 返回 `200 {"ok": true}`。

## 通用约定

- 请求与响应都是 JSON，响应头 `Content-Type: application/json; charset=utf-8`。
- 成功：创建返回 `201` 与新对象；查询返回 `200`；修改（PATCH）返回 `200` 与修改后的对象；删除返回 `204`，没有响应体。
- 失败统一返回 `{"error": {"code": "<代码>", "message": "<中文说明>"}}`：
  - `invalid_json`（400）：请求体不是合法 JSON，或不是 JSON 对象。
  - `validation_failed`（400）：字段缺失、类型或取值不对、查询参数不合法、引用的对象不存在。
  - `not_found`（404）：路径里的对象不存在（包括路径里的 id 不是正整数）；没有这个路径或方法。
  - `conflict`（409）：违反唯一性、时间冲突、名额已满，或删除仍被引用的对象。
- 编号 `id` 是正整数，每种资源各自从 1 递增，删除后不复用。
- 日期是 `YYYY-MM-DD`（必须是真实存在的日期），时间是 `HH:MM`（00:00–23:59）。
- 字符串字段先去掉首尾空白再校验长度。请求体里多余的字段忽略。
- 每种资源都有 `POST /<资源>` 创建、`GET /<资源>` 列表、`GET /<资源>/:id`、`PATCH /<资源>/:id`（只改请求里给出的字段，校验同创建）、`DELETE /<资源>/:id`。列表默认按 `id` 升序，另有说明的除外。

# 第一期

## 1. 成员 `/members`

字段：`id`、`name`（1–40 个字符）、`email`（必须含且只含一个 `@`，`@` 两边都不为空，不含空白；保存为小写；不区分大小写唯一）、`role`（`member` | `admin`，默认 `member`）。

- `email` 重复 → 409。
- `GET /members` 可选查询参数 `role` 过滤（取值不对 → 400）。

## 2. 场地 `/rooms`

字段：`id`、`name`（1–30 个字符，不区分大小写唯一）、`capacity`（整数 1–500）、`floor`（整数 -2–50，默认 1）。

- `name` 重复 → 409。
- `GET /rooms` 可选查询参数 `min_capacity`（正整数，不合法 → 400）：只返回 `capacity >= min_capacity` 的场地。

## 3. 器材 `/items`

字段：`id`、`name`（1–40 个字符）、`quantity`（整数 0–10000）、`condition`（`good` | `worn` | `broken`，默认 `good`）。名称可以重复。

- `GET /items` 可选查询参数 `condition` 过滤（取值不对 → 400）。
- `POST /items/:id/adjust`，请求体 `{"delta": <非零整数>}`：数量加上 `delta`，返回 `200` 与修改后的器材；结果小于 0 或大于 10000 → 409，数量不变。

## 4. 公告 `/notices`

字段：`id`、`title`（1–80 个字符）、`body`（0–2000 个字符，默认空字符串）、`pinned`（布尔，默认 `false`）。

- `GET /notices` 的顺序：置顶的在前，同组内按 `id` 降序。
- 可选查询参数 `q`：只返回 `title` 或 `body` 包含 `q` 的公告（不区分大小写；`q` 去掉首尾空白后为空 → 400）。

## 5. 标签 `/tags`

字段：`id`、`name`（1–20 个字符，不区分大小写唯一）、`color`（`#` 加 6 位十六进制，保存为小写，默认 `#888888`）。

- `name` 重复 → 409；`color` 格式不对 → 400。

# 第二期

## 6. 活动 `/events`

字段：`id`、`title`（1–60 个字符）、`room_id`、`date`、`start`、`end`（`end` 必须晚于 `start`，否则 400）、`tag_ids`（标签编号的数组，默认 `[]`，去重后按升序保存）、`signup_count`（只读，当前报名人数，响应里总是带上）。

- `room_id` 或 `tag_ids` 里有不存在的对象 → 400 `validation_failed`。
- 同一场地同一天时间段重叠的活动 → 409（`[start, end)` 左闭右开：一个 10:00 结束、另一个 10:00 开始不算重叠）。修改时也检查，不和自己比。
- `GET /events` 列表按 `date` 升序、同一天按 `start` 升序、再按 `id` 升序；可选查询参数 `date`（只列这一天）、`room_id`、`tag_id`（包含这个标签的），取值不合法 → 400。
- 删除活动时一并删除它的报名。
- 被活动引用的场地、标签不能删除 → 409。

## 7. 报名 `/events/:id/signups`

- `POST /events/:id/signups`，请求体 `{"member_id": <编号>}`：返回 `201 {"event_id", "member_id"}`。
  - 活动不存在 → 404；成员不存在 → 400 `validation_failed`；已经报过名 → 409；报名人数已达到场地的 `capacity` → 409。
- `GET /events/:id/signups`：返回报名成员的数组（成员对象），按成员 `id` 升序。
- `DELETE /events/:id/signups/:member_id`：取消报名，`204`；没有这条报名 → 404。
- 有报名的成员不能删除 → 409。
- `GET /members/:id/events`：这个成员报名的活动数组，顺序同 `GET /events`；成员不存在 → 404。

## 8. 统计 `/stats`

- `GET /stats`：`{"members", "rooms", "items", "notices", "tags", "events", "signups"}`，各是当前的条数（`items` 是器材记录数，不是数量合计）。
- `GET /stats/rooms?date=YYYY-MM-DD`（`date` 必填，不合法 → 400）：每个场地一项 `{"room_id", "name", "events", "signups"}`，是这一天该场地的活动数与报名人数合计，按 `room_id` 升序，没有活动的场地也列出（都是 0）。

## 不做的

登录与权限、通知、重复活动、网页界面。
