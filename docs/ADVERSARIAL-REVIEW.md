# pi-forge 对抗性评审与消融实验报告

日期：2026-10-10　对象：`main` @ `6146bc8`（M0–M8 与 e2e 全量通过之后、M9 之前）

本报告只做了分析与实验：`src/`、`agents/`、`rules/`、`skills/` 没有任何改动。新增的只有：
- `scripts/ablation/`：消融工具、故障注入用例；
- `docs/ablation/results.json`：各臂原始结果；
- 本文。

## 0. 结论摘要

1. **有一个会挡住 M9 的缺口（已用故障注入证实，F1）。** `commands.install` 只在 test-author 的隔离工作区里运行。阶段门禁和 stage-qa 用的是新的临时 worktree，里面没有依赖。worker 的 worktree 里装过依赖，所以预检和合并验证能过；到了门禁，全量 `test` 失败，又无法归属到某个 task，阶段转 `needs_human`。凡是要安装依赖的项目（模板默认的 pnpm、M9 的 ③）都会在每个阶段停住。
2. **同一棵代码树被反复全量验证（F2）。** 在 23 个完整流水线的 e2e 场景里：
   - 合并验证的 259 次命令中，228 次（88%）是同一棵树上已经成功跑过的；其中 204 次第一次就是在预检里跑的。
   - 门禁的 241 次命令中，238 次（99%）已经成功跑过。
   - 提案"同一棵树只验证一次"把合并验证的命令从 259 次减到 92 次，门禁从 241 次减到 91 次。
   - 消融显示，提案带来的唯一行为差异是不再生成 evidence 文件 `merge-a0-{typecheck,lint,test}.log`，没有任何流程结果改变。
3. **速度是瓶颈（F3，结构性推论）。** pi-flow 同一个看板项目：
   - 原生 Pi 用 17.6 分钟，隐藏测试 39/40；
   - pi-flow 最好的一次用 75.4 分钟（4.3 倍），隐藏测试 38–39/40。
   - pi-forge 精简模式每个阶段至少有 3 个依次执行的 LLM 会话；加上 P0、P1、S0 的串行 `.at`，3 个阶段共 12 个。3 倍目标（约 53 分钟）留给每个非实现会话约 4 分钟。
   - 质量类机制（独立测试、阶段审查、stage-qa）的价值只能在 M9 用真实模型做消融来回答，方案见 §5。
4. **程序性机制：24 组消融里，17 组去掉后都有专门的用例失败**，说明它们有测试保护，行为也符合各自的假设。**有 7 组去掉后没有任何用例失败**：
   - 契约只能追加的检查（提交时、预检时，以及两处都去掉）：**作为整体也没有流程级测试**。规格 M5 要求的 e2e"修改已有契约被拒"并不存在。
   - 合并队列里的契约结构化合并：已不可达。
   - "选第一个合格的 task"：永远选到队首。
   - 门禁失败后"没有变化就不重跑"的看守：没有用例覆盖。
   - `runStageGate` 的实施阶段分支：死代码。
5. **停滞只能靠 e2e 超时发现（F4）。** 一个约 40 行的纯函数（等待图）在 1 毫秒内就能发现偏离 72 那种互相等待。"在等谁"这条规则写了 4 遍，其中 `status-view` 已经和引擎不一致。
6. **语义冲突的责任落在后合并者身上（F7，e2e 偶发失败的根因）。** 先合并的 task 的改动让后合并者的全量测试失败；后合并者改不了对方的文件，只能把预检次数用完，然后转 blocked。现有的批量合并用例在 HEAD 上就会偶发失败（无负载下复跑，失败率约 1/5），原因正是合并顺序。
7. **耦合（F6）：**
   - `core/` 有 6 处反向依赖 `tools/`、`modes/`；
   - 规格、计划、变更、feature、adopt 五个文件组成一个循环依赖；
   - 合并的三条路径重复了"验证 → CAS 快进 → 转移"的流程；
   - 13 个导出没人引用。

## 1. 第一性原理：目标、约束与不变式

