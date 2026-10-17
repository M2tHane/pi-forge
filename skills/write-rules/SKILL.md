---
name: write-rules
description: 写项目命令（commands.yaml）与编码规则（rules/backend.md、rules/frontend.md）：命令能跑，规则具体、可检查、带审查清单
---

# 写项目命令与规则

两样都在 S0 写，随代码合并，合入即生效。`workflow.yaml` 是用户的流程配置，不改。

## commands.yaml

程序执行 install、test、acceptance、serve、env_up/env_down、db_create/db_drop、add_dep；其余命令（arch_check、contract_check、typecheck、lint 等）给开发 agent 与 reviewer 用，项目里有现成工具时才写。

- **test 与 serve 必写**；acceptance 用同一个测试器指定目录即可。
- `acceptance -- <task>` 只运行 tests/acceptance/<task>/；不带参数时运行全部（门禁用）。参数是相对 tests/acceptance/ 的路径。需要的服务由命令自己启动和停止。
- `arch_check`：架构检查（依赖方向、domain 之间只经接口调用）。`contract_check`：实际接口和 openapi.yaml 是否一致。
- 需要数据库服务器时写 `env_up`（例如启动本地数据库）、`db_create`、`db_drop`（按 $FORGE_DB_NAME 建库删库，一条语句）；依赖目录不是 node_modules 时写 `shared_env: { deps: [目录] }`。
- 都能在干净的 worktree 里直接运行，不需要交互。所有会启动服务或连数据库的命令，都从环境变量 PORT、FORGE_PORT_BASE、FORGE_DB_NAME、FORGE_TMP 取端口、数据库和临时目录，不写死。
- 会打开桌面应用或浏览器窗口的命令列进 gui_commands。一个命令只有一个清楚的职责（语法检查不能充当类型检查）。
- Python 项目用 uv 管理时：`install` 写 `uv sync --frozen`，其他命令写 `uv run --frozen <工具>`。加依赖用 `uv add`（guard 不允许 pip install）。

## 规则文件

规则按 task 注入：后端任务读 `rules/backend.md`，前端任务读 `rules/frontend.md`，reviewer 用同一份文件审查。写得具体，模型才会照做；写得含糊或与契约矛盾，任务就会卡住。

| 文件 | 写什么 |
|---|---|
| `rules/backend.md` | 分层与依赖方向、domain 之间怎么调用（只经接口，不读写别人的表）、controller 怎么组织、错误码怎么抛、权限检查放在哪一层、迁移的命名与写法、事务、禁止的写法（拼接 SQL） |
| `rules/frontend.md` | 目录、请求方式（只用生成的客户端）、mock 怎么切到真实接口、路由、表单校验、加载/空/错误/无权限四种状态的统一组件、怎样对照原型 |

通用的约定写进 docs/conventions.md，两份规则不要重复。

## 写法

- **每条规则都要能追溯到 PRD、契约、docs/arch/ 或安全底线（注入、越权、密钥）**。追溯不到的不写。
- **每个文件不超过 6 条规则、不超过 5 条审查清单。**
- 规则编号 `R<n>`，每条一句话，可以检查：`- R2 服务层抛出 BizException(ErrorCode.PRODUCT_NAME_TAKEN)`，不写"注意错误处理"。
- 关键条目给出最短的正确与错误写法对照，各一两行代码。按重要性排列。
- 能被 lint、arch_check、类型检查或测试自动发现的，不写成规则，交给工具。
- **文件末尾附审查清单**：每项以它检查的规则编号开头，如 `- [ ] R2 抛出的错误码都在错误码常量里`。编号不要变：reviewer 只能用文件里存在的 R 编号当"必须改"的出处（`rule:rules/backend.md#R2`）。

## 自检

- 与 docs/arch/overview.md、契约没有矛盾。
- 开发 agent 只看规则和任务说明，就知道代码该放在哪、怎么写、出错了怎么办。
- reviewer 能按审查清单逐条判断"满足"或"不满足"。
