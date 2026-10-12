# pi-forge 流程图

这些图按代码里的状态名画：task 状态机是 `src/core/state/state-machine.ts` 的 `TRANSITIONS`，阶段状态机是 `STAGE_TRANSITIONS`，阶段验收编排是 `src/core/stage/stage-acceptance.ts`。规格的章节号指 `docs/BUILD_PROMPT.md`。图只画主要路径，完整的转移条件看代码和测试；与规格不同的地方看 `NOTES.md` 的偏离记录。

## 1. 整体阶段（规格第 5 节）

build、feature、adopt 三种流程共用同一套机制，区别在输入和阶段。

```mermaid
flowchart TD
    subgraph build["build：/forge-build --prd"]
        B0["P0 规格<br/>主会话 + 用户，spec-lint"] -->|"/forge-approve"| B1["P1 契约与计划<br/>architect，程序校验"]
        B1 -->|"/forge-approve<br/>生成 S 阶段与 task，锁定契约"| BS["S0 骨架 → S1 … Sn"]
        BS -->|"每个 S 阶段验收后<br/>/forge-approve 签收"| BD["交付：最后一个阶段签收时<br/>集成分支 --no-ff 合入主分支"]
    end
    subgraph feature["feature：/forge-build --feature --prd"]
        F0["P0 增量规格<br/>docs/spec/features/"] --> F1["P1 增量契约与计划<br/>baseline 符号必须已存在"]
        F1 --> FS["S0… 实施"] --> FD["交付"]
    end
    subgraph adopt["adopt：/forge init --adopt"]
        A0["ADOPT 阶段<br/>architect 从现有代码反向整理<br/>docs/contracts、docs/arch"] -->|"/forge-approve stage:ADOPT<br/>--no-ff 合入主分支"| A1["契约基线就绪"]
    end
    A1 -.->|"feature 的前提：<br/>主分支有 docs/contracts/"| F0
```

要点：

- 用户界面只显示四个高层阶段：规格 → 契约与计划 → 实施 → 交付（`/forge-status`）；内部阶段 id 在 `--detail`。
- P0 的规格由主会话经 `forge_spec` 提交，程序做 spec-lint 并提交到集成分支，必须人工批准。P1 由程序驱动 architect，不经主会话。
- 批准 P1 时，程序先在主工作区应用规则与命令草案，再根据 `plan.yaml` 生成 S 阶段和 task，契约从此只能追加（偏离第 38 条）。
- feature 流程中，主分支已有的契约从流程开始就锁定（偏离第 69 条）。adopt 流程只有一个阶段 `ADOPT`，architect 只写 `docs/contracts/**` 和 `docs/arch/**`（偏离第 70 条）。
- 交付不是独立阶段：批准最后一个 S 阶段时，签收材料就是交付汇报，批准后合入主分支。
- 阶段之间串行，同一阶段内按 DAG 并行。

### 阶段状态机（`STAGE_TRANSITIONS`）