**目标**（规格第 0、17、18 节）：把 PRD 变成分阶段交付的项目，用 M9 的数字衡量：
- 隐藏测试不低于原生 Pi，0 回归；
- 精简模式的 agent 时间不超过原生的 3 倍。

**基准事实**（pi-flow `docs/EXPERIMENTS-4.md`，同一份看板 PRD）：

| 方案 | 时间 | 隐藏测试 | 运行次数 |
|---|---|---|---|
| 原生 Pi，单会话 | 17.6 分钟 | 39/40 | 1 |
| pi-flow 复跑三（最好的一次） | 75.4 分钟（4.3 倍） | 38–39/40 | 17 |

在这个基准上，原生 Pi 的质量已经接近满分，流程最多能多拿 1 个测试；**约束主要在速度一侧**。较大的项目（Homebox）上质量机制可能更有价值，但需要数据。

**由此推出评判每个机制的标准**——它必须属于以下之一，否则就是删除候选：

| 类别 | 含义 | 证明方式 |
|---|---|---|
| 不变式 | 多 agent 并行开发必须成立的性质 | 程序测试 + 去掉后有可观察的破坏（本报告的消融） |
| 质量假设 | 预期让隐藏测试更高、回归更少 | 只能用真实模型对照（M9 消融，§5） |
| 速度机制 | 只为更快 | 去掉后行为不变，只是更慢 |

**必须成立的不变式**：

- **I1 集成分支始终是绿的。** 并行 task 都从它同步；它坏了，所有下游的预检都会失败，也无法归属责任。
- **I2 验收测试独立于实现。**
- **I3 契约稳定。** 实施中只能追加。
- **I4 活性。** 每个没结束的 task，下一步都有人负责：运行者、程序步骤或用户。不会互相等待。
- **I5 状态只由程序写、可审计。**
- **I6 并行验证互不干扰。** 端口、数据库、临时目录。

## 2. 方法

### 2.1 消融（程序机制）

- **工具**：`scripts/ablation/ablations.ts` 定义 27 个臂，`run.ts` 运行，`analyze.ts` 汇总。
- **每一臂**：在 HEAD 的临时 detached worktree 里，对源码做最小的文本替换，去掉一个机制，然后跑全量单元测试与 e2e（与 `npm test` 相同的夹具，不用真实 LLM）。替换目标必须在文件里恰好出现一次，否则该臂报错。
- **臂的类型**：

  | 类型 | 数量 | 含义 |
  |---|---|---|
  | baseline | 1 | 不改动 |
  | probe | 1 | 观测：只加日志 |
  | ablate | 24 | 各去掉一个机制 |
  | proposal | 1 | 评审提出的简化 |

- **怎么读结果**：
  - 去掉后有用例失败：机制有测试保护，失败的用例说明它保护什么。
  - 没有用例失败：机制要么冗余（被别的层兜住），要么没有测试。再用组合臂或专门的场景区分。
  - 负载只会增加失败、不会掩盖失败，所以"没有用例失败"的结论不受负载影响。
- **噪声控制**：
  - 每批都带基线臂。
  - 真实 Pi 的四个 e2e 文件（`crash-recovery`、`orchestrator-session`、`orchestrator-p0`、`pi-subprocess`）在并行负载下会超时（第一批基线也失败了它们），而且不涉及被消融的机制。从第二批起不跑它们（`--no-real-pi`）。第二批的基线是 666 通过、0 失败。
  - `tools6` 的 `forge_service` 用例在负载下偶发超时：无负载时单独复跑 2/2 通过，约 5.5 秒。
  - 批量合并用例在 HEAD 上就偶发失败（F7）。这两个用例的失败，只有在失败原因与被消融的机制直接相关时才计入，例如批量合并本身被去掉、或合并验证被去掉。
- **复现**：

  ```
  node scripts/ablation/run.ts --parallel 4 --no-real-pi [--only <臂>]
  node scripts/ablation/analyze.ts <结果目录>
  ```

  全部臂并行运行约 4 小时。

### 2.2 故障注入（现有测试没覆盖的风险）

