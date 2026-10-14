# 后端规则

- R10 路由只在 `src/server/http.ts` 的 `handle()` 里分发，业务逻辑放各自模块。
- R11 每个模块导出 `resetXxx()` 供测试清空内存数据。
- R12 校验失败返回 400 + E_VALIDATION，找不到资源返回 404 + E_NOT_FOUND。
