# pi-forge 开发笔记

记录已核实的事实、设计决定（"偏离规格"一节，相对最初的规格；规格已删除，见 git 历史）、真实模型实验的结论。细节以代码与测试为准，这里只写"现在是什么样、为什么"。
偏离按主题写现状：新决定改写或追加到对应主题，被取代的内容直接删掉（历史看 git）。代码注释与测试不引用本文条目。用户文档见 `README.md`，流程图见 `docs/flow.md`。

## 已验证版本

| 组件 | 版本 | 说明 |
|---|---|---|
| Node / git | 24.18.0 / 2.50.1 | 要求 ≥22 / ≥2.30；测试用原生 TS 类型剥离（只用可擦除语法） |
| Pi | `@earendil-works/pi-coding-agent` 1.1.0 | 10-10 由 1.0.0 升级，扩展 API 只有新增；1.0.3 起 Azure 提供方名为 `azure` |
| 运行时依赖 | typebox 1.3.27（Pi 提供，不打包）、minimatch 10.2.6、proper-lockfile 4.1.2、yaml 2.9.0 | 不新增 |
| 插件 | pi-codegraph 0.1.10（只读）、pi-web-access 0.35.0（需 `setActiveTools`）、pi-ask-user 0.2.1 | pi-rules 不能按角色挑规则，不用 |
| 浏览器技能 | pi-playwright 0.1.2（只有技能，调用 `@playwright/cli` 0.1.x；`npm run setup` 下 Chromium 约 98MB） | 每条命令在当前目录写 `.playwright-cli/` |

## Pi API（已核实）

实测＝真实 pi 进程（假模型 `test/fixtures/fake-llm/`）；源码＝读 `.d.ts`、源码或文档。用到新 API 时先核实再补进来。

| 能力 | 结论 | 核实 |
|---|---|---|
| 包与命令 | `pi install <npm:包 \| 路径>`（`-l` 写项目 `.pi/settings.json`）；`package.json` 的 `pi.extensions/skills/prompts`，扩展由 jiti 加载；`registerCommand` 的 `args` 是原始字符串，`pi -p "/cmd"` 不调用模型 | 实测 |
| 工具 | `registerTool({name, parameters, execute, prepareArguments})`，`prepareArguments` 在 schema 校验之前；`setActiveTools` 在 `session_start` 中生效；结果可含图片 | 实测、源码 |
| 拦截 | `on('tool_call')` 返回 `{block, reason}`，按扩展加载顺序执行，guard 必须最后加载；`event.input` 可原地改 | 实测 |
| 提示与事件 | `before_agent_start` 改 `appendSystemPrompt`，或返回 `{message: {customType, content, display}}` 追加一条上下文消息（发给模型时转成 user 消息）；系统提示中途变化时，不能表示的模型服务收到整份新前缀，缓存失效（1.1 extensions.md）；`message_end` 的 assistant usage = `{input（不含缓存）, output, cacheRead, cacheWrite, cost}` 与 `errorMessage`；`sendUserMessage(text, {deliverAs: 'followUp'})`；`sendMessage({customType, content, display}, {deliverAs: 'steer'})` 存一条自定义消息进会话，多个 `before_agent_start` 处理函数返回的消息都会追加（1.1 types.d.ts、runner.js）；不能表示中途系统消息的模型服务由 Pi 把所有系统消息合并成开头一条（pi-ai utils/transcript.js）；UI 在 RPC 模式经 `extension_ui_request` | 实测 |
| 子进程 | `pi --mode rpc --session-dir … [--fork <会话>] --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp -e … --model --thinking --tools --append-system-prompt`；提示经 stdin，`agent_settled` 后关 stdin 退出；`--no-mcp` 必须带（`--tools` 不过滤 MCP 工具） | 实测 |
| 出错 | 限流、过载、5xx、网络错误自动重试 3 次，额度用完不重试；上下文超限自动压缩；启动报错 `No API key found for …`、`Model "x" not found. Use --list-models`（自定义模型名的 `… Using custom model id.` 只是提醒） | 源码 |
| 工具行为 | bash `timeout` 单位秒，超时 SIGKILL 进程组，bash 以 detached 起新进程组；edit 的 `oldText` 必须唯一精确匹配；路径解析会归一 Unicode 空格、去 `@`、展开 `~` 与 `file://`（guard 同规则） | 源码、实测 |
| 思考级别 | `off/minimal/low/medium/high/xhigh/max`，按模型收窄（glm-5.3-flash 只有 low/high/xhigh） | 实测 |
| codemode | `-e builtin:codemode` 且 `--tools` 含 codemode；脚本里的工具调用照样经过 `tool_call` | 实测 |

## 已知局限

