# pi-forge 项目说明（给 Claude Code）

## 需求与记录
- 规格见 `docs/BUILD_PROMPT.md`（不要修改它）。所有偏离规格的决定、已核实的 Pi API、已验证的版本号、真实模型实验的结论，都记在 `NOTES.md`。新增偏离时，在"偏离记录"末尾追加编号条目（1 到 3 行，只写决定与原因，细节看代码和测试）；被修订的旧条目要注明。
- 复用来源是 pi-flow（`~/Documents/Code/program/pi-flow`。运行时文件取 HEAD `31f3f15`，流程层取 `7006e7d`（第 1、16 节））。拷贝或改编的文件，在文件头注明来源。pi-flow 的 `NOTES.md` 和 `docs/EXPERIMENTS-4.md` 记录了为什么这样设计，改动运行时之前先读。
- 按里程碑推进：每个里程碑开始前给出计划；完成后汇报（做了什么、偏离、待确认项、下一步），**等用户确认再继续**。用户明确要求连续完成时除外。
- Pi 的 API 先查文档或源码再用，不凭记忆。Pi 安装在 `$(npm root -g)/@earendil-works/pi-coding-agent`。

## 结构（与 pi-flow 相同）
- `src/core/`：业务逻辑，不依赖 Pi，按模块分子目录。**分层：下层不得 import 上层，目录图无环**（`test/unit/core-layers.test.ts` 检查，新增目录先登记层号；旧路径对照见 `NOTES.md` 末节）。自下而上：
  - `state/`（1）：`.forge/` 状态层。`state-store.ts` 是 `.forge/` 唯一的读写入口；`state-machine.ts` 是转移表（不在表中的转移一律拒绝）；另有 schemas、event-log、migrations、checkpoints、config、paths、git、dag、waits，以及底层纯函数（failure-signature、acctest-lookup）。
  - `security/`（2）：guard（命令与路径校验）、shell 解析、redact、工具参数。
  - `workspace/`（2）：worktree、阶段 worktree、工作区合并、范围（scope）与越界检测、依赖准备、命令运行（verify-runner）、资源分配、服务、forge-read。
  - `verify/`（3）：验证缓存、测试调整。
  - `insight/`（3）：成本、预算与升级、角色模型设置、停滞检测（forge-watch）。
  - `spec/`（4）：规格解析与检查、规格流程、需求接入、预检。
  - `acceptance/`（5）：验收测试（acctest）、验收流程、覆盖率、阶段修复（stage-fix）。
  - `plan/`（6）：契约与计划：计划流程、契约检查/差异/合并、规则草稿、变更请求、feature 规格、纳管（adopt）、规格修订批准。
  - `stage/`（7）：阶段：审查、阶段审查/QA/验收/轮次、阶段定义、闸门（gates）、签收、合入主分支（release）。
  - `engine/`（8）：引擎。`dispatcher.ts` 是引擎；调度、子进程运行时、提示组装、上下文注入、合并队列、预检、知识库与笔记、谱系、指标。
  - `ops/`（9）：运维与查看（斜杠命令入口）：init、resume、doctor、状态视图、engine-lock、notify、history、codegraph。
- `src/tools/`：`forge_*` 工具的业务实现；`src/commands/`：斜杠命令的业务实现；`src/modes/`：阶段计划与 fix 流程。
- `src/pi-adapter/`：**唯一**可以调用 Pi API 的目录。
- `agents/`、`rules/`、`skills/`、`templates/`：角色提示、规则、技能、项目模板。
- `schemas/*.json` 由 `npm run gen:schemas` 从 `src/core/state/schemas.ts` 生成。

## 约定
- 状态只能由程序写；agent 只通过 `forge_*` 工具提交申请。约束靠移除能力和程序校验，不靠提示词。
- 能用程序判断的不交给 LLM。新增的检查（spec-lint、契约检查、DAG 推导、覆盖率）都是纯函数，并且都有单元测试。
- 测试不得依赖真实 LLM：单元测试、`test/fixtures/fake-subagent`、`test/fixtures/fake-llm`。真实模型只在 M9 和 `scripts/real-build.ts` 中使用。
- 改动后运行 `npm run typecheck` 与 `npm test`。
- 只用可擦除的 TypeScript 语法（不用参数属性、enum、namespace）。
- 标识符和文件名用英文；面向用户的提示、错误信息和文档用中文。用户界面只显示高层阶段（规格 → 契约与计划 → 实施 → 交付），细节放在 `--detail`。
- 修改 `agents/`、`rules/`、`skills/` 会让子进程系统提示的稳定前缀发生变化，导致提示缓存失效。要在 `NOTES.md` 的"缓存提醒"中记一笔，并在汇报中提醒用户。
- 不读取、不打印任何密钥。
