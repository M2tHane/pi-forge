# 第二次核对的决定（回复 Claude Code）

决定都已经并入 `docs/BUILD_PROMPT.md` v3（第 21 节是修订记录）。角色提示、技能、规则和 `templates/workflow.yaml` 也同步更新了，请一并替换。

## 第 1 节的两处遗漏

- **#15**：模板里的 researcher 已经补上 `read_paths: ["**", "!.forge/**"]`。`read_paths` 的语义定为：按 gitignore 规则从上到下匹配，后面的覆盖前面的，`!` 表示排除。guard 的 `matchesAny` 要改成这种有序匹配（v3 第 14 节）。
- **#21**：同意，M0 新建 NOTES.md 时写进去。

## 第 2 节：严重类

| # | 决定 | v3 位置 |
|---|---|---|
| 1 | **选 (a)**：S0 的 worker 是唯一的例外，可以写 `tests/acceptance/_support/**` 和一个冒烟测试 `tests/acceptance/S0-smoke/**`。冒烟测试证明框架能用，**不计入 AC 覆盖率**。S0 exit 的 AC 仍由 S0 的 `.at` 覆盖，以保持独立性 | §5、§6、§7.5 |
| 2 | 新增 §9.5"单独合并的验收测试"：impl 已经 done 时，`.at` 提交后程序在集成分支的临时 worktree 中合入测试并运行。通过的话，按普通 task 进入合并队列；失败的话，`.at` 以 report 结束，并为原 impl 创建 `.fx-n`，它的分支基于"集成分支 + 这批测试"。`.fx-n` 的 worker 可以修实现，也可以对测试提出争议；测试随 `.fx-n` 一起合并。这条路径的失败不计入任何 impl 的计数。S0 的 `.at`、覆盖缺口、被契约追加破坏、变更请求引出的 `.at-n`，都走这条路径 | §8.1、§9.5 |
| 3 | **选 (b)**：worker 可以在根文件 `paths` 下追加一条引用，值只能是 `$ref: './paths/<自己的模块>.yaml#/...'`，预检核对形式；冲突交给结构化合并处理。根文件的 `components` 只放公共 schema，实施中不能改；模块自己的 schema 放 `components/<模块>.yaml`。不选 (a)，因为生成的合并文件要么提交（会冲突），要么每个 worker 都要能生成（需要额外工具），比 (b) 复杂 | §6、§12.2、design-contract 技能 |
| 4 | **同意你在第 3.1 节的方案**：HEAD 的包内容放进 `test/fixtures/pi-flow-package/`，测试改为引用它，只改测试；M0 的 `pi -e` 和 `/forge doctor` 在用夹具模板初始化的临时项目里验证。config 适配 v3 模板放在 M1（M1 的内容里已写明） | §16、§18 |
| 5 | **同意你给出的导出基准**：`.at-n` 用 集成分支 HEAD + `acc/<task>` 最新提交 + 任务分支相对集成分支在 `docs/contracts/**` 上的改动；impl 已 done 时只用集成分支 HEAD | §9.2 |

## 第 2 节：中等类

