# 架构（摘要）

- 运行时：Node 24，TypeScript 由 node 直接运行（只用可擦除语法：不用参数属性、enum、namespace）。依赖只有 `@sinclair/typebox` 与 `yaml`。
- `src/core/`：业务逻辑，不依赖 Pi，**分层且下层不得 import 上层**（`test/unit/core-layers.test.ts` 检查）。自下而上：`state`(1) → `security`、`workspace`(2) → `verify`、`insight`(3) → `spec`(4) → `acceptance`(5) → `plan`(6) → `stage`(7) → `engine`(8) → `ops`(9)。
- 本轮改动涉及的入口：度量 `src/core/stage/signoff.ts`（`computeMetrics`、`renderMetrics`）与 `src/core/ops/status-detail.ts`（`renderMetricsView`）；计划报告 `src/core/state/dag.ts` + `src/core/plan/plan.ts`（`formatPlanReport`）；规格检查 `src/core/spec/spec.ts`（`lintSpec`，返回 `{ issues, warnings }`）；脱敏 `src/core/security/redact.ts`（`redactSecrets`）；守卫 `src/core/security/guard.ts`（`checkToolCall`、`localCurlDenied`）；状态视图 `src/core/ops/status-view.ts`（`renderStatus`、`renderFlow`）。
- 测试：`npm run test:fast`（纯函数单元测试，1 秒；`scripts/test-groups.ts` 按文件内容分组，新增的纯函数测试文件自动归入）；`npm run typecheck`。e2e（`test/e2e/`）很慢，子 agent 不跑。
- 验收测试：`tests/acceptance/<task>/*.test.ts`，`npm run test:acceptance -- <task>`，直接 import 被测的导出函数。
- 面向用户的文字用中文，标识符用英文。
