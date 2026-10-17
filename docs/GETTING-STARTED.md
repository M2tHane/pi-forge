# 快速入门：读懂 pi-forge

写给第一次接触这个项目的人。前半部分讲 pi-forge 是什么、里面有哪些东西；后半部分带你读代码：一个任务从派发到交付，经过哪些文件、哪些函数。

完整的命令与配置参考看 [README.md](../README.md)，状态图看 [flow.md](flow.md)，"为什么这样设计"看 [NOTES.md](../NOTES.md)。

---

## 第一部分：整体印象

### 1. pi-forge 是什么

pi-forge 是 Pi（`@earendil-works/pi-coding-agent`，一个终端里的编程 agent）的插件。它把"让 AI 写一个项目"变成一条有分工、有检查的流水线：

```
你在流程外写好 docs/PRD.md、做好可点击原型 docs/prototype/
  → architect 定技术栈、骨架、公共代码、domain 划分、契约与批次计划，你批准   【架构】
  → 每个批次：后端按 domain 并行开发，一个前端 agent 按页面顺序开发           【开发】
      每个任务：写代码和验收测试 → reviewer 审查 → 程序合并
      每个批次末：前端接上真实接口 → 门禁 → stage-qa 浏览器验收 → 你签收
  → 最后一批签收后合入主分支                                                【交付】
```

一个 Pi 会话也能写代码，pi-forge 多做了三件事：

- **并行**：几个后端 agent 同时写不同的 domain，各用各的 worktree，互不干扰；前端只有一个 agent，页面之间接着同一个会话做，风格一致。
- **检查**：每个任务有人审查，每次合并后跑回归测试，每个批次有门禁和浏览器验收，不是写完就算。
- **可控**：任务状态由程序管，agent 不能自己改；agent 被限制在自己的工作区里，越界的操作会被拦下。

适合从头做一个有前后端、有一定规模的项目。只想改一两处，用 `/forge-change`（小改动）或 `/forge-fix`（修缺陷），它们走更短的流程。

### 2. 必须知道的词

| 词 | 意思 |
|---|---|
| **流程（flow）** | 一次完整的工作，例如"做一个进销存应用"。编号 `B-001`（新项目）、`X-001`（修复）、`C-001`（小改动）。 |
| **阶段（stage）** | 流程分成几段：S0 架构，S1…Sn 是 `docs/plan.md` 里的批次。界面上只显示三个高层阶段：架构 → 开发 → 交付。 |
| **task** | 一个工作单元，编号 `T-001`。派生的有 `T-001.rv`（审查）、`T-001.fx-1`（修复）、`S1.qa`（批次验收）。 |
| **PRD** | `docs/PRD.md`，用户写的需求文档。程序只解析三样东西：需求编号 `REQ-001`、验收标准 `- AC1 …`（组成 `REQ-001.AC1`）、「页面」表。它是需求的唯一依据，agent 不能改。 |
| **原型** | `docs/prototype/` 下可点击的 HTML。前端按它实现，审查与浏览器验收按它核对。 |
| **domain** | 后端的一块业务（例如商品、库存），职责、拥有的表与对外接口写在 `docs/arch/domains.md`。一个 domain 一个后端任务；domain 之间只经架构师定好的接口调用。 |
| **契约（contract）** | `docs/contracts/openapi.yaml`（前后端之间的 HTTP 接口）与 `page-api.md`（每个页面用哪些接口）。前后端靠它并行开发；只有 architect 能改，开发 agent 要改时用 `forge_ask_architect` 提问。 |
| **集成分支** | `flow/<流程>/integration`。各任务先合到这里，架构批准与最后交付时再合入主分支。 |
| **worktree** | 工作区副本。每个任务有自己的 worktree（在 `<项目>.worktrees/` 下），agent 只在里面工作。 |
| **handoff** | 任务的交接记录：agent 写下做了什么、遇到什么，程序写下审查意见、失败原因、架构师的回答。下一个接手的人先读它。 |
| **`.forge/`** | 项目里的状态目录：流程、任务、运行记录、事件日志。**只有程序能写**。 |
| **门禁（gate）** | 批次末的确定性检查：全量测试、验收测试、架构检查、契约比对；AC 覆盖率只出报告。 |

