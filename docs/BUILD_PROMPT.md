# pi-forge 构建提示词（给 Claude Code）· v3.2

> 本文是新工作流 `pi-forge` 的完整规格。pi-flow 仓库是复用来源，不是要修改的对象。
> 名字 `pi-forge`、命令前缀 `/forge-`、工具前缀 `forge_` 都是占位，可以整体替换。
> 不要修改本文；偏离规格的决定记在 `NOTES.md` 的"偏离记录"里。
> v2、v3 分别根据第一次、第二次核对修订（逐条决定见 `DECISIONS-R1.md`、`DECISIONS-R2.md`），改动处在第 21 节"修订记录"中列出。

---

## 0. 角色与目标

你是资深 TypeScript 工程师。你要实现一个 **Pi package**：`pi-forge`。它把下面这套多 agent 开发流程固化成插件：

- **输入**：用户已经写好的 PRD，以及可选的界面原型（HTML 目录、图片或导出文件）。
- **输出**：一个从 0 开发的大型项目，能分阶段交付，每个阶段都经过验收。
- **目标**：开发要快，质量要高。两者都用数字衡量，见第 17 节。

| 架构图中的名字 | 本文的名字 | 是什么 | 做什么 |
|---|---|---|---|
| Main agent | `main`（主会话） | LLM | 接收 PRD 与原型，和用户沟通，把需求整理成可验证的规格；汇报进度；转达用户的决定 |
| Architect agent | `architect` | LLM | 写数据模型、OpenAPI 契约、错误码表、目录结构、分层编码规则，拆出分阶段的任务计划 |
| Orchestrator | `engine`（引擎） | **程序，不是 LLM** | 根据计划生成 DAG，派发就绪的 task，管理状态文件，执行预检、门禁与合并，处理重试与升级 |
| Test agent | `test-author` | LLM | 只读规格与契约，在契约边界写验收测试；它的工作区里没有实现代码 |
| Worker ×N | `worker` | LLM | 一个 task 一个 worker，按 TDD 实现，可以并行 |
| Reviewer | `reviewer` | LLM | 只看 diff、需求、契约和规则，看不到实现过程 |
| Stage QA agent | `stage-qa` | LLM | 阶段末在集成分支上核对需求覆盖和跨模块一致性 |
| — | `researcher` | LLM | 按需联网调研（从 pi-flow 原样复用） |

**orchestrator 必须是程序。** "orchestrator 该派 subagent 却自己动手"这个问题，根治办法是让调度根本不经过 LLM：选哪个 task、派给谁、并行几个、何时合并，全部由代码决定。主会话只有读取、查状态、提交申请这几类工具。

## 1. 对你（Claude Code）的工作方式要求

1. **复用优先，基线分两层。** pi-flow 在 `~/Documents/Code/program/pi-flow`。
   - **运行时文件取 HEAD（`31f3f15`，第六轮）**：第六轮补了服务管理、打码、`.flow` 格式迁移、检查点、PRD 原件入库，以及多项加固。
   - **流程层文件取 `7006e7d`**：那时 architect 角色还在，`modes/plan`、`stages`、`revision`、`acceptance`、`final-review` 与 pi-forge 的流程更接近。
   - 具体到每个文件的处理见第 16 节。拷贝或改编的文件，在文件头注明来源和提交，例如 `// 来源：pi-flow src/core/merge-queue.ts @ 31f3f15`。
2. **Pi 的 API 先查文档再用，不凭记忆。** Pi 安装在 `$(npm root -g)/@earendil-works/pi-coding-agent`。只有 `src/pi-adapter/` 可以调用 Pi API。
3. **严格按里程碑推进（第 18 节）。** 每个里程碑开始前给出计划；完成后跑通验收测试，然后汇报四件事：做了什么、偏离了什么、待确认项、下一步计划。**等我确认再继续。**
4. **测试先行。** 状态机、DAG 推导、guard、合并队列、恢复、各种校验器，都先写测试再写实现。测试不能依赖真实 LLM。
5. **安全。** 不读取、不打印、不提交任何密钥。
6. **不新增运行时依赖。** 沿用 pi-flow 的 minimatch、proper-lockfile、yaml，以及 Pi 自带的 typebox。OpenAPI 只用 `yaml` 解析成结构来做符号核对和结构比较；契约是否合法交给项目自己的 `commands.contract_lint`。
7. **代码风格与 pi-flow 一致**：只用可擦除的 TypeScript 语法；标识符英文，面向用户的文字用中文；Node 22 以上。

## 2. 设计原则（不可违背）

pi-flow 的 11 条原则全部保留：状态只由程序写；约束靠移除能力加程序校验；验收由程序自己跑命令；每次状态转移都写事件日志；会话可随时中断；人工闸门不能被 agent 自批准；调度权在代码；subagent 之间只通过产物协作；合并由程序串行执行；保留逃生口。

在此基础上新增：

12. **能用程序判断的，不交给 LLM 判断。**
13. **独立性靠隔离保证，不靠嘱咐。** test-author 的工作区是一个独立仓库，里面没有实现代码，也不共享对象库；worker 改不了验收测试；reviewer 读不到 `.forge/`。
14. **LLM 判断必须引用出处。** "必须改"要写明依据，没有出处的只能算"建议"，不阻塞流程。
15. **第二轮只能确认，不能提新问题。**
16. **速度是验收标准的一部分。**
17. **`done` 是终态。** 需要返工时创建新的派生 task，不从 `done` 转出。

## 3. 从 pi-flow 实验中学到的教训

| 现象（pi-flow 实测） | 本设计的做法 |
|---|---|
| 11 次打回里有 7 次是"先行验收测试写错" | test-author 与 worker 并行；测试只写在契约边界；提交前程序检查能收集；worker 有争议通道（第 9 节） |
| 逐任务审查时，强模型每一轮都能挑出新问题 | 只依据清单，必须有出处；第二轮只确认；小 task 跳过（第 10 节） |
| 函数级契约让规划 42 分钟，锁定后修订 3 次 | 契约只写边界，实施中只能追加，按模块分文件；修改走变更请求（第 12 节） |
| 14 个任务 35 次运行 | 粒度跟模型；S0 只有一个 task；DAG 报告提醒（第 7 节） |
| 看板项目：原生 17.6 分钟，pi-flow 75 分钟 | 精简模式（第 7.6 节）；速度基准（第 17、18 节） |
| 原地打转、孤儿进程、GUI 命令、违规死锁 | 复用 HEAD 的运行时加固 |
| 主 agent 读不到集成分支上的 PRD，隐藏测试只得 4/40（pi-flow 第 172、173 条） | main 用 `forge_read` 读集成分支上的产物；PRD 原件由程序入库（第 13.1 节） |
| 合并全量测试与可写范围冲突 | 单元测试走 test-adjust；验收测试由其 test-author 修复（第 9.4 节） |
| architect 连问三次停住 | 能合理假设的写进 assumptions，批准时列给用户 |

## 4. 总体架构

```
用户 ──对话──> main（只读 + forge_* 申请） ──forge_*──> engine（程序：唯一写状态）
用户 ──命令──> engine：/forge-approve /forge-reject /forge-decide /forge-add …（只有人能执行）

engine ──> architect        P1：契约与计划；变更请求
       ──> worker ×N        实现（git worktree）
       ──> test-author ×N   验收测试（独立仓库，没有实现代码）
       ──> reviewer         diff 审查
       ──> stage-qa         阶段验收
       ──> researcher       按需
engine 自己执行：入库、规格校验、计划校验与 DAG 推导、预检、合并队列、门禁、覆盖率、端口与数据库分配、恢复
```

- 子进程都是 `pi --mode rpc`，只启用本角色的工具，只能写本任务允许的路径（复用 dispatcher、launcher、guard、subagent-runtime）。
- 状态在 `.forge/`，事件日志带哈希链，提交到 `refs/pi-forge/state`。
- 中断后用 `/forge-resume` 恢复，只依赖 `.forge/` 和 git。

### 4.1 运行时资源隔离

每次运行（以及每次预检、门禁）由程序分配资源，通过环境变量注入：

| 变量 | 内容 |
|---|---|
| `FORGE_PORT_BASE` | 一段 10 个空闲端口的起点（程序登记占用，运行结束释放） |
| `PORT` | 等于 `FORGE_PORT_BASE` |
| `FORGE_DB_NAME` | 本次运行专用的数据库名或 SQLite 文件名（`forge_<run>`） |
| `FORGE_TMP` | 本次运行的临时目录 |

S0 的完成标准包括：`acceptance`、`e2e`、`serve` 都遵守这四个变量，在同一台机器上并行跑互不干扰。