```mermaid
stateDiagram-v2
    [*] --> active
    active --> awaiting_gate: submit_gate（本阶段工作都结束）
    awaiting_gate --> active: gate_failed（生成了修复或补测任务）
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

`abort` 可以从 active、awaiting_gate、awaiting_human、needs_human 转到 aborted。P0、P1 这类设计阶段也用同一套状态（阶段闸门需要人工批准）。

## 2. 单个 task 的状态机（规格第 8.1、9.5 节）

下图是 impl、fix、doc 这类实施 task 的主路径。`done` 和 `cancelled` 是终态，没有出边；需要返工时创建新的派生 task。

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> ready: schedule（硬依赖都 done，阶段 active）
    ready --> in_progress: dispatch（并发未满，不与在途 task 互斥）
    in_progress --> awaiting_inputs: submit（impl、fix、doc 提交）
    awaiting_inputs --> checking: inputs_ready（最新 .at done，软依赖 done，同步成功）
    awaiting_inputs --> in_progress: sync_conflict（同步有冲突，交回 worker）
    checking --> in_progress: precheck_fail（precheck_failures + 1）
    checking --> in_review: precheck_pass（impl 一律审查；预检只合入验收测试并检查契约追加，不跑命令，偏离 117）
    checking --> queued_merge: precheck_pass_skip（fix、doc 等不审查的类型）
    checking --> awaiting_inputs: foreign_tests_broken（别的 task 的验收测试失败）
    in_review --> in_progress: review_changes（有 must，review_rounds + 1）
    in_review --> queued_merge: review_pass
    in_review --> blocked: review_exhausted
    queued_merge --> merging: merge_start（第一个合格的 task）
    merging --> done: merge_done（rebase、冲突标记与 merge_check、快进）
    merging --> in_progress: merge_verify_fail（merge_failures + 1）
    merging --> awaiting_inputs: foreign_tests_broken
    merging --> queued_merge: merge_requeue
    in_progress --> disputed: dispute（forge_dispute）
    disputed --> checking: dispute_fixed（.at-n 改了测试）
    disputed --> in_progress: dispute_upheld（.at-n 维持测试）
    disputed --> blocked: dispute_escalated
    blocked --> in_progress: decide_keep / unblock（已开工）
    blocked --> disputed: decide_fix
    blocked --> queued_merge: accept（blocked_by = review_exhausted）
    blocked --> ready: unblock（尚未开工）
    done --> [*]
```

任何非终态之间还有这些通用转移：

- `block`：agent、调度器或用户阻塞，转 `blocked`，`blocked_by` 记原因。
- `run_failed`、`run_timeout`、`lease_expired`：计入 `attempts`，达到 `limits.max_attempts` 转 `blocked`（`blocked_by = attempts`）。
- `run_interrupted`、`run_paused`：不计失败。
- `cancel`：`pending`、`ready`、`blocked` 可由用户取消。

计数达到上限时，名义目标会被改为 `blocked`：`precheck_failures` 达到 `limits.max_precheck_failures` 为 `precheck_exhausted`，`merge_failures` 达到 `limits.max_merge_failures` 为 `merge_exhausted`，`review_rounds` 达到 `review.max_rounds` 为 `review_exhausted`。预检或合并次数用尽的 task 只能 `/forge unblock`，不能 `/forge accept`。

### 只读与验收测试 task

```mermaid
stateDiagram-v2
    [*] --> ready
    ready --> in_progress: dispatch
    in_progress --> done: report（review、qa；impl 未 done 时的 acctest）
    in_progress --> checking: submit（impl 已 done 时的 acctest，第 9.5 节）
    checking --> queued_merge: precheck_pass（测试在已有实现上通过）
    checking --> done: precheck_fail_handoff（测试失败：为原 impl 创建 .fx-n）
    queued_merge --> merging: merge_start
    merging --> done: merge_done
    merging --> done: precheck_fail_handoff（失败全在本 .at 目录内）
    merging --> blocked: merge_blocked（目录外失败，integration_broken）
```

要点：

- `review`、`qa` 只走 `ready → in_progress → done`（结论由 `forge_review_report`、`forge_qa_report` 或对应的 confirm 工具提交，要求没有改动）。
- `acctest` 在 impl 尚未 done 时提交即 done，测试随 impl 的预检合入（仅显式开启 test-author 时存在 .at，偏离 118）；impl 已 done 时（S0 的 `.at`、覆盖率缺口、被契约追加破坏、变更请求）走上图的单独合并。
- `.at-n` 的来由有四种：争议、覆盖率缺口、别的 task 的契约追加破坏了测试（第 9.4 节）、变更请求。

## 3. 阶段验收（规格第 11 节；`stage-acceptance.ts`）

一个 S 阶段的 impl 全部结束后的编排。引擎每次 pump 时调用 `stageStep`，它只根据持久化的状态（task、evidence、事件）决定下一步，崩溃后重入结果相同（偏离第 59 条）。

