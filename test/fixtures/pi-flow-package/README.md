# pi-flow 的包内容（测试夹具）

来源：pi-flow `agents/`、`skills/`、`rules/`、`templates/`、`prompts/` @ 31f3f15，只做了 M0 的改名（`flow_*` → `forge_*`、`/flow` → `/forge`、`.flow` → `.forge`、`pi-flow` → `pi-forge`）。

pi-forge 自己的 `agents/`、`skills/`、`rules/`、`templates/workflow.yaml` 已经是 v3 的新内容，pi-flow 的运行时（M0 原样迁入）还解析不了。运行时测试通过 `test/helpers/package.ts` 的 `PKG_CONTENT` 引用这里；真实 pi 进程的测试用环境变量 `PI_FORGE_CONTENT_ROOT` 指向这里。M1 起 config 改为解析 v3 模板，测试随之迁移，这个目录最终删除。
