# pi-forge 流程图

这些图按代码里的状态名画：任务状态机是 `src/core/state/state-machine.ts` 的 `TRANSITIONS`，阶段状态机是 `STAGE_TRANSITIONS`，批次验收是 `src/core/stage/stage-acceptance.ts`，架构阶段与批次是 `src/core/plan/plan-flow.ts`、`batches.ts`，fix 与小改动的推进是 `src/modes/fix.ts`。图只画主要路径，完整的转移条件看代码和测试；设计原因看 `NOTES.md`。

## 1. 三种流程

```mermaid
flowchart TD
    subgraph build["build：/forge-build"]
        IN["检查 docs/PRD.md 与 docs/prototype/<br/>缺了只提示，不建流程；齐全则提交到集成分支"] --> S0["S0 架构<br/>architect 一个任务：骨架、公共代码、domain、契约、规则、命令、plan.md"]
        S0 -->|"审查、合并、门禁后<br/>/forge-approve"| GEN["按 plan.md 生成 S1…Sn 与任务<br/>集成分支 --no-ff 合入主分支"]
        GEN --> SN["S1 … Sn（每个批次一个阶段）<br/>后端 domain 并行，前端按页面串行<br/>最后接入真实接口"]
        SN -->|"批次验收后 /forge-approve 签收<br/>最后一批签收时 --no-ff 合入主分支"| BD["交付"]
    end
    subgraph change["小改动：/forge-change --from &lt;yaml&gt; 或 forge_change"]
        C0["迷你计划：1–3 个 impl task（worker）"] --> C1["实施、审查、合并<br/>直接合入主分支"]
        C1 --> C2["更新架构图与契约（architect）"] --> C3["X1.qa 全量确认 → 结束"]
    end
    subgraph fix["fix：/forge-fix 问题描述"]
        F0["T-001（worker）定位、修复、回归测试"] --> F1["审查、合并（跑 typecheck、lint、test）<br/>直接合入主分支"] --> F2["X1.qa 复现确认 → 结束"]
    end
```

要点：

- 用户界面只显示三个高层阶段：架构 → 开发 → 交付（`/forge-status`）；内部阶段 id 在 `--detail`。
- S0 提交时程序检查必需文件与 plan.md 的 yaml 区块，缺文件或调度做不下去就退回，其余只提醒，显示在批准页上。用户打回时 architect 接着原会话返工。
- 批准 S0 时先生成批次再合入主分支；之后中止流程，主分支上的架构产出不撤回。S1 开始前建立共享构建环境，之后各 worktree 链接依赖，不再各自 install。
- 阶段之间串行。批次内：后端任务按 plan 的 `after` 依赖并行（`max_parallel_backend`）；前端同一时间只有 1 个，页面按顺序一个接一个，接着同一会话；接入真实接口等本批全部任务完成。审查、验收、咨询另用辅助池（`limits.max_parallel_aux`），咨询同时最多 1 个。
- 小改动与 fix 是单阶段 `X1` 的轻流程，用 worker 角色，同一时间只能有一个；build 流程运行时拒绝开始。

### 阶段状态机（`STAGE_TRANSITIONS`）

```mermaid
stateDiagram-v2
    [*] --> active
    active --> awaiting_gate: submit_gate（本阶段工作都结束）
    awaiting_gate --> active: gate_failed（生成了修复任务）
    awaiting_gate --> awaiting_human: gate_passed（需要人工签收）
    awaiting_gate --> done: gate_passed（不需要人工）
    awaiting_gate --> needs_human: gate_exhausted（轮数用尽或无法归属）
    needs_human --> awaiting_human: accept（/forge accept，仅用户）
    needs_human --> awaiting_gate: gate_rerun（/forge gate，仅用户）
    awaiting_human --> done: approve（/forge-approve，仅用户）
    awaiting_human --> active: reject（stage_reopened）
    needs_human --> active: reject（stage_reopened）
    done --> [*]
```

`abort` 可以从 active、awaiting_gate、awaiting_human、needs_human 转到 aborted。S0 也用同一套状态，批准即"架构批准"。

## 2. 单个任务的状态机

下图是 impl、fix、merge-fix 这类开发任务的主路径。`done` 和 `cancelled` 是终态，没有出边；需要返工时创建派生任务（`.fx-n`）。

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> ready: schedule（硬依赖都 done，阶段 active）
    ready --> in_progress: dispatch（所在的池有名额）
    in_progress --> in_review: submit（forge_submit，集成分支同步进任务分支）
    in_progress --> queued_merge: submit（不需要审查的任务）
    in_progress --> in_progress: sync_conflict（同步有冲突，交回原 agent）
    in_progress --> blocked: 等架构师（forge_ask_architect）
    in_review --> in_progress: review_changes（有 must，review_rounds + 1）
    in_review --> queued_merge: review_pass
    in_review --> blocked: review_exhausted
    queued_merge --> merging: merge_start（队列里第一个合格的任务）
    merging --> done: merge_done（rebase、冲突标记、快进）
    merging --> in_progress: merge_conflict（文本冲突交回原 agent，merge_failures + 1）
    merging --> in_progress: merge_verify_fail（残留冲突标记，或轻流程的 test 失败）
    merging --> queued_merge: merge_requeue
    merging --> blocked: merge_blocked（没有改动、受保护文件冲突等）
    blocked --> in_progress: 架构师回答后接着原会话
    blocked --> queued_merge: accept（仅 review_exhausted）
    blocked --> done: accept（仅 no_changes：要做的已在集成分支上）
    blocked --> blocked: hand_to_user（主会话转交用户）
    blocked --> in_progress: unblock（已开工）
    blocked --> ready: unblock（尚未开工）
    done --> [*]
