# AGENTS.md

本项目用 pi-forge 开发：架构（S0）→ 开发（批次 S1…Sn）→ 交付。本文件是目录，只写信息在哪、常用命令、不能碰什么；细节放在下面列出的文档里。架构阶段由 architect 按项目实际改写，保持 100 行以内。

## 信息在哪

| 要找什么 | 在哪 | 谁写 |
|---|---|---|
| 需求与验收标准（REQ、AC、页面表、通用约定） | `docs/PRD.md` | 用户 |
| 可点击原型 | `docs/prototype/` | 用户 |
| 技术栈、目录结构、分层与依赖方向 | `docs/arch/overview.md` | architect |
| domain 的职责、表、对外接口、依赖 | `docs/arch/domains.md` | architect |
| 架构决定与技术问答记录 | `docs/arch/decisions.md` | architect |
| 前后端 HTTP 接口 | `docs/contracts/openapi.yaml` | architect |
| 每个页面用哪些接口 | `docs/contracts/page-api.md` | architect |
| 鉴权、错误码、分页、时间金额格式 | `docs/conventions.md` | architect |
| 编码规则与审查清单 | `rules/backend.md`、`rules/frontend.md`、`rules/global.md` | architect |
| 批次、domain、页面顺序、公共文件 | `docs/plan.md` | architect |
| 前端视觉与公共组件 | `DESIGN.md`、`theme.css`（位置见 overview.md） | frontend |
| 验收测试 | `tests/acceptance/<任务>/`，公共工具在 `tests/acceptance/_support/` | 各任务自己 |
| 批次验收报告、审查建议 | `docs/qa/`、`docs/review/suggestions.md` | 程序 |

<!-- architect：在这里补充代码目录（后端各层、各 domain 的包、前端工程、公共代码、迁移目录）的位置。 -->

## 常用命令

命令定义在 `commands.yaml`，端口、数据库、临时目录从环境变量 `PORT`、`FORGE_PORT_BASE`、`FORGE_DB_NAME`、`FORGE_TMP` 取。

| 命令 | 用途 |
|---|---|
| `install` | 安装依赖（开发时依赖目录是共享链接，缺依赖用 `forge_add_dependency`） |
| `test` | 全部单元测试 |
| `acceptance -- <任务>` | 只跑某个任务的验收测试；不带参数跑全部 |
| `serve` | 启动服务（用 `forge_service`，不要放到后台） |
| `arch_check` | 架构检查：依赖方向、domain 之间只经接口 |
| `contract_check` | 实际接口与 `openapi.yaml` 是否一致 |

<!-- architect：按 commands.yaml 补全（typecheck、lint、db_create……），删掉项目没有的。 -->

## 不能碰什么

- `docs/PRD.md`、`docs/prototype/`：用户的需求与原型，所有 agent 只读。
- `docs/contracts/**`、`docs/arch/**`、`docs/plan.md`、`AGENTS.md`、`rules/**`：只有 architect 能改。开发中要改契约或已有公共内容，用 `forge_ask_architect`。
- `docs/plan.md` 里 `shared` 列出的公共文件：只能追加，修改找架构师。
- `.forge/`、`.git/`、`workflow.yaml`、`.pi/`、密钥文件：由程序或用户维护。
- 别的任务的验收测试目录：不改。

## 怎么协作

- 技术问题（接口怎么用、约定怎么理解、要改公共内容或契约）：`forge_ask_architect`。
- 需求矛盾、需要用户的环境或决定：`forge_block`。
- 对以后任务也有用的经验：`forge_learn`。
- 流程状态看 `/forge-status`；小改动用 `/forge-change`，缺陷修复用 `/forge-fix`。