- guard 看不到脚本内部（`bash x.sh`、`npm run`），兜底是提交时的 diff 检查与受保护路径；打码只认常见密钥形态。
- 签收被打回后，旧的 stage-qa 轮次仍计入 `qa.max_rounds`，可 `/forge accept` 放行。
- 共享构建环境不卸载任务删掉的依赖；测试留下的数据文件不再清理，靠 `.gitignore` 与审查。
- 合并后回归测试与阶段门禁跑同一组命令：测试慢的项目每次合并多一次全量检查（后台运行，可用 `limits.post_merge_test: false` 关掉）。没有主会话的运行（`scripts/real-tasks`）里，交给主会话的决定没人处理，要用户直接处理。
- 没接命令或没审阅的：变更请求的 `cancelled`（`StateStore.cancelChange`）；`scripts/forge-view.*` 只做过渲染冒烟；`scripts/ablation/` 是 M8 的消融工具，很多臂的机制已删。

## 偏离规格

### 基线与命名
- 产品与命名空间用 forge（`.forge/`、`forge_*`、`/forge*`）；领域名词 flow（流程实例）照用，如 `FlowFile`、集成分支 `flow/<id>/integration`。
- 主会话角色叫 orchestrator，不用规格的 main（用户决定）。
- 主会话的系统提示只放稳定的角色提示与技能（P0 的技能进入 P1 时去掉，变一次）；每轮的状态与下一步作为一条上下文消息放在对话末尾（用户要求优化缓存，10-14）。原来写在系统提示末尾，每轮都变，记账 API 实验里主会话缓存命中只有 26%。
- 笔记（主会话与子进程的结构化笔记）只在上下文里没有最新一份时存进会话：一轮开始时笔记变了、压缩之后；notes 工具的结果本身带着完整笔记，接近压缩阈值的提醒也只存一次。原来每次请求都把笔记临时接在末尾，请求不再是上一次的追加，magpie 转发的 gpt 只认追加，从第一次写笔记起缓存不再增长（stock run-02：主会话每次约 9 万 token 只命中 9344，命中约 9%；architect 同样走 gpt，命中停在系统提示加第一条消息的约 1.7 万，整体 33%；GLM 的 worker 不受影响，87%）。e2e 用假模型检查主会话与子进程的相邻请求只在末尾追加。
- `.npmrc` 设 `legacy-peer-deps=true`：锁文件里没有 Pi 的 peer 依赖。
- `.forge` 迁移链 v1→v2（删 `.at`、争议）、v2→v3（删范围申请）。

### 规格与计划
- `/forge-build` 不必带 `--prd`（用户决定）：默认扫描项目 `docs/` 下用户的文档入库到 `docs/spec/inputs/docs/`；有文档时主会话只问疑点，没有时详细访谈。
- spec-lint 只把程序要解析的格式算错误（需求标题与编号、AC 编号、MVP 至少一条 AC）；GWT 写法、占位词、页面状态与引用、权限表、术语格式只警告，权限表的角色不必在术语表里，没有界面的项目可以不交 screens（10-14 约束清点，见 `docs/CONSTRAINTS-AUDIT.md`）。有错误整体拒绝；P0 必须人工批准。规格可以分几次交，没交齐（requirements、permissions、glossary）时只存草稿并提示还差哪几份，交齐才检查（stock 实验：四份一次交超出模型单次输出上限，截断两次）；之后（lint 不通过、门禁不过、用户打回，以及等批准时主会话还想改）只重交改动的那几份，其余沿用上一次提交（`.forge/flows/<id>/spec-draft/`）：一行的 lint 问题不必重新生成四份文档。AC 编号 `REQ-001.AC1`；AC 只写用户能感知的行为，单条 REQ 超过 6 条 AC 只警告；占位词只认大写独立的 `TODO`、`TBD`、"待定"。
- P1 由程序驱动 architect（不经主会话），返工接着上一个 task 的会话。`forge_propose_plan` 在 architect 的 worktree 上跑完整校验，闸门在集成分支上重跑。task 编号全流程连续，含此前流程与 `tests/acceptance/` 的目录名。
- 项目命令写在仓库根目录的 `commands.yaml`（用户决定 10-14）：architect 在 P1 写、S0 修正，worker 可以补充，随代码合并、合入即生效；程序只执行 install、test、acceptance、serve（及 serve_*）、env_up/env_down、db_create/db_drop、add_dep，其余只给 agent 参考。`workflow.yaml` 只放流程配置。规则由 S0 直接写。
- 契约只能追加（`plan/contract-diff.ts`）：集合位置可新增键，数组（含 required、enum）不能变，新列须可空或有默认值；可追加可选参数；不限制只改本模块的契约。基线是任务 worktree 与集成分支的合并基点。空文件视为不存在（architect 清空即可）。只在 `forge_submit` 时检查一次。
- 计划与契约只拦调度不了的（10-14 约束清点）：编号与阶段写错、S0 不是 1 个 task、依赖有环或依赖更晚阶段、契约不是合法 YAML。plan.yaml 多写的字段忽略、列表字段可缺；AC 与需求的分配、produces/requires、契约文件布局与命名都只提醒；writes 可以为空、可以含验收测试目录；术语表可以改。
- 契约只写 task 之间的边界（用户决定 10-14）：几个 task 共用的数据（只写名字、类型、引用与唯一约束，校验以规格为准）、公共错误码、被别的 task 调用的函数与 HTTP 接口；只有自己用的接口不写。原因：club 实验 92 行需求写出约 2100 行契约，字段规则写了三遍，各模块接口都没有别的 task 调用。计划核对符号时，只有别的 task requires 的产出才要求在契约里。
- 计划的提示（10-15，stock 实验后）：被多个 task 依赖的横切能力（登录与权限）放进 S0 或更早的阶段；`~` 软依赖也要等生产方审查合并后才能预检与合并，阶段内依赖链尽量一层（登录 → 分类 → 商品三环把 4 个并行 task 拖成串行）；S0 的符号不写进 requires；不建只做集成验收的 task。
- 计划不再有 `review` 与 `test_interface`（用户决定 10-14，旧计划里写了也忽略）：审查强度只由程序推导（底座、auth 层、`risk: high`），批准页列出强审查的 task 与原因；`risk: high` 只给权限与鉴权、金额计算、不可恢复的批量数据操作，过半 task 标 high 时提醒。原因：club 实验里 5 个增删改查 task 全被标成 strong 与 high（技能原写"删除数据时写 high"）。