```

要点：

- 不需要审查的：fix、merge-fix、接入真实接口；审过之后只因合并冲突退回的，解决后也不再审查。每次合并后，程序在后台对集成分支跑一遍门禁命令，变红时定位到具体任务建修复（见第 3 节）。
- 合并先 rebase；双方都只插入行的冲突由程序三方合并，合不了的交回原 agent。plan.md 的 `shared` 文件提交时若不是只追加，只在审查材料里提醒。
- 通用转移：`block`（agent、调度器或用户阻塞）；`run_failed`、`run_timeout`、`lease_expired` 计入 `attempts`，达到 `limits.max_attempts` 转 blocked；`run_interrupted`、`run_paused` 不计失败；`cancel` 只能由用户对 pending、ready、blocked 执行。
- 子进程没提交就结束时，程序先分类再决定怎么处理：模型额度、限流、配置错误暂停这个模型，不计失败（设了兜底模型时，任务改用兜底模型继续）；运行环境出错直接阻塞；其余计一次失败重试。同样的失败连续两次先换升级模型，再换兜底模型，都试过仍一样就阻塞。
- 计数达到上限时转 blocked：`merge_failures`（`merge_exhausted`）、`review_rounds`（`review_exhausted`）。只有审查轮数用尽的能 accept 放行，其余用 unblock。
- 阻塞先交给主会话（`blocked_owner: orchestrator`）：程序或子进程造成的阻塞，由 orchestrator 用 `forge_decide` 决定 retry（计数清零、带意见重做）、accept 或转交用户（`hand_to_user`）；涉及技术判断的，它先问架构师。主会话自己交出来的、或同一任务它已决定 2 次之后的阻塞，直接等用户。"等架构师"的阻塞不交给主会话。用户始终可以直接 `/forge unblock`、`/forge accept`。

### 只读任务（审查与 stage-qa）

```mermaid
stateDiagram-v2
    [*] --> ready
    ready --> in_progress: dispatch（辅助池有名额）
    in_progress --> done: report（forge_review_report / forge_qa_report 或 confirm，不能有改动）
    done --> [*]
```

- 逐任务审查 `T-xxx.rv`、`.rv-2` 在被审查任务的 worktree 里运行（只读）；第 2 轮只确认上一轮的 must，不能新增问题。前端页面的审查材料带上原型文件与 page-api.md 里这一页。
- stage-qa `S1.qa`、`S1.qa-2` 在集成分支 HEAD 的临时 detached worktree 里运行，结束后删除。
- 小改动的「更新架构图与契约」是 doc task：有改动时走提交、合并；确实不用改时不改文件直接提交，视为完成（impl、fix 没有改动时也一样）。

## 3. 批次验收（`stage-acceptance.ts`）

一个批次的任务全部结束后的编排。引擎每次 pump 时调用 `stageStep`，它只根据持久化的状态（任务、evidence、事件）决定下一步，崩溃后重入结果相同。

```mermaid
flowchart TD
    W["阶段 active<br/>本批的任务都已结束（含接入真实接口）"] --> G["阶段 → awaiting_gate<br/>（submit_gate）"]
    G --> CHK["确定性检查：<br/>implementation_gate.auto 的命令（test、acceptance、arch_check、contract_check）<br/>+ AC 覆盖率矩阵（docs/qa/&lt;阶段&gt;.md，只报告）"]
    CHK -->|"命令失败"| FIX["按责任任务生成 .fx-n<br/>最多 2 轮"]
    FIX -->|"gate_failed：阶段回 active"| W
    FIX -->|"轮数用尽或找不到负责的任务"| NH
    CHK -->|"通过：记下通过时的 HEAD"| QAQ{"implementation_gate.qa ?"}
    QAQ -- 否 --> SIGN
    QAQ -- 是 --> QA["stage-qa S1.qa：浏览器验收<br/>（阶段保持 awaiting_gate）"]
    QA -->|"有 must"| QFX["按归属生成修复：唯一归属 → 该任务的 .fx-n<br/>多个或找不到 → architect 修<br/>gate_failed：阶段回 active"]
    QFX -->|"修复合并后"| W
    W -.->|"重跑检查通过后，S1.qa-2 只确认<br/>（最多 qa.max_rounds 轮）"| QA
    QA -->|"轮数用尽或阻塞"| NH
    QA -->|"pass，且之后只有程序记录的文档变化"| SIGN
    SIGN["awaiting_human：主会话提醒你签收<br/>/forge-approve，材料见 /forge report"]
    NH["needs_human（先交给主会话）"]
    NH -->|"forge_decide accept，或 /forge accept 阶段 --note"| SIGN
    NH -->|"/forge gate"| G
    NH -->|"/forge-reject"| W
    SIGN -->|"/forge-reject：主会话判断归属<br/>建修复任务或交给架构师"| W
    SIGN -->|"/forge-approve"| DONE["done：进入下一批<br/>最后一批：合入主分支"]