`scripts/ablation/faults/*.test.ts`：每个用例断言的是**现状**。用例通过，说明缺口存在；修复后要改成断言正确行为。它们不在 `npm test` 里。

### 2.3 静态分析

- 导入图：去掉 `import type` 之后求强连通分量，找出越层引用与没人用的导出。
- 按 §1 的不变式审读核心模块：`merge-queue`、`precheck`、`gates`、`stage-acceptance`、`dispatcher`、`state-store`。

## 3. 消融结果

"命中"是指相对基线新增、而且与被消融的机制直接相关的失败用例。原始数据见 `docs/ablation/results.json`。

| 臂 | 去掉的机制 | 不变式 | 命中 | 新增失败的用例（摘要） | 判断 |
|---|---|---|---|---|---|
| acctest-shared-objects | test-author 独立仓库不共享对象库（alternates 指回主仓库） | I2 | 1 | 单元：隔离工作区读不到实现提交 | 有保护。e2e 没察觉，因为 guard 照样拦下 `git show`：两道防线各自生效 |
| acctest-guard-off | 隔离工作区的 guard | I2 | 1 | e2e：隔离工作区读不到实现提交与绝对路径…… | 有保护 |
| forge-dir-read-off | 隔离工作区里 `.forge/` 的路径拦截 | I2、I5 | 1 | 单元：隔离工作区不能碰 `.forge/` | 有保护 |
| mutex-off | writes 重叠的 task 互斥 | I1 | 4 | 单元：互斥推导、互斥对、调度不选互斥 task、并发上限 | 有保护 |
| resources-shared | 端口与临时资源按运行分配 | I6 | 4 | 单元 3 + e2e：两个并行预检拿到不同端口段 | 有保护 |
| contract-append-submit-off | 提交时的契约只能追加检查 | I3 | **0** | — | 被预检那一处兜住 |
| contract-append-precheck-off | 预检时的契约只能追加检查 | I3 | **0** | — | 被提交那一处兜住 |
| contract-append-both-off | 两处都去掉 | I3 | **0** | — | **没有流程级测试**（只有纯函数 `contract-diff` 的单元测试） |
| contract-merge-at-sync-off | 预检前同步时的契约结构化合并（偏离 73） | 速度 | 1 | e2e：根 openapi.yaml 并行追加被结构化合并后合入 | 有保护 |
| contract-merge-at-queue-off | 合并队列 rebase 时的契约结构化合并 | 速度 | **0** | — | 同步已先合并过，**不可达** |
| sync-before-precheck-off | 预检前把集成分支同步进任务分支 | I1（提前） | 5 | e2e：预检同步新输入、同步冲突回 in_progress、受保护文件冲突暂停、正常合并、合并时全量 | 有保护 |
| precheck-commands-off | 预检命令 | 速度（提前反馈） | 5 | e2e：预检失败回 in_progress、争议后重跑预检、并行预检的资源、单任务流程 | 有保护。坏代码仍会被合并验证拦下：预检是提前反馈，不是最后防线 |
| merge-verify-off | 合并后全量验证 | **I1** | 5（+ 批量） | e2e：语义冲突被合并验证拦下、9.4 别的 task 的验收测试被破坏、知识候选、批量合并、合并时全量 | 有保护。是 I1 的唯一防线（预检之后集成分支的移动） |
| gate-commands-off | 门禁的 auto 命令 | I1 + 合并时没跑的命令 | 2 | 单元：`runImplementationChecks`；e2e：门禁只跑已配置命令（都是注入"只在门禁里失败的命令"） | 门禁的价值只在合并验证没跑的命令（e2e、contract_*）与覆盖率 |
| merge-batch-off | 批量合并 | 速度 | 1 | e2e：批量合并 | 有保护 |
| first-eligible-off | 合并队列选第一个合格的 task（改为严格队首） | — | **0** | — | **不可达**（见 F5） |
| foreign-break-routing-off | 别的 task 的验收测试被破坏时建 `.at-n`（9.4） | I4、归属 | 1 | e2e：第 9.4 节 | 有保护 |
| awaited-acctest-off | impl 不等硬依赖自己的验收测试（偏离 72） | I4 | 3 | 单元 `awaitedAcctest`；e2e：单独合并两例（超时） | 有保护，但 e2e 靠**超时**发现（F4） |
| merged-acceptance-filter-off | 提交 diff 排除程序合入的验收测试（偏离 47） | I4 | 1 | e2e：单独合并失败 → `.fx-n` 修好后合入 | 有保护 |
| must-basis-demotion-off | 没有出处的 must 降为 suggest | 原则 14 | 7 | 单元：审查与 stage-qa 的降级、确认轮、轮数用尽…… | 有保护 |
| dispute-evidence-check-off | 争议依据必须引用存在的位置 | 原则 14 | 1 | e2e：争议依据 | 有保护 |
| gate-retry-guard-off | 门禁失败后没有任何变化时不重跑 | I4 / 成本 | **0** | — | **没有用例覆盖**。S 阶段门禁失败后总会建 task 或转 needs_human，看守很可能不可达；P1 未核实 |
| lean-stage-review-off | 精简模式的阶段审查 | 质量假设 | 1 | e2e：精简模式 S1.rv 全流程 | 有保护。它的价值只能由 M9 回答 |
| gate-impl-branch-dead | `runStageGate` 实施阶段分支（改为抛错） | — | **0** | — | **死代码** |
| **proposal-skip-same-tree** | 同一棵树只验证一次（合并、门禁） | 速度 | 2 | e2e：两例都只是断言 evidence 文件名 `merge-a0-{typecheck,lint,test}.log` | **行为不变**。批量合并的偶发失败在 HEAD 上同样出现（F7） |
| probe | 只加日志 | — | 0 | — | 观测不改行为 |

