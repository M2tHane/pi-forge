# pi-forge 开发笔记

记录已核实的事实、偏离规格（`docs/BUILD_PROMPT.md`）的决定、真实模型实验的结论。细节以代码与测试为准，这里只写"现在是什么样、为什么"。
偏离按主题写现状：新决定改写或追加到对应主题，被取代的内容直接删掉（历史看 git）。代码注释与测试不引用本文条目。用户文档见 `README.md`，流程图见 `docs/flow.md`。

## 已验证版本

| 组件 | 版本 | 说明 |
|---|---|---|
| Node / git | 24.18.0 / 2.50.1 | 要求 ≥22 / ≥2.30；测试用原生 TS 类型剥离（只用可擦除语法） |
| Pi | `@earendil-works/pi-coding-agent` 1.1.0 | 10-10 由 1.0.0 升级，扩展 API 只有新增；1.0.3 起 Azure 提供方名为 `azure` |
| 运行时依赖 | typebox 1.3.27（Pi 提供，不打包）、minimatch 10.2.6、proper-lockfile 4.1.2、yaml 2.9.0 | 与 pi-flow 相同，不新增（规格第 1 节第 6 条） |
| 复用来源 | pi-flow：运行时 `31f3f15`，流程层 `7006e7d` | 旧流程层放在 `legacy/` 作参考，不参与构建 |
| 插件 | pi-codegraph 0.1.10（只读）、pi-web-access 0.35.0（需 `setActiveTools`）、pi-ask-user 0.2.1 | pi-rules 不能按角色挑规则，不用 |

## Pi API（已核实）

实测＝真实 pi 进程（假模型 `test/fixtures/fake-llm/`）；源码＝读 `.d.ts`、源码或文档。用到新 API 时先核实再补进来。

| 能力 | 结论 | 核实 |
|---|---|---|
| 包与命令 | `pi install <npm:包 \| 路径>`（`-l` 写项目 `.pi/settings.json`）；`package.json` 的 `pi.extensions/skills/prompts`，扩展由 jiti 加载；`registerCommand` 的 `args` 是原始字符串，`pi -p "/cmd"` 不调用模型 | 实测 |
| 工具 | `registerTool({name, parameters, execute, prepareArguments})`，`prepareArguments` 在 schema 校验之前；`setActiveTools` 在 `session_start` 中生效；结果可含图片 | 实测、源码 |
| 拦截 | `on('tool_call')` 返回 `{block, reason}`，按扩展加载顺序执行，guard 必须最后加载；`event.input` 可原地改 | 实测 |
| 提示与事件 | `before_agent_start` 改 `appendSystemPrompt`；`message_end` 的 assistant usage = `{input（不含缓存）, output, cacheRead, cacheWrite, cost}` 与 `errorMessage`；`sendUserMessage(text, {deliverAs: 'followUp'})`；UI 在 RPC 模式经 `extension_ui_request` | 实测 |
| 子进程 | `pi --mode rpc --session-dir … [--fork <会话>] --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp -e … --model --thinking --tools --append-system-prompt`；提示经 stdin，`agent_settled` 后关 stdin 退出；`--no-mcp` 必须带（`--tools` 不过滤 MCP 工具） | 实测 |
| 出错 | 限流、过载、5xx、网络错误自动重试 3 次，额度用完不重试；上下文超限自动压缩；启动报错 `No API key found for …`、`Model "x" not found. Use --list-models`（自定义模型名的 `… Using custom model id.` 只是提醒） | 源码 |
| 工具行为 | bash `timeout` 单位秒，超时 SIGKILL 进程组，bash 以 detached 起新进程组；edit 的 `oldText` 必须唯一精确匹配；路径解析会归一 Unicode 空格、去 `@`、展开 `~` 与 `file://`（guard 同规则） | 源码、实测 |
| 思考级别 | `off/minimal/low/medium/high/xhigh/max`，按模型收窄（glm-5.3-flash 只有 low/high/xhigh） | 实测 |
| codemode | `-e builtin:codemode` 且 `--tools` 含 codemode；脚本里的工具调用照样经过 `tool_call` | 实测 |

## 已知局限

- guard 看不到脚本内部（`bash x.sh`、`npm run`），兜底是提交时的 diff 检查与受保护路径；打码只认常见密钥形态。
- 签收被打回后，旧的 stage-qa 轮次仍计入 `qa.max_rounds`，可 `/forge accept` 放行。
- 契约追加检查有提交时、预检时两层，e2e 只覆盖提交那层；要删一层时先给预检补 e2e。
- 共享构建环境不卸载任务删掉的依赖；测试留下的数据文件不再清理，靠 `.gitignore` 与审查。
- 合并后回归测试与阶段门禁跑同一组命令：测试慢的项目每次合并多一次全量检查（后台运行，可用 `limits.post_merge_test: false` 关掉）。没有主会话的运行（`scripts/real-tasks`）里，交给主会话的决定没人处理，要用户直接处理。
- 没接命令或没审阅的：变更请求的 `cancelled`（`StateStore.cancelChange`）；`scripts/forge-view.*` 只做过渲染冒烟；`scripts/ablation/` 是 M8 的消融工具，很多臂的机制已删。

