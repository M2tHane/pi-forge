# pi-forge

pi-forge 是一个 [Pi](https://github.com/earendil-works/pi-coding-agent) 插件：把你写好的 PRD（和可选的界面原型）交给一组分工明确的 agent，分阶段做出一个大型项目，每个阶段都经过验收，最后由你签收、合入主分支。

调度不经过 LLM：选哪个任务、派给谁、并行几个、何时合并，全部由程序决定。agent 只做它那一份工作，并通过 `forge_*` 工具向程序提交结果。

> 状态：M0 到 M8 的功能和文档已完成，测试都用假模型（fake-llm、fake-subagent）。真实模型只做过几轮小规模实验（结论见 [NOTES.md](NOTES.md) 的"真实模型实验"），所以本文说的"能做什么"主要指代码已实现的行为。已知局限见 [NOTES.md](NOTES.md) 的"已知局限"。

第一次接触这个项目，先读 [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)：概念、角色，以及一个 task 在代码里怎么走。

## 核心思路

- **状态只由程序写。** 流程状态在项目的 `.forge/` 里（事件日志带哈希链，提交到 `refs/pi-forge/state`）。agent 读不到它，也改不了它，只能通过 `forge_*` 工具提交申请，由程序校验后写入。
- **约束靠移除能力和程序校验，不靠提示词。** 每个角色只拥有自己那份工具和可写范围；越界的调用会被 guard 拦截。实施类 task（impl、fix）不受计划 writes 限制，只有受保护路径与 `docs/spec/**` 不能写；writes 只用于调度互斥与合并冲突归属。能用程序判断的事（规格检查、契约检查、DAG 推导、AC 覆盖率、预检、合并验证）都用程序判断。
- **验收测试由 worker 写，reviewer 审查。** worker 按 AC 编号把验收测试写在 `tests/acceptance/<task>/`，reviewer 对照程序算出的 AC 覆盖，核对每条 AC 有测试、测试走了 Given/When/Then 且只经允许的入口、断言没有被弱化，并运行这些测试。
- **契约只能追加。** P1 批准后，`docs/contracts/**` 锁定。实施中新增接口、可选字段、错误码等允许，由程序做结构比较；修改或删除已有内容必须走变更请求，由你批准。
- **人工闸门不能被 agent 自批准。** 规格、契约与计划、每个实施阶段的签收，都要你执行 `/forge-approve`。
- **"必须改"要有出处。** reviewer 和 stage-qa 提的必须改，要引用规则、AC、契约或具体缺陷，没有出处的程序降为建议；第二轮只能确认，不能提新问题。

### 什么时候用，什么时候直接用 pi

几十行以内的改动直接用 `pi` 更划算。pi-forge 适合有 PRD、有多个模块、需要分阶段交付和验收的项目；缺陷修复用 `/forge-fix`，build 完成后加小功能用 `/forge-change`。它有固定的开销（规格讨论、契约与计划、阶段签收），项目越小越不划算。

## 环境与安装

| 项目 | 要求 |
|---|---|
| Node | 22 以上（开发和测试用 24.18.0） |
| git | 2.30 以上（用到 worktree） |
| Pi | `@earendil-works/pi-coding-agent`，插件检查要求 0.99.0 以上；**只在 1.0.0 上验证过**，其他版本会提醒 |
| 可选插件 | pi-codegraph（给 worker、architect、reviewer 等读代码），pi-web-access（联网搜索，默认不分配给角色，可在 workflow.yaml 里加给任何角色）。缺少时 `/forge doctor` 会提醒，相关工具不可用 |

安装（本地路径，Pi 不替你装依赖，所以先在 pi-forge 目录安装）：

```bash
cd /path/to/pi-forge
npm install
pi install /path/to/pi-forge        # 加 -l 写入项目的 .pi/settings.json
```

`pi -e <扩展路径>` 只加载扩展文件（子进程就是这样拉起的），技能目录要靠包清单加载，所以正常使用请用 `pi install`。包清单在 `package.json` 的 `pi` 字段：扩展入口是 `src/pi-adapter/extension.ts`，技能目录是 `skills/`。

### 初始化项目

在项目的 git 仓库根目录运行：

```
/forge init
```

它会生成 `workflow.yaml`、`AGENTS.md`、`docs/` 与 `tests/acceptance/` 骨架、`rules/`，把 `.codegraph/` 写进 `.gitignore`，初始化 `.forge/` 并提交一次。可以重复执行，不覆盖已有文件。然后：

1. `/forge-config`：为各角色选模型和思考级别（保存在用户级的 `~/.pi/agent/pi-forge.json`；`/forge-config show`、`set`、`unset`、`escalate`、`fallback`、`models` 见 `/forge-config help`）。建议设一个兜底模型，服务中断时任务换它继续。
2. 检查 `workflow.yaml` 的 `commands`（见下文"配置"）。这些命令由 architect 在 P1 按技术栈起草，你批准计划时应用，所以新项目可以先不改。

`/forge-build` 和 `/forge-fix` 在项目没有初始化时会自动执行 `/forge init`。

## 快速开始

### 新项目

新建一个项目目录，把需求文档（PRD、说明、原型图等，任意格式）放进 `docs/`，然后：

```
/forge-build                # 或 /forge-build "项目名"
```

程序把 `docs/` 下的文档原样入库到集成分支的 `docs/spec/inputs/docs/`（跳过 pi-forge 自己维护的 `docs/spec/`、`docs/contracts/` 等目录，以及隐藏文件和敏感文件）。主会话先读完这些文档，**只就有疑问的地方问你**（缺验收标准、缺页面状态、权限没说清、前后矛盾等）；`docs/` 下没有文档时，主会话会详细地问你需求。讨论后整理成 `docs/spec/` 下的四份规格。之后按"阶段"一节走。

也可以用 `--prd <文件或目录> [--prototype <路径>]` 直接指定文档位置，这时不扫描 `docs/`。

### 修缺陷

```
/forge-fix "登录后刷新页面会掉线：复现步骤……期望……"
/forge-fix --from bug.md
```

一个 worker 定位并修复（加回归测试），合并时跑全量测试（fix 流程没有阶段门禁），直接合入主分支；再由只读的 stage-qa 复现确认。流程运行中不能同时修复；流程正在等你审批时会先让你确认（`--yes` 跳过）。

### 小改动（build 完成之后加小功能）

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

在主会话里直接说要加什么也可以：主会话读架构图、规则与契约，和你商定 1 到 3 个 task 后用 `forge_change` 提交，不走 P0/P1 批准。worker 实现并写测试、reviewer 审查、逐个合入主分支（合并时跑全量测试）；全部完成后程序派 architect 更新 `docs/arch/overview.md` 与 `docs/contracts/`（没有改动且没写明"无需更新"时不能提交），最后 stage-qa 全量确认，写入日志。缺陷用 `/forge-fix`；需要新的需求规格或超过 3 个 task（`limits.change_max_tasks`）时用 `/forge-build`。

## 阶段

界面上只显示四个高层阶段：**规格 → 契约与计划 → 实施 → 交付**。`/forge-status` 看当前在哪一步、需要你处理什么；`--detail` 看内部状态。流程图见 [docs/flow.md](docs/flow.md)。

| 阶段 | 谁做 | 你要做什么 |
|---|---|---|
| **P0 规格** | 主会话（orchestrator）和你 | 回答它的问题，确认需求。规格通过 spec-lint 后进入等待批准，你 `/forge-approve` 或 `/forge-reject "<意见>"` |
| **P1 契约与计划** | architect（程序驱动，不经主会话） | 读批准页：阶段划分、task 数与并行度、DAG 提醒、assumptions（architect 的默认假设）和 extras（超出需求的设计）；`/forge-approve` 后程序应用命令草案、锁定契约、生成 S 阶段和 task |
| **实施 S0、S1…Sn** | S0 由 architect，S1 起由 worker；reviewer、stage-qa，由程序调度 | 处理"需要你处理"里的事项（阻塞、需人工放行），并在阶段末签收 |
| **交付** | 程序 | 不是独立阶段：批准最后一个 S 阶段的签收时，程序把集成分支 `--no-ff` 合入主分支 |

- S0 是骨架阶段，只有一个 task，由 architect 亲自做：建项目骨架、依赖与锁文件，搭好 docker、数据库等环境，让命令草案里的命令真的能跑，把共享类型、错误码和统一错误响应落成代码，直接写 `rules/`，建好 `tests/acceptance/_support/`，写一个贯穿前端、API、数据库的冒烟测试；之后由 reviewer 审查。worker 的 task 从 S1 开始。S0 合入后，程序建立共享构建环境（`<项目>.worktrees/.env-shared/`）：一次性 install、运行可选的 `env_up`，之后各 worktree 的依赖目录都链接到它，不再各自 install；每个 S 阶段开始时按集成分支刷新一次。
- 阶段之间串行；同一阶段内按 DAG 并行。
- 多个对象同时等批准时（阶段签收、变更请求），要写明对象：`/forge-approve stage:S1`、`change:C-001`。
- **阶段签收**（`/forge report` 随时可看）汇总：演示方式、`manual_checks`（需要你自己打开应用查看的条目）、AC 覆盖率矩阵、新增的建议（`docs/review/suggestions.md`）、耗时与成本。最后一个阶段的签收材料就是交付汇报。
- P0 批准之后需求变化只走变更请求（见下文）。签收时不满意，`/forge-reject "<意见>"`：阶段回到 active，主会话把意见整理成变更请求，你用 `/forge-approve change:<id>` 批准后，新的修改 task 新增在当前阶段，完成后重新验收。

## 六个角色

| 角色 | 做什么 | 能写什么 | bash |
|---|---|---|---|
| orchestrator（主会话） | 接收 PRD 与原型，和你沟通，整理规格，汇报进度，转达你的决定 | 无。规格经 `forge_spec` 由程序写入；P0 批准后的需求变化经 `forge_change_request` 提交 | 无 |
| architect | P1 写契约、架构、计划与命令草案；S0 亲自做骨架、共享代码和 `rules/`；变更请求里改计划|P1 与变更请求：`docs/contracts/**`、`docs/arch/**`、`docs/plan/**`、`docs/rules-draft/commands.yaml`、`AGENTS.md`；术语表只能追加。S0：与 worker 相同 | full |
| worker | 实现一个 task（纵向切片，前后端、迁移、单元测试，按 TDD），并写本 task 的验收测试（`tests/acceptance/<task>/`）；也做 fix 和合并冲突修复 | 工作区内任何文件（`writes` 只用于调度互斥与冲突归属；受保护路径与 `docs/spec/**` 除外）；契约文件只能追加。合并冲突修复（merge-fix）只能写冲突文件 | full |
| reviewer | 逐任务审查（impl 一律审查，S0 也审）：读 diff、AC、契约和规则，运行本 task 自己的测试，审查 worker 写的验收测试 | 无 | allowlist（只读命令加 `test`、`acceptance`） |
| stage-qa | 阶段末在集成分支上核对需求覆盖、跨模块一致性、抽查权限；fix 模式里复现确认 | 无（在集成分支 HEAD 的临时 worktree 里运行） | full |

角色的模型档位（strong、medium、cheap）和工具在 `workflow.yaml` 的 `roles` 里，不要改小范围的权限设计，除非你清楚后果。

## 任务流水线

一个 impl task 的流程：

1. **开工**：worker 实现，并写本 task 的验收测试（`tests/acceptance/<T>/`）。S0 的 task 由 architect 做，流程相同。
2. **提交与等待**：worker `forge_submit` 后 task 进入 `awaiting_inputs`，等软依赖的生产方 done；程序把集成分支合进任务分支（有冲突就交回 worker 解决）。
3. **预检**（程序，`checking`）：不再运行命令，只检查契约只做了追加；diff 越界在提交时检查。失败交回 worker，达到次数上限转 blocked。随后交给 reviewer。
4. **审查**（`in_review`）：impl 一律审查，按风险推导强度（`auto`、`strong`）。reviewer 读 diff，核对本 task 的验收测试，bash 只放行 `test` 与 `acceptance` 两条命令，运行范围由任务说明给定（本 task 改动的单元测试；验收测试 `-- <task>`）；必须改要有出处，测试失败的出处写 `defect:`；有 must 就回到 worker，第二轮（`.rv-2`）只确认。
5. **合并队列**：程序串行合并，选队列里第一个合格的 task；rebase 后只检查冲突标记并运行 merge_check，通过后快进到集成分支。合并之后程序在后台对集成分支跑一遍门禁命令（`limits.post_merge_test`，默认开）：变红时先重跑一次排除不稳定的测试，再在上一次通过之后的合并里二分，定位到引入回归的 task，给它建修复任务。冲突先做结构化合并：契约文件（`docs/contracts/**`）做三方合并；task 可写范围内、双方都只追加的普通文件（例如共享错误码常量）自动合并；合不了的由正在合并的 worker 自己解决。

派生 task 的命名：

| 名字 | 是什么 |
|---|---|
| `T-003.rv`、`.rv-2` | 审查与只确认的第二轮 |
| `T-003.fx-1`… | 修复：合并后回归测试、阶段门禁、覆盖率缺口、stage-qa 的 must 产生，接着该 task 最后一次 worker 的会话；不单独审查，由阶段门禁与 stage-qa 的确认轮核对 |
| `S1.qa`… | 阶段级的 stage-qa |

别的 task 的验收测试被正当的契约追加破坏时，程序不计入当前 task 的失败，由当前 task 的 worker 一并修改那些测试（不放宽断言）。

## 阶段验收

一个阶段的 impl 全部 done 后，程序按顺序：

1. **门禁**：在集成分支 HEAD 的临时 worktree 里运行 `implementation_gate.auto` 里配置了的命令。
2. **覆盖率**：扫描测试名里的 `[REQ-xxx.ACn]` 标签，生成 REQ、AC、测试文件矩阵，写入 `docs/qa/<阶段>.md`。有缺口就给负责的 task 建 `.fx-n` 补测。
3. **stage-qa**：核对跨模块一致性、页面状态、测试是否形同虚设、exit 是否达成，可用 `forge_service` 启动服务。
4. **修复**：门禁失败、覆盖率缺口、stage-qa 的 must 都生成修复或补测任务（按 task 归属，不是按角色）。修复合并后重跑门禁与覆盖率，stage-qa 再做只确认的一轮。门禁与覆盖率的修复最多 2 轮，stage-qa 最多 `qa.max_rounds` 轮。
5. **签收**：门禁通过时和最近一轮 stage-qa 的集成分支 HEAD 都等于当前 HEAD，才进入等你签收。

轮数用尽，或问题找不到负责的 task，阶段进入 **needs_human**，先交给主会话：它可以放行进入签收（你仍要签收），或转交给你。你也可以直接：

- 自己处理后 `/forge gate` 重跑门禁；
- `/forge accept <阶段> --note "<说明>"` 人工放行，直接进入签收（你仍要 `/forge-approve` 签收）；
- `/forge-reject "<意见>"` 打回，阶段回到 active。

## 阻塞先交给主会话

task 阻塞（审查轮数用尽、合并失败、同样的原因反复失败、子进程提问）、阶段门禁用尽、变更请求的修订就绪时，程序先交给主会话（orchestrator）用 `forge_decide` 决定：重做（带着它的意见，也用来回答子进程的提问）、放行，或转交给你。`/forge-status` 里这些事项列在"主会话处理中"。主会话转交给你的，以及同一个 task 它已经决定过 2 次之后又阻塞的，才进"需要你处理"。你始终可以直接处理：

- `/forge accept <task> --note` 用于审查轮数用尽而 blocked 的 task（代码已通过预检，只是审查意见没谈拢），直接进入合并；也用于合并时没有改动的 task（要做的已在集成分支上），视为完成。
- 预检或合并次数用尽的 task 不能 accept（代码没通过验证），只能 `/forge unblock <task> [--reset]`。

## 模型与兜底

- 失败升级：同一 task 失败达到 `escalation.after_failures` 次后改用升级模型（`/forge-config escalate <角色> <模型>`，默认上一档）。
- 兜底模型：`/forge-config fallback <模型>`（或 `workflow.yaml` 的 `models.fallback`），所有角色共用。任务要用的模型因服务中断、额度用完被暂停时，改用兜底模型继续，原模型恢复后换回；同样的原因连续失败时，先换升级模型、再换兜底模型，都试过仍一样才阻塞；没有升级模型时，失败达到次数直接用兜底模型。

## 变更请求

P0 批准之后，规格不再修订；需求变化（包括签收时打回的意见）和改契约、补计划都走变更请求。

- **提出**：worker 或主会话调用 `forge_change_request`（写明 what、why、impact）。程序派 architect 在当前阶段的 doc task 里起草修订，用 `forge_propose_plan` 提交。修订先由主会话审核：批准、打回让 architect 带着意见重做，或转交给你。你也可以直接 `/forge-approve change:<id>` 或 `/forge-reject change:<id> "<意见>"`。需求变化大到计划不再成立时，建议 `/forge abort` 后重新 `/forge-build`。
- 批准时在一个事务里落地：未开始的 task 调整或取消，已开始或已完成的 task 以新 task 加 `modifies: T-xxx` 的方式接在它后面，之后的 S 阶段可以新增或调整。受影响的验收测试由对应 task 的 worker 修改。已开始的 task 和已完成的阶段不能被直接修改。
- 同一流程同时只能有一个未结束的变更请求；等待批准期间，被它点名的 task 暂停派发，阶段门禁也等待。

## 命令

| 命令 | 作用 |
|---|---|
| `/forge init` | 初始化项目骨架（可重复执行，不覆盖） |
| `/forge-build ["<项目名>"] [--prd <路径>] [--prototype <路径>]` | 新项目：读 `docs/` 下的需求文档（没有就访谈你），进入规格阶段 |
| `/forge-fix "<问题>"`、`/forge-fix --from <文件>` | 修缺陷 |
| `/forge-change --from <yaml>` | build 完成后的小改动：1 到 3 个 task 的迷你计划，不走 P0/P1 |
| `/forge-status` | 阶段、进度、需要你处理的事项 |
| `/forge-status --detail` | 完整任务列表与内部状态 |
| `/forge-status --cost` | 成本：按流程、阶段、角色、模型、任务汇总，返工最多的任务 |
| `/forge-status --metrics` | 速度、返工、质量、成本度量 |
| `/forge-status --timing [--json]` | 耗时分布 |
| `/forge report` | 当前阶段的签收材料；最后一个阶段是交付汇报 |
| `/forge-approve [stage:<id>\|change:<id>] [--yes]` | 批准（仅用户）；最后一个阶段会合入主分支，要确认 |
| `/forge-reject [stage:<id>\|change:<id>] "<意见>"` | 打回并记录意见 |
| `/forge accept <阶段或task> --note "<说明>"` | 人工放行（阶段 needs_human；审查轮数用尽的 task；fix 的复现确认） |
| `/forge unblock <task> ["<回答>"] [--reset]` | 解除阻塞；`--reset` 清零对应计数 |
| `/forge answer [<task>]` | 回答阻塞 task 提出的问题 |
| `/forge gate` | 重跑当前阶段的门禁 |
| `/forge-resume` | 会话丢失或进程被杀后恢复，并进入调度模式 |
| `/forge off` | 退出调度模式，恢复原来的模型与工具（流程状态不变） |
| `/forge next` | 由程序选择 ready 任务并派发（一般自动派发，不需要手动） |
| `/forge sync` | 把主分支同步进集成分支（每个阶段开始时自动执行） |
| `/forge abort [--yes]` | 中止当前流程、修复或小改动（集成分支保留，主分支不受影响） |
| `/forge doctor [--fix]` | 状态完整性与前置条件检查；`--fix` 清理残留 worktree 与提示文件 |
| `/forge rules [apply [all\|<草案>...]]` | 查看或应用待应用的草案（P1 的命令草案、知识提升来的规则草案） |
| `/forge knowledge [...]` | 项目知识库：列出、搜索、确认候选、废弃、提升为规则草案 |
| `/forge models [resume <模型>\|all]` | 查看被暂停（额度用完、限流、配置有误）的模型；立即恢复 |
| `/forge budget [tokens\|cost\|minutes <数值>]` | 查看或设置本流程的预算 |
| `/forge checkpoint [restore <task>]` | 列出或恢复运行中自动拍的工作区检查点 |
| `/forge run [<run_id>]` | 某次子进程运行的工具调用摘要与最后的回复 |
| `/forge-config [show\|models\|set\|unset\|escalate\|fallback]` | 为各角色设置模型与思考级别；兜底模型 |

`/forge help`、`/forge-build help`、`/forge-fix help`、`/forge-change help` 显示命令自带的用法。

## 配置

项目根目录的 `workflow.yaml`（模板 `templates/workflow.yaml`）。常用的部分：

| 部分 | 说明 |
|---|---|
| `main_branch` | 主分支名 |
| `commands` | 项目命令：`install`、`typecheck`、`lint`、`test`、`acceptance`（加 `-- <task>` 只跑某个 task）、`e2e`、`contract_lint`、`contract_test`、`codegen`、`serve`、`merge_check`、`db_create`、`db_drop`、`env_up`、`env_down`、`add_dep`。architect 在 P1 起草，批准计划时应用。所有命令都应从 `PORT`、`FORGE_PORT_BASE`、`FORGE_DB_NAME`、`FORGE_TMP` 取资源，这样并行运行互不干扰 |
| `models` | 三个档位 `strong`、`medium`、`cheap` 的默认模型（`provider/model`），可选 `fallback`（兜底模型）。单个角色的实际模型用 `/forge-config` 设置，优先于这里 |
| `escalation` | `after_failures`：同一 task 失败多次后改用升级模型；`critical_fanout`：被这么多 task 硬依赖的 task 第一次就用升级模型，审查推导为 strong |
| `limits` | `max_parallel`（impl 并发）、`max_parallel_aux`（review、qa 并发）、`max_attempts`（只计运行失败）、`max_precheck_failures`、`max_merge_failures`、`post_merge_test`（合并后回归测试，默认开）、`port_block`（每次运行分配的连续端口数）、`run_minutes`（M 号 task 的时间预算）、`fix_max_files`、`change_max_tasks`（小改动最多几个 task，默认 3）、`continue_session` 等 |
| `review` | `max_rounds`：审查轮数，第 2 轮只确认（impl 一律审查） |
| `testing` | `adjust_tests`：worker 可改已有单元测试，只改不增删 |
| `qa` | `max_rounds`：stage-qa 报告、修复、只确认 |
| `implementation_gate` | 所有 S 阶段共用：`all_tasks_done`、`auto`（门禁里运行的命令名列表，只运行配置了的）、`coverage`（AC 覆盖率）、`qa`（是否启用 stage-qa）、`human`（是否要你签收） |
| `shared_env` | 共享构建环境：`enabled`（默认开启）、`deps`（链接进各 worktree 的依赖目录，默认 `node_modules`）。S0 合入后一次性装好依赖，之后所有 worktree 链接同一份。Python 用 uv 的项目不共享 `.venv`：每个 worktree 自己 `uv sync --frozen`（包从 uv 的全局缓存链接，很快），加依赖用 `uv add` |
| `generated_paths` | 由契约生成的代码路径 |
| `scopes`、`roles`、`tool_groups` | 角色的可写范围、工具与 bash 档位（`full`、`readonly`、`allowlist`）、读取范围 |
| `budget`（可选）、`notify.command`（可选） | 预算；通知命令（见下文） |

资源隔离：每次运行（含预检、门禁、合并验证）由程序分配一段端口（`limits.port_block`，从 41000 到 60000 之间按 10 对齐，登记前逐个探测）、专用数据库名和临时目录，通过 `PORT`、`FORGE_PORT_BASE`、`FORGE_DB_NAME`、`FORGE_TMP` 注入。登记文件在 `<项目>.worktrees/.resources.json`，`/forge-resume` 与 `/forge doctor --fix` 会回收已结束的条目。

## 观测

- `/forge-status`：高层阶段、进度和"需要你处理"的事项（阻塞、needs_human、等待批准、被暂停的模型等）；`--detail` 是完整任务列表；`--cost` 是成本；`--metrics` 是速度（agent 时间即墙钟时间减去等你的时间、关键路径）、返工、质量、成本度量；`--timing` 是耗时分布。
- `/forge run [<run_id>]`：某次子进程运行的工具调用摘要。
- 事件查看器：`node scripts/forge-view.ts <项目目录> [--out <文件>]` 把 `.forge/` 的状态生成一个自包含的 HTML（任务状态机与转移次数、任务 DAG、运行时间线、成本、事件日志），默认输出到 `<项目目录>.forge-view.html`（项目目录之外）。只读，不修改 `.forge/`。
- 通知：在 `workflow.yaml` 里写 `notify: { command: "<命令>" }`。出现新的"需要你处理"事项或流程完成时，程序运行一次该命令，事件 JSON 从标准输入传入（环境变量 `PI_FORGE_EVENT`、`PI_FORGE_TEXT` 也有），10 秒超时，失败不影响流程。例如用 macOS 的 `osascript` 弹通知。

## 已知局限与状态

- **真实模型验证（M9）还没有做。** 目前所有测试用假模型，提示词（`agents/`、`skills/`）的效果、各档位模型的表现，都没有真实数据。M9 按 `docs/BUILD_PROMPT.md` 第 18 节的通过条件执行。
- 只在 Pi 1.0.0 上验证；M9 开始前会单独做升级评估。
- M6、M7 的 e2e 测试写了但没有运行（按计划留到统一运行）。
- 阶段被打回后，旧的 stage-qa 轮次仍计入 `qa.max_rounds`，被打回后可以用 `/forge accept` 放行。
- 变更请求的 `cancelled` 状态在存储里有，但没有命令可以触发。
- 完整列表见 [NOTES.md](NOTES.md) 的"已知局限"，所有偏离规格的决定见同一文件的"偏离规格"。

## 开发

规格是 `docs/BUILD_PROMPT.md`（不要修改）。所有偏离规格的决定、已核实的 Pi API 与版本、真实模型实验的结论都记在 `NOTES.md`。

```
src/core/        业务逻辑，不依赖 Pi，按模块分子目录：
  state/         .forge/ 状态层：state-store.ts 是唯一的读写入口；state-machine.ts 是转移表
                 （不在表中的转移一律拒绝）；schemas、event-log、config、paths、git、dag 等
  engine/        引擎：dispatcher.ts 是引擎；调度、子进程运行时、提示组装、预算与成本
  workspace/     worktree、阶段 worktree、越界检测、依赖准备
  spec/ plan/ verify/ acceptance/ stage/   规格、契约与计划、验证与闸门、验收测试、阶段
  security/      guard、shell 解析、redact
  ops/           init、resume、doctor、状态视图、history 等
src/tools/       forge_* 工具的业务实现
src/commands/    斜杠命令的业务实现
src/modes/       阶段计划与 fix 流程
src/pi-adapter/  唯一可以调用 Pi API 的目录
agents/ rules/ skills/ templates/   角色提示、规则、技能、项目模板
schemas/*.json   由 npm run gen:schemas 从 src/core/state/schemas.ts 生成
scripts/         forge-view（事件查看器）、gen-schemas、real-build 与 baseline-build（M9 用）
test/            unit、e2e、fixtures
docs/            规格、入门（GETTING-STARTED.md）、流程图（flow.md）
legacy/          pi-flow 的参考代码，不参与构建
```

约定：状态只能由程序写；新增的检查（spec-lint、契约检查、DAG 推导、覆盖率）都是纯函数并有单元测试；只用可擦除的 TypeScript 语法（不用参数属性、enum、namespace）；标识符和文件名用英文，面向用户的提示、错误信息和文档用中文；不读取、不打印密钥。修改 `agents/`、`rules/`、`skills/` 会让子进程系统提示的稳定前缀变化，导致提示缓存失效，要在 `NOTES.md` 的"缓存提醒"里记一笔。

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # 先跑 test/unit，再跑 test/e2e
npm run test:fast                 # 纯函数单元测试（约 1 秒），改动时随手跑；后面加测试文件路径只跑这些文件
npm run test:slow                 # 用到 git 的单元测试；test:unit 跑全部单元测试，test:e2e 跑 e2e
node --test --test-reporter=spec "test/unit/**/*.test.ts"   # 只跑单元测试
npm run gen:schemas               # 从 src/core/state/schemas.ts 生成 schemas/*.json
```

测试不依赖真实 LLM：单元测试直接测纯函数；e2e 用 `test/fixtures/fake-subagent`（用脚本代替模型调用工具，仍经过真实的 guard 与 `forge_*` 工具）和 `test/fixtures/fake-llm`（假模型服务，供真实 pi 进程使用）。真实模型只在 M9 和 `scripts/real-build.ts` 中使用。

复用来源是 pi-flow（运行时文件取 `31f3f15`，流程层取 `7006e7d`），拷贝或改编的文件在文件头注明来源。