- **登记**：分配记录在 `<项目>.worktrees/.resources.json`（不在 `.forge/` 内），每条写 run id、pid、端口段、数据库名、分配时间，用文件锁保护。
- **回收**：运行正常结束时释放；`/forge-resume` 与 `/forge doctor --fix` 回收 run 已结束或 pid 已不存在的条目，同时删除 `FORGE_TMP`。
- **数据库**：SQLite 等文件数据库放在 `FORGE_TMP` 下，随目录删除。服务器类数据库（如 Postgres）由项目提供可选命令 `commands.db_create`、`commands.db_drop`，程序在分配和回收时以 `FORGE_DB_NAME` 调用；没有提供时，项目自己的命令要能按需建库（S0 负责）。

## 5. 阶段与闸门

用户界面上只显示：**规格 → 契约与计划 → 实施（S0 骨架、S1…Sn）→ 交付**。高层阶段（`phases`）为 `spec`、`plan`、`implementation`。

| 阶段 | 由谁做 | 产出 | 程序检查 | 闸门 |
|---|---|---|---|---|
| **P0 规格** | main 与用户 | `docs/spec/**` | spec-lint | 用户批准；之后 `docs/spec/**` 只能通过规格修订（第 13.5 节）改动 |
| **P1 契约与计划** | architect | 契约、架构、计划、规则与命令草案、AGENTS.md | 契约检查、计划校验、DAG 推导、覆盖检查 | 用户批准；程序生成 S 阶段记录与派生 task，契约变为只能追加，应用规则与命令 |
| **S0 骨架** | 1 个 worker；test-author 在 worker 之后 | 端到端最薄链路与全部基础设施 | 第 8 节 | 第 11 节 |
| **S1…Sn** | worker、test-author、reviewer | 每个阶段的需求切片 | 第 8 节 | 第 11 节 |
| **交付** | engine | 不是独立阶段：用户批准最后一个 S 阶段的签收时，程序把集成分支 `--no-ff` 合入主分支 | 最后一个 S 阶段的全量命令 | 交付汇报作为这次签收的汇总内容（M6 实现） |

- **S 阶段是动态的。** P1 批准时，程序根据 `plan.yaml` 在流程状态里写入 S 阶段记录（事件 `stages_planned`）。每个阶段的闸门取自 `workflow.yaml` 的 `implementation_gate`（第 15 节）。变更请求可以在当前阶段**新增 task**，可以新增或调整当前阶段**之后**的阶段；不能修改已完成的阶段，也不能修改当前阶段里已开始的 task（事件 `stages_revised`）。
- **S0 的特殊规则：** 只有 1 个 impl task。它的 worker 可以写 `tests/acceptance/_support/**` 和一个冒烟测试 `tests/acceptance/S0-smoke/**`（唯一的例外，见第 7.5 节）。S0 的 `.at` 在 impl 合并之后才派发，按第 9.5 节单独合并。
- 阶段之间是串行屏障；同一阶段内按 DAG 并行。

阶段的待人工状态为 `needs_human`，相关转移如下（只有用户能执行 accept、重跑门禁和打回）：

| 从 | 到 | 触发 | 条件或作用 |
|---|---|---|---|
| awaiting_gate | needs_human | gate_exhausted | 门禁修复轮数用尽 |
| needs_human | awaiting_human | accept | `/forge accept <阶段> --note "<说明>"`：人工放行，进入签收 |
| needs_human | awaiting_gate | `/forge gate` | 重跑门禁 |
| needs_human | active | `/forge-reject` | 打回，记 `stage_reopened` 事件 |
| awaiting_human | active | `/forge-reject` | 打回，记 `stage_reopened` 事件 |

## 6. 产物与目录

```
docs/spec/inputs/              PRD 与原型原件（由程序入库，只读）
docs/spec/requirements.md      需求：REQ、优先级、AC（Given/When/Then）
docs/spec/screens.md           页面：路由、字段、交互、状态、对应的 REQ
docs/spec/permissions.md       角色 × 资源 × 操作矩阵
docs/spec/glossary.md          术语表（P0 初版；P1 起 architect 只能追加）
docs/spec/features/<名字>.md    feature 模式的增量规格；以及批准的规格修订
docs/contracts/openapi.yaml    根文件：info、公共 components（Error、分页等）、每个路径一条指向 paths/<模块>.yaml 的 $ref
docs/contracts/paths/<模块>.yaml 各模块的 path item（按模块拆文件，减少并行追加的冲突）
docs/contracts/components/<模块>.yaml 各模块自己的 schema（由 paths 文件用 $ref 引用）
docs/contracts/errors/<模块>.yaml 各模块的错误码；错误码以模块前缀开头
docs/contracts/data-model.yaml 数据模型
docs/contracts/modules/<m>.md  跨模块的函数调用
docs/arch/overview.md、adr/    架构
docs/plan/plan.yaml            阶段与任务
docs/rules-draft/              分层规则与命令草案
docs/review/suggestions.md     不阻塞的建议（程序汇总）
docs/qa/<阶段>.md               覆盖率矩阵与阶段验收报告（程序写入）
tests/acceptance/<task>/**     验收测试（只有 test-author 能写）
tests/acceptance/_support/**   验收测试的公共工具（S0 的 worker 建立；之后 test-author 只能在 _support/<task>/ 下新建文件）
tests/acceptance/S0-smoke/**   S0 worker 写的冒烟测试（不计入 AC 覆盖率）
AGENTS.md
.forge/                        状态（只有程序写；子进程读不到）
```

### 6.1 规格格式与 spec-lint

需求格式：

```md
### REQ-012 团队负责人可以创建数据源 [MVP]
角色：管理员、团队负责人
- AC1：Given 已登录的团队负责人 When 提交合法的 MySQL 配置 Then 创建成功，返回数据源 id，状态为 untested
- AC2：Given 本团队已有同名数据源 When 再次创建 Then 失败，错误码 DATASOURCE_NAME_TAKEN
- AC3（manual）：在列表页新增后，新项出现在第一行
```

spec-lint 拒绝以下情况：

- REQ 编号重复（全局，包括 `features/` 下的文件）；优先级不合法。
- MVP 需求没有 AC；非 manual 的 AC 缺少 Given、When、Then 中的任何一个。
- `screens.md` 中的页面没有对应 REQ，或缺少四种状态之一（不适用写 `N/A：理由`）。
- `permissions.md` 的角色不在 glossary 里，或表格无法解析。
- 出现 `TODO`、`TBD`、`待定`。

另外，AC 里出现无法测试的词（快速、友好、合理）时给出警告，不阻塞。

没有提供原型时，`screens.md` 由 main 根据 PRD 的文字整理，规则相同。

## 7. 计划与 DAG

### 7.1 plan.yaml

```yaml
size_estimate: { loc: 18000, modules: 9 }
mode: standard                  # standard | lean
stages:
  - { id: S0, goal: "骨架：登录 → 选数据源 → 提问 → 返回一行结果（桩实现）", exit: [REQ-001] }
  - { id: S1, goal: "数据源管理与权限", exit: [REQ-010, REQ-011, REQ-012] }
baseline: [api:GET /api/users/me]      # 仅 feature 模式
tasks:
  - id: T-003
    stage: S1
    module: datasource          # 决定契约文件与错误码前缀
    title: 数据源管理：创建、编辑、删除、连接测试
    size: M
    layers: [backend, database, frontend]
    ac: [REQ-012.AC1, REQ-012.AC2, REQ-013.AC1]
    writes: [server/src/datasource/**, web/src/pages/datasource/**, server/migrations/*_datasource_*.sql]
    shared: [server/src/routes.ts, web/src/router.ts]
    produces: [table:datasources, api:POST /api/datasources, api:GET /api/datasources]
    requires: [table:teams, ~api:GET /api/teams/{id}]
    test_interface: [HTTP /api/datasources*, page /datasources]
    manual_checks: [新增后列表高亮]
    # review: skip | auto | strong   不写时由程序推导（第 10.1 节）
```

### 7.2 符号语法

| 前缀 | 含义 | 程序如何核对它存在 |
|---|---|---|
| `api:<METHOD> <path>` | REST 接口 | 在合并后的 OpenAPI 结构中能找到 |
| `table:<name>` | 数据表 | 在 `data-model.yaml` 中能找到 |
| `error:<CODE>` | 错误码 | 在某个 `errors/*.yaml` 中能找到 |
| `fn:<module>#<name>` | 跨模块函数 | `modules/<module>.md` 中有 `## <name>` 标题 |
| `page:<route>` | 页面 | 在 `screens.md` 中能找到 |
| `lib:<name>` | 公共组件 | 只要求有某个 task 产出它 |

`requires` 中带 `~` 前缀的是**软依赖**：消费方可以并行开工，但预检要等生产方 done（第 8.2 节）。

