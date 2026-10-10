# e2e 改写核对（6146bc8）

## 范围与做法

- **核对对象**：提交 `6146bc8` 改写的 22 个 e2e 文件。
- **剔除**：只是把公共工具搬进 `test/helpers/commands.ts` 的改动，包括 `env`、`drive`、`write`、`done` 改成 `engineEnv`、`drive`、`writeFiles`、`submitWork`、`commandEnv`。
- **逐条对照**：剩下的断言变化，逐条对照 `docs/BUILD_PROMPT.md` 与 NOTES 的偏离条目。
- **结论分三类**：
  - **符合**：改写后的断言与规格或偏离一致。
  - **削弱**：丢了覆盖，已在 M8.5 恢复。
  - **加强**：比原来测得更多。

## 逐条结论

| 文件 / 用例 | 原断言 | 现断言 | 依据 | 结论 |
|---|---|---|---|---|
| acctest-workspace：隔离工作区在项目之外 | `!workspace.startsWith(p.dir)` | `!workspace.startsWith(p.dir + '/')` | 第 9.2 节：工作区在 `<项目>.worktrees/` 下，路径字符串以项目路径为前缀，但不在项目目录内 | 符合（原断言本身有误） |
| contract-merge：根 openapi.yaml 并行追加 | 后合并者 rebase 冲突时被结构化合并 | 预检前同步时冲突、被结构化合并 | 第 12.2 节 + 偏离 73 | 符合。合并队列那一处的结构化合并因此失去覆盖（消融 `contract-merge-at-queue-off` 证实），记在评审 F5 |
| crash-recovery：合并中强杀 | test 命令一直慢 | 只在合并的资源目录（`merge-*`）里慢 | 测试意图是"在合并途中强杀"；预检也跑 test，一直慢会让用例停在预检 | 符合 |
| gates：门禁两轮修复 | 修复 task 叫 `T-003` | 修复 task 叫 `T-001.fx-1`/`.fx-2`，`for_task` 是 T-001 | 第 11.1 节（按 task 生成 `.fx-n`） | 符合 |
| knowledge：合并后验证失败生成知识候选 | 带 FAIL 的提交在合并时失败 | FAIL 只有和集成分支上后来的文件放在一起才失败（`beforeMerge` 钩子在第一次合并前提交该文件） | 预检已经会拦下单独的 FAIL；合并验证的价值正是"预检之后集成分支的移动"（消融 `merge-verify-off`） | 符合，场景更接近真实情况 |
| loops：模块谱系预算 | `max_attempts`、`max_merge_failures` 放宽到 10 | 另把 `max_precheck_failures` 放宽到 10 | 用例测的是谱系预算（`module_runs`），前提是"各个计数都没用完"；原用例为同样的原因放宽了另两个计数。用默认值 3 时，第二轮会先撞上预检上限，测的就不再是谱系预算 | 符合，保留放宽。M8.5 加了一条断言把前提写明：预检失败发生过，但没到上限 |
| p0-flow：规格修订批准 | 提示"M7 实现" | 计划还没批准时只提交修订，不发起变更请求 | 第 13.5 节 + 偏离 67（计划已批准且 AC 有变化时才自动发起变更请求） | 符合 |
| precheck：两个并行预检的端口 | ports.log 里恰好 2 行 | 只看 `forge_pc_` 开头的 2 行 | 两个 task 合入后门禁也会跑 test，写进同一个日志 | 符合 |
| disputes：`acc.sh` | 不管参数跑全部验收测试 | `-- <task>` 只跑该 task 的目录 | 第 8.2 节（预检跑 `acceptance -- <task>`）；夹具要能区分预检与合并 | 符合 |
| disputes：§9.4 | 默认 test 命令 | test 命令为 `true` | 默认命令要求 T-001 的文件，先合并的 T-002 过不了预检；与被测的 9.4 无关 | 符合 |
| change-request：变更请求全流程 | T-004 发起变更后 `forge_block`；T-003 的依赖没有完成；断言"T-003 没派发" | T-004 发起后完成自己的工作并合入；T-003 依赖 T-004，此时已 `ready`；断言"T-003 是 ready 但没派发" | 第 12.3 节 + 偏离 65（proposed 期间暂停被调整的 task） | **加强**：原断言是平凡成立的（T-003 本来就派发不了）。编号后移是因为起草修订的 architect task 占了 T-005（偏离 34） |
| stage-acceptance：精简模式跨阶段接续 | `s2.forkFrom` 非空 | 等于上一阶段最后一个 worker 运行（`.fx-1`）的会话文件 | 第 7.6 节 + 偏离 63 | **加强** |
| commands：`/forge-build` | 缺 `--prd` 报错；帮助里写 `--prd <文件或目录>` | 去掉"缺参数"；帮助改为 `["<项目名>"]` | 偏离 71（不再必须带 `--prd`） | 符合 |
| merge-queue：语义冲突 | T-002 等 T-001 done 才提交 | 两个都预检通过后才开始合并（`beforeMerge`），T-002 在合并后验证里被拦下 | 预检前同步（第 8.1 节）让"等 T-001 done 再提交"变成预检就失败；要测合并验证，必须在预检之后移动集成分支 | 符合；`merge_failures`、`attempts`、失败原因的断言都保留了 |
| merge-queue：合并时全量（原"提交后直接进合并队列，合并失败退回……"） | 合并时 test 失败 → 回到 worker、`merge_failures`=1、`attempts`=0、两轮 evidence | 只断言 evidence 文件名 | — | **削弱**：失败退回的部分由"语义冲突"用例覆盖，没有丢失 |
| single-task：删掉"合并时全量测试失败：回到 in_progress 重新派发并带上失败原因" | 重新派发的提示里含"上次未通过的原因……合并后验证失败（…test 退出码 1）"，转移含 `merge_verify_fail:merging->in_progress` | （删除） | — | **削弱，全仓库再没有别的用例覆盖**。M8.5 已在"语义冲突"用例里恢复这两条断言 |
| pi-subprocess（真实 pi）：失败退回 | 完整的转移序列 | 只断言"含 `precheck_fail`"与"最后是 `merge_done`" | 失败点从合并改为预检，序列应完整重写，而不是放宽 | **削弱**。M8.5 恢复为完整序列：`submit, inputs_ready, precheck_fail, submit, inputs_ready, precheck_pass_skip, merge_start, merge_done` |
| merge-queue：批量合并 | 坏的 T-003 在 FAIL 时单独就失败 | 坏的 T-003 只有和 T-001 叠加才失败；用例对合并顺序有依赖 | 第 12 节批量合并 | 符合，但**有偶发失败**（评审 F7）。M8.5 第 1 步已改为确定的合并顺序（T-003 最后进队） |
| fix、cost-control、lease-session、model-pause、p1-flow、rules-draft、sync | — | 只有公共工具的替换，以及随之调整的辅助参数 | — | 无断言变化 |

## 结论

- 一共 2 处削弱，都已恢复：`single-task` 删掉的失败原因断言，以及 `pi-subprocess` 被放宽的转移序列。
- 2 处加强：`change-request` 与 `stage-acceptance`。
- 其余改写都有规格或偏离条目作为依据。
- 改写本身没有引入用错依据的断言。但其中两条反映的问题已记入评审：
  - 合并队列那一处契约结构化合并已经走不到（F5）；
  - 语义冲突的责任落在后合并者身上（F7）。
