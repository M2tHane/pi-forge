---
name: write-rules
description: 写分层的项目规则草案（docs/rules-draft/<layer>.md）与命令草案：具体、可检查、带审查清单
---

# 写项目规则草案

（改编自 pi-flow 的 write-rules。pi-forge 的改动：按层拆文件，按 task 的 layers 注入；每个文件末尾的审查清单是 reviewer 判断"必须改"的依据。）

规则会被注入到相关层的 worker、reviewer、stage-qa 的提示里。写得具体，模型才会照做；写得含糊或与契约矛盾，task 就会卡住。
你不能改 `rules/` 和 `workflow.yaml`，只能写草案到 `docs/rules-draft/`，用户批准计划时由程序应用。

## 文件

| 文件 | 写什么 |
|---|---|
| `backend.md` | 框架用法、分层（路由、服务、仓储）与依赖方向、错误处理（如何抛出 errors/*.yaml 里的错误码）、权限检查放在哪一层、日志、配置读取 |
| `database.md` | ORM 或查询库、迁移的命名与写法、主键与时间等通用字段、事务、禁止的写法（拼接 SQL）、多租户过滤（team_id） |
| `frontend.md` | 框架、目录、请求方式（只用生成的客户端）、状态管理、路由、表单校验、四种页面状态的统一组件 |
| `ui.md` | 设计变量与组件库、怎样对照原型、可访问名称与四种状态的呈现方式（验收测试靠可访问名称定位元素）。不写焦点管理、键盘循环等交互细节，它们进 manual_checks |
| `commands.yaml` | 必配 test、serve（acceptance、acceptance_list 用同一个测试器指定目录）。typecheck、lint、codegen、e2e、contract_lint、contract_test、merge_check 只在项目已有现成工具时配置，零第三方依赖一律不配；gui_commands；acctest_workspace.include 按需 |

不适用的层不写。通用规则在 rules/global.md 里，不要重复。

## 命令要求

- 都能在干净的 worktree 里直接运行，不需要交互。
- `acceptance -- <task>` 只运行 tests/acceptance/<task>/；`acceptance -- suite/<文件>` 只运行共享目录 tests/acceptance/suite/ 下的这些文件（可带多个，lean 预检用）；不带参数时运行全部（阶段门禁用）。参数是相对 tests/acceptance/ 的路径，命令要同时支持目录和文件。需要的服务由命令自己启动和停止，端口用空闲端口。
- `acceptance_list -- <task>`：只收集、不执行（例如 `vitest list`、`pytest --collect-only -q`）。
- `merge_check`：合并时额外跑的检查，例如"生成的客户端与 openapi.yaml 一致"、"迁移只能有一个 head"。
- 所有会启动服务或连数据库的命令，都从环境变量 PORT、FORGE_PORT_BASE、FORGE_DB_NAME、FORGE_TMP 取端口、数据库和临时目录，不写死。
- `acctest_workspace`：仅 `test_author: true` 时有用（默认没有 test-author）。test-author 的隔离工作区只导出文档、验收测试和根目录配置。`include` 列出 monorepo 中运行 install 与 acceptance_list 还需要的文件（子包的 package.json、测试配置）；`cache` 列出可以按锁文件哈希复用的依赖目录（如 node_modules、.venv）。
- `db_create`、`db_drop`（可选）：项目使用服务器类数据库时，按 `FORGE_DB_NAME` 建库、删库的命令。

## 写法

- **每条规则都要能追溯到 permissions.md、screens.md、契约或安全底线（注入、越权、密钥）**。追溯不到的不写。
- **每个文件不超过 5 条规则、不超过 4 条审查清单。**
- 规则编号 `R<n>`，每条一句话，可以检查：`- R2 服务层抛出 AppError('DATASOURCE_NAME_TAKEN')（server/src/shared/errors.ts）`，不写"注意错误处理"。
- 关键条目给出最短的正确与错误写法对照，各一两行代码。
- 按重要性排列：违反了会出错或有安全问题的放前面。
- 能被 lint、类型检查或测试自动发现的，不写成规则，交给工具。
- **文件末尾附审查清单**：每项以它检查的规则编号开头，如 `- [ ] R2 抛出的错误码都在 errors/*.yaml 里`。编号不要变。
  reviewer 只能用文件里存在的 R 编号当"必须改"的出处，格式 `rule:rules/backend.md#R2`；编号不存在的引用会被程序降为建议。

## 自检

- 与 arch/overview.md、契约没有矛盾。
- worker 只看规则和任务说明，就知道代码该放在哪、怎么写、出错了怎么办。
- reviewer 能按审查清单逐条判断"满足"或"不满足"。
