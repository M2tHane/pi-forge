# 架构

- 运行时：Node 24，TypeScript 直接由 node 运行（不编译，不用 tsc）。没有任何第三方依赖。
- `src/server/http.ts`：唯一的路由入口 `handle(method, path, body)`，返回 `{ status, body }`。`main.ts` 把它挂到 `node:http`。新接口在 `handle` 里加分支，业务逻辑放到各自模块（`boards.ts`、`cards.ts`…）。
- `src/shared/`：共享代码。`errors.ts` 的 `ERROR_CODES` 与 `errorResponse()` 是唯一的错误响应形式；`types.ts` 是与契约一致的共享类型。两者都只追加，不改已有条目。
- 存储：内存 `Map`，每个模块提供 `resetXxx()` 给测试清空。
- 测试：`tests/unit/`（node:test），验收测试 `tests/acceptance/<task>/`，只经 `tests/acceptance/_support/api.ts` 调用接口，不开端口。
- 契约：`docs/contracts/openapi.yaml`。实现者可以在 paths 与 components 里追加，不改已有条目。
