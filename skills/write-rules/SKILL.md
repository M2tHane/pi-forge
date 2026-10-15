---
name: write-rules
description: 写分层的项目规则（rules/<layer>.md，S0 写）与项目命令（commands.yaml，P1 写、S0 修正）：具体、可检查、带审查清单
---

# 写项目规则

（按层拆文件，按 task 的 layers 注入；每个文件末尾的审查清单是 reviewer 判断"必须改"的依据。）

规则会被注入到相关层的 worker、reviewer、stage-qa 的提示里。写得具体，模型才会照做；写得含糊或与契约矛盾，task 就会卡住。
分两段做：**P1 只写项目命令** 仓库根目录的 `commands.yaml`（随代码合并，合入即生效；`workflow.yaml` 是用户的流程配置，不改）；**规则在 S0 由你直接写到 `rules/`**（`global.md` 必写，再按计划里的 layers 写 `rules/<layer>.md`）。

## 文件

| 文件 | 写什么 |
|---|---|
| `rules/backend.md` | 框架用法、分层（路由、服务、仓储）与依赖方向、错误处理（如何抛出 errors/*.yaml 里的错误码）、权限检查放在哪一层、日志、配置读取 |
| `rules/database.md` | ORM 或查询库、迁移的命名与写法、主键与时间等通用字段、事务、禁止的写法（拼接 SQL）、多租户过滤（team_id） |
| `rules/frontend.md` | 框架、目录、请求方式（只用生成的客户端）、状态管理、路由、表单校验、四种页面状态的统一组件 |
| `rules/ui.md` | 设计变量与组件库、怎样对照原型、可访问名称与四种状态的呈现方式（验收测试靠可访问名称定位元素）。不写焦点管理、键盘循环等交互细节，它们进 manual_checks |
| `commands.yaml`（P1） | 必写 test、serve（acceptance 用同一个测试器指定目录）。程序只执行 install、test、acceptance、serve、env_up/env_down、db_create/db_drop、add_dep；typecheck、lint 等只给 agent 参考，项目已有现成工具时才写，零第三方依赖不写；gui_commands 按需 |

不适用的层不写（层名按计划里的 layers）。通用规则写在 `rules/global.md`，各层文件不要重复。

## 命令要求（P1 写；S0 负责让这些命令真的能跑）

- 都能在干净的 worktree 里直接运行，不需要交互。
- `acceptance -- <task>` 只运行 tests/acceptance/<task>/；不带参数时运行全部（阶段门禁用）。参数是相对 tests/acceptance/ 的路径。需要的服务由命令自己启动和停止，端口用空闲端口。
- 所有会启动服务或连数据库的命令，都从环境变量 PORT、FORGE_PORT_BASE、FORGE_DB_NAME、FORGE_TMP 取端口、数据库和临时目录，不写死。
- `db_create`、`db_drop`（可选）：项目使用服务器类数据库时，按 `FORGE_DB_NAME` 建库、删库的命令。
- Python 项目用 uv 管理时：`install` 写 `uv sync --frozen`，其他命令写 `uv run --frozen <工具>`（例如 `uv run --frozen pytest`）。每个 worktree 有自己的 `.venv`，包从 uv 的全局缓存链接，同步很快；加依赖用 `uv add`，会记进 pyproject.toml 与 uv.lock（guard 不允许 pip install）。

## 写法

- **每条规则都要能追溯到 permissions.md、screens.md、契约或安全底线（注入、越权、密钥）**。追溯不到的不写。
- **每个文件不超过 5 条规则、不超过 4 条审查清单。**
- 规则编号 `R<n>`，每条一句话，可以检查：`- R2 服务层抛出 AppError('DATASOURCE_NAME_TAKEN')（server/src/shared/errors.ts）`，不写"注意错误处理"。
- 关键条目给出最短的正确与错误写法对照，各一两行代码。
- 按重要性排列：违反了会出错或有安全问题的放前面。
- 能被 lint、类型检查或测试自动发现的，不写成规则，交给工具。
- **文件末尾附审查清单**：每项以它检查的规则编号开头，如 `- [ ] R2 抛出的错误码都在 errors/*.yaml 里`。编号不要变。
  reviewer 只能用文件里存在的 R 编号当"必须改"的出处，格式 `rule:rules/backend.md#R2`，所以编号要稳定。

## 自检

- 与 arch/overview.md、契约没有矛盾。
- worker 只看规则和任务说明，就知道代码该放在哪、怎么写、出错了怎么办。
- reviewer 能按审查清单逐条判断"满足"或"不满足"。
