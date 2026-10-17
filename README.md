# pi-forge

pi-forge 是一个 [Pi](https://github.com/earendil-works/pi-coding-agent) 插件：你写好 PRD、做好可点击的原型，它交给一组分工明确的 agent 做出项目——架构师定下技术栈、骨架与契约，后端按 domain 并行开发，一个前端 agent 按页面顺序开发，每个任务都经过审查，每个批次接上真实接口后在浏览器里验收，由你签收，最后合入主分支。

调度不经过 LLM：选哪个任务、派给谁、并行几个、何时合并，全部由程序决定。agent 只做它那一份工作，并通过 `forge_*` 工具向程序提交结果。

> 状态：测试都用假模型（fake-llm、fake-subagent）。真实模型的实验结论见 [NOTES.md](NOTES.md) 的"真实模型实验"（现在这套"PRD 与原型 → 架构 → 按批次开发"的流程还没有用真实模型跑过）。已知局限见 [NOTES.md](NOTES.md) 的"已知局限"。

第一次接触这个项目，先读 [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)：概念、角色，以及一个任务在代码里怎么走。流程图见 [docs/flow.md](docs/flow.md)。

## 核心思路

- **需求在流程外定好。** 你和 Claude 写 `docs/PRD.md`，用 Claude Design 做原型放进 `docs/prototype/`，自己点过、满意了再开始。PRD 是需求的唯一依据，流程里不再改写成另一套规格。
- **架构一次定下。** 架构阶段（S0）由 architect 一次做完技术栈、骨架、公共代码、domain 划分与接口、前后端契约、规则、命令与批次计划，你批准后才开始开发。
- **前端单人、后端按 domain 并行。** 每个 domain 一个后端任务并行；前端只有一个 agent，按页面顺序接着同一个会话做。双方只靠契约对接。
- **状态只由程序写。** 流程状态在项目的 `.forge/`（事件日志带哈希链，提交到 `refs/pi-forge/state`）。agent 只能通过 `forge_*` 工具提交申请，由程序校验后写入。
- **默认放权，只拦禁止列表。** 开发 agent 在自己的 worktree 里可以读、写、执行；guard 只拦受保护路径（`.forge/`、`.git/`、`workflow.yaml`、密钥、PRD 与原型；对后端和前端还有契约与架构文档）和少数危险命令。
- **"必须改"要有出处。** reviewer 和 stage-qa 的必须改要引用 AC、契约、规则或具体缺陷；第二轮只能确认，不能提新问题。
- **人工闸门不能被 agent 自批准。** 架构批准与每批签收都要你执行 `/forge-approve`。

### 什么时候用，什么时候直接用 pi

几十行以内的改动直接用 `pi` 更划算。pi-forge 适合有 PRD、有原型、前后端都有、需要分批交付和验收的项目；缺陷修复用 `/forge-fix`，交付后加小功能用 `/forge-change`。它有固定的开销（架构阶段、每批的接入、验收与签收），项目越小越不划算。

## 环境与安装

| 项目 | 要求 |
|---|---|
| Node | 22 以上（开发和测试用 24.18.0） |
| git | 2.30 以上（用到 worktree） |
| Pi | `@earendil-works/pi-coding-agent`，在 1.1.0 上验证过，其他版本会提醒 |
| 必需插件 | pi-playwright（stage-qa 的浏览器验收用，另需下载约 98MB 的 Chromium；没装不能开始流程，安装命令见 `/forge doctor` 的提示） |
| 可选插件 | pi-codegraph（读代码），pi-web-access（联网搜索，默认不分配给角色）。缺少时 `/forge doctor` 会提醒 |

安装（本地路径，Pi 不替你装依赖，所以先在 pi-forge 目录安装）：

```bash
cd /path/to/pi-forge
npm install
pi install /path/to/pi-forge        # 加 -l 写入项目的 .pi/settings.json
```

包清单在 `package.json` 的 `pi` 字段：扩展入口是 `src/pi-adapter/extension.ts`，技能目录是 `skills/`。

### 初始化项目

在项目的 git 仓库根目录运行 `/forge init`。它生成 `workflow.yaml`、`AGENTS.md`、`rules/global.md`、`docs/PRD.md` 模板、`docs/prototype/README.md` 与 `tests/acceptance/` 骨架，把 `.codegraph/` 写进 `.gitignore`，初始化 `.forge/` 并提交一次。可以重复执行，不覆盖已有文件。`/forge-build` 和 `/forge-fix` 在项目没有初始化时会自动执行它。

然后用 `/forge-config` 为各角色选模型和思考级别（保存在 `~/.pi/agent/pi-forge.json`，见 `/forge-config help`）。建议 reviewer 用和开发角色不同的模型，并设一个兜底模型，服务中断时任务换它继续。

## 快速开始

### 新项目

1. 写 `docs/PRD.md`（照 `/forge init` 生成的模板）。程序只读三样东西，格式要照写：
   - 每条需求的标题带编号 `REQ-xxx`，例如 `### 6.3 商品  REQ-003`；
   - 验收标准写在需求下面，每条一行，以 `- ACn` 开头，例如 `- AC1 Given … When … Then …`，程序据此组成 `REQ-003.AC1`；
   - 「页面」一节的表格：`页面 | 原型文件 | 对应需求`，原型文件写相对路径，例如 `docs/prototype/products.html`。

   另外建议写概述、用户与角色、分期、约束（技术栈，不写由架构师决定）、通用约定（字段规则、格式）、不做的、待定。解析不出 REQ、某条 REQ 没有 AC、原型文件不存在、编号重复，都只警告，显示在架构批准页上。
2. 把可点击的 HTML 原型（含 CSS 与图片）放进 `docs/prototype/`，至少一个 `.html`。
3. 运行：

```
/forge-build                # 或 /forge-build "项目名"
```

缺 PRD 或原型时只提示，不开始流程。齐全时程序把两者提交到集成分支，派 architect 开始架构阶段。之后按"流程"一节走。

### 修缺陷

```
/forge-fix "登录后刷新页面会掉线：复现步骤……期望……"
/forge-fix --from bug.md
```

一个 worker 定位并修复（加回归测试），合并时跑全量测试，直接合入主分支；再由 stage-qa 复现确认。流程运行中不能同时修复。

### 小改动（交付之后加小功能）

```
/forge-change --from change.yaml
```

```yaml
title: 看板支持归档
description: 归档后的看板不在列表中显示，可以在"已归档"里恢复
tasks:
  - title: 归档与恢复接口
    writes: [src/server/boards/**]
    ac: ["Given 看板存在 When 调用归档 Then 列表不再返回它", "Given 已归档 When 恢复 Then 列表再次返回它"]
  - title: 归档入口与已归档页面
    writes: [src/web/boards/**]
    depends_on: [{ task: T-001, type: hard }]
    ac: ["Given 看板详情 When 点击归档 Then 跳转列表且该看板消失"]
```

也可以在主会话里直接说要加什么，由它用 `forge_change` 提交。1 到 3 个 task（`limits.change_max_tasks`），worker 实现、reviewer 审查、逐个合入主分支；全部完成后 architect 更新 `docs/arch/` 与 `docs/contracts/`（不用改时无改动提交），最后 stage-qa 确认。超过 3 个 task 时用 `/forge-build`。

## 流程

界面上只显示三个高层阶段：**架构 → 开发 → 交付**。`/forge-status` 看当前在哪一步、需要你处理什么；`--detail` 看内部状态（阶段 id S0、S1…Sn）。

```
/forge-build
  → 架构阶段 S0：architect 做全部架构产出 → reviewer 审查 → 合并、门禁 → 等你批准
/forge-approve
  → 程序按 docs/plan.md 生成批次 S1…Sn 与任务，架构产出 --no-ff 合入主分支，开始第 1 批
  → 后端 domain 并行、前端按页面顺序 → 逐个审查 → 合并
  → 本批页面与 domain 都完成 → 前端接入真实接口 → 门禁 → 浏览器验收 → 修复 → 复验 → 等你签收
/forge-approve
  → 下一批……最后一批签收后合入主分支（交付）
```

### 架构阶段（S0）

一个由 architect 完成的任务，产出：

| 产出 | 内容 |
|---|---|
| 代码 | 项目骨架、公共代码（统一响应、错误码、异常、枚举）、鉴权机制、domain 间接口与 DTO（空实现）、domain 骨架、数据库迁移配置与初始数据、前端骨架（路由外壳、从 OpenAPI 生成的客户端与 mock）、检查工具（`arch_check`、`contract_check`、lint）、测试基础与一条前端 → API → 数据库的冒烟测试 |
| 文档 | `AGENTS.md`（目录）、`docs/arch/overview.md`、`docs/arch/domains.md`、`docs/arch/decisions.md`、`docs/contracts/openapi.yaml`、`docs/contracts/page-api.md`、`docs/conventions.md`、`rules/backend.md`、`rules/frontend.md`、`commands.yaml`、`docs/plan.md` |

提交时程序检查必需文件都在（AGENTS.md、overview、domains、openapi、page-api、commands.yaml 要有 test、plan.md），`docs/plan.md` 最后一节「## 程序读取的部分」的 yaml 能解析、调度做得下去（批次或 domain 不重名、`after` 指向存在且不更晚的 domain、不成环、批次不为空）；不满足就退回给 architect。其余（REQ 没进任何批次、页面 id 在 PRD 里找不到）只提醒。

审查、合并、门禁通过后等你批准。批准页显示 plan.md 的说明部分、风险与假设、PRD 与计划的提醒。`/forge-reject "<意见>"` 时 architect 接着原会话返工。

### 开发阶段（每个批次一个阶段）

批准时程序按 plan.md 为每个批次生成任务：

| 任务 | 角色 | 依赖 |
|---|---|---|
| 每个 domain 一个 | backend | plan 里写的 `after`（前面批次的视为已满足）；同时开发的数量受 `max_parallel_backend` 限制 |
| 前端基础（只在第 1 批） | frontend | 无 |
| 每个页面一个 | frontend | 前一个页面；同一时间只有一个前端任务，接着同一个会话做 |
| 接入真实接口（每批一个） | frontend | 本批所有页面与 domain；不单独审查，由本批浏览器验收检查 |

- 新增常量、枚举值、错误码由开发 agent 自己加；plan.md 的 `shared` 文件只能追加（程序只在审查材料里提醒，不拦）。双方都只追加时合并由程序自动完成。
- 修改或删除已有公共内容、改契约：开发 agent 调用 `forge_ask_architect`，自己不改。`docs/contracts/**`、`docs/arch/**`、`docs/plan.md`、`AGENTS.md`、`rules/**` 对后端和前端是受保护路径。

### 架构师问答

`forge_ask_architect(question, kind)`：`kind` 为 `answer`（只要回答）或 `change`（要求修改公共内容或契约）。主会话、backend、frontend 可用。

- 子 agent 提问后任务暂停（阻塞原因"等架构师"），程序派一个咨询任务（`consult`），architect 接着它上一次的会话回答，用 `forge_answer` 提交；`change` 时它可以同时改公共代码和契约，经合并队列合入。每次都在 `docs/arch/decisions.md` 追加一条记录。回答写进提问任务的 handoff，集成分支同步进它的 worktree，它接着原会话继续。
- 主会话提问时，回答在下一次 `forge_wait` 返回时交给它，由它转达给你。
- 咨询任务串行（同一时间只有一个架构师在写），不审查；改了契约的，由下一次批次门禁的 `contract_check` 与浏览器验收兜底。
- `forge_block` 只用于不是技术问题、又做不下去的事（需求矛盾、要你的环境），先交给主会话。

### 任务流水线

1. **开发**：开发 agent 在自己的 worktree 里实现，写本任务的验收测试（`tests/acceptance/<任务>/`，测试名带 `[REQ-xxx.ACn]`），提交前自己跑通测试与检查。
2. **提交**：`forge_submit` 后程序把集成分支同步进任务分支，有冲突交回原 agent 解决；然后进审查，不需要审查的直接排队合并。
3. **审查**：架构阶段、每个 domain、前端基础与每个页面都审。reviewer 用新上下文，先运行本任务的测试，再读 diff。只有本任务测试失败、违反 AC 或通用约定、违反契约、违反规则清单、安全问题与确定的缺陷算 must，其余是建议，汇总给你签收时看。前端按页面对照原型与 `page-api.md` 审。最多 2 轮，第 2 轮只确认；2 轮不过交给主会话。审过之后只因合并冲突退回的，解决后不再审查。
4. **合并**：程序串行合并，rebase 后只检查冲突标记，快进集成分支。双方都只追加的冲突由程序三方合并，合不了的交回原 agent。每次合并后在后台对集成分支跑一遍门禁命令（`limits.post_merge_test`，默认开），变红时二分定位到引入回归的任务，给它建修复任务。

派生任务的命名：`T-003.rv`、`.rv-2`（审查与确认轮）；`T-003.fx-1`…（修复，接着该任务的会话做）；`S1.qa`…（批次验收）。

### 批次验收

本批任务都完成后，程序按顺序：

1. **门禁**：在集成分支 HEAD 上跑 `implementation_gate.auto` 的命令（默认 `test`、`acceptance`、`arch_check`、`contract_check`，`commands.yaml` 里没定义的跳过）。
2. **覆盖率**：扫描测试名里的 `[REQ-xxx.ACn]`，按 PRD 的 REQ 与 AC 生成矩阵写入 `docs/qa/<阶段>.md`。只报告，缺口不拦门禁。
3. **stage-qa**：对照 PRD 本批的需求和原型，在无界面浏览器里像用户一样操作，检查控制台报错、失败请求、页面状态，并抽查权限。每条 must 附复现步骤、失败的请求或控制台报错、怀疑的归属。
4. **修复**：一条问题只交给一个任务修：看问题涉及的文件是哪个已完成任务改过的，再看 plan.md 的 `paths`，页面文件归该页面的任务；唯一归属就接着那个任务的会话修，涉及多个任务或找不到归属就交给 architect。修完重跑门禁，stage-qa 做只确认的一轮。门禁修复最多 2 轮，stage-qa 最多 `qa.max_rounds` 轮。
5. **签收**：主会话汇报，提醒你 `/forge-approve`。`/forge report` 随时可看签收材料（演示方式、需要你自己打开查看的条目、覆盖率矩阵、审查建议、耗时与成本）。

轮数用尽或问题找不到负责的任务时，阶段进入 **needs_human**，先交给主会话：它可以放行进入签收（你仍要签收），或转交给你。你也可以直接 `/forge gate` 重跑门禁，`/forge accept <阶段> --note "<说明>"` 放行，或 `/forge-reject "<意见>"` 打回。

签收被打回时，主会话判断要改的内容属于哪个任务：能明确归属的交程序建修复任务，不能的交架构师。

### 阻塞先交给主会话

任务阻塞（审查轮数用尽、合并失败、同样的原因反复失败、子 agent 提问）和门禁用尽时，程序先交给主会话用 `forge_decide` 决定：重做（带着它的意见）、放行，或转交给你；涉及技术判断的，它先问架构师。主会话转交给你的、以及同一任务它已决定过 2 次之后又阻塞的，才进"需要你处理"。"等架构师"的阻塞不交给主会话。你始终可以直接用 `/forge accept`、`/forge unblock` 处理。

## 角色

| 角色 | 做什么 | 能写什么 | bash |
|---|---|---|---|
| orchestrator（主会话） | 汇报进度；提醒你批准或签收；处理程序交上来的判断；技术问题交给架构师；签收打回时判断归属 | 无 | 无 |
| architect | 架构阶段的全部产出；之后回答技术问题、修改公共内容与契约、修复归属不清的问题 | 工作区内除 PRD 与原型外的文件 | full |
| backend | 一个 domain 的整条后端链路 | 除受保护路径外的文件 | full |
| frontend | 前端基础与全部页面、每批的接入真实接口；同一时间只有 1 个 | 除受保护路径外的文件 | full |
| reviewer | 审查架构产出、每个 domain、每个页面 | 无 | allowlist（只读命令加 `test`、`acceptance`、`typecheck`、`lint`、`arch_check`、`contract_check`） |
| stage-qa | 每批的浏览器验收；修复与小改动流程里的确认 | 无（在集成分支 HEAD 的临时 worktree 里运行） | full |
| worker | 只给 `/forge-fix`、`/forge-change` 两个轻流程用 | 除受保护路径外的文件 | full |

角色的模型档位与工具在 `workflow.yaml` 的 `roles` 里。

## 模型与兜底

- 失败升级：同一任务失败达到 `escalation.after_failures` 次后改用升级模型（`/forge-config escalate <角色> <模型>`，默认上一档）。
- 兜底模型：`/forge-config fallback <模型>`（或 `models.fallback`），所有角色共用。任务要用的模型因服务中断、额度用完被暂停时改用兜底模型继续，原模型恢复后换回；同样的失败连续两次先换升级模型、再换兜底模型，都试过仍一样才阻塞。

## 命令

| 命令 | 作用 |
|---|---|
| `/forge init` | 初始化项目骨架（可重复执行，不覆盖） |
| `/forge-build ["<项目名>"]` | 新项目：检查 `docs/PRD.md` 与 `docs/prototype/`，从架构阶段开始 |
| `/forge-fix "<问题>"`、`/forge-fix --from <文件>` | 修缺陷 |
| `/forge-change --from <yaml>` | 交付后的小改动：1 到 3 个 task |
| `/forge-status` | 高层阶段、进度、需要你处理的事项 |
| `/forge-status --detail` | 完整任务列表与内部状态 |
| `/forge-status --cost` | 成本：按流程、阶段、角色、模型、任务汇总，返工最多的任务 |
| `/forge-status --metrics` | 速度、返工、质量、成本度量 |
| `/forge-status --timing [--json]` | 耗时分布 |
| `/forge report` | 当前阶段的签收材料；最后一个阶段是交付汇报 |
| `/forge-approve [stage:<id>] [--yes]` | 批准架构或签收批次（仅用户）；最后一批会合入主分支，要确认 |
| `/forge-reject [stage:<id>] "<意见>"` | 打回并记录意见 |
| `/forge accept <阶段或任务> --note "<说明>"` | 人工放行（阶段 needs_human；审查轮数用尽的任务；修复的确认） |
| `/forge unblock <任务> ["<回答>"] [--reset]` | 解除阻塞；`--reset` 清零对应计数 |
| `/forge answer [<任务>]` | 回答阻塞任务提出的问题 |
| `/forge gate` | 重跑当前阶段的门禁 |
| `/forge-resume` | 会话丢失或进程被杀后恢复，并进入调度模式 |
| `/forge off` | 退出调度模式，恢复原来的模型与工具（流程状态不变） |
| `/forge next` | 由程序选择 ready 任务并派发（一般自动派发） |
| `/forge sync` | 把主分支同步进集成分支（每个阶段开始时自动执行） |
| `/forge abort [--yes]` | 中止当前流程、修复或小改动（集成分支保留，主分支不受影响） |
| `/forge doctor [--fix]` | 状态完整性与前置条件检查；`--fix` 清理残留 worktree 与提示文件 |
| `/forge rules [apply [all\|<草案>...]]` | 查看或应用知识提升来的规则草案 |
| `/forge knowledge [...]` | 项目知识库：列出、搜索、确认候选、废弃、提升为规则草案 |
| `/forge models [resume <模型>\|all]` | 查看被暂停的模型；立即恢复 |
| `/forge budget [tokens\|cost\|minutes <数值>]` | 查看或设置本流程的预算 |
| `/forge checkpoint [restore <任务>]` | 列出或恢复运行中自动拍的工作区检查点 |
| `/forge run [<run_id>]` | 某次子进程运行的工具调用摘要与最后的回复 |
| `/forge-config [show\|models\|set\|unset\|escalate\|fallback]` | 为各角色设置模型与思考级别；兜底模型 |

`/forge help`、`/forge-build help`、`/forge-fix help`、`/forge-change help` 显示命令自带的用法。

## 配置

项目根目录的 `workflow.yaml`（模板 `templates/workflow.yaml`）是流程配置，agent 只读。项目怎么装依赖、跑测试、启动服务写在 `commands.yaml`（architect 在架构阶段写，开发 agent 可补充，随代码合并）：程序只执行 `install`、`test`、`acceptance`（`-- <任务>` 只跑某个任务）、`serve`、`env_up`、`env_down`、`db_create`、`db_drop`、`add_dep`，以及门禁里配置的命令；其余给 agent 参考。所有命令都从 `PORT`、`FORGE_PORT_BASE`、`FORGE_DB_NAME`、`FORGE_TMP` 取资源，这样并行运行互不干扰。

| 部分 | 说明 |
|---|---|
| `main_branch` | 主分支名 |
| `models` | `strong`、`medium`、`cheap` 三个档位的默认模型，可选 `fallback`。单个角色的模型用 `/forge-config` 设置，优先于这里 |
| `escalation` | `after_failures`：失败多次后改用升级模型 |
| `limits` | `max_parallel_backend`（同时开发的 domain 数，plan.md 可覆盖）、`max_parallel`（轻流程的并发）、`max_parallel_aux`（审查、验收并发）、`max_attempts`、`max_merge_failures`、`post_merge_test`、`port_block`、`run_minutes`、`fix_max_files`、`change_max_tasks`、`continue_session` 等 |
| `review` | `max_rounds`：审查轮数，第 2 轮只确认 |
| `qa` | `max_rounds`：stage-qa 报告、修复、只确认 |
| `implementation_gate` | 所有批次共用：`auto`（门禁命令，默认 `test`、`acceptance`、`arch_check`、`contract_check`）、`coverage`（只报告）、`qa`（是否启用 stage-qa）、`human`（是否要你签收） |
| `shared_env` | 共享构建环境：架构阶段合入后一次性装好依赖，之后各 worktree 链接同一份；Python 用 uv 的项目每个 worktree 自己 `uv sync --frozen` |
| `roles`、`scopes`、`tool_groups` | 角色的模型档位、工具、bash 档位（`full`、`readonly`、`allowlist`）与可写范围 |
| `budget`（可选）、`notify.command`（可选） | 预算；通知命令（见下文） |

资源隔离：每次运行由程序分配一段端口（41000 到 60000）、专用数据库名和临时目录，通过上面四个环境变量注入；登记在 `<项目>.worktrees/.resources.json`，`/forge-resume` 与 `/forge doctor --fix` 会回收已结束的条目。

## 观测

- `/forge-status` 系列与 `/forge run`（见上面的命令表）。
- 事件查看器：`node scripts/forge-view.ts <项目目录> [--out <文件>]` 把 `.forge/` 生成一个自包含的 HTML（任务状态机、任务依赖、运行时间线、成本、事件日志），默认输出到 `<项目目录>.forge-view.html`。只读。
- 通知：在 `workflow.yaml` 里写 `notify: { command: "<命令>" }`。出现新的"需要你处理"事项或流程完成时运行一次，事件 JSON 从标准输入传入（环境变量 `PI_FORGE_EVENT`、`PI_FORGE_TEXT` 也有），10 秒超时，失败不影响流程。

## 开发

设计决定、已核实的 Pi API 与版本、真实模型实验的结论都记在 `NOTES.md`；给 Claude Code 的项目说明（目录分层、测试、约定）在 `CLAUDE.md`。

```bash
npm run typecheck                 # tsc --noEmit
npm run test:fast                 # 纯函数单元测试（约 1 秒）；后面加文件路径只跑这些文件
npm run test:slow                 # 用到 git 的单元测试
npm run test:e2e                  # e2e（假子进程跑完整流程，约 25 分钟）
npm test                          # 全部
npm run gen:schemas               # 从 src/core/state/schemas.ts 生成 schemas/*.json
```

测试不依赖真实 LLM：e2e 用 `test/fixtures/fake-subagent`（用脚本代替模型调用工具，仍经过真实的 guard 与 `forge_*` 工具）和 `test/fixtures/fake-llm`（假模型服务，供真实 pi 进程使用）。真实模型只在 `scripts/real-build.ts` 这类实验脚本里使用。