## 4. 发现

### 4.1 F1：门禁与 stage-qa 的临时 worktree 没有依赖（高，已证实）

- **代码**：
  - `acctest.ts` 的 `installAndCodegen` 只在隔离工作区里调用。
  - `gates.ts` 的 `runImplementationChecks`、stage-qa 的临时 worktree 都是 `git worktree add --detach` 之后直接跑命令。
  - 任务 worktree、merge-fix worktree 也不安装依赖，`agents/worker.md` 里也没有提示。
- **实验**：`scripts/ablation/faults/install-gap.test.ts`。
  - 配置：`install: touch .deps-installed`，`test: test -f .deps-installed`，`.gitignore` 忽略这个标记文件（模拟 `node_modules`）。
  - worker 在自己的 worktree 里"安装依赖"后实现、提交。
  - 结果：T-001 预检通过、合并通过、done；门禁的 `test` 在新 worktree 里失败，"无法从日志定位负责的 task"，阶段转 `needs_human`。用例通过，缺口存在。
- **影响**：
  - M9 的 ①②（零依赖的 `node --test`、Go）可能碰不到，③（用户自己的项目）几乎必然碰到。
  - 规格第 7.5 节 S0 的完成标准"在干净的 worktree 中能跑通 install……"暗含程序会运行 install。
- **建议（高内聚，不新增机制）**：
  - 把隔离工作区已有的"install → codegen，依赖目录按锁文件哈希缓存、命中时硬链接"抽成 `prepareWorkspace(dir)`。
  - 任务 worktree、门禁与 stage-qa 的临时 worktree、merge-fix worktree 都用它。

### 4.2 F2：同一棵树上的重复验证（中高，速度；提案已由消融验证）

**观测**：`probe` 臂在 `runShell` 里记录每次命令的 HEAD tree（23 个 e2e 场景）：

| 阶段 | 运行次数 | 同一棵树上已成功跑过的同名命令 | 第一次在哪一步跑过 |
|---|---|---|---|
| 预检 | 334 | 144（43%） | 预检 144 |
| 合并验证 | 259 | 228（88%） | 预检 204、合并 24 |
| 门禁 | 241 | 238（99%） | 预检 204、合并 34 |