### S0 与构建环境
- S0 的唯一 task 由 architect 做（bash full，worker 的工具）：建骨架、直接写 `rules/`（对它豁免受保护路径）、把共享类型与错误响应落成代码；S0 合入后 rules 生效。
- S0 一律人工签收；批准时集成分支（规格、契约、计划、骨架、rules、commands.yaml）先 `--no-ff` 合入主分支，集成分支再移到合入后的提交，之后的阶段照常在它上面做（用户决定 10-14）。代价：之后中止流程，主分支上的骨架不撤回；批准 S0 时主工作区不能有未提交的改动。
- Python 用 uv 的项目不共享 `.venv`（可编辑安装指向安装时的源码目录，共享会让各 worktree 测到旧代码）：每个 worktree 自己 `uv sync --frozen`，包从 uv 的全局缓存链接；guard 提醒不要用 pip 装包，加依赖用 `uv add`。`.venv/`、`__pycache__/`、`.pytest_cache/` 写进本地 exclude。
- 每个 S 阶段开始时建立或刷新共享构建环境 `<项目>.worktrees/.env-shared/`，worktree 链接依赖目录，不再各自 install；只追加根 package.json 依赖时装进共享环境（`forge_add_dependency`），改版本等用私有副本（`forge_private_deps`）。端口段（41000–60000）与数据库按运行分配。没有共享环境时（S0 期间）各工作区自己 install，只读工作区按锁文件哈希缓存。

