# 第一次核对的决定（回复 Claude Code）

你的核对很到位，27 条基本都成立。决定如下，已经全部并入 `docs/BUILD_PROMPT.md` v2（第 21 节列出了改动处）。请用 v2 替换旧版，读完后给出 M0 的计划。

## 先拍板的三件事

1. **基线：同意。** 运行时取 HEAD `31f3f15`，流程层（modes/plan、stages、revision、acceptance、final-review、requirements、gates、modes/fix）取 `7006e7d`。记一条偏离。
2. **M0 拷贝范围：同意。** 拷贝 HEAD 的整个 `src/` 与 `test/`；流程层的 7006e7d 版本另存到 `legacy/` 作参考，不参与构建。未归类文件的处理按你的建议（v2 第 16 节）。
3. **严重类第 2 到 7 条：** 见下面的第 2 到 7 条。

## 逐条决定

| # | 决定 | v2 位置 |
|---|---|---|
| 1 | 同上 | §1、§16 |
| 2 | 新增 `forge_read({path, ref?, offset?, limit?})`，由程序从集成分支读取；PRD 与原型由 HEAD 的 intake 入库，并在 P0 第一轮提示中注入文件清单 | §13.1 |
| 3 | 新状态 `awaiting_inputs`：要等最新 `.at-*` done，**并且**软依赖的生产方 done；然后程序把集成分支同步进任务分支，再跑预检。同步有冲突时回到 worker。软依赖的含义变成"并行开工，预检和合并在后" | §7.3、§8.1 |
| 4 | test-author **不用 git worktree，改用独立仓库**：`git archive` 导出允许的路径，`git init`，不共享对象库；提交后程序只取验收目录里的文件，以补丁形式应用。guard 再拦截绝对路径、`..`、`.forge/`、读取对象的 git 子命令。monorepo 用 `acctest_workspace.include` 导出子包清单；生成的代码由程序在里面跑 codegen。S0 的完成标准包含"隔离工作区里能 install 和 list"；实在做不到的项目降级为 worktree 加 guard，记入 NOTES | §9.2、§7.5、§19 |
| 5 | S0 的 `.at` 在 impl 合并后才派发 | §5、§7.4 |
| 6 | 契约按模块拆文件（`paths/<模块>.yaml`、`errors/<模块>.yaml`），worker 只能追加到自己模块的文件；`docs/contracts/**` 的冲突先做结构化三方合并，双方都只是追加且键不重复时自动合并，否则走 merge-fix，不再一律 blocked | §6、§12.2 |
| 7 | 程序分配 `FORGE_PORT_BASE`/`PORT`/`FORGE_DB_NAME`/`FORGE_TMP`；S0 的命令必须遵守 | §4.1 |
| 8 | `done` 是终态。争议、覆盖缺口、被契约追加破坏，都创建 `.at-n`；第二轮审查创建 `.rv-2`；修复创建 `.fx-n` | §2 第 17 条、§7.4 |
| 9 | 等待的 `.at` 或生产方 blocked 时，列进"需要你处理"并写明原因。争议时 worker 的运行结束、释放租约，task 进入 `disputed`。结果有三种：test 修改 → 直接重跑预检；维持 → fork worker；交给用户。`/forge-decide <task> keep-test\|fix-test "<说明>"` | §8.1、§9.3 |
| 10 | 失败计数分开：`precheck_failures`、`review_rounds`、`merge_failures`、`disputes`，各有上限；`attempts` 只计运行失败。task 级用 blocked，阶段级用 needs_human，两者都列在"需要你处理" | §8.1、§20 |
| 11 | 合并队列选**第一个合格**的 task，不是严格的队首。由于第 3 条的改动，消费方在生产方 done 之前不会进入队列 | §8.1 |
| 12 | P1 批准时程序写入 S 阶段记录（事件 `stages_planned`）；闸门由 `workflow.yaml` 的 `implementation_gate` 定义；变更请求只能新增或调整当前阶段之后的阶段（`stages_revised`） | §5、§15 |
| 13 | 新增 `forge_spec_amend`（main 用），写到 `docs/spec/features/<日期>-<名字>.md`，需要用户批准，批准后自动发起变更请求。`/forge-add` 和签收打回都走规格修订。architect 对 glossary 只能追加 | §13.5 |
| 14 | 失败的测试属于另一个 task 的验收目录时，不计入当前 task 的失败，而是为那个 task 创建 `.at-n`（fork 它的 test-author），当前 task 回到 `awaiting_inputs`。test-adjust 排除 `tests/acceptance/**` | §9.4 |
| 15 | 除 main 外，所有角色的 `read_paths` 排除 `.forge/**`；test-author 的隔离工作区只导出 `docs/spec`、`docs/contracts`、`docs/arch/overview.md`、`AGENTS.md`、`tests/acceptance` 与配置清单，不包含 `docs/review`、`docs/qa`、`docs/plan` | §9.2、§10.2、§14 |
| 16 | fix task：按"最后一个 writes 覆盖该文件的已完成 impl task"归属，按 task 分组（不按角色）；不创建新的 `.at`；预检跑原 task 的验收目录；不做逐任务审查，由 stage-qa 的确认轮核对 | §11.1 |
| 17 | lean 模式：跨阶段时 fork 上一阶段 worker 的会话（受大小上限约束）；阶段末 `.rv` 审查一次，必须改的生成 `.fx`，`.rv-2` 只确认，仍未解决转 needs_human | §7.6 |
| 18 | guard 新增 `allowlist` 档：只读命令加上角色 `bash_allow` 中按名字引用的 commands | §14.1 |
| 19 | M9 的门槛改为：精简模式的 **agent 时间**（扣除等待人工的时间）不超过原生的 3 倍，与 pi-flow BENCHMARK-5 的"3 倍"一致；标准模式只记录、不设门槛。新增 P0 用户模拟脚本（每个问题都答"按推荐"）。`--prototype` 改为可选 | §17、§18 |
| 20 | 同意，不加 OpenAPI 依赖；用 yaml 做结构解析，合法性交给 `contract_lint` | §1 |
| 21 | 采用你的建议：动 `required`、动 `enum`、新增必填请求字段，都算修改。完整表格见 v2，记入 NOTES | §12.1 |
| 22 | 字段已补全（含 `module`、`risk` 与四个计数） | §16 |
| 23 | `review` 不再有默认值：写了就以写的为准；没写时按 strong → skip → auto 的顺序推导。`critical_fanout` 的边界是大于等于 | §10.1 |
| 24 | `/forge accept <task\|阶段> --note`：放行审查轮数用尽的 task，或 needs_human 的阶段 | §13.2 |
| 25 | feature 文件含需求、页面、权限三节；spec-lint 与覆盖率把基线和所有 feature 文件合并处理；权限矩阵中被修改的行在批准页单独列出 | §13.3 |
| 26 | main 补上 notes、history。采用 HEAD 的 `forge_request_scope`（worker）、`forge_resolve_scope`（main）、`forge_service`（stage-qa），语义沿用 HEAD；M0 汇报时说明 HEAD 的具体行为 | §13.1、§14 |
| 27 | 路径已修正为 `~/Documents/Code/program/pi-flow` | CLAUDE.md、§1 |

## 另外

- 角色提示、技能和 `templates/workflow.yaml` 也同步更新了（main 用 `forge_read`；test-author 改为隔离工作区；契约按模块拆文件；workflow 新增 `implementation_gate`、`acctest_workspace`、`bash_allow` 等）。请一并替换。
- 如果你在 v2 里又发现了矛盾，照样按严重程度列出，不要自己选一种做法直接实现。