夹具里的命令很快（多是 `true`），所以这些数字说明的是**结构**，不是耗时。真实项目里，每一次都是一遍全量 typecheck、lint、test。

**为什么重复**：
- 预检之前程序先把集成分支同步进任务分支。只要预检到合并之间集成分支没动，squash 并 rebase 之后的树就是预检验过的那棵树。
- 门禁开始时，集成分支 HEAD 往往就是最后一次合并验证过的提交。
- 精简模式每个阶段只有一个 impl，同一棵树会跑三遍全量。

**提案（`proposal-skip-same-tree`，约 10 行）**：
- 合并时，分叉点等于集成分支 HEAD（不包括单独合并的验收测试），跳过 typecheck、lint、test。merge_check 与全量 acceptance 照跑，因为预检只跑本 task 的 acceptance。
- 门禁时，HEAD 正是最近一次合并验证过的提交，跳过与合并验证相同的命令，只跑 e2e、contract_* 等合并时没跑的命令。

**结果**：
- 合并验证的命令从 259 次降到 92 次，门禁从 241 次降到 91 次。（提案臂比观测臂少跑两个真实 Pi 的文件，数字是近似的对比。）
- 命中的 2 个用例都只是断言 evidence 文件名，流程结果不变。

**还可以更进一步**：按树的哈希缓存"命令 → 结果"。这样门禁在覆盖率报告提交之后、修复轮之后也能命中。但这要新增一个缓存机制，先落地上面的简单版本。

**小的不一致**：预检与门禁会去掉命令里的 `{files}` 占位，合并验证不会；模板已经不用 `{files}`。建议整体删掉这个占位，而不是补齐。

### 4.3 F3：精简模式的关键路径（结构性风险，需要 M9 数据）

关键路径上依次执行的 LLM 会话（顺利、无返工）：

| 段 | 会话 |
|---|---|
| P0 | 主会话（与用户） |
| P1 | architect |
| S0 | worker → `.at`（impl 合并后才开始，第 5 节）→ 阶段审查 `.rv` → stage-qa `.qa` |
| 每个 Sk（k≥1） | max(worker, `.at`) → `.rv` → `.qa` |

以三个阶段（S0–S2）为例，共 12 个依次执行的会话。

- 原生 17.6 分钟 × 3 = 53 分钟。扣掉实际写代码的 worker 时间（约等于原生的 15 分钟）后，剩下 9 个非实现会话分约 38 分钟，平均每个约 4 分钟。
- pi-flow 最好的一次里，规划单独就用了约 17 分钟。

**对抗性观点**：`.rv`（门禁前审查整个阶段的 diff）与 `.qa`（门禁后在集成分支上验收）都是只读的 LLM 判断：
- 都要求出处；
- 都有"第二轮只确认"；
- 都把 must 变成 fix。

在精简模式下，它们看的几乎是同一份 diff。奥卡姆剃刀的候选是合并成一个判断会话。但这只能用 M9 的对照来定（§5 的 A2–A4），不能凭推理删除。

### 4.4 F4：停滞只能靠 e2e 超时发现（中，活性 I4）

偏离 72–74 都是在 e2e 里发现的停滞：
- 72：impl 与自己的 `.at` 互相等待；
- 74：merge-fix 停在 checking，没有程序步骤处理它。

`awaited-acctest-off` 臂复现了 72：e2e 的两个用例要等到超时才失败。现有的发现手段：
- `stallOf`：N 分钟没有事件；
- `stuckTasks`：只看 blocked 与 pending 的依赖。

**实验**：`scripts/ablation/faults/liveness.test.ts`。
- 原型是纯函数 `waitsOn`、`stalls`（约 40 行）：每个没结束的 task 指向它在等的 task，有环或等到 blocked / cancelled 就报停滞。
- 偏离 72 的现场：旧的等待规则（`latestAcctest`）成环、被报出；现行规则（`awaitedAcctest`）不成环。
- 等到已阻塞的软依赖生产方也会报；正常的并行等待不报。
- 每个用例约 1 毫秒。

