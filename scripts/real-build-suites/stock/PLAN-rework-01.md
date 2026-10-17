# stock rework-01 实验方案（草稿，开跑前定稿；跑不跑由用户决定）

同 run-01 到 run-04、native-01 的项目（小仓库进销存，约 1 万行，三期）。第一次用改造后的流程跑：PRD 与原型驱动、架构阶段 S0 一次定下契约与计划、后端按 domain 并行、前端一个 agent 按页面顺序做、每批浏览器验收后签收。

## 输入

- `scripts/real-build-suites/stock/PRD.md`：由原来的 requirement.md 改写，内容不变，只改格式与编号（16 条 REQ、63 条 AC、页面表 14 行对应 14 个原型文件；`src/core/spec/prd.ts` 解析无警告）。驱动脚本复制到被测项目的 `docs/PRD.md`。
  - 编号：REQ-001 服务启动与存储（原"技术约束"里可测的 4 条）、REQ-002 登录与权限、REQ-003–007 第一期、REQ-008–012 第二期、REQ-013–015 第三期、REQ-016 页面通用要求；"技术约束""通用约定""不做的"保留为不带编号的节。
  - 页面表把原来一行的"采购单列表与详情""销售单列表与详情"各拆成两行，因为对应两个原型文件。
- `prototype/`：不变，复制到 `docs/prototype/`。
- `hidden.mjs`：不变，52 条（一期 18、二期 15、三期 5、页面 13、持久化 1）。
- 代码版本：改造第 1–7 步全部合入后的提交，开跑前记下 sha，工作区要干净。

## 怎么跑

由 `scripts/real-build.ts` 驱动（不再由 Claude Code 通过 herdr 扮演用户）：建空仓库 → `/forge init` → 写实验配置 → 放入 PRD 与原型并提交 → RPC 模式的主会话里 `/forge-build "stock"` → 架构批准与每批签收都发 `/forge-approve`，最后一批的"确认合入"选确认 → 交付后在 main 上跑 hidden.mjs。

```
node scripts/real-build.ts --suite scripts/real-build-suites/stock --max-parallel-backend 3 --out ~/pi-forge-runs/stock/rework-01b
node scripts/real-build.ts --suite scripts/real-build-suites/stock --max-parallel-backend 1 --out ~/pi-forge-runs/stock/rework-01a
```

两组按这个顺序各跑一次（先跑 3：它是模板默认值，也是主要假设）。脚本扮演的用户只做规则表里的事（`scripts/real-build/user.ts`）：

- 等批准 → `/forge-approve`；阶段 needs_human → `/forge accept <阶段>`（每阶段最多 2 次）。
- task 阻塞：agent 提问 → `/forge unblock "按你的推荐做，以 PRD 和契约为准"`；失败次数用尽、程序停下 → `/forge unblock`（必要时 `--reset`）；审查轮数用尽或没有改动且主会话已转交 → `/forge accept`。每个 task 最多放行 3 次。等架构师回答的阻塞不处理。
- 主会话弹出的选择框选推荐项，输入框回"按你的推荐"。
- 规则表以外的情况算流程失败，不即兴处理。**不打回**（run-04 也没有打回，只有一次放行 T-004）。

交付后由我（Claude Code）用浏览器检查 13 个页面，做法同 run-04：造数据，登录走页面表单，记录打不开、控制台报错、失败请求、常驻错误提示、一直"加载中"。

上限 480 分钟，30 分钟没有任何活动算卡住，模型暂停超过 10 分钟算基础设施故障（时间照算，同 run-02）。跑的过程中不改代码，发现的程序问题记在运行目录的 notes.md，跑完再修。

## 配置

| 角色 | 模型 | 思考 | 与 run-04 |
|---|---|---|---|
| orchestrator（主会话） | magpie/codex/gpt-6.1-sol | medium | 同 |
| architect | magpie/codex/gpt-6.1-sol | medium | 同；现在还要写 plan.md 与全部契约（run-04 的 P1 由它做，S0 也由它做） |
| backend、frontend | magpie/workbuddy/glm-5.3-flash | low | 同 run-04 的 worker |
| reviewer、stage-qa | magpie/workbuddy/glm-5.3-flash | high | 同 |

- 升级关闭；兜底模型 glm-5.3-flash；项目不建 codegraph 索引；pi-ask-user 不装；pi-playwright 0.1.2；Pi 1.1.0（脚本开跑前断言）。
- 并行：`limits.max_parallel_backend` 一组 1、一组 3；前端固定 1 个。run-04 是 `max_parallel` 5，不分前后端。
- 其余 workflow.yaml 取模板默认值（审查最多 2 轮、stage-qa 最多 2 轮、门禁默认命令含 `arch_check`、`contract_check`，没定义的跳过）。
- 与 run-04 的其他不同：没有 P0（规格问答）与 P1（计划批准），PRD 直接作为需求依据；用户由脚本扮演；没有变更请求，技术问题走 `forge_ask_architect`。
- reviewer 与写代码用同一个模型（改造方案建议用不同模型）：为了和 run-04 可比，这次不换。