```mermaid
flowchart TD
    W["阶段 active<br/>本阶段的 task 都已结束<br/>且没有未结束的变更请求"] --> L{"精简模式?"}
    L -- 是 --> RV["阶段审查 S1.rv<br/>（reviewer 看整个阶段的 diff）"]
    RV -->|"有 must"| FXR["生成 .fx-n 交给 worker<br/>再 S1.rv-2 只确认"] --> RV
    RV -->|"轮数用尽或阻塞"| NH
    RV -->|"通过"| G
    L -- 否 --> G["阶段 → awaiting_gate<br/>（submit_gate）"]
    G --> CHK["确定性检查：<br/>implementation_gate.auto 的命令<br/>+ AC 覆盖率矩阵（docs/qa/&lt;阶段&gt;.md）"]
    CHK -->|"命令失败"| FIX["按 task 归属生成 .fx-n<br/>最多 MAX_GATE_ROUNDS = 2 轮"]
    CHK -->|"覆盖率有缺口"| AT["给负责的 task 生成 .at-n 补测<br/>与门禁修复共用 2 轮"]
    FIX -->|"gate_failed：阶段回 active"| W
    AT -->|"gate_failed：阶段回 active"| W
    FIX -->|"轮数用尽或找不到负责的 task"| NH
    AT -->|"轮数用尽或找不到负责的 task"| NH
    CHK -->|"通过：记下通过时的 HEAD"| QAQ{"implementation_gate.qa ?"}
    QAQ -- 否 --> SIGN
    QAQ -- 是 --> QA["stage-qa S1.qa<br/>（阶段保持 awaiting_gate）"]
    QA -->|"有 must"| QFX["生成 .fx-n（标题含“S1.qa 第 k 轮”）<br/>gate_failed：阶段回 active"]
    QFX -->|"修复合并后"| W
    W -.->|"重跑检查通过后，S1.qa-2 只确认<br/>（最多 qa.max_rounds 轮）"| QA
    QA -->|"轮数用尽或阻塞"| NH
    QA -->|"pass 且门禁通过时的 HEAD<br/>与 qa 的 HEAD 都等于当前 HEAD"| SIGN
    SIGN["awaiting_human：等你签收<br/>/forge-approve，材料见 /forge report"]
    NH["needs_human（需要你处理）"]
    NH -->|"/forge accept 阶段 --note"| SIGN
    NH -->|"/forge gate"| G
    NH -->|"/forge-reject"| W
    SIGN -->|"/forge-reject（stage_reopened）"| W
    SIGN -->|"/forge-approve"| DONE["done：进入下一阶段<br/>最后一个阶段：合入主分支"]
```

要点：

- 只有"门禁通过时的 HEAD"和"最近一轮 stage-qa 的 HEAD"都等于当前集成分支 HEAD，才进入签收；修复合并之后 HEAD 变了，会重跑门禁和覆盖率，再让 stage-qa 做只确认的一轮。
- 变更请求处于 drafting、proposed 或 rejected 时，阶段门禁等待，因为批准后可能在本阶段新增 task。
- stage-qa 和阶段审查没有自己的 worktree，它们在集成分支 HEAD 的临时 detached worktree 里运行，结束后删除，主工作区没有任何改动（偏离第 62 条）。
- 覆盖率只对计划里有的 S 阶段计算（偏离第 60 条）。
- 签收被打回（`stage_reopened`）后，旧的 qa 与阶段审查轮次仍计入轮数上限，这是已知局限，可以 `/forge accept` 放行。
- 精简模式的 qa 与阶段审查的轮数用尽，也是转 `needs_human`。

## 4. 变更请求的生命周期（规格第 12.3、13.5 节）

变更请求存为 `changes/C-001.json`（偏离第 64 条）。

