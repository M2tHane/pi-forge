# pi-forge

pi-forge 是一个 [Pi](https://github.com/earendil-works/pi-coding-agent) 插件：把你写好的 PRD（和可选的界面原型）交给一组分工明确的 agent，分阶段做出一个大型项目，每个阶段都经过验收，最后由你签收、合入主分支。

调度不经过 LLM：选哪个任务、派给谁、并行几个、何时合并，全部由程序决定。agent 只做它那一份工作，并通过 `forge_*` 工具向程序提交结果。

> 状态：M0 到 M8 的功能和文档已完成，测试都用假模型（fake-llm、fake-subagent）。**真实模型验证（M9）还没有做**，所以本文说的"能做什么"指代码已实现的行为，不代表在真实项目上的效果已被验证。已知局限见 [NOTES.md](NOTES.md) 的"待确认与已知局限"。

## 核心思路

- **状态只由程序写。** 流程状态在项目的 `.forge/` 里（事件日志带哈希链，提交到 `refs/pi-forge/state`）。agent 读不到它，也改不了它，只能通过 `forge_*` 工具提交申请，由程序校验后写入。
- **约束靠移除能力和程序校验，不靠提示词。** 每个角色只拥有自己那份工具和可写范围；越界的调用会被 guard 拦截。能用程序判断的事（规格检查、契约检查、DAG 推导、AC 覆盖率、预检、合并验证）都用程序判断。
- **测试由独立的 test-author 编写。** 它在程序导出的独立仓库里工作，里面只有规格、契约和已有的验收测试，没有实现代码。worker 改不了验收测试；认为测试写错时，只能通过 `forge_dispute` 提出争议。
- **契约只能追加。** P1 批准后，`docs/contracts/**` 锁定。实施中新增接口、可选字段、错误码等允许，由程序做结构比较；修改或删除已有内容必须走变更请求，由你批准。
- **人工闸门不能被 agent 自批准。** 规格、契约与计划、每个实施阶段的签收，都要你执行 `/forge-approve`。
- **"必须改"要有出处。** reviewer 和 stage-qa 提的必须改，要引用规则、AC、契约或具体缺陷，没有出处的程序降为建议；第二轮只能确认，不能提新问题。

### 什么时候用，什么时候直接用 pi

小改动（单文件、几十行以内）直接用 `pi` 更划算。pi-forge 适合有 PRD、有多个模块、需要分阶段交付和验收的项目；缺陷修复用 `/forge-fix`。它有固定的开销（规格讨论、契约与计划、阶段签收），项目越小越不划算。估算规模低于 `limits.lean_below_loc`（默认 6000 行）时，会建议用精简模式（每个阶段只有一个实施任务，跨阶段接着会话，阶段末统一审查）。

## 环境与安装

| 项目 | 要求 |
|---|---|
| Node | 22 以上（开发和测试用 24.18.0） |
| git | 2.30 以上（用到 worktree） |
| Pi | `@earendil-works/pi-coding-agent`，插件检查要求 0.99.0 以上；**只在 1.0.0 上验证过**，其他版本会提醒 |
| 可选插件 | pi-serena、pi-codegraph（给 worker、architect、reviewer 等读代码），pi-web-access（researcher 联网）。缺少时 `/forge doctor` 会提醒，相关工具不可用 |

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

1. `/forge-config`：为各角色选模型和思考级别（保存在用户级的 `~/.pi/agent/pi-forge.json`；`/forge-config show`、`set`、`unset`、`escalate`、`models` 见 `/forge-config help`）。
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

### 已有项目上加功能

已有项目需要先有一份契约基线：

```
/forge init --adopt "涉及的模块或说明"
/forge-approve stage:ADOPT          # 看过 architect 整理的 docs/contracts/ 与 docs/arch/ 之后
/forge-build --feature        # 先把本次功能的文档放进 docs/
```

feature 模式同样扫描 `docs/`，但跳过之前流程已经入库过的文档，只收新放进去的。`--adopt` 让 architect 从现有代码反向整理边界契约（只描述现有行为，不改代码），你批准后合入主分支成为基线。主分支没有 `docs/contracts/` 时，`/forge-build --feature` 会拒绝并提示先 adopt。feature 流程的规格是增量的，写进 `docs/spec/features/`；P1 只写增量契约与计划。以后要纳管更多模块，用 `/forge init --adopt "<说明>" --force`（已有契约只能追加）。

### 修缺陷

```
/forge-fix "登录后刷新页面会掉线：复现步骤……期望……"
/forge-fix --from bug.md
```

一个 worker 定位并修复（加回归测试），合并时跑全量测试，直接合入主分支；再由只读的 stage-qa 复现确认。流程运行中不能同时修复；流程正在等你审批时会先让你确认（`--yes` 跳过）。

## 阶段

界面上只显示四个高层阶段：**规格 → 契约与计划 → 实施 → 交付**。`/forge-status` 看当前在哪一步、需要你处理什么；`--detail` 看内部状态。流程图见 [docs/flow.md](docs/flow.md)。

| 阶段 | 谁做 | 你要做什么 |
|---|---|---|
| **P0 规格** | 主会话（orchestrator）和你 | 回答它的问题，确认需求。规格通过 spec-lint 后进入等待批准，你 `/forge-approve` 或 `/forge-reject "<意见>"` |
| **P1 契约与计划** | architect（程序驱动，不经主会话） | 读批准页：阶段划分、task 数与并行度、DAG 提醒、assumptions（architect 的默认假设）和 extras（超出需求的设计）；`/forge-approve` 后程序应用规则与命令草案、锁定契约、生成 S 阶段和 task |
| **实施 S0、S1…Sn** | worker、test-author、reviewer、stage-qa，由程序调度 | 处理"需要你处理"里的事项（争议裁决、阻塞、需人工放行），并在阶段末签收 |
| **交付** | 程序 | 不是独立阶段：批准最后一个 S 阶段的签收时，程序把集成分支 `--no-ff` 合入主分支 |

- S0 是骨架阶段，只有一个 task：搭好安装、类型检查、lint、测试、验收测试的命令，建好 `tests/acceptance/_support/`，写一个贯穿前端、API、数据库的冒烟测试。
- 阶段之间串行；同一阶段内按 DAG 并行。
- 多个对象同时等批准时（阶段签收、规格修订、变更请求），要写明对象：`/forge-approve stage:S1`、`amend:A-001`、`change:C-001`。
- **阶段签收**（`/forge report` 随时可看）汇总：演示方式、`manual_checks`（需要你自己打开应用查看的条目）、AC 覆盖率矩阵、新增的建议（`docs/review/suggestions.md`）、耗时与成本。最后一个阶段的签收材料就是交付汇报。
- 签收时不满意，`/forge-reject "<意见>"`：阶段回到 active，主会话把意见整理成规格修订，你批准后走变更请求，新的修改 task 新增在当前阶段，完成后重新验收。

## 七个角色

| 角色 | 做什么 | 能写什么 | bash |
|---|---|---|---|
| orchestrator（主会话） | 接收 PRD 与原型，和你沟通，整理规格，汇报进度，转达你的决定 | 无。规格经 `forge_spec`、`forge_spec_amend` 由程序写入 | 无 |
| architect | P1 写契约、架构、计划、规则与命令草案；变更请求里改计划；`--adopt` 里反向整理契约 | `docs/contracts/**`、`docs/arch/**`、`docs/plan/**`、`docs/rules-draft/**`、`AGENTS.md`；术语表只能追加 | readonly |
| worker | 实现一个 task（纵向切片，前后端、迁移、单元测试，按 TDD）；也做 fix 和合并冲突修复 | task 的 `writes` 与 `shared`、对已有单元测试的适配（只改不增删）；本模块的契约文件只能追加 | full |
| test-author | 只依据规格与契约，在契约边界写验收测试；与 worker 并行 | 隔离工作区里的 `tests/acceptance/<task>/**`、`tests/acceptance/_support/<task>/**` | allowlist（只读命令加 `acceptance_list`、`acceptance`） |
| reviewer | 只看 diff、AC、契约和规则做逐任务审查（精简模式是阶段审查） | 无 | readonly |
| stage-qa | 阶段末在集成分支上核对需求覆盖、跨模块一致性、抽查权限；fix 模式里复现确认 | 无（在集成分支 HEAD 的临时 worktree 里运行） | full |
| researcher | 按需联网调研，结论在前并附来源 | `docs/research/**` | 无 |

角色的模型档位（strong、medium、cheap）和工具在 `workflow.yaml` 的 `roles` 里，不要改小范围的权限设计，除非你清楚后果。

## 任务流水线

一个 impl task 的流程：

1. **并行开工**：worker 实现，test-author 在独立仓库里写 `T-003.at`（验收测试）。S0 例外：`.at` 在 impl 合并之后才开始，单独合并。
2. **提交与等待**：worker `forge_submit` 后 task 进入 `awaiting_inputs`，等最新的 `.at` 完成、软依赖的生产方 done；程序把集成分支合进任务分支（有冲突就交回 worker 解决）。
3. **预检**（程序，`checking`）：带着分配的端口和数据库，运行 `typecheck`、`lint`、`test` 和本 task 的验收测试；检查 diff 没有越出 `writes`、契约只做了追加、验收测试没被改。失败交回 worker，达到次数上限转 blocked。
4. **审查**（`in_review`）：按风险推导是否需要（`skip`、`auto`、`strong`）。reviewer 只看 diff 等输入，必须改要有出处；有 must 就回到 worker，第二轮（`.rv-2`）只确认。
5. **合并队列**：程序串行合并，选队列里第一个合格的 task；rebase 后跑全量验证，通过后快进到集成分支。契约文件的文本冲突先尝试结构化三方合并。

派生 task 的命名：

| 名字 | 是什么 |
|---|---|
| `T-003.at`、`.at-2`… | 验收测试。`.at-n` 在争议、覆盖率缺口、契约追加破坏了它、变更请求时产生 |
| `T-003.rv`、`.rv-2` | 审查与只确认的第二轮 |
| `T-003.fx-1`… | 修复：阶段门禁、stage-qa 的 must、验收测试在已有实现上失败时产生，接着该 task 最后一次 worker 的会话 |
| `S1.rv`、`S1.qa`… | 阶段级的审查与 stage-qa |

**争议**：worker 认为测试写错时，调用 `forge_dispute`，必须引用规格或契约的具体位置。程序创建 `.at-n` 让 test-author 判断：修改测试，或引用出处维持原测试；规格本身矛盾，或同一测试争议超过 `testing.max_disputes`，转给你。你用 `/forge-decide <task> keep-test`（维持测试，worker 改实现）或 `/forge-decide <task> fix-test "<说明>"`（按说明改测试）。

别的 task 的验收测试被正当的契约追加破坏时，程序不计入当前 task 的失败，而是给那个测试创建 `.at-n`，当前 task 等它修好。

## 阶段验收

一个阶段的 impl 全部 done 后（精简模式要先做阶段审查），程序按顺序：

1. **门禁**：在集成分支 HEAD 的临时 worktree 里运行 `implementation_gate.auto` 里配置了的命令。
2. **覆盖率**：扫描测试名里的 `[REQ-xxx.ACn]` 标签，生成 REQ、AC、测试文件矩阵，写入 `docs/qa/<阶段>.md`。有缺口就给负责的 task 建 `.at-n`。
3. **stage-qa**：核对跨模块一致性、页面状态、测试是否形同虚设、exit 是否达成，可用 `forge_service` 启动服务。
4. **修复**：门禁失败、覆盖率缺口、stage-qa 的 must 都生成修复或补测任务（按 task 归属，不是按角色）。修复合并后重跑门禁与覆盖率，stage-qa 再做只确认的一轮。门禁与覆盖率的修复最多 2 轮，stage-qa 最多 `qa.max_rounds` 轮。
5. **签收**：门禁通过时和最近一轮 stage-qa 的集成分支 HEAD 都等于当前 HEAD，才进入等你签收。

轮数用尽，或问题找不到负责的 task，阶段进入 **needs_human**（"需要你处理"）。这时你可以：

- 自己处理后 `/forge gate` 重跑门禁；
- `/forge accept <阶段> --note "<说明>"` 人工放行，直接进入签收（你仍要 `/forge-approve` 签收）；
- `/forge-reject "<意见>"` 打回，阶段回到 active。

`/forge accept <task> --note` 还可用于审查轮数用尽而 blocked 的 task（代码已通过预检，只是审查意见没谈拢），直接进入合并。预检或合并次数用尽的 task 不能 accept（代码没通过验证），只能 `/forge unblock <task> [--reset]`。

## 变更请求与规格修订

- **加需求**：`/forge-add "<需求>"`（P0 批准之后可用）。主会话把它整理成规格修订（`forge_spec_amend`），写入 `docs/spec/features/<日期>-<序号>-<名字>.md`；程序列出变化的 AC 与受影响的 task、验收测试；你 `/forge-approve amend:<id>` 批准，或 `/forge-reject amend:<id> "<意见>"` 打回。批准后如果计划已批准且 AC 有变化，程序自动发起变更请求（来源 `amend:A-xxx`）。
- **改契约或补计划**：worker 或主会话调用 `forge_change_request`（写明 what、why、impact）。程序派 architect 在当前阶段的 doc task 里起草修订，用 `forge_propose_plan` 提交。你 `/forge-approve change:<id>` 批准，或 `/forge-reject change:<id> "<意见>"` 打回让 architect 带着意见重做。
- 批准时在一个事务里落地：未开始的 task 调整或取消，已开始或已完成的 task 以新 task 加 `modifies: T-xxx` 的方式接在它后面，受影响的验收测试创建 `.at-n`，之后的 S 阶段可以新增或调整。已开始的 task 和已完成的阶段不能被直接修改。
- 同一流程同时只能有一个未结束的变更请求；等待批准期间，被它点名的 task 暂停派发，阶段门禁也等待。

## 命令

| 命令 | 作用 |
|---|---|
| `/forge init` | 初始化项目骨架（可重复执行，不覆盖） |
| `/forge init --adopt ["<说明>"] [--force]` | 已有项目纳管：生成契约基线，批准用 `/forge-approve stage:ADOPT` |
| `/forge-build ["<项目名>"] [--prd <路径>] [--prototype <路径>]` | 新项目：读 `docs/` 下的需求文档（没有就访谈你），进入规格阶段 |
| `/forge-build --feature ["<功能名>"] [--prd <路径>]` | 已有项目加功能：读 `docs/` 下新放的文档（需要 `docs/contracts/`） |
| `/forge-fix "<问题>"`、`/forge-fix --from <文件>` | 修缺陷 |
| `/forge-status` | 阶段、进度、需要你处理的事项 |
| `/forge-status --detail` | 完整任务列表与内部状态 |
| `/forge-status --cost` | 成本：按流程、阶段、角色、模型、任务汇总，返工最多的任务 |
| `/forge-status --metrics` | 速度、返工、质量、成本度量 |
| `/forge-status --timing [--json]` | 耗时分布 |
| `/forge report` | 当前阶段的签收材料；最后一个阶段是交付汇报 |
| `/forge-approve [stage:<id>\|amend:<id>\|change:<id>] [--yes]` | 批准（仅用户）；最后一个阶段会合入主分支，要确认 |
| `/forge-reject [stage:<id>\|amend:<id>\|change:<id>] "<意见>"` | 打回并记录意见 |
| `/forge-add "<需求>"` | 中途追加需求，交给主会话整理成规格修订 |
| `/forge-decide <task> keep-test ["<说明>"]`、`fix-test "<说明>"` | 裁决验收测试争议 |
| `/forge accept <阶段或task> --note "<说明>"` | 人工放行（阶段 needs_human；审查轮数用尽的 task；fix 的复现确认） |
| `/forge unblock <task> ["<回答>"] [--reset]` | 解除阻塞；`--reset` 清零对应计数 |
| `/forge answer [<task>]` | 回答阻塞 task 提出的问题 |
| `/forge gate` | 重跑当前阶段的门禁 |
| `/forge-resume` | 会话丢失或进程被杀后恢复，并进入调度模式 |
| `/forge off` | 退出调度模式，恢复原来的模型与工具（流程状态不变） |
| `/forge next` | 由程序选择 ready 任务并派发（一般自动派发，不需要手动） |
| `/forge sync` | 把主分支同步进集成分支（每个阶段开始时自动执行） |
| `/forge abort [--yes]` | 中止当前流程或修复（集成分支保留，主分支不受影响） |
| `/forge doctor [--fix]` | 状态完整性与前置条件检查；`--fix` 清理残留 worktree 与提示文件 |
| `/forge rules [apply [all\|<草案>...]]` | 查看或应用规则与命令草案 |
| `/forge knowledge [...]` | 项目知识库：列出、搜索、确认候选、废弃、提升为规则草案 |
| `/forge models [resume <模型>\|all]` | 查看被暂停（额度用完、限流）的模型；立即恢复 |
| `/forge budget [tokens\|cost\|minutes <数值>]` | 查看或设置本流程的预算 |
| `/forge checkpoint [restore <task>]` | 列出或恢复运行中自动拍的工作区检查点 |
| `/forge run [<run_id>]` | 某次子进程运行的工具调用摘要与最后的回复 |
| `/forge-config [show\|models\|set\|unset\|escalate]` | 为各角色设置模型与思考级别 |

`/forge help`、`/forge-build help`、`/forge-fix help` 显示命令自带的用法。

## 配置

项目根目录的 `workflow.yaml`（模板 `templates/workflow.yaml`）。常用的部分：

| 部分 | 说明 |
|---|---|
| `main_branch` | 主分支名 |
| `commands` | 项目命令：`install`、`typecheck`、`lint`、`test`、`acceptance`（加 `-- <task>` 只跑某个 task）、`acceptance_list`（只收集不执行）、`e2e`、`contract_lint`、`contract_test`、`codegen`、`serve`、`merge_check`、`db_create`、`db_drop`。architect 在 P1 起草，批准计划时应用。所有命令都应从 `PORT`、`FORGE_PORT_BASE`、`FORGE_DB_NAME`、`FORGE_TMP` 取资源，这样并行运行互不干扰 |
| `models` | 三个档位 `strong`、`medium`、`cheap` 的默认模型（`provider/model`）。单个角色的实际模型用 `/forge-config` 设置，优先于这里 |
| `escalation` | `after_failures`：同一 task 失败多次后改用升级模型；`critical_fanout`：被这么多 task 硬依赖的 task 第一次就用升级模型，审查推导为 strong |
| `limits` | `max_parallel`（impl 并发）、`max_parallel_aux`（acctest、review、qa 并发）、`max_attempts`（只计运行失败）、`max_precheck_failures`、`max_merge_failures`、`port_block`（每次运行分配的连续端口数）、`run_minutes`（M 号 task 的时间预算）、`lean_below_loc`、`continue_session` 等 |
| `review` | `per_task`、`max_rounds`、`skip_sizes`（plan 没写 review 时，这些尺寸且没追加契约则跳过） |
| `testing` | `adjust_tests`（worker 可改已有单元测试，只改不增删）、`max_disputes` |
| `qa` | `max_rounds`：stage-qa 报告、修复、只确认 |
| `implementation_gate` | 所有 S 阶段共用：`all_tasks_done`、`auto`（门禁里运行的命令名列表，只运行配置了的）、`coverage`（AC 覆盖率）、`qa`（是否启用 stage-qa）、`human`（是否要你签收） |
| `acctest_workspace` | test-author 隔离工作区额外导出的路径（`include`，如各子包的 `package.json`、测试配置）与 `cache`（如 `node_modules`，按锁文件哈希缓存，命中时硬链接复制，跳过 install）。默认已导出 `docs/spec`、`docs/contracts`、`docs/arch/overview.md`、`AGENTS.md`、`tests/acceptance`、根目录的包清单与锁文件 |
| `generated_paths` | 由契约生成的代码路径 |
| `scopes`、`roles`、`tool_groups` | 角色的可写范围、工具与 bash 档位（`full`、`readonly`、`allowlist`）、读取范围 |
| `budget`（可选）、`notify.command`（可选） | 预算；通知命令（见下文） |

资源隔离：每次运行（含预检、门禁、合并验证）由程序分配一段端口（`limits.port_block`，从 41000 到 60000 之间按 10 对齐，登记前逐个探测）、专用数据库名和临时目录，通过 `PORT`、`FORGE_PORT_BASE`、`FORGE_DB_NAME`、`FORGE_TMP` 注入。登记文件在 `<项目>.worktrees/.resources.json`，`/forge-resume` 与 `/forge doctor --fix` 会回收已结束的条目。

## 观测

- `/forge-status`：高层阶段、进度和"需要你处理"的事项（争议、阻塞、needs_human、等待批准、被暂停的模型等）；`--detail` 是完整任务列表；`--cost` 是成本；`--metrics` 是速度（agent 时间即墙钟时间减去等你的时间、关键路径）、返工、质量、成本度量；`--timing` 是耗时分布。
- `/forge run [<run_id>]`：某次子进程运行的工具调用摘要。
- 事件查看器：`node scripts/forge-view.ts <项目目录> [--out <文件>]` 把 `.forge/` 的状态生成一个自包含的 HTML（任务状态机与转移次数、任务 DAG、运行时间线、成本、事件日志），默认输出到 `<项目目录>.forge-view.html`（项目目录之外）。只读，不修改 `.forge/`。
- 通知：在 `workflow.yaml` 里写 `notify: { command: "<命令>" }`。出现新的"需要你处理"事项或流程完成时，程序运行一次该命令，事件 JSON 从标准输入传入（环境变量 `PI_FORGE_EVENT`、`PI_FORGE_TEXT` 也有），10 秒超时，失败不影响流程。例如用 macOS 的 `osascript` 弹通知。

## 已知局限与状态

- **真实模型验证（M9）还没有做。** 目前所有测试用假模型，提示词（`agents/`、`skills/`）的效果、各档位模型的表现、精简模式的速度，都没有真实数据。M9 按 `docs/BUILD_PROMPT.md` 第 18 节的通过条件执行。
- 只在 Pi 1.0.0 上验证；M9 开始前会单独做升级评估。
- M6、M7 的 e2e 测试写了但没有运行（按计划留到统一运行）。
- 阶段被打回后，旧的 stage-qa 与阶段审查轮次仍计入 `qa.max_rounds` 和 `review.max_rounds`，被打回后可以用 `/forge accept` 放行。
- 变更请求的 `cancelled` 状态在存储里有，但没有命令可以触发。
- 完整列表见 [NOTES.md](NOTES.md) 的"待确认与已知局限"，所有偏离规格的决定见同一文件的"偏离记录"。

## 开发

规格是 `docs/BUILD_PROMPT.md`（不要修改）。所有偏离规格的决定、已核实的 Pi API 与版本、真实模型实验的结论都记在 `NOTES.md`。

```
src/core/        业务逻辑，不依赖 Pi。state-store.ts 是 .forge/ 唯一的读写入口；
                 state-machine.ts 是转移表（不在表中的转移一律拒绝）；dispatcher.ts 是引擎
src/tools/       forge_* 工具的业务实现
src/commands/    斜杠命令的业务实现
src/modes/       阶段计划与 fix 流程
src/pi-adapter/  唯一可以调用 Pi API 的目录
agents/ rules/ skills/ templates/   角色提示、规则、技能、项目模板
schemas/*.json   由 npm run gen:schemas 从 src/core/schemas.ts 生成
scripts/         forge-view（事件查看器）、gen-schemas、real-build 与 baseline-build（M9 用）
test/            unit、e2e、fixtures
docs/            规格、决定记录、流程图（flow.md）
legacy/          pi-flow 的参考代码，不参与构建
```

约定：状态只能由程序写；新增的检查（spec-lint、契约检查、DAG 推导、覆盖率）都是纯函数并有单元测试；只用可擦除的 TypeScript 语法（不用参数属性、enum、namespace）；标识符和文件名用英文，面向用户的提示、错误信息和文档用中文；不读取、不打印密钥。修改 `agents/`、`rules/`、`skills/` 会让子进程系统提示的稳定前缀变化，导致提示缓存失效，要在 `NOTES.md` 的"缓存提醒"里记一笔。

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # 先跑 test/unit，再跑 test/e2e
node --test --test-reporter=spec "test/unit/**/*.test.ts"   # 只跑单元测试
npm run gen:schemas               # 从 src/core/schemas.ts 生成 schemas/*.json
```

测试不依赖真实 LLM：单元测试直接测纯函数；e2e 用 `test/fixtures/fake-subagent`（用脚本代替模型调用工具，仍经过真实的 guard 与 `forge_*` 工具）和 `test/fixtures/fake-llm`（假模型服务，供真实 pi 进程使用）。真实模型只在 M9 和 `scripts/real-build.ts` 中使用。

复用来源是 pi-flow（运行时文件取 `31f3f15`，流程层取 `7006e7d`），拷贝或改编的文件在文件头注明来源。