### 3. 角色

| 角色 | 做什么 | 定义在 |
|---|---|---|
| orchestrator（主会话） | 汇报进度、提醒你批准或签收；程序遇到需要拿主意的事先问它；技术问题交给架构师 | `agents/orchestrator.md` |
| architect | 架构阶段的全部产出；之后回答技术问题、修改公共内容与契约、修归属不清的问题 | `agents/architect.md` |
| backend | 一个 domain 的整条后端链路 | `agents/backend.md` |
| frontend | 前端基础、全部页面、每批的接入真实接口 | `agents/frontend.md` |
| reviewer | 审查架构产出、每个 domain、每个页面，运行这个任务的测试 | `agents/reviewer.md` |
| stage-qa | 每批的浏览器验收 | `agents/stage-qa.md` |
| worker | 只给修复与小改动两个轻流程用 | `agents/worker.md` |

除了 orchestrator，其他角色都在 Pi 子进程里运行，由程序派发。哪个角色用什么模型，用 `/forge-config` 设置。

### 4. 你会在哪些地方出手

- **流程开始前**：写 PRD、做原型，自己点一遍。`/forge init` 会在 `docs/examples/` 放一份示例 PRD 与原型供参考（不提交），并执行 `codegraph init -y` 建立代码索引（没装 codegraph 时只提示）。
- **批准架构**：看批准页（计划说明、风险与假设、各项提醒），`/forge-approve` 或 `/forge-reject "<意见>"`。
- **每批签收**：浏览器验收通过后，看 `/forge report`，`/forge-approve` 签收或打回。
- **主会话转交给你的事**：程序遇到需要拿主意的情况（任务阻塞、门禁修复轮数用尽），先交给主会话决定，它解决不了才转给你。

其余的都由程序推进。`/forge-status` 会列出"需要你处理"的事。

---

## 第二部分：读懂代码

### 5. 三条设计原则

读代码之前先记住这三条，很多看起来绕的地方都是为了它们：

1. **状态只由程序写。** agent 不能直接改 `.forge/`，只能调用 `forge_*` 工具提交申请（如 `forge_submit`），程序校验后才改状态。所有状态变化都走一张转移表，不在表里的一律拒绝。
2. **能用程序判断的，不交给模型。** PRD 解析、plan.md 的批次校验、AC 覆盖率、合并冲突、回归定位到哪个任务、问题归属，都是程序算的纯函数，并且有单元测试。
3. **默认放权，只拦禁止列表。** 开发 agent 在自己的 worktree 里可以读、写、执行；guard 在每次工具调用前只拦受保护路径和少数危险命令，只读角色拿不到写工具。加一条拦截之前要先说出它防住了哪次真实发生过的事。

### 6. 目录地图

```
src/
  core/          业务逻辑，不依赖 Pi（可以单独测试）
  pi-adapter/    唯一调用 Pi API 的地方：注册命令和工具、启动子进程、guard 挂钩
  tools/         forge_* 工具的实现（子进程用的在 subagent-tools.ts，主会话用的在 orchestrator-tools.ts）
  commands/      斜杠命令的实现（/forge、/forge-config）
  modes/         修复与小改动的轻流程
agents/          各角色的系统提示
skills/          角色按需加载的技能说明（写契约、拆批次、写验收测试、审查……）
rules/           通用规则；项目自己的 rules/backend.md、rules/frontend.md 由架构阶段写
templates/       新项目的 workflow.yaml、AGENTS.md、PRD 模板
schemas/         .forge/ 里各类文件的 JSON Schema（由 schemas.ts 生成）
test/            unit/（纯函数与用 git 的单元测试）、e2e/（用假子进程跑完整流程）
```

`src/core/` 按层分目录，**下层不能 import 上层**（`test/unit/core-layers.test.ts` 检查）。从下往上：