| # | 决定 | v3 位置 |
|---|---|---|
| 6 | 签收被打回：阶段回到 active（事件 `stage_reopened`），修改 task **新增在当前阶段**，完成后重新执行门禁、覆盖率和 stage-qa，再次签收。变更请求的规则相应放宽：可以在当前阶段新增 task，可以新增或调整之后的阶段；不能改已完成的阶段，也不能改当前阶段里已开始的 task | §5、§11、§12.3 |
| 7 | 规格修订有三种写法：新增 `### REQ-031`；整条替换 `### REQ-012（修订）`（AC 编号相同视为同一条，新编号视为新增，消失的视为删除）；整条删除 `### REQ-012（删除）`。**生效规格** = 基线 + `features/` 下的文件按文件名顺序叠加；spec-lint、覆盖率、DAG 都使用生效规格。程序比较新旧两版，列出变化的 AC 及受影响的 task 和测试 | §13.5 |
| 8 | `/forge-approve [<对象>]`、`/forge-reject [<对象>] "<意见>"`，对象写成 `stage:<id>`、`amend:<id>`、`change:<id>`。只有一个在等批准时可以省略；有多个时，程序列出清单并要求写明 | §13.2 |
| 9 | 拆成四条转移：`decide_keep`（blocked → in_progress）、`decide_fix`（blocked → disputed）、`accept`（blocked → queued_merge，**只用于** review_exhausted）、`unblock [--reset]`（blocked → in_progress）。预检或合并次数用尽的 task **不能 accept**，因为代码没有通过验证，只能 unblock | §8.1、§13.2 |
| 10 | 扩大可写范围**沿用 HEAD**，由 main 用 `forge_resolve_scope` 批准，另外加三类程序硬限制（main 也批不了）：`tests/acceptance/**`、`docs/spec/**`、别的模块的契约文件。隐式授予收窄：`forge_service` 只给 worker 和 stage-qa；`forge_request_scope` 只给 worker | §14 |
| 11 | **`bash:` 字段是唯一依据**：写了这个字段，程序就注册 bash 工具并按档位拦截；`tools` 里不再写 `bash` 或 `bash_readonly`；没写的角色没有 bash。`!` 的语义见上面 #15 | §14.1、模板 |
| 12 | `acctest_workspace`（`include`、`cache`）写在 workflow.yaml。architect 在 `docs/rules-draft/commands.yaml` 的 `acctest_workspace` 键下起草，`rules-draft` 批准时连同 `commands`、`gui_commands` 一起应用（扩展应用的键） | §15、plan-dag 与 write-rules 技能 |
| 13 | 顺序改为先 install 再 codegen。加缓存：`acctest_workspace.cache` 列出的目录（例如 `node_modules`）按锁文件哈希缓存在 `<项目>.worktrees/.acctest-cache/<hash>/`，命中时用硬链接复制，跳过 install | §9.2 |
| 14 | test-author 新建的辅助文件只能放在 `_support/<本 task>/` 下；`_support/` 的公共文件只有 S0 的 worker 能建。这样就不会撞名。值得共享的工具由 stage-qa 作为 suggest 提出 | §6、§9.2、test-author 提示与技能 |

## 第 2 节：较低类

| # | 决定 |
|---|---|
| 15 | **同意你的归类**：scope、flow-watch、notify、timing 只改名；finish-report 改编为交付汇报；planning.ts 删除；intake 归为小改（改入库路径） |
| 16 | **同意**：`.forge` 格式版本从 1 开始，清空迁移步骤，保留迁移框架；具体在 M1 定 |
| 17 | 已改成"预检和合并都排在生产方之后"。这时运行时还没有，提示缓存失效没有影响 |
| 18 | 分配记录放在 `<项目>.worktrees/.resources.json`，写明 run id、pid、端口段、数据库名，用文件锁保护。正常结束时释放；`/forge-resume` 与 `/forge doctor --fix` 回收 run 已结束或 pid 已不存在的条目，并删除 `FORGE_TMP`。SQLite 放在 `FORGE_TMP` 下；服务器类数据库用可选的 `commands.db_create`、`db_drop`，以 `FORGE_DB_NAME` 调用；不提供这两个命令时，由项目自己的命令按需建库（S0 负责） |

## 第 3 节：M0 计划

- **打包内容的处理**：同意（见上面 #4）。
- **保留领域名词 flow**：同意。`FlowFile`、`flowId`、`.forge/flows/<id>/`、`active_flow` 等保留。角色名和阶段编号在 M1、M2 改编时再换。
- **M0 不 skip 测试**：同意，按你的理由。"M1 起随改编替换的流程层测试"清单记进 NOTES。通知测试的偶发失败按你的方法修（只改测试），记一条偏离。
- **M0 结束时提交 git：要提交。** 第一次提交包含我放进去的 docs、agents、skills、rules、templates，以及 M0 的全部改动。之后每个里程碑结束、我确认以后各提交一次，提交信息写里程碑编号和要点。
- **拷贝清单、改名规则、legacy/ 的内容**：都按你的计划执行。

可以开始 M0。完成后按 CLAUDE.md 汇报，其中要说明 HEAD 里 scope 和 service 的实际行为，以及它们和 v3 第 14 节的差异。