**"t 在等谁"写了 4 遍**：
- `dispatcher.advanceInputs`；
- `state-store` 的 facts（`latest_acctest_done`、`soft_deps_done`、合并队列的 `eligible`）；
- `merge-queue`（`processNext`、`mergeBatch` 各一处软依赖判断）；
- `status-view`（"需要你处理"）。

其中 `status-view.ts:86` 仍用 `latestAcctest`，与引擎的 `awaitedAcctest` 不一致：一个 fix task 可能被说成"在等已阻塞的 S0 `.at`"，实际上它并不等。

**建议**：
- 把 `waitsOn` 放进 `core/`，作为唯一出处，上面 4 处都改用它。
- `stalls` 接到"需要你处理"与 `forge doctor`。
- e2e 的 `drive()` 每轮断言 `stalls() == []`，这样这类问题会以清楚的原因立即失败，而不是超时。

### 4.5 F5：冗余、不可达与死代码（低，奥卡姆剃刀）

| 项 | 证据 | 建议 |
|---|---|---|
| 契约只能追加：`forge_submit` 与预检各查一遍（偏离 54、66） | 单独去掉任一处，0 个用例失败；**两处都去掉也 0 个**。纯函数有单元测试，但两处的接线没有任何测试。本次会话修掉的"契约检查路径重复拼接"就是因此一直没被发现的 | 先补 M5 要求的 e2e（worker 修改已有契约 → 被拒，并说明原因）。然后只保留预检这一处（在同步之后，基线最准）；提交时如需更早提示，只提示、不拒绝 |
| 合并队列 rebase 时的契约结构化合并 | 0 个用例失败；同步阶段（偏离 73）先合并过了 | 删掉这一处调用（罕见时走 merge-fix），或补一个"预检后集成分支又追加契约"的用例。倾向删掉 |
| "选第一个合格的 task"（规格第 8.1 节 merge_start） | 改为严格队首，0 个用例失败。进队列的 task 都已过 inputs_ready，软依赖的生产方已 done，而 done 是终态；变更请求也不能改已开始 task 的依赖（偏离 57） | 规格要求它，但它不可达。建议记为偏离：严格队首，删掉 state-store、`processNext`、`mergeBatch` 三处判断 |
| 门禁失败后"没有变化就不重跑"（`gateFailedWithoutChange`） | 0 个用例失败 | S 阶段：`afterChecks` 失败时总会建 task 或转 needs_human，看守不可达。P1：失败后总会新建 architect task。核实 P1 后删除 |
| `runStageGate` 的实施阶段分支 | 改为抛错，0 个用例失败。生产调用方只有 P0（`forge_spec`）和 P1、ADOPT | 删掉这一段，以及 `gates.ts` 里过时的注释"M6 由 stage-qa 取代：暂时保留……" |
| 没有引用的导出（13 个） | 静态扫描：`dropIsolatedWorkspace`、`hasAcceptanceDir`、`isAdoptFlow`、`formatDagReport`、`planConflicts`、`KnowledgeStatus`、`ChangeStatus`、`SCOPE_HARD_LIMITS`、`nextTaskId`、`ports.ts` 的 4 个类型 | 删除 |
| 只被测试使用的导出（6 个） | `validateDag`、`gitCommitPaths`、`emptyNotes`、`qaRounds`、`stageReviewRounds`、`isClean` | 逐个看：要么是测试辅助，要么删除 |

### 4.6 F6：耦合与内聚（低到中）

**越层**（`core/` 应该不依赖 `tools/`、`modes/`）：

| 依赖 | 建议 |
|---|---|
| `core/dispatcher → tools/module-tools.syncTaskInputs` | 同步是引擎步骤，搬到 `core/`（与 `advanceInputs`、`waitsOn` 放在一起） |
| `core/dispatcher → tools/subagent-tools.RUN_ENV_KEYS` | 常量搬到 `core/` |
| `core/subagent-runtime → tools/subagent-tools`（`FlowToolError`、`SUBAGENT_TOOLS` 等） | 把类型与错误类搬到 `core/`，工具表由调用方注入 |
| `core/resume → tools/orchestrator-tools.statusText` | `statusText` 搬到 `core/status-view` |
| `core/dispatcher`、`core/status-view → modes/fix` | fix 模式是业务逻辑，搬进 `core/` |

