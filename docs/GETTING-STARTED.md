# 快速入门：读懂 pi-forge

写给第一次接触这个项目的人。前半部分讲 pi-forge 是什么、里面有哪些东西；后半部分带你读代码：一个任务从派发到交付，经过哪些文件、哪些函数。

完整的命令与配置参考看 [README.md](../README.md)，状态图看 [flow.md](flow.md)，"为什么这样设计"看 [NOTES.md](../NOTES.md)。

---

## 第一部分：整体印象

### 1. pi-forge 是什么

pi-forge 是 Pi（`@earendil-works/pi-coding-agent`，一个终端里的编程 agent）的插件。它把"让 AI 写一个项目"变成一条有分工、有检查的流水线：

```
你提需求
  → 主会话（orchestrator）和你讨论，整理成规格             【规格】
  → architect 定边界契约，把工作拆成可以并行的 task          【契约与计划】
  → 多个 worker 各自在独立的 git worktree 里并行实现          【实施】
      每个 task：worker 写代码和验收测试 → reviewer 审查 → 程序合并
      每个阶段末：全量检查 → stage-qa 验收 → 你签收
  → 合入主分支                                              【交付】
```

一个 Pi 会话也能写代码，pi-forge 多做了三件事：

- **并行**：几个 worker 同时写不同的 task，各用各的 worktree，互不干扰。
- **检查**：每个 task 有人审查，每次合并后跑回归测试，每个阶段有门禁和验收，不是写完就算。
- **可控**：任务状态由程序管，agent 不能自己改；agent 被限制在自己的工作区里，越界的操作会被拦下。

适合从头做一个有一定规模的项目。只想改一两处，用 `/forge-change`（小改动）或 `/forge-fix`（修缺陷），它们走更短的流程。

### 2. 必须知道的词

| 词 | 意思 |
|---|---|
| **流程（flow）** | 一次完整的工作，例如"做一个看板应用"。编号 `B-001`（新项目）、`X-001`（修复）、`C-001`（小改动）。 |
| **阶段（stage）** | 流程分成几段：P0 规格、P1 契约与计划、S0 骨架、S1…Sn 实施。界面上只显示四个高层阶段：规格 → 契约与计划 → 实施 → 交付。 |
| **task** | 一个工作单元，编号 `T-001`。派生的有 `T-001.rv`（审查）、`T-001.fx-1`（修复）、`S1.qa`（阶段验收）。 |
| **规格（spec）** | `docs/spec/` 下的四份文档：需求（带编号的验收标准，如 `REQ-001.AC1`）、页面、权限、术语表。P0 结束后就不再改。 |
| **契约（contract）** | `docs/contracts/` 下 task 之间的边界：几个 task 共用的数据、公共错误码、被别的 task 调用的函数与接口。模块自己的行为以规格为准，不重复写进契约。并行的 worker 靠它对齐。实施中只能追加，要修改已有内容得走变更请求。 |
| **集成分支** | `flow/<流程>/integration`。各 task 先合到这里，整个流程交付时再合入主分支。 |
| **worktree** | git 的工作区副本。每个 task 有自己的 worktree（在 `<项目>.worktrees/` 下），worker 只在里面工作。 |
| **handoff** | task 的交接记录：worker 写下做了什么、遇到什么，程序写下审查意见、失败原因。下一个接手的人先读它。 |
| **`.forge/`** | 项目里的状态目录：流程、task、运行记录、事件日志。**只有程序能写**。 |
| **门禁（gate）** | 阶段末的确定性检查：全量测试、验收测试；AC 覆盖率只出报告。 |

### 3. 角色

| 角色 | 做什么 | 定义在 |
|---|---|---|
| orchestrator（主会话） | 和你对话、整理规格、汇报进度；程序遇到需要拿主意的事（阻塞、修订审核）先问它 | `agents/orchestrator.md` |
| architect | 写契约与计划；S0 搭项目骨架、写项目规则 | `agents/architect.md` |
| worker | 实现 task，写验收测试 | `agents/worker.md` |
| reviewer | 审查 task 的 diff，运行这个 task 的测试 | `agents/reviewer.md` |
| stage-qa | 阶段末的整体验收 | `agents/stage-qa.md` |

除了 orchestrator，其他角色都在 Pi 子进程里运行，由程序派发。哪个角色用什么模型，用 `/forge-config` 设置。

### 4. 你会在哪些地方出手

你只在少数几个点上做决定：

- **批准规格**（P0）和**批准计划**（P1）。
- **阶段签收**：每个 S 阶段结束、最后交付时。
- **主会话转交给你的事**：程序遇到需要拿主意的情况（task 阻塞、门禁修复轮数用尽、变更请求的修订），先交给主会话决定，它解决不了才转给你。

其余的都由程序推进。`/forge-status` 会列出"需要你处理"的事。

---

## 第二部分：读懂代码

### 5. 三条设计原则

读代码之前先记住这三条，很多看起来绕的地方都是为了它们：