| 层 | 目录 | 放什么 |
|---|---|---|
| 1 | `state/` | `.forge/` 的读写（`state-store.ts` 是唯一入口）、转移表（`state-machine.ts`）、schemas、配置 |
| 2 | `security/`、`workspace/` | guard（命令与路径校验）；worktree、依赖准备、命令运行、端口与数据库分配 |
| 3 | `verify/`、`insight/` | 验证结果缓存；成本、预算、模型升级与兜底、停滞检测 |
| 4 | `spec/` | PRD 的解析与检查（`prd.ts`）、启动前检查、PRD 与原型入库 |
| 5 | `acceptance/` | 验收测试、覆盖率、修复任务的生成与归属 |
| 6 | `plan/` | 架构阶段的提交检查与批准、plan.md 的批次解析与任务生成（`batches.ts`）、只追加的自动合并 |
| 7 | `stage/` | 审查、批次门禁、stage-qa、签收 |
| 8 | `engine/` | 引擎：派发、子进程、提示组装、合并队列、合并后回归测试、主会话裁决 |
| 9 | `ops/` | 状态视图、恢复、doctor 等 |

分层的好处：改 `state/` 时只要担心它本身，上面的层不会反过来牵连它。

### 7. 跟一个任务走一遍

下面按时间顺序，列出一个开发任务（例如某个 domain 的后端任务）经过的代码。括号里是文件和函数，可以照着点进去看。

**① 生成**（`core/plan/batches.ts`：`deriveBatchTasks`）

- 你批准架构阶段时，程序读 `docs/plan.md` 最后一节的 yaml，为每个批次生成阶段与任务：每个 domain 一个后端任务、第 1 批的前端基础、按顺序串起来的页面任务、每批一个接入真实接口的任务。

**② 派发**（`core/engine/dispatcher.ts`：`Engine.next` → `dispatch`）

- `selectDispatchable`（`engine/scheduler.ts`）从 ready 的任务里挑出要派的：后端、前端（固定 1 个）、辅助（审查、验收、咨询）各有名额。
- `planModel` 决定用哪个模型：平时用角色的模型；失败多次换升级模型；原模型被暂停（服务中断）或升级后还是失败，换兜底模型。
- `createTaskWorktree` 建 worktree，`prepareDeps` 准备依赖（有共享构建环境时直接链接）。
- 状态 `ready → in_progress`：`store.transitionTask` 调用 `planTransition`（`state/state-machine.ts`）检查转移是否合法。
- `buildSpec` 组装子进程的参数，提示由 `assemblePrompt`（`engine/prompt-assembler.ts`）拼出：角色提示 + 规则 + 技能 + 任务说明 + handoff。前端任务接着同一批上一个前端任务的会话（`fork_from_task`）。
- `launcher.launch` 启动 Pi 子进程（真实实现在 `pi-adapter/launcher.ts`，测试用 `test/fixtures/fake-subagent/`）。

**③ 子进程里干活**（`pi-adapter/subagent.ts`）

- 子进程加载这个扩展，它注册 `forge_*` 工具，并在每次工具调用前调用 guard。
- guard（`core/security/guard.ts`：`enforceToolCall` → `checkToolCall`）检查工具白名单、写路径、受保护路径、敏感文件（读取不限范围）；bash 命令先解析（`security/shell.ts`），开发角色按禁止列表拦（判断不了的放行），只读角色按允许列表放。拦下的只记账，不结束运行。
- 遇到技术问题，agent 调用 `forge_ask_architect`：任务暂停，程序派一个咨询任务给 architect，回答写进 handoff 后任务接着原会话继续。
- 写完代码，agent 调用 `forge_note` 写 handoff，再调用 `forge_submit`（`tools/subagent-tools.ts`：`flowSubmit`）。程序校验 token、算出 diff、检查受保护路径。

**④ 子进程结束**（`dispatcher.ts`：`onExit`）

- 正常提交：状态已经变了。
- 没提交就结束：`classifyRunFailure`（`engine/failure-class.ts`）按错误原文分类——额度用完、限流、配置错误就暂停这个模型（`engine/model-pause.ts`），不算任务失败；其余计一次失败，下次重试。

**⑤ 同步与审查**（`core/stage/review-flow.ts`：`resolveReviews`、`decideReview`）

- 提交后程序把集成分支同步进任务分支，有冲突就交回原 agent。
- 程序建一个 `T-001.rv`，派给 reviewer。reviewer 在同一个 worktree 里只读，运行这个任务的测试，用 `forge_review_report` 交结论。
- 有必须改的问题：回到原 agent；第二轮 `.rv-2` 只确认上一轮的问题。没问题：进入合并队列。