```

要点：

- 合并后回归测试（`engine/post-merge-test.ts`，`limits.post_merge_test` 默认开）：每次任务合入后在后台对集成分支最新提交跑 `implementation_gate.auto` 的命令。变红时同一提交重跑一次，通过就记为不稳定；仍失败就在上一次通过之后的合并里二分，给第一个变红的合并对应的任务建 `.fx-n`。它在跑时批次门禁先等，门禁沿用同一棵代码树上通过的结果。
- 门禁通过后，与最近一轮 stage-qa 的 HEAD 之间只有程序记录的文档（审查建议、`docs/qa/`）时才进入签收；修复合并之后会重跑门禁与覆盖率，再让 stage-qa 做只确认的一轮。stage-qa 轮数用尽后集成分支又有了改动时，门禁通过后再开一轮只确认的 stage-qa。
- 问题归属：一条问题只交给一个任务修。先看问题涉及的文件是哪个已完成任务改过的，再看 plan.md 的 `paths`，页面文件归该页面的任务；归到唯一一个任务就接着它的会话修，否则建一个由 architect 完成的修复任务。
- 签收被打回（`stage_reopened`）后，旧的 qa 轮次仍计入轮数上限，这是已知局限，可以 `/forge accept` 放行。

## 4. 架构师问答（`forge_ask_architect`、`forge_answer`）

```mermaid
flowchart TD
    Q1["backend / frontend 调用<br/>forge_ask_architect(question, kind)"] --> B["提问任务阻塞：等架构师"]
    B --> C["程序建咨询任务（consult，串行，不审查）<br/>architect 接着上一次的会话<br/>（会话太大就开新会话，带上 docs/arch/decisions.md）"]
    Q2["主会话调用 forge_ask_architect"] --> C
    C --> A["architect：forge_answer(text)<br/>kind=change 时同时修改公共代码与契约并提交<br/>在 docs/arch/decisions.md 追加一条"]
    A -->|"有修改"| M["经合并队列合入集成分支"]
    A --> R1["回答写进提问任务的 handoff<br/>集成分支同步进它的 worktree<br/>接着原会话继续"]
    M --> R1
    A --> R2["主会话：下一次 forge_wait 返回时拿到回答，转达用户"]
```

要点：

- `kind`：`answer` 只要回答；`change` 要求修改已有公共内容或契约。新增常量、枚举值、错误码不用问，开发 agent 自己加。
- 改了契约的，由下一次批次门禁里的 `contract_check` 与 stage-qa 兜底。
- `forge_block` 只用于不是技术问题、又做不下去的事（需求矛盾、要用户的环境），仍先交给主会话。

## 5. fix 与小改动（`src/modes/fix.ts`）

两者都是单阶段 `X1` 的轻流程：不跑批次门禁，合并直接进主分支，日志写在 `.forge/fixes/<日期>-nnn.md`。

```mermaid
flowchart TD
    S1["/forge-fix 问题描述"] --> T1["T-001（worker）<br/>定位 + 修复 + 回归测试"]
    S2["/forge-change --from &lt;yaml&gt;<br/>或主会话的 forge_change"] --> T2["1–3 个 impl task<br/>（迷你计划，程序校验依赖）"]
    T1 --> RV["逐任务审查 .rv"]
    T2 --> RV
    RV --> M["合并队列：rebase、冲突标记<br/>（fix 另跑 test）<br/>直接合入主分支"]
    M -->|"小改动：实现都合入后"| D["「更新架构图与契约」doc task（architect）<br/>改 docs/arch、docs/contracts；不用改就无改动提交"]
    M -->|"fix"| Q1
    D --> Q1["X1.qa（stage-qa，只读）<br/>在主分支 HEAD 的临时 worktree 确认"]
    Q1 -->|"没有 must"| LOG["写日志，X1 done"]
    Q1 -->|"有 must"| FX["生成 .fx-n（worker，接着原会话）"]
    FX --> M2["合并"] --> Q2["X1.qa-2 只确认"]
    Q2 -->|"通过"| LOG
    Q2 -->|"仍有问题（最多 2 轮）"| NH["needs_human"]
    NH -->|"/forge accept --note"| LOG
    NH -->|"/forge abort"| X["中止"]
```

要点：

- 修复与小改动直接合入主分支，不需要 `/forge-approve`；"需要你处理"时用 `/forge accept --note "<说明>"` 放行。
- `implementation_gate.qa: false` 时跳过 X1.qa。
- 小改动的 task 数上限是 `limits.change_max_tasks`（默认 3）；要改已有契约时，worker 用 forge_block 说明。