1. **状态只由程序写。** agent 不能直接改 `.forge/`，只能调用 `forge_*` 工具提交申请（如 `forge_submit`），程序校验后才改状态。所有状态变化都走一张转移表，不在表里的一律拒绝。
2. **能用程序判断的，不交给模型。** 规格格式、契约是否只做了追加、计划的依赖图、AC 覆盖率、合并冲突、回归定位到哪个 task，都是程序算的纯函数，并且有单元测试。
3. **约束靠拿掉能力，不靠提示词。** 只读角色根本拿不到写工具；guard 在每次工具调用前检查路径和命令。提示词只负责告诉模型怎么做好，不负责防止它做坏。

### 6. 目录地图

```
src/
  core/          业务逻辑，不依赖 Pi（可以单独测试）
  pi-adapter/    唯一调用 Pi API 的地方：注册命令和工具、启动子进程、guard 挂钩
  tools/         forge_* 工具的实现（子进程用的在 subagent-tools.ts，主会话用的在 orchestrator-tools.ts）
  commands/      斜杠命令的实现（/forge、/forge-config）
  modes/         修复与小改动的轻流程
agents/          各角色的系统提示
skills/          角色按需加载的技能说明（写规格、拆计划、审查……）
rules/           通用规则；项目自己的规则由 S0 写进项目的 rules/
templates/       新项目的 workflow.yaml 模板
schemas/         .forge/ 里各类文件的 JSON Schema（由 schemas.ts 生成）
test/            unit/（纯函数与用 git 的单元测试）、e2e/（用假子进程跑完整流程）
```

`src/core/` 按层分目录，**下层不能 import 上层**（`test/unit/core-layers.test.ts` 检查）。从下往上：

| 层 | 目录 | 放什么 |
|---|---|---|
| 1 | `state/` | `.forge/` 的读写（`state-store.ts` 是唯一入口）、转移表（`state-machine.ts`）、schemas、配置 |
| 2 | `security/`、`workspace/` | guard（命令与路径校验）；worktree、依赖准备、命令运行、端口与数据库分配 |
| 3 | `verify/`、`insight/` | 验证结果缓存；成本、预算、模型升级与兜底、停滞检测 |
| 4 | `spec/` | 规格解析与 spec-lint |
| 5 | `acceptance/` | 验收测试、覆盖率、修复任务的生成 |
| 6 | `plan/` | 计划与契约的检查、变更请求 |
| 7 | `stage/` | 审查、阶段门禁、stage-qa、签收 |
| 8 | `engine/` | 引擎：派发、子进程、提示组装、合并队列、合并后回归测试、主会话裁决 |
| 9 | `ops/` | 状态视图、恢复、doctor 等 |

分层的好处：改 `state/` 时只要担心它本身，上面的层不会反过来牵连它。

### 7. 跟一个 task 走一遍

下面按时间顺序，列出一个 impl task 经过的代码。括号里是文件和函数，可以照着点进去看。

**① 派发**（`core/engine/dispatcher.ts`：`Engine.next` → `dispatch`）

- `selectDispatchable`（`engine/scheduler.ts`）从 ready 的 task 里挑出要派的，实施池和辅助池分开限流。
- `planModel` 决定用哪个模型：平时用角色的模型；失败多次换升级模型；原模型被暂停（服务中断）或升级后还是失败，换兜底模型。
- `createTaskWorktree` 建 worktree，`prepareDeps` 准备依赖（有共享构建环境时直接链接）。
- 状态 `ready → in_progress`：`store.transitionTask` 调用 `planTransition`（`state/state-machine.ts`）检查转移是否合法。
- `buildSpec` 组装子进程的参数，提示由 `assemblePrompt`（`engine/prompt-assembler.ts`）拼出：角色提示 + 规则 + 任务说明 + handoff。
- `launcher.launch` 启动 Pi 子进程（真实实现在 `pi-adapter/launcher.ts`，测试用 `test/fixtures/fake-subagent/`）。

**② 子进程里干活**（`pi-adapter/subagent.ts`）

- 子进程加载这个扩展，它注册 `forge_*` 工具，并在每次工具调用前调用 guard。
- guard（`core/security/guard.ts`：`enforceToolCall` → `checkToolCall`）检查工具白名单、写路径、受保护路径、敏感文件（读取不限范围）；bash 命令先解析（`security/shell.ts`），实施角色按禁止列表拦（判断不了的放行），只读角色按允许列表放。拦下的记一次违规，只记账，不结束运行。
- worker 写完代码，调用 `forge_note` 写 handoff，再调用 `forge_submit`（`tools/subagent-tools.ts`：`flowSubmit`）。程序校验 token、算出 diff、检查越界和契约改动，状态转到 `awaiting_inputs`。

**③ 子进程结束**（`dispatcher.ts`：`onExit`）

- 正常提交：什么都不用做，状态已经变了。
- 没提交就结束：`classifyRunFailure`（`engine/failure-class.ts`）按错误原文分类——额度用完、限流、配置错误就暂停这个模型（`engine/model-pause.ts`），不算 task 失败；其余计一次失败，下次重试。

**④ 等输入、预检**（`advanceInputs`、`precheckOne`）

- 软依赖的上游都 done 后，把集成分支合进任务分支（`awaiting_inputs → checking`）。
- 预检只查契约是否只做了追加，不跑命令（`checking → in_review`）。