### 调度与运行
- 两个池：实施 task 用 `max_parallel`，review、qa 用 `max_parallel_aux`。writes 只是调度优先级，重叠的也会并行（用户决定）。
- worker 与 S0 的 architect 可写工作区内任何文件，只排除受保护路径与 `docs/spec/**`（用户决定）；没有范围申请。
- 主会话的上下文（10-15，stock 实验：主会话 $20.6，占全部费用一半以上，gpt 缓存命中 12%）：P0 之后的状态不再带规格检查的警告（57 条约 4500 字，每次 forge_wait 都带）；forge_wait 超时又没有变化时只回两行概况。提交变更请求后立刻推进引擎，起草修订的 architect 不再等下一个任务结束才派发。主会话的系统提示在所有阶段都带 P0 的两份技能（约 3k token），离开 P0 时系统提示不变，缓存不失效。
- 失败处理：`run_timeout` 计入 attempts，由程序按进展决定接着做、从头做或交给用户；同样的失败连续两次先换升级模型，再换兜底模型（`models.fallback`、`/forge-config fallback` 或表格最后一行，所有角色共用，用户决定 10-14），都试过仍一样就阻塞；没有升级模型时，失败达到次数直接用兜底模型。任务要用的模型被暂停时改用兜底模型继续，原模型恢复后换回。子进程没提交就结束时按错误原文分类（`engine/failure-class.ts`）：额度、限流、配置错误暂停这个模型、不计任务失败（额度与配置要手动恢复），运行环境出错直接 blocked，其余计一次失败、带提示重试。运行中原地打转会结束本次运行并计一次失败；被 guard 拦下只记账，不因次数结束运行；没有按谱系的总预算（10-14 约束清点）。
- 子进程结束后清理它留下的进程，跳过仍在运行的 run 的进程树（审查、修复常与原任务共用 worktree）。
- 提升 pending → ready 时跳过已经不是 pending 的 task：有几处提升不在调度的串行队列里（`/forge next`、run 结束的回调），两处同时算出同一批时，后一个会报 ready → ready（stock run-02）。
- 需要拿主意的事先交给主会话（用户决定，10-14）：程序或子进程造成的阻塞（审查轮数用尽、合并失败、反复失败、子进程提问）、S 阶段门禁用尽、变更请求的修订，都由 orchestrator 用 `forge_decide` 决定（retry、accept、approve、reject，或转交用户）；它转交的、以及同一 task 它已决定 2 次之后的阻塞才等用户。用户始终可以直接处理；规格与阶段签收仍只由用户批准。出现新的待决定事项时给主会话发一条消息让它开始一轮（它这一轮已结束时没有别的东西会叫醒它）。
- 实施角色（bash full）的 bash 只按禁止列表拦（用户决定，10-14，列表写在 `guard.ts` 的 `IMPL_FORBIDDEN` 注释）：判断不了的（解析不了的命令、命令名或 rm/mv 参数含变量、`sh -c`、`eval`）放行，cd 不拦，兜底是提交时的 diff 检查；sed -i、tee 只查写入位置；`git reflog` 只拦 expire、delete、drop（run-03：只读的 reflog 被当成改写拦下）；共享依赖目录里用包管理器改依赖、uv 项目用 pip 只在结果后面提醒。只读角色仍按允许列表，但可以读其他提交。读取不限范围（含 `.forge/`），只拦敏感文件；`read_paths`、`max_violations_per_run` 已不再使用。`forge_service` 可以直接给命令（与 bash 同样检查）。
- 所有带 bash 的角色都可以联网（用户决定，10-14）：curl、wget 不限主机；实施角色的下载目标按写路径检查（不能写主工作区与受保护路径），只读角色不能把内容写进文件，stage-qa 在临时 worktree 里不另加限制；`git fetch`、`pull` 仍禁止（远程分支由引擎同步）。
- 工具的可选参数里的占位值（''、`N/A`、null）当作没传；`bash_allow` 没在 commands 定义的命令只告警；guard 的变量代入也作用于命令替换；`git` 设 `core.quotePath=false`。
- worker 与 reviewer 的任务说明带 requirements.md 的「通用约定」原文（截到下一个二级标题，最多 1.2 万字）：字段长度、字符、大小写、默认值、PATCH 语义按 spec-from-prd 不写成 AC，契约也不重复，而这两个角色不读规格，只有 stage-qa 读（stock run-01 到 run-03 字段规则都要到阶段验收或我打回才被发现，run-03 的 S2 因此打回 3 次）。放在任务说明而不是系统提示，不影响缓存。
- 任务说明带「已交付的接口」一节（计划不再写 test_interface：worker 自己写验收测试，不再限定入口，10-14）；上游 handoff 只带上游最后一次 run 写的段。

### 预检、审查与合并
- 每个 task 不跑预检命令，合并时也不跑测试（用户决定，省时间）：实现类任务的预检不做检查。每次合并后在后台对集成分支跑一遍门禁命令（`limits.post_merge_test`，默认开，用户决定 10-14）：变红时同一提交重跑一次排除不稳定，再在上一次通过之后的合并里二分，给第一个变红的合并建 `.fx-n`（同一 task 最多 2 次，之后交给门禁）；阶段门禁等它跑完，并沿用同一棵代码树上通过的结果。fix 流程没有阶段门禁，合并时仍跑 typecheck、lint、test。
- 没有 test-author（用户决定）：worker 自己写 `tests/acceptance/<T>/` 的验收测试。impl 一律审查，fix、doc、merge-fix 不审查；reviewer 读 diff，运行本 task 的单元测试与验收测试，检查每条 AC 都有带编号的测试且没被写弱。must 写明出处（`rule:`、`ac:`、`contract:`、`defect:`），程序不校验、不降级（10-14 用户决定：校验时去主分支找规则文件，S0 写的规则还在集成分支上，真缺陷被降成建议漏过）；确认轮不能新增问题，按关闭条件的目的判断（修在别处、有对应测试也算解决）。
- 页面 AC 的验收测试不开浏览器：只测页面路径返回 HTML、页面用到的接口、前端模块的纯逻辑；打开页面看交互与状态交给 stage-qa 的浏览器检查，reviewer 与 stage-qa 不因为没有浏览器测试判 must（run-03：reviewer 要求页面状态测试，worker 自己搭浏览器脚本，一次返工 50 分钟，脚本写死本机路径）。
- 审查者 forge_block 时只阻塞审查 task，原 task 留在审查中等它，forge_wait 会因审查 task 阻塞醒来（club run-02：原 task 一并阻塞，主会话对两者各 retry 一次，worker 与 reviewer 在同一个 worktree 里同时运行）。验收测试的 Given 可以用夹具直接写存储（准备所需的接口还没交付时），When 与 Then 走公开入口。
- 浏览器检查（用户决定，10-15；10-16 只留给 stage-qa：run-03 的 worker 用了 469 次浏览器命令，把浏览器脚本写进项目验收测试并写死本机路径，没看到因此发现的缺陷；stage-qa 用它发现了登录页空顶栏与启停清零金额）：pi-playwright 必须安装（项目级或用户级），没装不能开始流程；stage-qa 的角色提示固定写着这一节（子进程 `--no-skills`），技能位置用占位 `{{playwright-browser}}`，派发时换成按 Pi 用户目录（`getAgentDir()`）找到的实际路径，路径用正斜杠（Windows、macOS、Linux 的 node 与常见 shell 都认），同一台机器上提示不变；安装提示是两条独立命令（不用 cd、&&）。stage-qa 在隔离工作区里也能读、运行这个目录（子进程按同样的方法找到后传给 guard）；`.playwright-cli/` 记进本地 exclude（stock run-02：商品页打不开、错误条一直显示，只有在浏览器里看才发现）。
- 首轮审查说明列出本 task 软依赖的上游及其接口（要求用真实实现，不留替身或"合入后再换"）和 diff 里属于其他已完成 task 范围的文件（要求确认原功能还在）（stock run-02：T-013 改了商品页，页面在用到 `state` 前就引用了它，打不开；软依赖的替身合入后一直没换，审查只看本 task 的 AC，都没发现）。
- 合并：rebase；双方都只插入行的冲突由程序三方合并，合不了的交回正在合并的 worker（用户决定）；受保护文件冲突、主工作区有改动等阻塞先交给主会话；任务分支相对集成分支没有改动的阻塞为 `no_changes`，确认后视为完成（impl、fix、doc 提交时就没有改动的，直接完成，10-14）；提交不要求先写 handoff（提交说明自动记入），handoff 超长截断；doc、merge-fix 可以改验收测试；其他种类与主分支同步冲突走 merge-fix。之后只查冲突标记，build 流程不跑命令（轻流程跑 test；合并后验证失败的知识候选因此只在轻流程出现）。同一棵代码树的同一条命令只验证一次。工具不存在导致的命令失败按跳过处理并提醒。