## 假设（与 run-04 对比；结论只看跑完的数据）

- H1 冲突更少：合并冲突 + 同步冲突 < 13（run-04 合并 5、同步 8，几乎都在 T-003 写死页面清单的那一行）。
- H2 返工更少：写代码角色的返工 run < 27（run-04 worker 27 个：冲突 13、审查打回与主会话重试 14）。
- H3 质量不降：隐藏测试 52/52；交付后 13 个页面没有打不开、控制台报错、失败请求、常驻错误提示。
- H4 不更慢、不更贵：/forge-build 到交付 ≤ 334 分钟（run-04 含 P0 19、P1 14 分钟）；费用 ≤ $7.2。
- H5 后端并行有用：`max_parallel_backend` 3 比 1 的开发阶段（S1…Sn 合计）更快，冲突不更多。

和 native-01（原生 Pi 单会话，glm-5.3-flash high：84 分钟、$1.77、52/52、13 个页面正常、4.9k 行）对照，回答同一个问题：工作流相对单会话，多花的时间与费用换来了什么。开跑前的预期是仍然更慢、更贵，看质量差别。

## 指标（口径同 run-04；脚本写进 summary.json，已用 run-04 的 .forge 核对：费用、命中率、返工 27、冲突 5/8、审查轮数 32、各阶段用时都与 NOTES 记录一致）

1. 各阶段耗时：`stages`，按事件日志的阶段转移算墙钟时间与等用户的时间（与 `/forge-status --metrics` 同口径）；`wall_min` 是 /forge-build 到交付。对照时 run-04 的 P0 + P1 + S0 对新流程的 S0（架构），run-04 的 S1–S4 合计对新流程的 S1…Sn 合计（批次数可能不同）。
2. 各角色费用：`usage.by_role`，每个角色的模型调用次数、命中率（命中 /（输入 + 命中））、费用、工具调用、浏览器命令数；按会话文件逐次调用统计，同一角色里条目 id 与时间相同的只算一次（续做的 run 会复制之前的会话）。新流程的 backend + frontend 对 run-04 的 worker。
3. 返工 run 数：`rework.rework_runs`，backend、frontend（及 worker）同一任务第一个 run 之后的 run；architect 单列；修复任务（.fx）的 run 单列在 `fix_runs`。
4. 冲突次数：`rework.conflicts`，事件日志里 `merge_conflict` 与 `sync_conflict` 的次数。
5. 审查轮数：`rework.review_rounds`（.rv 任务数）与轮数最多的任务。
6. 其他：隐藏测试按组（`hidden`）；项目自带测试（`project_tests`）；介入次数（`interventions`：闸门、额外介入按类）；架构师咨询次数（`.forge` 里 kind 为 consult 的任务，手工统计）；交付后代码行数（排除 node_modules、data，分后端、前端、测试）；13 个页面的浏览器检查结果。

留档：`~/pi-forge-runs/stock/rework-01{a,b}/` 下的 summary.json、metrics.txt（`/forge-status --metrics` 与最后一次 `--detail`）、hidden.json、interventions.jsonl、rpc.jsonl、main-session/、project/。

## 对照表（跑完填）

| | run-04 | native-01 | rework-01a（1） | rework-01b（3） |
|---|---|---|---|---|
| 用时（分钟） | 334（P0 19、P1 14、S0 37、S1 51、S2 70、S3 95、S4 46） | 84 | | |
| 费用 | $7.2（主会话 1.1、architect 1.4、worker 3.2、reviewer 0.7、stage-qa 0.8） | $1.77 | | |
| 返工 run | 27 | — | | |
| 冲突（合并/同步） | 5 / 8 | — | | |
| 审查轮数 | 32（T-004 7 轮） | — | | |
| 隐藏测试 | 52/52 | 52/52 | | |
| 13 个页面检查 | 无问题 | 无问题 | | |
| 介入 | 1（放行 T-004） | 3 次"对照检查" | | |

## 跑完怎么记结论

- 每组一条，写进 NOTES.md 的"真实模型实验"，格式同 run-04：代码版本与本方案路径、是否跑完、隐藏测试与页面检查、各阶段用时、各角色费用与命中率、返工、冲突、审查轮数、介入，再写观察到的现象与 H1–H5 各自成立与否。
- 没跑完的只写看到了什么，不下效率或质量结论。
- 暴露的程序问题列在条目末尾，跑完再修，修了的写明"已修"。