### 7.3 DAG 推导（纯函数，`dag.ts`）

1. 核对符号：每个 `produces` 中的符号都能在契约里找到（`lib:` 除外）；每个 `requires` 中的符号都有生产方，可以是某个 task，也可以是 `baseline`（`baseline` 中的符号也要在现有契约中找到）。
2. 同一个符号只能有一个生产方。
3. 生成依赖边：不带 `~` 是硬依赖（生产方 done 后，消费方才能开工）；带 `~` 是软依赖（可以并行开工，预检和合并在生产方之后）。生产方所在阶段不能晚于消费方。
4. 互斥：`writes` 有重叠（`shared` 除外）的 task 不能同时运行。复用 `conflictsWith`、`mutexPairs`。
5. 环检测，复用 `findCycle`。
6. AC 覆盖：每条 MVP 非 manual AC 恰好分配给一个 task；阶段 exit 中需求的 AC，都分配给本阶段或更早阶段的 task；每条 MVP REQ 都出现在某个阶段的 exit 中。
7. 报告：复用 `dagReport`，并加上每个阶段的 task 数、互斥对、提醒。

### 7.4 派生 task（由程序生成，名字后缀固定）

| 派生 task | kind | 角色 | 何时创建、何时就绪 |
|---|---|---|---|
| `T-003.at` | `acctest` | test-author | 计划批准时创建；与 T-003 同时就绪（S0 除外：impl 合并后才就绪，按第 9.5 节单独合并） |
| `T-003.rv` / `.rv-2` | `review` | reviewer | 预检通过且需要审查时创建；第二轮创建 `.rv-2` |
| `T-003.at-2`、`.at-3`… | `acctest` | test-author | 争议、覆盖率缺口、因契约追加导致失败、变更请求时创建，fork 上一个 `.at` 的会话。impl 尚未 done 时随 impl 的预检带入；impl 已 done 时按第 9.5 节单独合并 |
| `T-003.fx-1`… | `fix` | worker | 阶段门禁或 stage-qa 发现问题时创建（第 11.3 节） |

### 7.5 粒度与 S0

- 一个 task 是一个纵向切片，由一个 worker 负责前后端、迁移和单元测试。只有 size 为 L 且接口是真实 REST 边界时，才拆成 api 和 ui 两个 task（ui 对 api 用 `~` 软依赖）。
- 强模型：一个 task 可以是一整块业务；弱模型：一次会话能做完。
- **S0 只能有 1 个 task。** 完成标准如下：
  1. `install`、`typecheck`、`lint`、`test`、`acceptance`、`acceptance_list` 在干净的 worktree 中能跑通；
  2. 这些命令遵守第 4.1 节的环境变量；
  3. worker 写的冒烟测试 `tests/acceptance/S0-smoke/` 贯穿 前端或客户端 → API → 数据库（这是 worker 唯一能写验收目录的例外；它证明框架可用，不计入 AC 覆盖率，S0 exit 的 AC 由 S0 的 `.at` 覆盖）；
  4. `tests/acceptance/_support/` 建好（登录、准备数据、读取 PORT 与 FORGE_DB_NAME 的公共工具）；
  5. **在 test-author 的隔离工作区（第 9.2 节）里，`install` 和 `acceptance_list` 能运行。**
- 程序提醒（不阻塞）：一个阶段的 task 超过 `max_parallel × 3` 个；关键路径超过任务数的一半；`writes` 超过 `max_task_files`。

### 7.6 精简模式（lean）

`size_estimate.loc` 低于 `limits.lean_below_loc`（默认 6000）时，architect 应选 lean，没选的话程序在批准页提醒。规则如下：

- 每个阶段只有 1 个 impl task。**跨阶段时接着上一阶段 worker 的会话**（fork；同模型、会话不超过 `continue_session` 的大小上限，否则从头开始，靠 notes 和 handoff 衔接）。
- test-author 照常与 worker 并行。
- 不做逐任务审查。阶段的 impl 合并后、门禁之前，reviewer 对**整个阶段的 diff** 审查一次（`.rv`）；有 must 时生成 `.fx` 交给 worker（fork），再由 `.rv-2` 只确认；仍未解决的，转为阶段的 `needs_human`。
- 门禁、覆盖率、stage-qa 照常执行。

## 8. 单个 task 的流水线

### 8.1 状态与转移

在 pi-flow 的状态集合（`pending、ready、in_progress、queued_merge、merging、done、blocked、cancelled`）上新增：

- `awaiting_inputs`：impl、fix 或 doc 已提交，在等 `.at` 完成或软依赖的生产方 done。
- `checking`：程序正在跑预检。
- `in_review`：在等 reviewer。
- `disputed`：worker 提出了争议，等待裁决；此时没有运行中的 worker，也没有租约。

新增 task 字段 `blocked_by`，记录阻塞原因，取值为 `dispute`、`review_exhausted`、`precheck_exhausted`、`merge_exhausted`、`attempts`、`agent`、`dispatcher`、`user`、`integration_broken`；分别表示争议、审查轮数用尽、预检次数用尽、合并失败次数用尽、运行失败次数用尽、agent 阻塞、调度器阻塞、用户阻塞、集成分支已坏。

| 从 | 到 | 触发 | 条件或作用 |
|---|---|---|---|
| pending | ready | schedule | 硬依赖都已 done；本阶段处于 active |
| ready | in_progress | dispatch | 并发未满；不与运行中的 task 互斥 |
| in_progress | awaiting_inputs | submit | impl、fix、doc：本次运行结束，释放租约 |
| awaiting_inputs | checking | inputs_ready | 最新的 `.at-*` 已 done，且软依赖的生产方都已 done；程序把集成分支合进任务分支（同 `forge_sync`）。有冲突时转 `in_progress`（`sync_conflict`，fork，交给 worker 解决） |
| checking | awaiting_inputs | foreign_tests_broken | 别的 task 的验收测试失败，按第 9.4 节处理；不计入当前 task 的任何计数 |
| checking | in_progress | precheck_fail | `precheck_failures` 加 1；达到 `limits.max_precheck_failures` 时转 blocked，`blocked_by = precheck_exhausted` |
| checking | in_review | precheck_pass | 需要审查 |
| checking | queued_merge | precheck_pass_skip | 不需要审查 |
| in_review | in_progress | review_changes | 有 must；`review_rounds` 加 1 |
| in_review | queued_merge | review_pass | — |
| in_review | blocked | review_exhausted | 已到 `review.max_rounds` 仍未解决；`blocked_by = review_exhausted` |
| queued_merge | merging | merge_start | 选队列里**第一个合格**的 task（软依赖的生产方都已 done），不是严格的队首 |
| merging | done | merge_done | — |
| merging | awaiting_inputs | foreign_tests_broken | 别的 task 的验收测试失败，按第 9.4 节处理；不计入当前 task 的任何计数 |
| merging | in_progress | merge_verify_fail | `merge_failures` 加 1；达到 `limits.max_merge_failures` 时转 blocked，`blocked_by = merge_exhausted` |
| in_progress | disputed | dispute | worker 调用 `forge_dispute`，本次运行结束；程序创建 `.at-n` |
| disputed | checking | dispute_fixed | `.at-n` 修改了测试：直接重跑预检，不需要再派 worker |
| disputed | in_progress | dispute_upheld | `.at-n` 维持了测试；fork worker 的会话，附上 test-author 的理由 |
| disputed | blocked | dispute_escalated | 同一个测试的争议次数超过 `testing.max_disputes`，或 `.at-n` 用 forge_block 交给用户；`blocked_by = dispute` |
| blocked | in_progress | decide_keep | 仅限用户执行，且 `blocked_by = dispute`；`/forge-decide <task> keep-test`：fork worker，附上用户的说明 |
| blocked | disputed | decide_fix | 仅限用户执行，且 `blocked_by = dispute`；`/forge-decide <task> fix-test "<说明>"`：创建 `.at-n` 并附上用户的说明；`.at-n` done 后走 dispute_fixed |
| blocked | queued_merge | accept | 仅限用户执行，且 `blocked_by = review_exhausted`；`/forge accept <task>`：代码已通过预检，只是审查意见没谈拢 |
| blocked | in_progress | unblock | 仅限用户执行，且 task 已开工；`/forge unblock <task> [--reset]`：保留 worktree，`--reset` 把对应计数清零；预检或合并失败次数用尽的 task 不能 accept，只能 unblock |
| blocked | ready | unblock | 仅限用户执行，且 task 尚未开工；无需 worktree，`--reset` 把对应计数清零 |
| 以及 pi-flow 的 block、lease_expired、run_failed、run_interrupted、run_paused、run_timeout、cancel | | | 原样保留；`attempts` 只计运行失败（崩溃、超时等），不计预检、审查、合并失败 |