```mermaid
stateDiagram-v2
    [*] --> drafting: forge_change_request（worker 或主会话）<br/>或规格修订批准后自动发起（amend:A-xxx）
    drafting --> proposed: architect 在 doc task 里改计划与契约，<br/>forge_propose_plan 通过校验
    proposed --> approved: /forge-approve change:C-001
    proposed --> rejected: /forge-reject change:C-001 "意见"
    rejected --> drafting: 新的 architect task 带着意见返工（rounds + 1）
    approved --> [*]
    drafting --> cancelled: （存储里有，没有命令触发）
    cancelled --> [*]
```

```mermaid
flowchart LR
    R1["/forge-add 需求"] --> R2["主会话整理<br/>forge_spec_amend"]
    R2 --> R3["规格修订 A-001（proposed）<br/>列出变化的 AC 与受影响 task"]
    R3 -->|"/forge-approve amend:A-001"| R4["feature 文件提交到集成分支"]
    R4 -->|"计划已批准且 AC 有变化"| C["自动发起变更请求"]
    R4 -->|"否则"| R5["结束"]
    R3 -->|"/forge-reject amend:A-001"| R6["主会话带着意见重提"]
    W["worker 的 forge_change_request"] --> C
    C --> D["drafting → proposed → approved"]
    D --> E["同一事务落地：<br/>新增、调整、取消 task；<br/>已开始或完成的 task 用 modifies 新增后续 task；<br/>受影响的验收测试 .at-n；<br/>stages_revised"]
```

要点：

- 同一流程同时只能有一个未结束的变更请求（drafting、proposed、rejected 都算未结束），第二个直接拒绝。
- proposed 期间，被它调整的 task 暂停派发（偏离第 65 条）；architect 对契约的修改在你批准前就合入集成分支，当前计划取自最近一个已批准变更请求的 `plan_text`，所以被打回的修订不会污染基线。
- 已开始或已完成的 task 不能直接改或取消；要改就新增 task 并写 `modifies: T-xxx`，程序把它变成硬依赖原 task 的后续 task。
- 变更请求可以在当前阶段新增 task，可以新增或调整当前阶段之后的 S 阶段，不能改已完成的阶段。

## 5. fix 模式（规格第 13.4 节；`src/modes/fix.ts`）

`/forge-fix "<问题>"` 创建一个只有一个阶段 `X1` 的流程，不建 DAG、不跑阶段门禁，不派 `.at`，不做逐任务审查（偏离第 68 条）。

```mermaid
flowchart TD
    S["/forge-fix 问题描述"] --> C["检查：没有进行中的修复；<br/>build 流程运行中则拒绝，等待审批时需确认"]
    C --> T1["T-001（worker）<br/>定位 + 修复 + 回归测试<br/>writes = **"]
    T1 --> M["合并队列：rebase，冲突标记与 merge_check<br/>通过后直接合入主分支"]
    M --> Q1["X1.qa（stage-qa，只读）<br/>在主分支 HEAD 的临时 worktree 复现确认"]
    Q1 -->|"没有 must"| LOG["写修复日志<br/>.forge/fixes/&lt;日期&gt;-nnn.md<br/>X1 done"]
    Q1 -->|"有 must"| FX["生成 T-001.fx-n（worker，fork 会话）"]
    FX --> M2["再次合并验证并合入"]
    M2 --> Q2["X1.qa-2 只确认"]
    Q2 -->|"通过"| LOG
    Q2 -->|"仍有问题（最多 2 轮）"| NH["needs_human"]
    T1 -.->|"task 阻塞"| NH
    NH -->|"/forge accept --note"| LOG
    NH -->|"/forge abort"| X["中止"]
```

要点：

- 修复直接合入主分支，所以不需要 `/forge-approve`；"需要你处理"时用 `/forge accept --note "<说明>"` 放行。
- `implementation_gate.qa: false` 时跳过复现确认。
- `limits.fix_max_files` 只写进 handoff 提醒 worker，程序不强制。
- 同一时间只允许一个修复；用 `/forge abort` 中止。