**⑤ 审查**（`core/stage/review-flow.ts`：`resolveReviews`、`decideReview`）

- 程序建一个 `T-001.rv`，派给 reviewer。reviewer 在同一个 worktree 里只读，运行这个 task 的测试，用 `forge_review_report` 交结论。
- 有必须改的问题：回到 worker（`review_changes`）；第二轮 `.rv-2` 只确认上一轮的问题。没问题：进入合并队列（`review_pass`）。

**⑥ 合并**（`core/engine/merge-queue.ts`：`processNext` → `merge`）

- 串行合并：把任务分支 squash 成一个提交，rebase 到集成分支最新提交，检查冲突标记，快进集成分支（不跑命令；合入后在后台跑一次回归测试）。
- 冲突：契约文件和"双方都只追加"的文件由程序三方合并；合不了的交回 worker。

**⑦ 合并后回归测试**（`core/engine/post-merge-test.ts`：`PostMergeTester.schedule` → `checkIntegration`）

- 每次合并后，在后台对集成分支最新提交跑一遍门禁命令。
- 变红：同一提交重跑一次排除不稳定的测试；仍然红，就在"上一次通过"之后的合并里二分（`firstFailing`），找到第一个变红的合并，给它对应的 task 建修复任务 `.fx-n`（`acceptance/stage-fix.ts`：`createStageFixTasks`）。

**⑧ 阶段验收**（`core/stage/stage-acceptance.ts`：`stageStep`）

- 本阶段的 task 都结束后，阶段转 `awaiting_gate`，跑门禁（`stage/gates.ts`：`runImplementationChecks`）和 AC 覆盖率。同一棵代码树上已经通过的命令直接沿用（`verify/verify-cache.ts`）。
- 门禁通过后派 stage-qa 做整体验收；有问题就建修复，修完再确认。
- 都通过了等你签收；轮数用尽则 `needs_human`，先交给主会话决定（`engine/decisions.ts`）。

**⑨ 阻塞了怎么办**（`core/engine/decisions.ts`）

- 程序或子进程造成的阻塞，task 带上 `blocked_owner: orchestrator`（在 `state-machine.ts` 的 `blocked()` 里设置）。
- 主会话用 `forge_decide` 决定：retry 重做、accept 放行，或转交用户。同一个 task 最多由它决定 2 次。

看完这一遍，可以对照 [flow.md](flow.md) 里的状态图再过一次。

### 8. 建议的阅读顺序

想快速建立全局认识，按这个顺序读：

1. `src/core/state/schemas.ts`：先看 `TaskFile`、`FlowFile`，知道状态里有什么字段。
2. `src/core/state/state-machine.ts`：`TRANSITIONS` 转移表，所有状态变化的规则都在这里。
3. `src/core/engine/dispatcher.ts`：引擎，从 `pump` 和 `dispatch` 读起。
4. `src/tools/subagent-tools.ts`：子进程能调用的工具，看 `flowSubmit`。
5. `src/core/security/guard.ts`：读开头的禁止列表注释和 `BashChecker.checkCommand`。

再往下按兴趣读：合并（`merge-queue.ts`）、阶段验收（`stage-acceptance.ts`）、计划检查（`plan/`）。

### 9. 改代码

- **跑测试**：
  - `npm run typecheck`：类型检查。
  - `npm run test:fast`：纯函数单元测试，1 秒左右；后面加文件路径就只跑这些文件，改代码时随手跑。
  - `npm run test:slow`：用到 git 的单元测试，几分钟。
  - `npm run test:e2e`：用假子进程跑完整流程，约 30 分钟。
  - `npm test` 全部跑一遍。
- **测试不调用真实模型**：e2e 用 `test/fixtures/fake-subagent/` 模拟子进程，脚本里直接写"调用哪个工具、传什么参数"。真实模型只在 `scripts/real-build.ts`、`scripts/real-tasks/` 这些实验脚本里用。
- **TypeScript 只用可擦除的语法**：不用 enum、namespace、构造函数参数属性（Node 直接剥类型运行）。
- **命名**：标识符和文件名用英文；给用户看的提示、错误信息和文档用中文。
- **改 `agents/`、`skills/`、`rules/`** 会改变子进程系统提示的稳定前缀，提示缓存会失效一次。要在 NOTES.md 的"缓存提醒"里记一笔。
- **偏离规格的决定**记在 NOTES.md 的"偏离规格"对应主题下；代码注释里直接写原因，不引用 NOTES 的条目。
- **只有 `src/pi-adapter/` 能调用 Pi API**，用之前先查 Pi 的文档或源码（安装在 `$(npm root -g)/@earendil-works/pi-coding-agent`）。
- **改 `schemas.ts` 之后**运行 `npm run gen:schemas` 重新生成 `schemas/*.json`。

### 10. 接下来读什么

- [README.md](../README.md)：所有命令、`workflow.yaml` 的每个配置项。
- [docs/flow.md](flow.md)：task 状态机、阶段验收、变更请求的状态图。
- [NOTES.md](../NOTES.md)：每个设计决定的原因，以及真实模型实验的结论。