## 偏离规格

### 基线与命名
- 改名只改产品与命名空间（`pi-flow`→`pi-forge`、`.flow/`→`.forge/`、`flow_*`→`forge_*`、`/flow*`→`/forge*`）；领域名词 flow（流程实例）保留，如 `FlowFile`、集成分支 `flow/<id>/integration`。
- 主会话角色叫 orchestrator，不用规格的 main（用户决定）。
- `.npmrc` 设 `legacy-peer-deps=true`：锁文件里没有 Pi 的 peer 依赖。
- `.forge` 不兼容旧 pi-flow 状态；迁移链 v1→v2（删 `.at`、争议）、v2→v3（删范围申请）。

### 规格与计划
- `/forge-build` 不必带 `--prd`（用户决定）：默认扫描项目 `docs/` 下用户的文档入库到 `docs/spec/inputs/docs/`；有文档时主会话只问疑点，没有时详细访谈。
- spec-lint 有错误整体拒绝；P0 必须人工批准。AC 编号 `REQ-001.AC1`；AC 只写用户能感知的行为，单条 REQ 超过 6 条 AC 只警告；占位词只认大写独立的 `TODO`、`TBD`、"待定"。
- P1 由程序驱动 architect（不经主会话），返工接着上一个 task 的会话。`forge_propose_plan` 在 architect 的 worktree 上跑完整校验，闸门在集成分支上重跑。task 编号全流程连续，含此前流程与 `tests/acceptance/` 的目录名。
- 批准 P1 时在主工作区应用命令草案 `docs/rules-draft/commands.yaml`，再生成 S 阶段与 task；规则由 S0 直接写。草案是完整的命令表，应用时替换整张 `commands`（模板默认的 typecheck、lint 等不在草案里就去掉；只合并时留下了跑不了的 pnpm 命令）。
- 契约只能追加（`plan/contract-diff.ts`）：集合位置可新增键，数组（含 required、enum）不能变，新列须可空或有默认值；可追加可选参数；不限制只改本模块的契约。基线是任务 worktree 与集成分支的合并基点。空文件视为不存在（architect 清空即可）。术语表只追加。

### S0 与构建环境
- S0 的唯一 task 由 architect 做（bash full，worker 的工具）：建骨架、直接写 `rules/`（对它豁免受保护路径）、把共享类型与错误响应落成代码；S0 合入后 rules 生效。
- Python 用 uv 的项目不共享 `.venv`（可编辑安装指向安装时的源码目录，共享会让各 worktree 测到旧代码）：每个 worktree 自己 `uv sync --frozen`，包从 uv 的全局缓存链接；guard 不让 pip 装包，加依赖用 `uv add`。`.venv/`、`__pycache__/`、`.pytest_cache/` 写进本地 exclude。
- 每个 S 阶段开始时建立或刷新共享构建环境 `<项目>.worktrees/.env-shared/`，worktree 链接依赖目录，不再各自 install；只追加根 package.json 依赖时装进共享环境（`forge_add_dependency`），改版本等用私有副本（`forge_private_deps`）。端口段（41000–60000）与数据库按运行分配。没有共享环境时（S0 期间）各工作区自己 install，只读工作区按锁文件哈希缓存。