`doc`（architect 的 P1 task）与 impl 一样走 `awaiting_inputs → checking`，等待条件自然满足；M3 将契约检查和计划校验接入它的预检。

`review`、`qa` 只走 `ready → in_progress → done（report）`。`acctest` 有两条路径：impl 尚未 done 时，提交即 done（测试随 impl 的预检合入）；impl 已 done 时，走第 9.5 节的单独合并。

**卡住时必须能被看见。** 一个 task 处于 `awaiting_inputs`，而它等待的 `.at-*` 或软依赖生产方已经 blocked 时，程序把它列进"需要你处理"，写明它在等谁、那个 task 为什么 blocked。

### 8.2 预检（checking，程序步骤）

1. 把最新 `.at-*` 的分支合并进任务分支。它只涉及 `tests/acceptance/<task>/**` 与 `tests/acceptance/_support/<task>/**`，按第 9.2 节的路径规则，不会与别的 task 冲突。
2. 在任务的 worktree 中，带着第 4.1 节分配的资源运行：`typecheck`、`lint`、`test`、`acceptance -- <task>`。
3. 检查 diff：不能越出 `writes`、`shared`，以及 test-adjust 允许的范围；`docs/contracts/**` 只能追加（第 12.1 节）；`tests/acceptance/**` 没有被改动（例外：S0 的 impl 可以改 `tests/acceptance/_support/**` 与 `tests/acceptance/S0-smoke/**`，第 5、7.5 节）。
4. 失败的输出用 HEAD 的失败摘要压缩后交给 worker；通过时，把 diff 和输出存为 evidence。

### 8.3 恢复（resume）

| 中断时的状态 | 恢复时怎么做 |
|---|---|
| checking | 丢弃这次预检的结果，重新跑 |
| awaiting_inputs | 重新评估条件 |
| in_review | 对应的 `.rv*` 是普通的只读 task，按 pi-flow 规则恢复 |
| disputed | 对应的 `.at-n` 按 pi-flow 规则恢复 |

## 9. 测试分工与争议

### 9.1 三类测试

| 测试 | 谁写 | 放在哪 | 什么时候跑 |
|---|---|---|---|
| 单元与组件测试 | worker（tdd） | 按项目约定 | 预检、合并 |
| 验收测试 | test-author | `tests/acceptance/<task>/` | 预检、合并、阶段门禁 |
| 端到端与契约测试 | S0 搭框架，test-author 补充 | `tests/acceptance/`、`commands.e2e`、`commands.contract_test` | 阶段门禁 |

### 9.2 test-author 的隔离工作区（程序保证）

test-author **不用 git worktree**，用一个独立仓库：

1. **导出基准**：首个 `.at` 用集成分支 HEAD。`.at-n` 用三者叠加：集成分支 HEAD，加上 `acc/<task>` 最新提交（本 task 尚未合并的测试），再加上任务分支相对集成分支在 `docs/contracts/**` 上的改动（worker 追加的契约，争议时常常引用它）。impl 已 done 时只用集成分支 HEAD。用 `git archive` 导出以下路径：`docs/spec/**`、`docs/contracts/**`、`docs/arch/overview.md`、`AGENTS.md`、`tests/acceptance/**`，以及 `workflow.yaml` 的 `acctest_workspace.include`（根目录与各子包的 `package.json`、锁文件、测试配置，用 glob 指定）。
2. 解压到 `<项目>.worktrees/<run>-at/`，`git init`，提交一次作为基线。这个仓库**和主仓库不共享对象库**，所以 `git show`、`git cat-file` 都读不到实现代码。
3. 程序在里面**先运行 `install`，再运行 `commands.codegen`**（codegen 工具通常是 devDependency；生成的代码通常不提交）。为了速度，`acctest_workspace.cache` 列出的目录（如 `node_modules`）按锁文件哈希缓存在 `<项目>.worktrees/.acctest-cache/<hash>/`，命中时用硬链接复制（`cp -al` 或等价做法），跳过 install。
4. test-author 提交后，程序只取 `tests/acceptance/<task>/**` 与 `tests/acceptance/_support/<task>/**` 下的改动，以补丁的形式应用到主仓库的 `acc/<task>` 分支。改动 `_support/` 下其他位置（包括别的 task 的子目录与 S0 建立的公共文件）或任何其他路径，都会让提交被拒。这样并行的 test-author 不会撞名。公共工具需要扩充时，写进本 task 的子目录；值得共享的，由 stage-qa 作为 suggest 提出。
5. guard 作为第二道防线：拦截访问工作区之外的绝对路径、`..` 越出工作区的路径、`.forge/`，以及 `git` 的 `remote`、`fetch`、`clone`、`worktree` 子命令。
6. test-author 的 bash 使用白名单档位（第 14.1 节）：只允许运行 `acceptance_list`、`acceptance`，以及只读命令。

提交时，程序在这个工作区里运行 `acceptance_list -- <task>`；收集出错就拒绝提交。测试名必须带 AC 编号（`[REQ-012.AC2]`），程序通过静态扫描统计覆盖率。

### 9.3 争议通道

- worker 不能改测试。认为测试写错时，调用 `forge_dispute({ test, reason, evidence })`，`evidence` 必须引用规格或契约的具体位置。调用后本次运行结束，task 进入 `disputed`。
- 程序创建 `.at-n`，fork 上一个 test-author 的会话，交给它判断：修改测试（`dispute_fixed`）、引用出处维持原测试（`dispute_upheld`），或者因为规格本身矛盾而用 forge_block 交给用户。
- 交给用户时，main 并排列出双方的依据。用户执行 `/forge-decide <task> keep-test`（维持测试，worker 改实现）或 `/forge-decide <task> fix-test "<说明>"`（按说明改测试）。规格本身有问题时，同时发起规格修订（第 13.5 节）。
- 争议次数计入度量。超过 15% 的 task 发生争议时，说明规格写得含糊。

### 9.4 已完成 task 的验收测试被破坏

正当的契约追加（第 12.1 节）不应该破坏别的 task 的验收测试；如果破坏了，多半是那个测试断言了规格没规定的东西。处理方式：

- 预检或合并验证时，失败的测试属于**另一个** task 的验收目录：程序不计入当前 task 的失败，而是为那个 task 创建 `.at-n`，附上失败输出与相关的契约追加，fork 它的 test-author。
- 当前 task 回到 `awaiting_inputs`，等待那个 `.at-n` done。
- 单元测试被破坏时，沿用 pi-flow 的 test-adjust（只能修改已有测试，不能增删）。test-adjust 的路径范围**排除 `tests/acceptance/**`**。

### 9.5 单独合并的验收测试

impl 已经 done 的 `.at` / `.at-n`（S0 的 `.at`、覆盖率缺口、被契约追加破坏、变更请求引出的）没有 impl 的预检可以搭车，按下面的路径合并：

| 从 | 到 | 触发 | 条件或作用 |
|---|---|---|---|
| in_progress | checking | submit | 程序在集成分支 HEAD 的临时 worktree 中合入测试补丁，带资源运行 `acceptance -- <task>` |
| checking | queued_merge | precheck_pass | 测试在已有实现上通过：按普通 task 进入合并队列（合并时照常跑全量） |
| checking | done | precheck_fail_handoff | 测试在已有实现上失败：`.at-n` 以 report 结束，程序为原 impl task 创建 `.fx-n`，它的分支基于"集成分支 + 这批测试补丁"，附上失败输出。`.fx-n` 中的 worker 可以修实现，也可以对测试 forge_dispute（走第 9.3 节）；测试随 `.fx-n` 一起合并 |
| merging | done | precheck_fail_handoff | 合并验证失败，且失败的测试都在本 `.at` 自己的目录里：测试不合入，按预检失败的方式交给原 impl 的 `.fx-n` |
| merging | blocked | merge_blocked | 合并验证有测试在本 `.at` 的目录之外失败：这次合并只加了测试，说明集成分支本身已经坏了；`blocked_by = integration_broken`，列进"需要你处理"，不生成 `.fx-n` |

- S0 的 `.at` 自己的测试失败时同样生成 `S0` impl 的 `.fx-n`。
- 这条路径的预检失败与上述合并验证失败不计入任何 impl task 的计数。

## 10. 审查（reviewer）

### 10.1 什么时候审查

task 的 `review` 字段写了值时，以它为准。没写时，由程序推导：

1. 被至少 `escalation.critical_fanout` 个 task 硬依赖，或 `layers` 包含 `auth`、或 AC 涉及权限、计费、删除（plan 中由 architect 打上 `risk: high` 标记）→ `strong`；
2. 否则，size 在 `review.skip_sizes` 中，且没有追加契约 → `skip`；
3. 否则 → `auto`。

