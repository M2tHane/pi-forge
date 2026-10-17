# AGENTS.md

本项目使用 pi-forge 管理开发流程：架构（S0）→ 开发（批次 S1…Sn）→ 交付。架构阶段由 architect 改写本文件，写入项目的结构、命令与约定。

- 项目命令见 `workflow.yaml` 的 `commands`。
- 流程状态在 `.forge/`（由程序维护，agent 不可读写）；查看用 `/forge-status`。
- 规则在 `rules/`：`global.md` 是通用规则，`<layer>.md` 按层生效（S0 由 architect 直接写入）。
- 文档：需求 `docs/PRD.md` 与原型 `docs/prototype/`（用户写的，agent 不改）、架构 `docs/arch/`、边界契约 `docs/contracts/`（批准后只能追加）、计划 `docs/plan/plan.yaml`、阶段验收报告 `docs/qa/`、审查建议 `docs/review/suggestions.md`。
- 验收测试在 `tests/acceptance/<task>/`，由该 task 的 worker 编写，reviewer 审查并运行；其他 task 不能修改。

小改动（单文件、几十行以内）直接用 pi 更划算；缺陷修复用 `/forge-fix`。