### 调度与运行
- 两个池：实施 task 用 `max_parallel`，review、qa 用 `max_parallel_aux`。writes 只是调度优先级，重叠的也会并行（用户决定）。
- worker 与 S0 的 architect 可写工作区内任何文件，只排除受保护路径与 `docs/spec/**`（用户决定）；没有范围申请。
- 失败处理：`run_timeout` 计入 attempts，由程序按进展决定接着做、从头做或交给用户；同样的失败连续两次先换升级模型，再换兜底模型（`models.fallback`、`/forge-config fallback` 或表格最后一行，所有角色共用，用户决定 10-14），都试过仍一样就阻塞；没有升级模型时，失败达到次数直接用兜底模型。任务要用的模型被暂停时改用兜底模型继续，原模型恢复后换回。子进程没提交就结束时按错误原文分类（`engine/failure-class.ts`）：额度、限流、配置错误暂停这个模型、不计任务失败（额度与配置要手动恢复），运行环境出错直接 blocked，其余计一次失败、带提示重试。运行中原地打转或 guard 违规满额会结束本次运行并计一次失败。
- 子进程结束后清理它留下的进程，跳过仍在运行的 run 的进程树（审查、修复常与原任务共用 worktree）。
- 需要拿主意的事先交给主会话（用户决定，10-14）：程序或子进程造成的阻塞（审查轮数用尽、合并失败、反复失败、子进程提问）、S 阶段门禁用尽、变更请求的修订，都由 orchestrator 用 `forge_decide` 决定（retry、accept、approve、reject，或转交用户）；它转交的、以及同一 task 它已决定 2 次之后的阻塞才等用户。用户始终可以直接处理；规格与阶段签收仍只由用户批准。出现新的待决定事项时给主会话发一条消息让它开始一轮（它这一轮已结束时没有别的东西会叫醒它）。
- 实施角色（bash full）的 bash 只按禁止列表拦（用户决定，10-14，列表写在 `guard.ts` 的 `IMPL_FORBIDDEN` 注释）：判断不了的（命令名、`sh -c`、`eval`、重定向目标含变量）放行，兜底是提交时的 diff 检查；sed -i、tee 只查写入位置。只读角色仍按允许列表。
- 所有带 bash 的角色都可以联网（用户决定，10-14）：curl、wget 不限主机；实施角色的下载目标按写路径检查（不能写主工作区与受保护路径），只读角色不能把内容写进文件，stage-qa 在临时 worktree 里不另加限制；`git fetch`、`pull` 仍禁止（远程分支由引擎同步）。
- 工具的可选参数里的占位值（''、`N/A`、null）当作没传；`bash_allow` 没在 commands 定义的命令只告警；guard 的变量代入也作用于命令替换；`git` 设 `core.quotePath=false`。
- 任务说明带「允许的测试入口」「已交付的接口」两节；上游 handoff 只带上游最后一次 run 写的段。

### 预检、审查与合并
- 每个 task 不跑预检命令，合并时也不跑测试（用户决定，省时间）：预检只查契约只能追加。每次合并后在后台对集成分支跑一遍门禁命令（`limits.post_merge_test`，默认开，用户决定 10-14）：变红时同一提交重跑一次排除不稳定，再在上一次通过之后的合并里二分，给第一个变红的合并建 `.fx-n`（同一 task 最多 2 次，之后交给门禁）；阶段门禁等它跑完，并沿用同一棵代码树上通过的结果。fix 流程没有阶段门禁，合并时仍跑 typecheck、lint、test。
- 没有 test-author（用户决定）：worker 自己写 `tests/acceptance/<T>/` 的验收测试。impl 一律审查，fix、doc、merge-fix 不审查；reviewer 读 diff，运行本 task 的单元测试与验收测试，检查每条 AC 都有带编号的测试且没被写弱。must 的出处只能是 `rule:`（须指向存在的规则条目）、`ac:`、`contract:`、`defect:`，否则降为 suggest；确认轮不能新增问题，按关闭条件的目的判断（修在别处、有对应测试也算解决）。
- 合并：rebase；双方都只插入行的冲突由程序三方合并，合不了的交回正在合并的 worker（用户决定）；受保护文件冲突、主工作区有改动等阻塞先交给主会话；任务分支相对集成分支没有改动的阻塞为 `no_changes`，确认后视为完成；其他种类与主分支同步冲突走 merge-fix。之后只查冲突标记与 `merge_check`。同一棵代码树的同一条命令只验证一次。工具不存在导致的命令失败按跳过处理并提醒。

### 阶段验收
- 门禁命令与覆盖率 → stage-qa → 修复 → 重跑 → stage-qa 只确认一轮 → 签收；门禁通过时与最近一轮 qa 的 HEAD 都等于当前 HEAD 才签收。只依据持久化状态，崩溃后重入结果相同。
- 门禁失败与覆盖率缺口都建 `.fx-n`，共用 2 轮；归属先看各 task 合入时实际改动的文件，再看 writes，兜底给本阶段最后合入的 impl。
- stage-qa 在集成分支 HEAD 的临时 worktree 里运行，bash 参数不能引用主工作区路径。
- 最后一个阶段批准时存交付汇报再 `--no-ff` 合入主分支；`/forge-status --metrics` 含速度、返工（含没提交就结束的 run 按类别计数）、成本、被拦下的操作。

