# legacy/：改编参考，不参与构建

这里的文件原样取自 pi-flow（`~/Documents/Code/program/pi-flow`），没有改名，也不参与 `tsc` 与测试（`tsconfig.json` 已排除，`package.json` 的 `files` 不包含）。M1 以后改编流程层时对照使用。

| 目录 | 提交 | 内容 | 用途 |
|---|---|---|---|
| `7006e7d/src/core/` | `7006e7d` | stages、revision、acceptance、final-review、requirements、gates | 流程层的基线（BUILD_PROMPT 第 1、16 节）：那时 architect 还在 |
| `7006e7d/src/modes/` | `7006e7d` | plan、fix | 同上 |
| `7006e7d/src/tools/` | `7006e7d` | module-tools（architect 用 `flow_propose_modules` 提交模块）、orchestrator-tools（`flow_replan` 交给 architect） | 对照 `forge_propose_plan`、变更请求 |
| `7006e7d/test/` | `7006e7d` | e2e 的 modules、replan、final-review、fix，unit 的 revision，helpers/flow5 | 上述文件当时的测试 |
| `5100d6b-parent/src/core/` | `5100d6b^`（`feae289`） | stage-review（清单 → 修复 → 只确认）、state-machine（review、precheck 等转移） | 第 16 节"从历史找回" |