### 阶段验收
- 门禁命令与覆盖率 → stage-qa → 修复 → 重跑 → stage-qa 只确认一轮 → 签收；门禁通过时与最近一轮 qa 的 HEAD 到当前 HEAD 之间只有程序记录的文档（审查建议、`docs/qa/`）时才签收。只依据持久化状态，崩溃后重入结果相同。原来要求 HEAD 相等：club 实验里 qa 带建议通过 → 建议提交让 HEAD 变化 → 重新验收，循环了 6 轮。
- 用户打回 S 阶段后，在本阶段有新的任务变化之前不重新提交门禁，主会话的下一步是用变更请求把修改加进本阶段（stock 实验：task 都已完成，打回 6 秒后又回到等签收，打回白费）。判断"还有 task 等派发"只看当前阶段：后面阶段的 task 总是 pending，算进来时打回意见轮不到主会话（stock run-02）。审查轮数用尽的阻塞原因带上最新一轮审查者的说明，不只是首轮原文（run-02：首轮写"上限是 50"，第二轮已改成 30 只差测试，主会话看到的还是 50）。
- stage-qa 轮数用尽后集成分支又有了改动（用户打回、变更请求的 task 合入），门禁通过后再开一轮只确认的 stage-qa，不按改动之前的结论交给用户；没有新改动时照常交给用户（stock run-03：S2 修完后门禁两次都按旧结论判用尽，修复没人复验）。
- 门禁失败建 `.fx-n`，2 轮；覆盖率只报告（签收时给用户看），缺口不拦门禁（10-14 约束清点：按 AC 逐条补测试是测试代码膨胀的原因之一）。修复归属先看各 task 合入时实际改动的文件，再看 writes，兜底给本阶段最后合入的 impl。
- stage-qa 在集成分支 HEAD 的临时 worktree 里运行，路径不能越出这个 worktree（主工作区、别的 worktree、`.forge/` 都拦）；系统临时目录可用，不查敏感文件（用户决定，10-14：club 与 m9 的 6 次运行里 stage-qa 被拦 33 次，全是 `rg -g '!*.pem'`、`printenv PORT` 与 `mktemp -d /tmp/…`）。
- 所有角色点名查看环境变量（`printenv PORT`）放行，只拦打印全部（不带参数的 `printenv`、`env`、`export` 等）：子进程继承 Pi 的全部环境变量，里面可能有 API key（用户决定，10-14）。
- 最后一个阶段批准时存交付汇报再 `--no-ff` 合入主分支；`/forge-status --metrics` 含速度、返工（含没提交就结束的 run 按类别计数）、成本、被拦下的操作。

### 变更请求、fix 与小改动
- 变更请求 drafting → proposed → approved/rejected，同时只能有一个；修订就绪后先由主会话审核（最多打回到第 3 轮），它可以转交用户；proposed 时就暂停被调整的 task，阶段门禁等待；architect 的说明带发起 task 的改动与 handoff；已开始的 task 用 `modifies` 新增后续 task；上一次修订加的修改 task 原样保留 `modifies` 不算新加（stock 实验：第二次变更请求因此被拒）。
- fix 与小改动都是单阶段 `X1` 的轻流程，直接合入主分支，最后由 X1.qa 确认（最多两轮）；同一时间只能有一个，build 运行时拒绝。小改动（用户决定）：`/forge-change --from <yaml>` 或 `forge_change`，1–3 个 impl task，不走 P0/P1 批准；实现合入后程序强制 architect 的「更新架构图与契约」task，不需要改时直接无改动提交。