`review.per_task: false`（精简模式自动设置）时，不做逐任务审查，改为阶段末审查（第 7.6 节）。fix task 不做逐任务审查，由 stage-qa 的确认轮核对。

### 10.2 输入

- `git diff <base>..<head>`，不包括 `tests/acceptance/**`，直接附在提示里，最多 2 万字。
- 本 task 的 AC 原文、相关契约片段、`rules/<layer>.md` 及其审查清单、glossary。
- worker 填写的 `deviations`。
- **读取范围**：`read_paths` 排除 `.forge/**`；会话留档目录在仓库之外，guard 也会拦截。reviewer 读不到 notes、handoff 和会话记录。

### 10.3 输出

- `forge_review_report({ verdict, issues: [{ id, level, basis, file, location, problem, expected }] })`。
- `must` 的 `basis` 只能是 `rule:`、`ac:`、`contract:`、`defect:` 四种，格式不对的由程序降为 `suggest`。
- `suggest` 追加到 `docs/review/suggestions.md`，阶段签收时列给用户。
- 第二轮（`.rv-2`）只拿到上一轮的 must 清单，用 `forge_review_confirm` 回答；schema 里没有新增问题的字段。找回 `5100d6b^:src/core/stage-review.ts` 的机制。

## 11. 阶段验收

一个阶段的 impl task 全部 done 后（精简模式下还要先完成阶段审查）：

1. **确定性门禁（程序）。** 在集成分支 HEAD 的临时 worktree 中，带着第 4.1 节的资源，运行 `implementation_gate.auto` 列出的命令。
2. **覆盖率（程序）。** 扫描 AC 标签，生成"exit 中的 REQ → AC → 测试文件"矩阵，写入 `docs/qa/<阶段>.md`。有缺口时，为负责该 AC 的 task 创建 `.at-n`（"补充 AC 的测试"）。
3. **stage-qa（LLM）。** 用 `forge_service` 启动 `commands.serve`（HEAD 的服务管理，不需要后台 `&`），抽查权限；核对跨模块一致性、页面状态、测试是否形同虚设、exit 是否真正达成。用 `forge_qa_report` 提交，规则同 reviewer。第二轮 `forge_qa_confirm` 只确认。
4. **修复（第 11.3 节）。** 门禁失败、stage-qa 的 must 都会生成 fix task。修复合并后，重跑门禁与覆盖率，再由 stage-qa 做只确认的一轮。门禁修复最多两轮；stage-qa 最多 `qa.max_rounds` 轮。超出后，阶段转为 `needs_human`。
5. **人工签收。** main 汇总以下内容：演示方式、manual_checks、覆盖率矩阵、新增建议、耗时与成本。用户可以：
   - `/forge-approve`：进入下一阶段；
   - `/forge-reject "<意见>"`：阶段回到 active（事件 `stage_reopened`），main 把意见整理成规格修订（第 13.5 节），用户批准后由 architect 走变更请求，修改 task **新增在当前阶段**；它们完成后重新执行本阶段的门禁、覆盖率与 stage-qa，再次签收；
   - `/forge accept <阶段> --note "<说明>"`：在 `needs_human` 时人工放行，直接进入签收。

### 11.1 fix task 的规则

- **归属**：失败的文件按"最后一个 `writes` 覆盖了它并且已经 done 的 impl task"找到负责的 task。一个问题涉及几个 task 的文件时，拆成几个 fix task。（pi-flow 的 `gateFailed` 按角色分组，这里改成按 task 分组。）
- **派生方式**：`T-003.fx-n`，kind 为 `fix`，角色 worker，`writes` 是问题涉及的文件，fork 该 task 最后一次 worker 会话。
- **流水线**：没有新的 `.at`。问题本身是"验收测试缺失或形同虚设"时，交给 `.at-n`，而不是 fix。预检运行原 task 的验收目录与单元测试；不做逐任务审查；合并时跑全量。

## 12. 契约变更

### 12.1 什么算"追加"

程序对 YAML 契约做结构比较：解析新旧两版，逐路径比较。

| 允许（算追加） | 不允许（算修改，需要走变更请求） |
|---|---|
| 新增 path、新增 operation | 删除或改名任何已有内容 |
| 给已有 operation 新增响应状态码 | 修改已有字段的类型、格式、默认值 |
| 给响应 schema 新增**可选**字段 | 给请求新增**必填**字段；改动任何 `required` 数组 |
| 给请求 schema 新增**可选**字段 | 改动任何 `enum`（包括新增取值） |
| 新增 schema、新增错误码、新增 `modules/*.md` 中的函数小节 | 修改已有错误码的 http 状态或含义 |
| `data-model.yaml` 新增表、新增可空列 | 修改已有列；新增非空且没有默认值的列 |

这条规则记入 NOTES。

### 12.2 并行追加的合并

- 契约按模块拆文件（`paths/<模块>.yaml`、`components/<模块>.yaml`、`errors/<模块>.yaml`），worker 只能追加到**自己 task 的 module** 对应的文件；要追加到别的模块，走变更请求。
- OpenAPI 3.1 的 `paths` 不能整体引用另一个文件，所以新增接口时，worker 还要在根文件 `openapi.yaml` 的 `paths` 下**追加一条**引用：键是新路径，值只能是 `$ref: './paths/<自己的模块>.yaml#/...'`。程序在预检时核对根文件的改动只有这一种形式；对根文件 `components` 的任何改动都算修改（公共 schema 由 architect 在 P1 定好，模块自己的 schema 放 `components/<模块>.yaml`）。
- 根文件的 `paths` 与 `data-model.yaml` 仍然可能被并行追加。合并队列遇到 `docs/contracts/**` 的文本冲突时，先尝试**结构化三方合并**：双方都只是追加，并且新增的键互不相同，就自动合并；否则生成 merge-fix 交给当前 task。不再像 pi-flow 第 31 条那样一律转 blocked。

### 12.3 变更请求

- 修改已有契约时，调用 `forge_change_request({ what, why, impact })`（worker 或 main 都可以）。程序派 architect 起草修订（技能 change-request），用户批准后在一个事务里落地：
  - 未开始的 task：调整或取消；
  - 进行中的 task：做完后接一个修改 task；
  - 已完成的 task：新增修改 task；
  - 受影响的验收测试：创建 `.at-n`。
- 变更请求可以在当前阶段新增 task，可以新增或调整之后的 S 阶段（第 5 节）。

## 13. 主会话、命令与模式

### 13.1 main 的工具与读取

- 工具：`read`、`grep`、`find`、`ls`（读主工作区）、**`forge_read`**、`ask_user`、`forge_spec`、`forge_spec_amend`、`forge_status`、`forge_wait`、`forge_change_request`、`forge_resolve_timeout`、`forge_resolve_scope`、`notes`、`history`。
- **`forge_read({ path, ref?, offset?, limit? })`**：由程序从集成分支（默认）或指定的流程分支读取文件；`path` 是目录时列出目录。敏感文件规则照旧。这个工具解决了"main 读不到集成分支上的产物"的问题（pi-flow 第 172、173 条）。
- **入库**：`/forge-build` 开始时，程序（HEAD 的 `intake.ts`）把 PRD 与原型原件提交到集成分支的 `docs/spec/inputs/`，并把文件清单注入 P0 的第一轮提示。原型是图片时，`forge_read` 返回图片内容。
- 没有写文件和执行命令的工具；配置层面硬性检查。

### 13.2 命令

| 命令 | 作用 |
|---|---|
| `/forge-build --prd <文件> [--prototype <路径>]` | 新项目。原型可选，没有原型时 `screens.md` 由 main 根据 PRD 整理 |
| `/forge-build --feature --prd <文件> [--prototype <路径>]` | 在已有项目上加功能 |
| `/forge-fix "<问题>"` | 修复 |
| `/forge-status [--detail\|--cost\|--metrics]` | 状态 |
| `/forge-approve [<对象>]`、`/forge-reject [<对象>] "<意见>"` | 闸门。对象是 `stage:<id>`、`amend:<id>`、`change:<id>`；只有一个在等批准时可以省略，多个时程序列出清单并要求写明 |
| `/forge-decide <task> keep-test\|fix-test ["<说明>"]` | 裁决测试争议 |
| `/forge-add "<需求>"` | 中途追加需求：交给 main 整理成规格修订（第 13.5 节） |
| `/forge accept <task\|阶段> --note "<说明>"` | 人工放行：只用于审查轮数用尽的 task（→ queued_merge），或 `needs_human` 的阶段（→ 签收） |
| `/forge unblock <task> [--reset] ["<说明>"]`、`/forge gate` | 解除阻塞（预检、合并次数用尽的 task 只能用它）、重跑门禁 |
| `/forge-resume`、`/forge off`、`/forge rules`、`/forge budget`、`/forge models`、`/forge knowledge`、`/forge doctor`、`/forge init [--adopt]`、`/forge abort`、`/forge run`、`/forge-config` | 同 pi-flow |