**⑥ 合并**（`core/engine/merge-queue.ts`：`processNext` → `merge`）

- 串行合并：把任务分支 squash 成一个提交，rebase 到集成分支最新提交，检查冲突标记，快进集成分支（不跑命令；合入后在后台跑一次回归测试）。
- 冲突："双方都只追加"的文件由程序三方合并；合不了的交回原 agent。

**⑦ 合并后回归测试**（`core/engine/post-merge-test.ts`：`PostMergeTester.schedule` → `checkIntegration`）

- 每次合并后，在后台对集成分支最新提交跑一遍门禁命令。
- 变红：同一提交重跑一次排除不稳定的测试；仍然红，就在"上一次通过"之后的合并里二分（`firstFailing`），找到第一个变红的合并，给它对应的任务建修复任务 `.fx-n`（`acceptance/stage-fix.ts`：`createStageFixTasks`）。

**⑧ 批次验收**（`core/stage/stage-acceptance.ts`：`stageStep`）

- 本批的任务都结束后，阶段转 `awaiting_gate`，跑门禁（`stage/gates.ts`：`runImplementationChecks`）和 AC 覆盖率。同一棵代码树上已经通过的命令直接沿用（`verify/verify-cache.ts`）。
- 门禁通过后派 stage-qa 在浏览器里验收；有问题就按归属建修复，修完再确认。
- 都通过了等你签收；轮数用尽则 `needs_human`，先交给主会话决定（`engine/decisions.ts`）。

**⑨ 阻塞了怎么办**（`core/engine/decisions.ts`）

- 程序或子进程造成的阻塞，任务带上 `blocked_owner: orchestrator`（在 `state-machine.ts` 的 `blocked()` 里设置）。"等架构师"的阻塞不交给主会话。
- 主会话用 `forge_decide` 决定：retry 重做、accept 放行，或转交用户。同一个任务最多由它决定 2 次。

看完这一遍，可以对照 [flow.md](flow.md) 里的状态图再过一次。

### 8. 建议的阅读顺序

1. `src/core/state/schemas.ts`：先看 `TaskFile`、`FlowFile`，知道状态里有什么字段。
2. `src/core/state/state-machine.ts`：`TRANSITIONS` 转移表，所有状态变化的规则都在这里。
3. `src/core/engine/dispatcher.ts`：引擎，从 `pump` 和 `dispatch` 读起。
4. `src/tools/subagent-tools.ts`：子进程能调用的工具，看 `flowSubmit`。
5. `src/core/security/guard.ts`：读开头的禁止列表注释和 `BashChecker.checkCommand`。

再往下按兴趣读：合并（`merge-queue.ts`）、批次验收（`stage-acceptance.ts`）、架构阶段与批次（`plan/plan-flow.ts`、`plan/batches.ts`）。

### 9. 改代码

开发约定（测试命令、分层、注释、缓存提醒、Pi API 的用法）以仓库根目录的 `CLAUDE.md` 为准，这里只列最常用的：

- `npm run typecheck`；`npm run test:fast`（纯函数，1 秒左右，后面加文件路径只跑这些文件）；`npm run test:slow`（用到 git 的单元测试）；`npm run test:e2e`（假子进程跑完整流程，约 25 分钟）。
- 测试不调用真实模型：e2e 用 `test/fixtures/fake-subagent/` 模拟子进程，脚本里直接写"调用哪个工具、传什么参数"。
- TypeScript 只用可擦除的语法：不用 enum、namespace、构造函数参数属性。
- 改 `agents/`、`skills/`、`rules/` 会让提示缓存失效一次，要在 NOTES.md 的"缓存提醒"里记一笔。
- 改 `schemas.ts` 之后运行 `npm run gen:schemas`。

### 10. 接下来读什么

- [README.md](../README.md)：所有命令、`workflow.yaml` 的配置项。
- [docs/flow.md](flow.md)：任务状态机、批次验收、架构师问答的状态图。
- [NOTES.md](../NOTES.md)：每个设计决定的原因，以及真实模型实验的结论。