### 删掉与没做的
- 10-12 删除（用户决定）：feature、adopt、规格修订、精简模式、test-author 与 `.at`、争议、范围申请。原因：后续功能由 agent 读架构图与 rules 完成，不走重流程。旧 workflow.yaml 里已删的键与工具只告警。
- 10-14 删除 researcher 角色（用户决定）：没有流程会派它，所有带 bash 的角色都已能联网。`web` 工具组（pi-web-access）留在模板里，默认不分配给任何角色，要用时在角色 tools 里加 `"@web"`。
- 10-13 删除 pi-serena：扩展工具只能只读或联网，写文件只用内置 write/edit。
- 10-13 评估「Stage 级共享工作区 + CAS」，不做：实验里 worktree 准备只要几秒、没有合并冲突，时间花在模型思考；共享工作区会让半成品互相干扰、失败算错人，bash 写入也无法纳入 CAS。

### 提示词与代码组织
- worker 带 `simplicity`、`receiving-feedback`、`acceptance-tests`，reviewer 带 `simplicity`、`acceptance-tests`；单元测试写法与过度工程只作 suggest；规则编号 `R<n>`，每文件不超过 5 条。
- `src/core/` 无环分层（state → security/workspace → verify/insight → spec → acceptance → plan → stage → engine → ops），`test/unit/core-layers.test.ts` 检查。测试分组见 `scripts/test-groups.ts`。

## 真实模型实验