### 13.3 feature 模式

- P0：`docs/spec/features/<名字>.md` 用同样的格式，包括三节：需求（REQ 编号接着已有的最大编号）、页面（新增页面或"对已有页面的改动"）、权限（新增或修改的矩阵行；修改的行在批准页单独列出）。spec-lint 和覆盖率把基线与所有 feature 文件合在一起处理。
- P1：只写增量契约和增量计划；`baseline` 中的符号必须在现有契约里找到。
- 已有项目没有 `docs/contracts/` 时，先运行 `/forge init --adopt`：architect 从现有代码反向生成本次涉及模块的边界契约，用户批准后作为基线。

### 13.4 fix 模式

沿用 pi-flow 的 `modes/fix.ts`：一个 worker 定位、修复并加回归测试 → 合并 → 由一个只读的 stage-qa 复现确认 → 修复日志。

### 13.5 规格修订（P0 批准之后）

- main 用 `forge_spec_amend({ content, reason })` 提交修订，写进 `docs/spec/features/<日期>-<序号>-<名字>.md`。三种写法：
  - 新增：`### REQ-031 …`，编号接着最大编号；
  - 整条替换：`### REQ-012（修订）…`，写出这条需求的完整新版本；AC 编号不变的视为同一条（内容可能变了），新编号视为新增，旧版有、新版没有的视为删除；
  - 整条删除：`### REQ-012（删除）`。
- **生效规格** = 基线文件，加上 `features/` 下的文件按文件名顺序依次叠加。spec-lint、覆盖率、DAG 都用生效规格；只有带"（修订）"或"（删除）"的标题可以与已有编号重复。
- 程序比较新旧两版，列出变化的 AC，并根据覆盖率映射找到受影响的 task 与验收测试；这份清单写在批准页上，也作为变更请求的输入。
- 修订需要用户 `/forge-approve`。批准后，涉及契约或计划的部分由程序自动发起变更请求交给 architect。
- 修改已分配给已开始或已完成 task 的 AC 时，修订里必须写明影响，批准后按变更请求处理（第 12.3 节）。
- architect 在 P1 及之后可以**追加** glossary 的条目，不能修改已有条目；修改走规格修订。

## 14. 角色、工具与权限

| 角色 | 读 | 写 | 工具 |
|---|---|---|---|
| main | 主工作区 `**`；`forge_read` 读集成分支 | 无 | 第 13.1 节 |
| architect | `**`（排除 `.forge/**`） | `docs/contracts/**`、`docs/arch/**`、`docs/plan/**`、`docs/rules-draft/**`、`AGENTS.md`；glossary 只能追加 | read、write、edit、codemode、serena_read、codegraph、`forge_propose_plan`、`forge_note`、`forge_submit` |
| worker | `**`（排除 `.forge/**`） | `writes` + `shared` + test-adjust（排除 `tests/acceptance/**`）；本模块的契约文件只能追加 | read、write、edit、`forge_service`、serena_read、serena_edit、codegraph、`forge_sync`、`forge_dispute`、`forge_change_request`、`forge_request_scope`、`forge_note`、`forge_submit` |
| test-author | 隔离工作区（第 9.2 节） | `tests/acceptance/<task>/**`、`tests/acceptance/_support/<task>/**` | read、write、edit、`forge_note`、`forge_submit` |
| reviewer | `**`（排除 `.forge/**`） | 无 | read、serena_read、codegraph、`forge_review_report`、`forge_review_confirm` |
| stage-qa | `**`（排除 `.forge/**`） | 无（临时目录除外） | read、`forge_service`、serena_read、codegraph、`forge_qa_report`、`forge_qa_confirm` |
| researcher | `**`（排除 `.forge/**`） | `docs/research/**` | 原样复用 |

bash 的有无和档位只由角色的 `bash:` 字段决定：architect、reviewer 为 readonly，worker、stage-qa 为 full，test-author 为 allowlist，main 和 researcher 没有 bash。

**`read_paths` 的写法**：按 gitignore 的规则，从上到下逐条匹配，**后面的覆盖前面的**；以 `!` 开头的是排除。例如 `["**", "!.forge/**"]` 表示除 `.forge/` 外都能读。guard 的 `matchesAny` 要改成这种有序匹配。

- 所有子进程角色隐式拥有 `forge_block`、`forge_learn`、`notes`、`history`；有 `forge_submit` 的角色隐式拥有 `forge_claim`。
- **扩大可写范围**（`forge_request_scope` → `forge_resolve_scope`）：沿用 HEAD 的做法，由 main 用 `forge_resolve_scope` 批准。HEAD 的其余规则保留：每个 task 同时只能有一份申请；每次最多 10 个路径；在角色可写范围内、且不与任何未完成 task 的 `writes`、`shared` 重叠的，程序直接批准；拒绝时必须写理由（写进 handoff）。pi-forge 另加：
  - **三类硬限制**，由程序检查、main 无法批准：`tests/acceptance/**`、`docs/spec/**`、别的模块的契约文件。
  - **与已开始的 task 重叠时直接拒绝**：申请的路径与任何已开始但还没 done 的 task（`in_progress`、`awaiting_inputs`、`checking`、`in_review`、`disputed`、`queued_merge`、`merging`）的 `writes` 或 `shared` 重叠时，程序直接拒绝，main 也批不了。只与 `pending`、`ready` 的 task 重叠的，可以由 main 批准，派发时的互斥检查会让它们排队。
  - 申请权限只给 worker（不再按"有可写范围且能提交"隐式授予 test-author、architect、researcher）。
- **`forge_service`**：
  - 授予在 config 里显式列出，只给 worker 和 stage-qa（不再按"有完整 bash"自动授予）。
  - 启动服务时注入本次运行分配的 `PORT`、`FORGE_PORT_BASE`、`FORGE_DB_NAME`、`FORGE_TMP`（第 4.1 节）。M4 实现。
  - 没有 worktree 的 task（例如 stage-qa），由程序在集成分支 HEAD 上建一个只读的临时 worktree 来跑服务，**绝不在主工作区启动**。M6 实现。

### 14.1 bash 的三档

| 档位 | 允许 |
|---|---|
| `full` | pi-flow 的 bash 规则 |
| `readonly` | pi-flow 的只读命令 |
| `allowlist` | 只读命令，加上 `workflow.yaml` 中角色 `bash_allow` 列出的命令（按 `commands` 的名字引用，前缀匹配） |

**角色的 `bash:` 字段是唯一依据**：写了 `bash:` 的角色由程序注册 bash 工具并按档位拦截；`tools` 里不再写 `bash` 或 `bash_readonly`。没写 `bash:` 的角色没有 bash。

guard 在 readonly 与 allowlist 档位下都拦截能读出其他提交内容的 git 子命令（`show`、`cat-file`、`log -p`、带版本参数的 `diff`、`grep <rev>`、`archive`）——给 test-author 用的是第二道防线，第一道是独立仓库。

### 14.2 技能注入

| 角色 | 场景 | 技能 |
|---|---|---|
| main | P0、规格修订 | spec-from-prd、grilling |
| architect | P1 | design-contract、plan-dag、domain-modeling、write-rules、write-handoff |
| architect | 变更请求、`--adopt` | change-request、design-contract、plan-dag |
| worker | impl、fix | tdd、write-handoff |
| test-author | acctest | acceptance-tests、write-handoff |
| reviewer | review | code-review、tdd |
| stage-qa | qa、fix 模式的复现确认 | stage-qa |

## 15. workflow.yaml

模板见 `templates/workflow.yaml`。相对 pi-flow 的新增项：

- `commands`：`acceptance`、`acceptance_list`、`e2e`、`contract_lint`、`contract_test`、`codegen`、`serve`。
- `implementation_gate`：S 阶段闸门的定义（`auto` 命令列表、`coverage`、`qa`、`human`）。
- `acctest_workspace`：`include`（额外导出的路径）与 `cache`（按锁文件哈希缓存的目录）。architect 在 `docs/rules-draft/commands.yaml` 的 `acctest_workspace` 键下起草，`rules-draft` 批准时连同 `commands`、`gui_commands` 一起应用。
- `commands.db_create`、`commands.db_drop`（可选，第 4.1 节）。
- `limits`：`max_parallel_aux`、`max_precheck_failures`、`max_merge_failures`、`lean_below_loc`、`port_block`。
- `review`：`per_task`、`max_rounds`、`skip_sizes`。
- `testing`：`adjust_tests`、`max_disputes`。
- `qa.max_rounds`。
- 角色的 `bash: full | readonly | allowlist` 与 `bash_allow`。

