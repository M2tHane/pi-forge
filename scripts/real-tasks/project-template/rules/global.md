# 全局规则

- R1 不引入第三方依赖；标准库够用。确实需要时先用 forge_block 说明，不要自己改 package.json 的 dependencies。
- R2 错误响应只用 `src/shared/errors.ts` 的 `errorResponse()` 与 `ERROR_CODES`；新增错误码在对象末尾追加一行。
- R3 每个接口都要有验收测试，测试名以 `[REQ-xxx.ACn]` 开头，只经 `tests/acceptance/_support/api.ts` 调用。
- R4 不改已有测试的断言；接口变化导致旧测试失败时，先在 handoff 里写明原因。
- R5 完成定义：`npm test` 与 `npm run test:acceptance` 都通过。