**循环**：`spec-flow → change-flow → plan-flow → (spec-flow | adopt → feature-spec → spec-flow)`。成环只是因为 `SPEC_PATHS`、`SpecFlowError` 放在 `spec-flow` 里，把它们搬到叶子模块（例如 `spec.ts`）就能解开。

**重复的流程**：合并有三条路径：
- `merge`；
- `mergeBatch`；
- `mergeSyncFix`。

它们各自写了"验证 → CAS 快进 → 转 done → 记事件 → 清理"。可以提出一个 `finishMerge(candidate)`。这项和 F2 一起做最合适，因为跳过验证的判断也放在这里。

**体量**：

| 文件 | 行数 | 被引用 | 引用别人 | 性质 |
|---|---|---|---|---|
| `state-store.ts` | 1375 | 48 | — | 唯一写入口，这是设计 |
| `dispatcher.ts` | 943 | — | 40 | 编排 |

这两个都可以接受。建议把 store 里的推导（facts 的计算）交给 `waitsOn` 一类的纯函数，store 只负责持久化与事务。

### 4.7 F7：语义冲突的责任落在后合并者身上（中，有 e2e 偶发失败为证）

**现场**：`merge-queue.test.ts` 的批量合并用例在 HEAD 上无负载复跑，失败率约 1/5。

**失败时的经过**：
1. 带 BAD 的 T-003 先合入（它自己的树是绿的）。
2. T-001 合并验证失败（`merge_verify_fail`），回到 worker。
3. 下次同步后，BAD 进了 T-001 的 worktree，每次预检都失败。
4. T-001 改不了 T-003 的文件，预检次数用完，转 blocked。

**根因**：
- 合并验证失败一律算当前 task 的问题。
- 第 9.4 节只对"别的 task 的**验收测试目录**"做了分流；失败的文件属于别的已 done task 的 writes 时，没有分流。

**建议（复用现有机制）**：合并验证或预检失败时，用 `gateIssues`/`ownerOf` 已有的"失败文件 → 负责 task"归属：
- 失败文件全部不在当前 task 的 writes 内，而且属于已 done 的 task：为负责的 task 建 `.fx-n`，当前 task 回 `awaiting_inputs` 并 `waits_for` 它，与第 9.4 节同样处理。
- 同时把用例改成确定的合并顺序，消除偶发失败。

## 5. M9 的真实模型消融方案（建议开跑前定下，不再改）

质量类机制的价值只能这样回答。在看板（①）上：
- 每臂至少 3 次；
- 同一模型、同一 PRD、同一隐藏测试；
- 记录 agent 时间、隐藏测试、回归、返工次数（第 17 节）、成本。

| 臂 | 内容 | 回答的问题 |
|---|---|---|
| N | 原生 Pi 单会话 | 对照 |
| A0 | pi-forge 精简模式（修好 F1，带 F2） | 3 倍门槛是否可达 |
| A1 | A0 − test-author（worker 自己按 AC 编号写验收测试，覆盖率检查不变） | 独立测试是否提高隐藏测试、减少回归？pi-flow 的打回里 7/11 是先行测试写错 |
| A2 | A0 − 阶段审查（`.rv`） | 阶段审查的 must 有多少对应隐藏测试的失败 |
| A3 | A0 − stage-qa（`implementation_gate.qa: false`） | 同上，针对 stage-qa |
| A4 | A0，`.rv` 与 `.qa` 合并为一次判断（如果 A2、A3 各自都没有显著损失） | 合并后的判断会话是否兼得 |

**决定规则（预先写定）**：
- 去掉某个机制后，隐藏测试平均下降不到 1 个、回归不增加，并且它占 agent 时间的 10% 以上：从精简模式的默认流程里去掉（标准模式保留开关）。
- 否则保留，并记录它的单位时间收益。