## 16. 复用地图

**M0 先拷贝整个 `src/` 与 `test/`，再在 M1 及以后逐个改编。** 原因是"原样拷贝"的文件在 import 上不封闭，只拷贝其中一部分跑不起来。下表说明每个文件**最终**怎么处理，以及取哪个提交。

| 处理方式 | 文件 | 基线 |
|---|---|---|
| **只改名** | scope、flow-watch、notify、timing、engine-lock、git、worktree、verify-runner、shell、strays、model-pause、role-settings、cost、cost-control、metrics、session-log、history、knowledge、dependencies、codegraph、core/launcher、release、doctor、agents、tool-common；HEAD 新增的 services、redact、lineage、checkpoints；pi-adapter 下的 launcher、memory、plugins、ports、pi-api.d.ts；commands/args、role-table；fake-llm、fake-subagent、crash-driver；scripts/baseline-build | HEAD |
| **小改** | intake（入库路径从 `docs/prd/`、`prototype/` 改为 `docs/spec/inputs/`）；migrations（pi-forge 的 `.forge` 格式版本从 1 开始，清空迁移步骤，保留迁移框架）；paths（`INTERFACES_PATH` → `CONTRACTS_PATH`；按角色和阶段的保护放进 guard，不放进全局保护列表）；run-budget（acctest、review、qa 减半；提醒文字）；notes（根据 AC 编号从规格查回原文，再填进笔记）；preflight（检查 `rules/<layer>.md`）；rules-draft（取 HEAD，含命令草案校验）；commands/flow-config（七个角色） | HEAD |
| **改编** | finish-report（→ 交付汇报）、schemas、config、state-store、state-machine、guard（read_paths 用于所有角色、bash allowlist、契约只能追加、`.forge/` 不可读）、dag、merge-queue（第一个合格、契约结构化合并）、scheduler（两个并发池；依赖判断改回"done 即可"）、resume（第 8.3 节）、subagent-runtime（契约追加、临时目录给 stage-qa、隔离工作区）、test-adjust（新 kind；排除 `tests/acceptance/**`）、dispatcher、context-injector、status-view、prompt-assembler（按 layers 选规则）、additions（`/forge-add` → 规格修订）、pi-adapter/extension 与 subagent、tools/*（新工具；module-tools 的 `flow_propose_modules` → `forge_propose_plan`）、commands/flow、init 与模板 | HEAD |
| **改编（流程层）** | modes/plan（P0、P1、动态 S 阶段）、stages、revision（→ 变更请求）、acceptance（→ stage-qa.ts，保留 gateFailed，改为按 task 分组）、final-review（→ 精简模式的阶段审查）、requirements（→ spec.ts）、gates（覆盖率）、modes/fix | 7006e7d |
| **从历史找回** | `5100d6b^:src/core/stage-review.ts`（清单、修复、只确认）；`5100d6b^:src/core/state-machine.ts`（review、precheck 转移） | — |
| **新写** | spec-lint、contract-check（结构化解析、追加判定、三方合并）、coverage、dispute、review、plan、acctest-workspace、resources（端口与数据库分配） | — |
| **M9 重写** | scripts/real-build.ts（流程写死了 D0、D2）；P0 的用户模拟脚本 | — |
| **M8 适配** | scripts/flow-view.*（阶段与角色） | — |
| **测试夹具** | `workflow-legacy.yaml`、`fixtures/agents/*`、`fake-llm/scripts/*` 在 M0 原样保留（只改名）；HEAD 的包内容（agents、skills、rules、templates/workflow.yaml、prompts）放进 `test/fixtures/pi-flow-package/`，测试改为引用它；随 M1 以后的改编逐步换成 v3 的内容 | HEAD |
| **删除** | planning.ts（由 `forge_propose_plan` 取代）；designer、acceptor 角色；原型阶段；write-prototype、plan-modules、write-requirements 技能；`docs/interfaces/` | — |

技能与角色提示：本包已给出全文，直接使用。

**task 的新字段**（schemas）：`module`、`ac`、`layers`、`produces`、`requires`、`test_interface`、`review`、`risk`、`for_task`、`deviations`、`precheck_failures`、`review_rounds`、`merge_failures`、`disputes`。新的 kind：`acctest`、`review`、`qa`、`fix`。**plan 的字段**：`size_estimate`、`mode`、`stages[].exit`、`baseline`。

## 17. 速度与质量的度量

`/forge-status --metrics` 和每次交付都输出以下指标：

- **速度**：每个阶段的**agent 时间**（墙钟时间减去等待人工的时间）与墙钟时间；每个 task 从派发到 done 的时间；排队等待时间；关键路径的实际用时与理论用时之比。
- **返工**：预检失败、审查打回、合并验证失败、争议、`.at-n`、门禁修复、stage-qa 修复的次数。
- **质量**：AC 覆盖率；验收测试数；stage-qa 的 must 数；交付后的 `/forge-fix` 次数。
- **成本**：沿用 `cost.ts`。

## 18. 里程碑

每个里程碑结束时，`npm run typecheck` 和 `npm test` 全部通过，然后汇报，**等我确认**。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 迁入运行时** | 拷贝 HEAD 的整个 `src/`、`test/`；HEAD 的包内容放进 `test/fixtures/pi-flow-package/`；7006e7d 的流程层与 `5100d6b^` 的两个文件放进 `legacy/`（不参与构建）；按明确的规则改名（产品名、`.flow` 目录、refs、环境变量、配置文件名、工具名、命令名、文件名），**领域名词 flow（FlowFile、flowId、flows/ 等）保留**；不 skip 测试，修掉通知测试的偶发失败（只改测试）；新建 NOTES.md；结束时做第一次 git 提交 | HEAD 的全部测试在新仓库通过；在用夹具模板初始化的临时项目里 `pi -e` 能加载、`/forge doctor` 能运行；汇报 HEAD 的 scope 与 service 的实际行为 |
| **M1 Schema 与状态机** | 第 8.1、9.5 节的状态与转移；分开的失败计数；新字段；plan 的 schema；动态 S 阶段的记录与事件；`.forge` 格式版本 1；config 改为解析 v3 模板（`bash:`、有序 read_paths、`implementation_gate`、`acctest_workspace`、新角色），夹具模板随之迁移 | 每条转移都有正例和反例；`done` 没有出边；不在表中的转移被拒绝 |
| **M2 P0 规格** | intake；`forge_read`；spec-lint；`forge_spec`、`forge_spec_amend`；main 的提示与技能注入；`/forge-build --prd [--prototype]` | spec-lint 每条规则都有正反用例；fake-llm 跑完 P0（main 用 `forge_read` 读到 PRD；不合格被拒 → 修正 → 批准）；修订流程走通 |
| **M3 P1 契约与计划** | contract-check（结构解析、符号核对）；plan；DAG 推导；覆盖检查；`forge_propose_plan`；批准时生成 S 阶段与派生 task、锁定契约、应用规则与命令 | 第 7.3 节每类错误都有测试；软依赖与硬依赖正确；S0 多于一个 task 时报错；S0 的 `.at` 在 impl 之后 |
| **M4 流水线一** | 资源分配与回收（第 4.1 节）；acctest 隔离工作区（导出基准、install 后 codegen、缓存）；第 9.5 节的单独合并；bash allowlist；impl 与 `.at` 并行；`awaiting_inputs`（含软依赖与同步）；预检；争议与 `/forge-decide`；第 9.4 节 | e2e：隔离工作区里 `git show <实现提交>` 失败，读取绝对路径被拦截；`_support/` 的修改被拒；两个并行预检的端口不冲突；软依赖的消费方在生产方 done 前停在 awaiting_inputs；争议的三种结果都正确；别的 task 的验收测试被破坏时生成 `.at-n`；`forge_service` 启动的服务拿到本次运行分配的 `PORT`、`FORGE_DB_NAME` 等变量；范围申请与已开始的 task 重叠时被拒绝、只与 pending/ready 重叠时可以批准；M1 的临时直通预检代码已删除 |
| **M5 流水线二** | reviewer 的输入组装；`review` 的推导；report 与 confirm；出处校验与降级；合并队列选第一个合格的 task；契约追加判定与结构化三方合并 | e2e：第二轮不能新增问题；没有出处的 must 被降级；队首不合格时后面的 task 能先合并；两个 task 并行追加契约自动合并；修改已有契约被拒 |
| **M6 阶段验收与交付** | 门禁；覆盖率矩阵；`forge_service` 与 stage-qa；fix task（按 task 分组）；精简模式的阶段审查；`/forge accept`；交付 | e2e：覆盖缺口生成 `.at-n`；stage-qa 的 must 生成 fix 并走流水线；超出轮数后进入 needs_human，可以用 accept 放行；没有 worktree 的 stage-qa 用 `forge_service` 启动服务时，服务运行在集成分支 HEAD 的临时 worktree 里，主工作区没有任何进程和文件改动 |
| **M7 变更与模式** | `forge_change_request`；`/forge-add` → 规格修订；feature 模式与增量规格；`/forge init --adopt`；fix 模式 | e2e：变更请求批准后任务图、S 阶段与 `.at-n` 都正确更新 |
| **M8 观测与文档** | `/forge-status` 与 `--metrics`（agent 时间）；flow-view；README、NOTES、流程图 | 状态视图的快照测试 |
| **M9 真实模型验证** | P0 用户模拟脚本（对每个问题都回答"按推荐"，记录问题数）；重写 real-build；① 看板（无原型，`--prototype` 省略）新建 + 变更；② Homebox R1–R4（feature）；③ 用户自己的项目 | 通过条件（开跑前定下，不改）：①② 的隐藏测试不低于原生、0 回归；**精简模式的 agent 时间不超过原生的 3 倍**（与 pi-flow BENCHMARK-5 的"超过 3 倍只算质量更好但太慢"一致）；标准模式只记录、不设门槛；③ 由用户定性评估 |

## 19. 风险与待定

- **隔离工作区能否安装依赖**：monorepo 的子包清单通过 `acctest_workspace.include` 导出；S0 的完成标准包含这一项。仍然装不起来的项目，降级为 git worktree 加 guard 拦截，并在 NOTES 中记录"隔离降级"。
- **争议率**：超过 15% 时，先把 test-author 换成 strong 模型，再改进 spec-from-prd。
- **验收测试依赖外部服务**：由 S0 提供测试替身，或在 `serve` 中启动容器；做不到时降级为只跑接口层测试，并在报告中注明。
- **3 倍目标**：P0 对话、S0 和阶段签收都是固定开销。达不到时，先看时间花在哪里（第 17 节），再决定是否进一步精简，不要事后放宽门槛。

## 20. 词汇表（实现中统一用这些名字）

`.at` / `.at-n`：派生的验收测试 task；`.rv` / `.rv-2`：审查；`.fx-n`：修复；impl：worker 的主 task；软依赖：`~` 前缀；agent 时间：墙钟时间减去等待人工的时间；needs_human：阶段级的待人工状态（task 级用 blocked）。两者都列在"需要你处理"中。

## 21. 修订记录

v3.1（M0 汇报之后）：

- 第 14 节表格的"工具"列去掉 bash 字样；表格下注明 bash 的有无和档位只由 `bash:` 字段决定（architect、reviewer 为 readonly，worker、stage-qa 为 full，test-author 为 allowlist，main、researcher 没有）。
- 第 14 节"加两条硬限制"改为"三类硬限制"。
- 第 14 节 test-author 的可写范围改为 `tests/acceptance/<task>/**`、`tests/acceptance/_support/<task>/**`。
- 第 8.2 节第 3 步加上 S0 impl 的例外（`_support/**`、`S0-smoke/**`）。
- 第 14 节：扩大可写范围与已开始的 task 重叠时直接拒绝，只与 pending、ready 重叠的可以批准；申请权限只给 worker；HEAD 的其余规则保留。
- 第 14 节：`forge_service` 在 config 里显式授予 worker、stage-qa；启动时注入第 4.1 节的资源变量（M4）；没有 worktree 的 task 在集成分支 HEAD 的只读临时 worktree 中启动服务，绝不在主工作区（M6）。M4、M6 的验收加上对应测试。

v3（第二次核对之后，逐条决定见 `DECISIONS-R2.md`）：

- S0 的 worker 可以写 `_support/` 与 `S0-smoke/`（唯一例外，冒烟测试不计入覆盖率）。
- 新增第 9.5 节：impl 已 done 时验收测试的单独合并；失败时生成 `.fx-n`，测试随修复一起合并。
- OpenAPI：worker 在根文件 `paths` 下只能追加一种形式的 `$ref`；模块 schema 放 `components/<模块>.yaml`。
- `.at-n` 的导出基准：集成分支 + `acc/<task>` + 任务分支的契约改动；隔离工作区先 install 后 codegen，带缓存。
- `_support/` 只能在本 task 子目录下新建，消除撞名。
- 签收打回：阶段回到 active，修改 task 新增在当前阶段；变更请求可以在当前阶段新增 task。
- 规格修订的"（修订）""（删除）"写法与"生效规格"。
- `/forge-approve`、`/forge-reject` 带对象参数。
- `/forge-decide`、`/forge accept`、`/forge unblock --reset` 的转移拆开写明。
- 扩大可写范围沿用 HEAD（main 批准），加三类硬限制；收窄 `forge_service`、`forge_request_scope` 的隐式授予。
- `bash:` 字段是唯一依据；`read_paths` 按 gitignore 的有序规则匹配。
- `acctest_workspace` 由 architect 在命令草案里起草，批准时应用。
- 资源登记、回收与服务器类数据库的建库、删库。
- 第 16 节补全 HEAD 新增文件的归类；`.forge` 格式版本从 1 开始。
- M0：不 skip 测试，打包内容进夹具，保留领域名词 flow，结束时提交 git。

v2（第一次核对之后，逐条决定见 `DECISIONS-R1.md`）：

- 基线改为两层（第 1 节）；M0 拷贝整个 src。
- 新增 `forge_read`、PRD 入库（第 13.1 节）。
- 软依赖：预检等生产方 done，并且先同步（`awaiting_inputs`）。
- test-author 改用独立仓库（第 9.2 节）；bash 白名单。
- S0 的 `.at` 在 impl 之后。
- 契约按模块拆文件，并做结构化三方合并（第 12.2 节）。
- 端口与数据库隔离（第 4.1 节）。
- `done` 不再重新打开，改为派生 task。
- 定义争议期间的状态与 `/forge-decide` 的用词。
- 失败计数分开。
- 合并队列选第一个合格的 task。
- S 阶段动态生成，闸门由 `implementation_gate` 定义。
- 规格修订（第 13.5 节）；glossary 只能追加。
- 验收测试被破坏时生成 `.at-n`（第 9.4 节）。
- reviewer 等角色读不到 `.forge/`；test-author 只导出必要的文档。
- 定义 fix task 的规则（第 11.1 节）。
- 补全精简模式的细节。
- M9 改为 3 倍、只算 agent 时间，增加用户模拟脚本，原型改为可选。
- 不新增 OpenAPI 依赖。
- 明确"追加"的判定规则（第 12.1 节）。
- 补全 task 与 plan 的新字段。
- 明确 `review` 的推导规则与 `critical_fanout` 的边界（大于等于）。
- 重新定义 `/forge accept`。
- 补全 feature 模式的增量规格。
- main 的工具补上 notes、history；采用 HEAD 的 scope 工具与 `forge_service`。
- 修正 pi-flow 的路径。

v3.2（M1 计划评审后的决定）：

- 第 5 节：交付不做独立阶段，`phases` 为 `spec`、`plan`、`implementation`；用户批准最后一个 S 阶段的签收时，程序将集成分支 `--no-ff` 合入主分支，交付汇报作为这次签收的汇总内容（M6 实现）。
- 第 5 节：补阶段的 `needs_human` 转移；门禁用尽后待人工，用户可以 accept 进入签收、用 `/forge gate` 重跑门禁，或 `/forge-reject` 打回 active；签收时打回也回到 active，两种打回都记 `stage_reopened` 事件。
- 第 8.1 节：新增 `checking → awaiting_inputs`、`merging → awaiting_inputs`，触发 `foreign_tests_broken`，不计入当前 task 的任何计数。
- 第 8.1 节：新增 `blocked_by`，取值为 `dispute`、`review_exhausted`、`precheck_exhausted`、`merge_exhausted`、`attempts`、`agent`、`dispatcher`、`user`、`integration_broken`；`decide_*` 仅接受 `dispute`，`accept` 仅接受 `review_exhausted`。
- 第 8.1 节：unblock 分两种，已开工的回到 `in_progress` 并保留 worktree，没开工的回到 `ready`。
- 第 8.1 节：doc 与 impl 一样走 `awaiting_inputs → checking`，等待条件自然满足，M3 接入契约检查与计划校验。
- 第 18 节：M4 的验收加一条"M1 的临时直通预检代码已删除"。
- 第 9.5 节：单独合并的验收测试在合并验证时失败，若失败的测试都在本 `.at` 目录里，走 `merging → done（precheck_fail_handoff）`，测试不合入，交给 `.fx-n`；若有测试在本目录之外失败，走 `merge_blocked`，`blocked_by = integration_broken`，列进"需要你处理"，不生成 `.fx-n`。