- 对照：看板项目用原生 Pi（不走工作流）17.6 分钟、隐藏测试 39/40。M9（10-10、10-11）的教训已落实：test-author 零次抓到缺陷、争议循环 60 分钟以上 → 删 test-author；精简计划仍过重 → 删精简模式；范围申请硬拒导致失败 → 写入放开。
- 迷你看板（10-12，`scripts/real-tasks --suite mini-boards`，GLM-5.3-flash）：4 次运行逐步拆掉 writes、契约、互斥的墙，run4 5/5 合入、门禁通过、22 分钟、$0.23，stage-qa 抓到 1 个真缺陷。
- pi-forge 自身（10-13，`--suite pi-forge`，约 1.9 万行；worker GLM，审查与 QA gpt-6.1-sol）：big1 4/6 合入、31 分钟、$2.44（reviewer 占 $1.97），gpt 的 must 都是真漏洞，最慢的 worker 18.8 分钟里约 13 分钟是模型思考；big2（thinking low、并发 5）worker 5–26 分钟，7/12 完成时 $0.84，worktree 准备合计 5 秒，后因上游 502 未跑完。
- 记账 API（10-14，`scripts/real-build.ts` 全流程，`scripts/real-build-suites/ledger/`，主会话与规划 gpt-6.1-sol medium、worker glm-5.3-flash high）：计划 3 个阶段 9 个 task（S1 有 6 个可并行）；规格 9 分钟、architect 规划 13 分钟，S0 进行中时用户叫停（52 分钟），未计分。暴露命令草案只合并不替换。
- 社团管理 API（10-14，`scripts/real-build.ts`，`scripts/real-build-suites/club/`，配置同记账，`max_parallel` 5）：计划 3 个阶段 10 个 task，S1 的 5 个 task 同时开工、约 11 分钟全部审查通过并合入（worker 运行合计 35 分钟），worker $0.32、reviewer $1.63；S1 范围的隐藏测试 24/24。S1 的 stage-qa 因建议提交循环 6 轮，用户在 S2 进行中叫停（83 分钟），未计分。还暴露 must 出处校验去主分支找 S0 写的规则文件，真缺陷被降为建议。
- club run-02（10-14，修复出处校验、验收循环，S0 并入 main，契约只写边界后）：P1 9.6 分钟（run-01 15.8）、契约 134 行（run-01 约 2100）、architect $2.39；强审查只有 S0。S0 签收在第 27.5 分钟并已合入 main；S1 的 5 个 task 15.3 分钟合入，stage-qa 第 1 轮 2 条 must（真问题）→ 修复 → 第 2 轮转主会话放行，S0 签收到 S1 签收 27.1 分钟。S2 进行中 gpt-6.1-sol 额度用完（429），暂停超过 10 分钟，87 分钟时按基础设施故障结束，未计分；S1 范围隐藏测试 24/24。没跑完，不下效率结论。当时的待修（worker 与 reviewer 同时运行、reviewer 的入口要求与计划的存储造数矛盾）已在 10-15 修掉。
- club run-03（10-14，代码同 run-02）：P0 1.9、P1 签收 8.2、S0 签收 18.3、S1 签收 38.3 分钟（S1 的 5 个 task 在 S0 签收后 18.5 分钟合入）；契约 247 行。S2 进行中用户叫停（66 分钟）改 stage-qa 的拦截，未计分。
- stock run-01（10-15，约 1 万行前后端进销存，`scripts/real-build-suites/stock/`，PRD 加 14 个原型页；Claude Code 经 herdr 在交互式 Pi 里扮演用户；主会话与 architect gpt-6.1-sol medium，worker GLM-5.3-flash low，reviewer 与 stage-qa GLM max）：P0 18、P1 24、S0 48、S1 87 分钟，S2 收尾时用户叫停（约 4 小时 40 分钟），未计分。观察：审查比写代码慢（每个 task 审查合计 17–29 分钟，写 6–25 分钟）；S1 的软依赖链让 4 个并行 task 实际串行；GLM 三个角色合计约 $2.4，主会话 $20.6、architect $10.9；stage-qa 没发现规格把"保存为大写"压缩错导致的缺陷，我实测发现后打回。暴露的程序问题已在 10-15 修掉（打回无效、修订误报 modifies、规格必须一次交齐、forge_wait 撑大主会话、变更请求派发延迟）。没跑完，不下效率结论。
- stock run-02（10-15，同 run-01 的 PRD 与隐藏测试，原型补了各种状态；代码 ca05b40；reviewer 与 stage-qa 改 GLM high，其余同 run-01；方案 `~/pi-forge-runs/stock/PLAN-run-02.md`）：跑完交付，隐藏测试 52/52（一期 18、二期 15、三期 5、页面 13、持久化 1），约 9900 行（后端 1.8k、前端 3.8k、测试 4.3k）。用时 P0 19、P1 17、S0 20、S1 33、S2 85、S3 55、S4 74 分钟，共 5 小时 4 分钟（含我检查与约 10 分钟 gpt 额度中断）。计划 S0 加 4 期 13 个 task，同阶段软依赖最多一层，S2、S3 各 4 个 task 并行；每个 task 写代码中位数 11 分钟、审查合计中位数 8.5 分钟（run-01 审查 17–29 分钟），审查轮数中位数 2，3 个 task 用尽轮数交主会话后都由它放行解决。费用 $31.6：主会话 $20.9（缓存命中 12%，S1 签收时只有 $0.9，之后被返工叫醒时每次 $0.3–0.5）、architect $7.2（34%）、GLM 三个角色 $3.5。规格照抄了"保存为大写"。stage-qa 在 S2、S3、S4 都提出了有依据的 must（字段规则偏离、changeStock 三套实现、非法日期 500），漏了上级分类不存在返回 404（我跑隐藏测试发现）；前端没人在浏览器里看过：S4 的 T-013 让商品页完全打不开、销售单列表错误条常显，审查、stage-qa、隐藏测试都放过，我用浏览器发现后打回。介入：P0 两次回答、各阶段签收、S2 与 S4 各打回一次、S2 打回后提醒主会话用变更请求（nextStep 只看到后面阶段的 pending task）、额度恢复后提醒一次。暴露的程序问题见 10-15 晚的修复（打回意见被后面阶段的 pending 盖住、用尽轮数的原因显示首轮原文、门禁提示叫用户执行 /forge gate、P0 等批准时不能重交、笔记每次接在末尾让缓存不增长）；还没修：引擎偶发 ready→ready 非法转移报错（不影响推进），软依赖的消费方先写替身、合并后没换回（stage-qa 兜住了）。
- stock run-03（10-15 晚，同 run-02 的 PRD、原型、隐藏测试与配置；代码 ca05b40 加未提交改动：笔记存进会话、主会话系统提示各阶段不变、浏览器检查、跨 task 审查提醒、打回意见只看当前阶段；方案 `~/pi-forge-runs/stock/PLAN-run-03.md`）：S3 的 stage-qa 进行中时用户叫停（约 7 小时 10 分钟，S3 四个 task 都已合入，S4 没做），未计分；叫停时一期隐藏测试 18/18。用时 P0 21、P1 15、S0 18、S1 100、S2 150、S3 120 分钟以上。观察：缓存命中主会话 99%（$3.1）、architect 94%（$2.0）、worker 98%、reviewer 与 stage-qa 93%，合计 $9.7；architect 的命中随调用增长，不再停在 1.7 万。worker 每次模型调用的耗时与 run-02 相同（9.1 秒对 9.4 秒），慢在调用次数：S1–S3 用了 1889 次（run-02 S1–S4 共 1910 次），其中浏览器命令 469 次；T-004、T-009 把浏览器脚本写进了项目的验收测试（`tests/acceptance/*/browser.js` 写死本机 `~/.pi` 下的路径），调试这些测试占了单个 run 的大半，审查没指出。stage-qa 用浏览器发现了登录页空顶栏（`display:flex` 盖掉 `hidden`）和启停把金额清零，S0 首页 favicon 404 也提了。S2 我打回 3 次（SKU 没转大写、q 只有空格不报 400、stage-qa 第 4 轮才提出的 PATCH 清零与长度上限），每次走一遍变更请求，主会话都自己提了变更请求；第 3 次修完后门禁仍以旧的 stage-qa 结论判轮数用尽、不再重新验收（`stage-rounds.ts` 的轮数按整个阶段算，变更请求的 task 不挂在任何一轮上），`/forge gate` 也一样，最后由主会话读代码核实后放行。其他：guard 把只读的 `git reflog` 当改写拦下。没跑完，不下效率结论。
- 实验暴露并已修的程序问题：残留进程清理误杀同一 worktree 的下一个 run；guard 不代入命令替换里的变量；审查池按全部在途任务计数。

