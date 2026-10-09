# pi-forge 项目说明（给 Claude Code）

## 需求与记录
- 规格见 `docs/BUILD_PROMPT.md`（不要修改它）。所有偏离规格的决定、已核实的 Pi API、已验证的版本号、真实模型实验的结论，都记在 `NOTES.md`。新增偏离时，在"偏离记录"末尾追加编号条目（1 到 3 行，只写决定与原因，细节看代码和测试）；被修订的旧条目要注明。
- 复用来源是 pi-flow（`~/Documents/Code/program/pi-flow`。运行时文件取 HEAD `31f3f15`，流程层取 `7006e7d`（第 1、16 节））。拷贝或改编的文件，在文件头注明来源。pi-flow 的 `NOTES.md` 和 `docs/EXPERIMENTS-4.md` 记录了为什么这样设计，改动运行时之前先读。
- 按里程碑推进：每个里程碑开始前给出计划；完成后汇报（做了什么、偏离、待确认项、下一步），**等用户确认再继续**。用户明确要求连续完成时除外。
- Pi 的 API 先查文档或源码再用，不凭记忆。Pi 安装在 `$(npm root -g)/@earendil-works/pi-coding-agent`。

## 结构（与 pi-flow 相同）
- `src/core/`：业务逻辑，不依赖 Pi。`state-store.ts` 是 `.forge/` 唯一的读写入口；`state-machine.ts` 是转移表（不在表中的转移一律拒绝）；`dispatcher.ts` 是引擎。
- `src/tools/`：`forge_*` 工具的业务实现；`src/commands/`：斜杠命令的业务实现；`src/modes/`：阶段计划与 fix 流程。
- `src/pi-adapter/`：**唯一**可以调用 Pi API 的目录。
- `agents/`、`rules/`、`skills/`、`templates/`：角色提示、规则、技能、项目模板。
- `schemas/*.json` 由 `npm run gen:schemas` 从 `src/core/schemas.ts` 生成。

## 约定
- 状态只能由程序写；agent 只通过 `forge_*` 工具提交申请。约束靠移除能力和程序校验，不靠提示词。
- 能用程序判断的不交给 LLM。新增的检查（spec-lint、契约检查、DAG 推导、覆盖率）都是纯函数，并且都有单元测试。
- 测试不得依赖真实 LLM：单元测试、`test/fixtures/fake-subagent`、`test/fixtures/fake-llm`。真实模型只在 M9 和 `scripts/real-build.ts` 中使用。
- 改动后运行 `npm run typecheck` 与 `npm test`。
- 只用可擦除的 TypeScript 语法（不用参数属性、enum、namespace）。
- 标识符和文件名用英文；面向用户的提示、错误信息和文档用中文。用户界面只显示高层阶段（规格 → 契约与计划 → 实施 → 交付），细节放在 `--detail`。
- 修改 `agents/`、`rules/`、`skills/` 会让子进程系统提示的稳定前缀发生变化，导致提示缓存失效。要在 `NOTES.md` 的"缓存提醒"中记一笔，并在汇报中提醒用户。
- 不读取、不打印任何密钥。