## 6. 建议的优先级

| 优先级 | 项 | 理由 | 规模 |
|---|---|---|---|
| P0（M9 之前） | F1：所有工作区用同一个 `prepareWorkspace`（install + codegen + 缓存） | 不修，③ 每个阶段都会停 | 中 |
| P0 | F2：同一棵树只验证一次（合并、门禁） | 每个阶段省 1–2 次全量测试；行为不变已由消融验证 | 小 |
| P1 | 补 M5 要求的"修改已有契约被拒"e2e；然后契约检查只留预检一处 | 当前两处都去掉也没有测试失败 | 小 |
| P1 | F4：`waitsOn` 作为"在等谁"的唯一出处；`stalls` 接到 doctor、status 和 e2e 的 `drive` | 活性 I4 变成可测的性质；修掉 status-view 的不一致 | 小 |
| P1 | F7：失败文件归属到已 done 的 task 时分流（复用 `ownerOf`）；批量合并用例改成确定的合并顺序 | 后合并者不会被冤枉到 blocked；消除偶发失败 | 小到中 |
| P1 | §5 的 M9 消融方案（开跑前定下） | 质量机制的去留需要数据 | — |
| P2 | F5：删不可达与死代码（严格队首、合并时的契约合并、门禁重跑看守、`runStageGate` 实施分支、13 个导出） | 奥卡姆剃刀；"严格队首"需要你同意偏离规格第 8.1 节 | 小 |
| P2 | F6：越层引用搬家、拆循环、提取 `finishMerge` | 高内聚、低耦合；行为不变 | 中 |
| P3 | 删掉 `{files}` 占位 | 遗留、不一致 | 小 |

以上改动都等你确认后，再按里程碑方式计划与实施。涉及规格的两处（严格队首；如果 M9 数据支持，精简模式合并或去掉判断会话）要你决定。

## 7. 评审后的决定（10-10，与用户讨论后）

- M9 之前做（M8.5）：
  - F1（加两个要求：缓存要做好；S0 时还没有清单和锁文件，不能报错）；
  - F2（跳过时写沿用记录，指向被沿用的 evidence）；
  - F4（提到 P0）；
  - 补"修改已有契约被拒"的 e2e；
  - F7 第一步：失败提示里引导 worker 用 `forge_request_scope`，已完成 task 的文件会被自动批准；
  - stage-qa 用绝对路径写主工作区的故障注入用例；
  - 逐个对照规格，核对上一次提交里按现行行为改写的 e2e 用例。
- F7 改为两步：先用范围申请；预检次数快用完时生成修复 task，把双方的改动与失败输出都附上，不转 blocked。原建议"按失败文件归给已完成的 task"会归错人，因为失败输出里列的往往是测试文件。
- F5、F6 放到 M9 之后，以免流程大改后白做。
- 补充风险：缓存的硬链接只用于只读的临时 worktree；可写的 worktree 用写时复制或整份复制，否则 worker 改依赖会污染共享的缓存。

## 8. M8.5 之后的消融复测（10-10）

在 `dbd38c2` 上跑了 4 臂，用 `--no-real-pi`，结果追加在 `docs/ablation/results.json`，`round` 字段为 M8.5。

| 臂 | 通过 / 失败 | 新增失败 |
|---|---|---|
| baseline | 711 / 0 | — |
| contract-append-both-off | 708 / 3 | 2 条 e2e（修改本模块已有契约、修改别的模块的契约）与 1 条单元测试（`runPrecheck`） |
| awaited-acctest-off | 706 / 5 | 3 条单元测试与 2 条 e2e（acctest-merge）。e2e 约 2 秒就失败，正常约 7 秒跑完，不是靠超时才发现 |
| verify-reuse-off（新增臂：关掉同一棵树的沿用） | 708 / 3 | 2 条 `reusableRuns` 单元测试与 1 条 e2e（断言沿用记录文件）。行为类用例没有失败，与"只省重复运行、不改结果"一致 |

结论：三个机制现在都有测试保护，各自都有新增失败。