## 缓存提醒

修改 `agents/`、`rules/`、`skills/` 会改变子进程系统提示的稳定前缀，提示缓存失效一次。改动时在此追加一行。

- 10-09 至 10-12：多次改动 agents 与 skills（改名 orchestrator、M9 提示词调整、写入放开、去掉 test-author、共享环境、删减功能、S0 由 architect 做、小改动），每次相关角色的缓存各失效一次。
- 10-13：`agents/architect.md` 去掉 serena、`skills/plan-dag/SKILL.md` 改 writes 与 test_interface 两行；模板去掉 serena 工具组。architect、worker、reviewer、stage-qa 的缓存各失效一次。
- 10-14：删除 `agents/researcher.md`，模板去掉 researcher 角色与 research 范围。其他角色的系统提示不变，缓存不受影响。
- 10-14：`agents/orchestrator.md`（forge_decide）、`agents/reviewer.md` 与 `skills/code-review`（确认轮按目的判断）、`skills/write-rules`（uv 命令）；`forge_block` 与 `forge_change_request` 的工具描述也改了。所有子进程角色与主会话的缓存各失效一次。
- 10-14：`agents/orchestrator.md` 与 `skills/spec-from-prd` 各改一句（规格只重交改动的那几份）；主会话的状态从系统提示移到消息。主会话的缓存失效一次，子进程角色不受影响。
- 10-14：约束清点后改了 `agents/architect.md`、`agents/worker.md`、`skills/plan-dag`、`skills/design-contract`、`skills/spec-from-prd`（提醒与错误的说法），并去掉 agents、skills、rules 里提到旧项目来源的句子（`rules/global.md`、`skills/` 下 9 个技能）；`forge_service`、`forge_spec`、`forge_note` 的工具描述或参数也变了。所有子进程角色与主会话的缓存各失效一次。
- 10-14：`agents/architect.md`、`agents/reviewer.md`、`skills/write-rules`、`skills/plan-dag` 把"命令草案"改成 `commands.yaml`，去掉 merge_check。子进程角色的缓存失效一次。
- 10-14：club 实验后改了 `agents/architect.md`、`agents/reviewer.md`、`agents/worker.md`、`skills/design-contract`、`skills/plan-dag`、`skills/acceptance-tests`、`skills/code-review`、`skills/write-rules`（契约只写边界、去掉 review 与 test_interface、risk 收窄、出处不再校验）；`forge_review_report`、`forge_qa_report` 的工具描述也改了。architect、worker、reviewer、stage-qa 的缓存各失效一次。
- 10-15：stock 实验后改了 `agents/orchestrator.md`（规格可以分次交）、`agents/reviewer.md` 与 `skills/acceptance-tests`（Given 可以用夹具准备）、`skills/plan-dag`（横切能力靠前、阶段内依赖链、requires 不写 S0 符号、不建只做集成的 task）、`skills/spec-from-prd`（PRD 的字段规则照抄）；`forge_spec` 的工具描述也改了。主会话、architect、worker、reviewer 的缓存各失效一次。
- 10-15：run-02 中途修复：`forge_spec` 的工具描述改了一句（等批准时也能重交）；笔记改为存进会话而不是每次请求接在末尾。主会话的缓存失效一次，子进程角色不受影响。
- 10-15：`agents/worker.md`、`agents/stage-qa.md` 与 `skills/stage-qa` 加了浏览器检查（技能 playwright-browser），stage-qa 不再写"不打开浏览器"。worker 与 stage-qa 的缓存各失效一次。
- 10-15：`agents/orchestrator.md` 改了一句（worker 与 stage-qa 会用无界面浏览器）；主会话的系统提示改为所有阶段都带 P0 的两份技能。主会话的缓存失效一次，之后离开 P0 不再失效。
- 10-16：`agents/worker.md` 去掉浏览器检查一句，`agents/orchestrator.md` 改一句（只有 stage-qa 用浏览器）。worker 与主会话的缓存各失效一次。
- 10-16：`skills/acceptance-tests`、`skills/tdd`、`skills/code-review`、`skills/stage-qa`、`agents/reviewer.md` 改了页面测试的要求（不开浏览器，页面交给 stage-qa）。worker、reviewer、stage-qa 与 S0 的 architect 缓存各失效一次。
