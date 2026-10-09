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
| `ui.md` | 设计变量与组件库、怎样对照原型、可访问名称（验收测试靠它定位元素） |
| `commands.yaml` | install、typecheck、lint、test、acceptance、acceptance_list、e2e、contract_lint、contract_test、codegen、serve、merge_check；gui_commands；acctest_workspace.include |

不适用的层不写。通用规则在 rules/global.md 里，不要重复。

## 命令要求

- 都能在干净的 worktree 里直接运行，不需要交互。
- `acceptance -- <task>` 只运行 tests/acceptance/<task>/；不带参数时运行全部。需要的服务由命令自己启动和停止，端口用空闲端口。
- `acceptance_list -- <task>`：只收集、不执行（例如 `vitest list`、`pytest --collect-only -q`）。
- `merge_check`：合并时额外跑的检查，例如"生成的客户端与 openapi.yaml 一致"、"迁移只能有一个 head"。
- 所有会启动服务或连数据库的命令，都从环境变量 PORT、FORGE_PORT_BASE、FORGE_DB_NAME、FORGE_TMP 取端口、数据库和临时目录，不写死。
- `acctest_workspace`：test-author 的隔离工作区只导出文档、验收测试和根目录配置。`include` 列出 monorepo 中运行 install 与 acceptance_list 还需要的文件（子包的 package.json、测试配置）；`cache` 列出可以按锁文件哈希复用的依赖目录（如 node_modules、.venv）。
- `db_create`、`db_drop`（可选）：项目使用服务器类数据库时，按 `FORGE_DB_NAME` 建库、删库的命令。

## 写法

- 每条一句话，可以检查：写"服务层抛出 `AppError('DATASOURCE_NAME_TAKEN')`（server/src/shared/errors.ts）"，不写"注意错误处理"。
- 关键条目给出最短的正确与错误写法对照，各一两行代码。
- 按重要性排列：违反了会出错或有安全问题的放前面。
- 能被 lint、类型检查或测试自动发现的，不写成规则，交给工具。
- 每个文件不超过 100 行。**文件末尾附 3 到 8 条审查清单**（`- [ ] R1 ...`），编号稳定；reviewer 引用它作为"必须改"的出处，例如 `rule:backend.md#R3`。

## 自检

- 与 arch/overview.md、契约没有矛盾。
- worker 只看规则和任务说明，就知道代码该放在哪、怎么写、出错了怎么办。
- reviewer 能按审查清单逐条判断"满足"或"不满足"。