### 变更请求、fix 与小改动
- 变更请求 drafting → proposed → approved/rejected，同时只能有一个；修订就绪后先由主会话审核（最多打回到第 3 轮），它可以转交用户；proposed 时就暂停被调整的 task，阶段门禁等待；architect 的说明带发起 task 的改动与 handoff；已开始的 task 用 `modifies` 新增后续 task。
- fix 与小改动都是单阶段 `X1` 的轻流程，直接合入主分支，最后由 X1.qa 确认（最多两轮）；同一时间只能有一个，build 运行时拒绝。小改动（用户决定）：`/forge-change --from <yaml>` 或 `forge_change`，1–3 个 impl task，不走 P0/P1 批准；实现合入后程序强制 architect 的「更新架构图与契约」task。

### 删掉与没做的
- 10-12 删除（用户决定）：feature、adopt、规格修订、精简模式、test-author 与 `.at`、争议、范围申请。原因：后续功能由 agent 读架构图与 rules 完成，不走重流程。旧 workflow.yaml 里已删的键与工具只告警。
- 10-14 删除 researcher 角色（用户决定）：没有流程会派它，所有带 bash 的角色都已能联网。`web` 工具组（pi-web-access）留在模板里，默认不分配给任何角色，要用时在角色 tools 里加 `"@web"`。
- 10-13 删除 pi-serena：扩展工具只能只读或联网，写文件只用内置 write/edit。
- 10-13 评估「Stage 级共享工作区 + CAS」，不做：实验里 worktree 准备只要几秒、没有合并冲突，时间花在模型思考；共享工作区会让半成品互相干扰、失败算错人，bash 写入也无法纳入 CAS。

### 提示词与代码组织
- worker 带 `simplicity`、`receiving-feedback`、`acceptance-tests`，reviewer 带 `simplicity`、`acceptance-tests`；单元测试写法与过度工程只作 suggest；规则编号 `R<n>`，每文件不超过 5 条。
- `src/core/` 无环分层（state → security/workspace → verify/insight → spec → acceptance → plan → stage → engine → ops），`test/unit/core-layers.test.ts` 检查。测试分组见 `scripts/test-groups.ts`。

## 真实模型实验

- 对照（pi-flow）：看板项目原生 Pi 17.6 分钟、隐藏测试 39/40。M9（10-10、10-11）的教训已落实：test-author 零次抓到缺陷、争议循环 60 分钟以上 → 删 test-author；精简计划仍过重 → 删精简模式；范围申请硬拒导致失败 → 写入放开。
- 迷你看板（10-12，`scripts/real-tasks --suite mini-boards`，GLM-5.3-flash）：4 次运行逐步拆掉 writes、契约、互斥的墙，run4 5/5 合入、门禁通过、22 分钟、$0.23，stage-qa 抓到 1 个真缺陷。
- pi-forge 自身（10-13，`--suite pi-forge`，约 1.9 万行；worker GLM，审查与 QA gpt-6.1-sol）：big1 4/6 合入、31 分钟、$2.44（reviewer 占 $1.97），gpt 的 must 都是真漏洞，最慢的 worker 18.8 分钟里约 13 分钟是模型思考；big2（thinking low、并发 5）worker 5–26 分钟，7/12 完成时 $0.84，worktree 准备合计 5 秒，后因上游 502 未跑完。
- 记账 API（10-14，`scripts/real-build.ts` 全流程，`scripts/real-build-suites/ledger/`，主会话与规划 gpt-6.1-sol medium、worker glm-5.3-flash high）：计划 3 个阶段 9 个 task（S1 有 6 个可并行）；规格 9 分钟、architect 规划 13 分钟，S0 进行中时用户叫停（52 分钟），未计分。暴露命令草案只合并不替换。
- 实验暴露并已修的程序问题：残留进程清理误杀同一 worktree 的下一个 run；guard 不代入命令替换里的变量；审查池按全部在途任务计数。

## 缓存提醒

修改 `agents/`、`rules/`、`skills/` 会改变子进程系统提示的稳定前缀，提示缓存失效一次。改动时在此追加一行。

- 10-09 至 10-12：多次改动 agents 与 skills（改名 orchestrator、M9 提示词调整、写入放开、去掉 test-author、共享环境、删减功能、S0 由 architect 做、小改动），每次相关角色的缓存各失效一次。
- 10-13：`agents/architect.md` 去掉 serena、`skills/plan-dag/SKILL.md` 改 writes 与 test_interface 两行；模板去掉 serena 工具组。architect、worker、reviewer、stage-qa 的缓存各失效一次。
- 10-14：删除 `agents/researcher.md`，模板去掉 researcher 角色与 research 范围。其他角色的系统提示不变，缓存不受影响。
- 10-14：`agents/orchestrator.md`（forge_decide）、`agents/reviewer.md` 与 `skills/code-review`（确认轮按目的判断）、`skills/write-rules`（uv 命令）；`forge_block` 与 `forge_change_request` 的工具描述也改了。所有子进程角色与主会话的缓存各失效一次。
