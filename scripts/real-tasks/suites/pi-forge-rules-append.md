
## 本项目（pi-forge 自身）的补充规则
- R20 `src/core/` 分层：下层不得 import 上层（state → security/workspace → verify/insight → spec → acceptance → plan → stage → engine → ops）；`test/unit/core-layers.test.ts` 会检查。
- R21 只用可擦除的 TypeScript 语法（不用参数属性、enum、namespace）；标识符英文，面向用户的文字中文。
- R22 改动后至少运行 `npm run typecheck` 与 `npm run test:fast`；不跑 e2e。快照测试（`UPDATE_SNAPSHOTS=1`）重新生成后必须核对 diff。
- R23 新增的检查与统计做成纯函数并配单元测试；不读 `.forge/` 以外的状态、不调用 Pi API。
