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
- `scripts/forge-view.*` 只做过渲染冒烟。`scripts/real-tasks/`（跳过主会话的驱动）没跟新流程适配，还是把 worker 任务直接种进 S1。
- 页面任务没有 `ac`：PRD 不区分页面 AC 与接口 AC，程序只在任务说明里列页面表的对应需求；没写 `reqs` 的 domain 同样没有 AC 清单。
- 页面归属按路径里出现的页面 id 认：后端目录名含页面 id、又没有别的归属时会归给页面任务。

## 偏离规格

### 基线与命名
- 产品与命名空间用 forge（`.forge/`、`forge_*`、`/forge*`）；领域名词 flow（流程实例）照用，如 `FlowFile`、集成分支 `flow/<id>/integration`。
- 主会话角色叫 orchestrator，不用规格的 main（用户决定）。
- 主会话的系统提示只放稳定的角色提示与技能；每轮的状态与下一步作为一条上下文消息放在对话末尾（用户要求优化缓存，10-14）。原来写在系统提示末尾，每轮都变，记账 API 实验里主会话缓存命中只有 26%。
- 笔记（主会话与子进程的结构化笔记）只在上下文里没有最新一份时存进会话：一轮开始时笔记变了、压缩之后；notes 工具的结果本身带着完整笔记，接近压缩阈值的提醒也只存一次。原来每次请求都把笔记临时接在末尾，请求不再是上一次的追加，magpie 转发的 gpt 只认追加，从第一次写笔记起缓存不再增长（stock run-02：主会话每次约 9 万 token 只命中 9344，命中约 9%；architect 同样走 gpt，命中停在系统提示加第一条消息的约 1.7 万，整体 33%；GLM 的 worker 不受影响，87%）。e2e 用假模型检查主会话与子进程的相邻请求只在末尾追加。
- `.npmrc` 设 `legacy-peer-deps=true`：锁文件里没有 Pi 的 peer 依赖。
- `.forge` 迁移链 v1→v2（删 `.at`、争议）、v2→v3（删范围申请）、v3→v4（10-17 改造）。v4 不迁移旧流程，只把文件改到能过新 schema（等待输入、预检中的任务转阻塞），好让 `/forge abort` 能执行；有未结束的旧流程时 `/forge-resume` 与 `/forge doctor` 提示中止后用新流程重建。

### 需求与架构
- 需求输入只认固定位置（10-17 改造）：`docs/PRD.md` 与 `docs/prototype/`（至少一个 .html），缺了 `/forge-build` 只提示、不建流程；两者原样提交到集成分支（路径不变），之后所有 agent 从集成分支读。PRD 是需求的唯一依据，不再改写成规格：P0、`forge_spec`、spec-lint、技能 spec-from-prd 与 grilling 已删，build 流程从 S0 开始。程序只解析 REQ 编号、`- ACn` 验收标准与"页面"表（`spec/prd.ts`）；解析不出、缺 AC、编号重复、原型文件不存在只警告。
- `/forge init` 把示例 PRD 与两页原型复制到 `docs/examples/`（用户决定 10-17），写进 .gitignore、不提交：示例进了 git 会出现在每个任务的 worktree 里，agent 可能把示例需求当成本项目的需求。显式的 `/forge init` 在项目还没有 `.codegraph/` 时执行 `codegraph init -y` 建索引（codegraph 1.6.2 已核实），失败只提示；`/forge-build` 等命令自动初始化时不建，避免意外等很久。
- 实施任务不能改 `docs/PRD.md` 与 `docs/prototype/`（原来不能改的是 `docs/spec/`）：需求是用户在流程外定的，agent 改了就没有依据可对照。审查材料不再带术语表；PRD 的「通用约定」照旧放进开发 agent 与 reviewer 的任务说明。
- 架构阶段 S0（10-17 改造）：原来的 P1（契约与计划）与 S0（骨架）合并成 S0 的一个 impl task，architect 一次做完技术栈、骨架、公共代码、domain 划分与接口、OpenAPI 与页面接口对照、rules、commands.yaml、`docs/plan.md`；由程序派发（不经主会话），经审查、合并、门禁后等用户批准，打回时新 task 接着原会话返工。原因：P1 与 S0 分开时契约写完要等一次批准才落成代码，骨架又常发现契约要改。task 编号全流程连续，含此前流程与 `tests/acceptance/` 的目录名。
- 鉴权拆成接口与实现（用户决定 10-17）：S0 只定鉴权接口（校验令牌、当前用户、检查权限）、角色与权限的表达、请求入口的中间件，和只用于开发与测试的桩；真实实现（用户增删改查、登录退出、令牌签发与校验、停用后令牌立即失效）是 identity domain，放第 1 批。别的 domain 只依赖接口、开发时用桩，和 identity 并行；「接入真实接口」与批次门禁时真实鉴权已合入，所有接口在真实鉴权下再跑一遍。plan.md 里有 domain 写 `after: [identity]` 或 identity 不在第 1 批时只提醒。原因：stock run-01 登录 → 分类 → 商品三环依赖把 4 个能并行的任务拖成串行。
- S0 提交时只拦两类（`plan/batches.ts`、`plan/plan-flow.ts`）：缺必需文件（AGENTS.md、overview、domains、openapi、page-api、commands.yaml 要有 test、plan.md），plan.md 的 yaml 区块解析不过或调度做不下去（批次 id 或 domain 重名、after 不存在、指向更晚批次、成环、空批次）；PRD 的警告、REQ 没进批次、页面 id 找不到只提醒，显示在批准页。批准时先按 yaml 生成批次阶段 S1…Sn 与任务（每个 domain 一个 backend 任务、第 1 批的前端基础、页面按顺序串成链并接着同一会话、每批一个「接入真实接口」任务，后三种是 frontend；「接入真实接口」不单独审查，由本批浏览器验收检查），再 `--no-ff` 合入主分支。
- 后端任务的 `ac` 由 plan.md 里 domain 的 `reqs` 展开成这些需求的全部 AC（10-17）：审查按它核对每条 AC 有没有测试，覆盖矩阵按它填负责的任务。原来批次任务都没有 `ac`，开发 agent 自己去 PRD 里找本 domain 的 AC，审查也不核对。页面任务不分，见已知局限。
- 项目命令写在仓库根目录的 `commands.yaml`（用户决定 10-14）：architect 在 S0 写，开发 agent 可以补充，随代码合并、合入即生效；程序只执行 install、test、acceptance、serve（及 serve_*）、env_up/env_down、db_create/db_drop、add_dep，其余只给 agent 参考。`workflow.yaml` 只放流程配置。规则由 S0 直接写。
- 契约与架构文档只由 architect 改（10-17 改造）：backend、frontend 不能写 `docs/contracts/**`、`docs/arch/**`、`docs/plan.md`、`AGENTS.md`（guard 拦），要改用 `forge_ask_architect`；plan.md 的 `shared` 文件不拦，提交时检查对它们的改动是否只追加，不是就在审查材料里提醒（只提醒）。原来在 `forge_submit` 时检查契约只追加（contract-diff），已删。
- 契约只写前后端之间的边界（10-14 用户决定，10-17 改造后）：`openapi.yaml` 只写前端调用的 HTTP 接口，`page-api.md` 写每个页面用哪些接口；domain 之间的接口写成代码（接口与 DTO，空实现）；校验细则以 PRD 为准不重复。原因：club 实验 92 行需求写出约 2100 行契约，字段规则写了三遍，各模块接口都没有别的 task 调用。
- task 的 `review` 只由程序写：「接入真实接口」是 skip，其余由程序推导（底座、auth 层、`risk: high` 用强审查）。原因：club 实验里 architect 把 5 个增删改查 task 全标成 strong 与 high。

### S0 与构建环境
- S0 的唯一 impl task 由 architect 做（bash full，worker 的工具）：建骨架、直接写 `rules/`（对它豁免受保护路径）、把共享类型与错误响应落成代码；S0 合入后 rules 生效。
- S0 一律人工签收；批准时集成分支（PRD、原型与架构产出）先 `--no-ff` 合入主分支，集成分支再移到合入后的提交，之后的阶段照常在它上面做（用户决定 10-14）。代价：之后中止流程，主分支上的骨架不撤回；批准 S0 时主工作区不能有未提交的改动。
- Python 用 uv 的项目不共享 `.venv`（可编辑安装指向安装时的源码目录，共享会让各 worktree 测到旧代码）：每个 worktree 自己 `uv sync --frozen`，包从 uv 的全局缓存链接；guard 提醒不要用 pip 装包，加依赖用 `uv add`。`.venv/`、`__pycache__/`、`.pytest_cache/` 写进本地 exclude。
- 每个 S 阶段开始时建立或刷新共享构建环境 `<项目>.worktrees/.env-shared/`，worktree 链接依赖目录，不再各自 install；只追加根 package.json 依赖时装进共享环境（`forge_add_dependency`），改版本等用私有副本（`forge_private_deps`）。端口段（41000–60000）与数据库按运行分配。没有共享环境时（S0 期间）各工作区自己 install，只读工作区按锁文件哈希缓存。

### 调度与运行
- 三个池（10-17 改造）：backend 用 `max_parallel_backend`（plan.md 写了就覆盖，批准时存进 flow），frontend 固定 1 个（前端按页面顺序做），aux（review、qa、consult）用 `max_parallel_aux`；S0 的 architect 与轻流程的 worker 用 `max_parallel`。按关键路径挑任务；writes 不影响调度，依赖只有 hard（writes 互斥与软依赖已删）。
- 写代码的角色可写工作区内任何文件，只排除受保护路径与 `docs/PRD.md`、`docs/prototype/`（用户决定），backend、frontend 另外不能写契约与架构文档（见上）；没有范围申请。
- 主会话的上下文（10-15，stock 实验：主会话 $20.6，占全部费用一半以上，gpt 缓存命中 12%）：forge_wait 超时又没有变化时只回两行概况；状态里不带 PRD 检查的警告（只在批准页显示）。
- 失败处理：`run_timeout` 计入 attempts，由程序按进展决定接着做、从头做或交给用户；同样的失败连续两次先换升级模型，再换兜底模型（`models.fallback`、`/forge-config fallback` 或表格最后一行，所有角色共用，用户决定 10-14），都试过仍一样就阻塞；没有升级模型时，失败达到次数直接用兜底模型。任务要用的模型被暂停时改用兜底模型继续，原模型恢复后换回。子进程没提交就结束时按错误原文分类（`engine/failure-class.ts`）：额度、限流、配置错误暂停这个模型、不计任务失败（额度与配置要手动恢复），运行环境出错直接 blocked，其余计一次失败、带提示重试。运行中原地打转会结束本次运行并计一次失败；被 guard 拦下只记账，不因次数结束运行；没有按谱系的总预算（10-14 约束清点）。
- 子进程结束后清理它留下的进程，跳过仍在运行的 run 的进程树（审查、修复常与原任务共用 worktree）。
- 提升 pending → ready 时跳过已经不是 pending 的 task：有几处提升不在调度的串行队列里（`/forge next`、run 结束的回调），两处同时算出同一批时，后一个会报 ready → ready（stock run-02）。
- 需要拿主意的事先交给主会话（用户决定，10-14）：程序或子进程造成的阻塞（审查轮数用尽、合并失败、反复失败、子进程提问）、批次门禁用尽，都由 orchestrator 用 `forge_decide` 决定（retry、accept，或转交用户；签收打回后还有 fix，见批次验收）；它转交的、以及同一 task 它已决定 2 次之后的阻塞才等用户。用户始终可以直接处理；架构批准与批次签收仍只由用户做；等架构师回答的阻塞不交给主会话。出现新的待决定事项时给主会话发一条消息让它开始一轮（它这一轮已结束时没有别的东西会叫醒它）。
- 实施角色（bash full）的 bash 只按禁止列表拦（用户决定，10-14，列表写在 `guard.ts` 的 `IMPL_FORBIDDEN` 注释）：判断不了的（解析不了的命令、命令名或 rm/mv 参数含变量、`sh -c`、`eval`）放行，cd 不拦，兜底是提交时的 diff 检查；sed -i、tee 只查写入位置；`git reflog` 只拦 expire、delete、drop（run-03：只读的 reflog 被当成改写拦下）；共享依赖目录里用包管理器改依赖、uv 项目用 pip 只在结果后面提醒。只读角色仍按允许列表，但可以读其他提交；按行号打印的 `sed -n 'a,bp'`、`node --check`、`git -C`（与 cd 等价）也放行（stock run-04：reviewer 被拦的 34 次里这三种占 29 次）。读取不限范围（含 `.forge/`），只拦敏感文件；`read_paths`、`max_violations_per_run` 已不再使用。`forge_service` 可以直接给命令（与 bash 同样检查）。
- 所有带 bash 的角色都可以联网（用户决定，10-14）：curl、wget 不限主机；实施角色的下载目标按写路径检查（不能写主工作区与受保护路径），只读角色不能把内容写进文件，stage-qa 在临时 worktree 里不另加限制；`git fetch`、`pull` 仍禁止（远程分支由引擎同步）。
- 工具的可选参数里的占位值（''、`N/A`、null）当作没传；`bash_allow` 没在 commands 定义的命令只告警；guard 的变量代入也作用于命令替换；`git` 设 `core.quotePath=false`。
- 开发 agent 与 reviewer 的任务说明带 PRD「通用约定」一节的原文（截到下一个二级标题，最多 1.2 万字）：字段长度、字符、大小写、默认值、PATCH 语义不写成 AC，契约也不重复，而开发 agent 只按自己的 REQ 编号 grep PRD、读不到这一节，reviewer 只拿到 AC 原文（stock run-01 到 run-03 字段规则都要到阶段验收或我打回才被发现，run-03 的 S2 因此打回 3 次）。放在任务说明而不是系统提示，不影响缓存。
- 批次任务的说明由程序生成：domain 或页面、本批需求、原型路径与 page-api.md 的位置；页面任务的审查材料带原型路径与 page-api.md 里这一页。任务说明不列「输入文件」（程序从不填，一直是「（无）」）。
- 任务说明带「已交付的接口」一节（计划不再写 test_interface：worker 自己写验收测试，不再限定入口，10-14）；上游 handoff 只带上游最后一次 run 写的段。

### 提交、审查与合并
- 提交与合并时不跑命令（用户决定，省时间）。`forge_submit` 先把集成分支合进任务分支：冲突时不提交、列出文件，agent 在同一次运行里解决；没冲突时需要审查的进审查，不需要的直接排队合并（10-17 改造，代替等待输入、预检与冲突后重新派发）。每次合并后在后台对集成分支跑一遍门禁命令（`limits.post_merge_test`，默认开，用户决定 10-14）：变红时同一提交重跑一次排除不稳定，再在上一次通过之后的合并里二分，给第一个变红的合并建 `.fx-n`（同一 task 最多 2 次，之后交给门禁）；阶段门禁等它跑完，并沿用同一棵代码树上通过的结果。fix 流程没有阶段门禁，合并时仍跑 typecheck、lint、test。
- 没有 test-author（用户决定）：worker 自己写 `tests/acceptance/<T>/` 的验收测试。impl 都审查（「接入真实接口」除外），fix、doc、merge-fix、consult 不审查；审查通过后因合并冲突交回 worker 的，解决后不再审查，由阶段门禁检查（stock run-04：冲突后的审查是新的首轮，5 次里 3 次提了之前各轮没提的 must，T-004 因此用完轮数交给用户）；reviewer 读 diff，运行本 task 的单元测试与验收测试，检查每条 AC 都有带编号的测试且没被写弱。must 写明出处（`rule:`、`ac:`、`contract:`、`defect:`），程序不校验、不降级（10-14 用户决定：校验时去主分支找规则文件，S0 写的规则还在集成分支上，真缺陷被降成建议漏过）；确认轮不能新增问题，按关闭条件的目的判断（修在别处、有对应测试也算解决）。
- 审查的 must 只限：本 task 的测试失败、违反 PRD 的 AC 或通用约定、违反契约、违反规则清单、安全问题、确定的缺陷，其余是 suggest（10-17 改造）。前端按页面对照原型与 page-api.md 审，后端按 domain 审。
- 页面 AC 的验收测试不开浏览器：只测页面路径返回 HTML、页面用到的接口、前端模块的纯逻辑；打开页面看交互与状态交给 stage-qa 的浏览器检查，reviewer 与 stage-qa 不因为没有浏览器测试判 must（run-03：reviewer 要求页面状态测试，worker 自己搭浏览器脚本，一次返工 50 分钟，脚本写死本机路径）。菜单、页面清单、路由表不断言完整列表，只断言本 task 的项（run-04：T-003 的测试写死了页面清单，之后加页面的 task 都改这一行，13 次冲突返工都在这里）。
- 审查者 forge_block 时只阻塞审查 task，原 task 留在审查中等它，forge_wait 会因审查 task 阻塞醒来（club run-02：原 task 一并阻塞，主会话对两者各 retry 一次，worker 与 reviewer 在同一个 worktree 里同时运行）。验收测试的 Given 可以用夹具直接写存储（准备所需的接口还没交付时），When 与 Then 走公开入口。
- 浏览器检查（用户决定，10-15；10-16 只留给 stage-qa：run-03 的 worker 用了 469 次浏览器命令，把浏览器脚本写进项目验收测试并写死本机路径，没看到因此发现的缺陷；stage-qa 用它发现了登录页空顶栏与启停清零金额）：pi-playwright 必须安装（项目级或用户级），没装不能开始流程；stage-qa 的角色提示固定写着这一节（子进程 `--no-skills`），技能位置用占位 `{{playwright-browser}}`，派发时换成按 Pi 用户目录（`getAgentDir()`）找到的实际路径，路径用正斜杠（Windows、macOS、Linux 的 node 与常见 shell 都认），同一台机器上提示不变；安装提示是两条独立命令（不用 cd、&&）。stage-qa 在隔离工作区里也能读、运行这个目录（子进程按同样的方法找到后传给 guard）；`.playwright-cli/` 记进本地 exclude（stock run-02：商品页打不开、错误条一直显示，只有在浏览器里看才发现）。
- 首轮审查说明列出 diff 里属于其他已完成 task 范围的文件，要求确认原功能还在（stock run-02：T-013 改了商品页，页面在用到 `state` 前就引用了它，打不开，审查只看本 task 的 AC 没发现）。
- 合并：rebase；双方都只插入行的冲突由程序三方合并，合不了的交回正在合并的 worker（用户决定）；受保护文件冲突、主工作区有改动等阻塞先交给主会话；任务分支相对集成分支没有改动的阻塞为 `no_changes`，确认后视为完成（impl、fix、doc 提交时就没有改动的，直接完成，10-14）；提交不要求先写 handoff（提交说明自动记入），handoff 超长截断；doc、merge-fix 可以改验收测试；其他种类与主分支同步冲突走 merge-fix。之后只查冲突标记，build 流程不跑命令（轻流程跑 test；合并后验证失败的知识候选因此只在轻流程出现）。同一棵代码树的同一条命令只验证一次。工具不存在导致的命令失败按跳过处理并提醒。

### 批次验收
- 门禁命令与覆盖率 → stage-qa → 修复 → 重跑 → stage-qa 只确认一轮 → 签收；门禁通过时与最近一轮 qa 的 HEAD 到当前 HEAD 之间只有程序记录的文档（审查建议、`docs/qa/`）时才签收。只依据持久化状态，崩溃后重入结果相同。原来要求 HEAD 相等：club 实验里 qa 带建议通过 → 建议提交让 HEAD 变化 → 重新验收，循环了 6 轮。
- 用户打回批次后，在本阶段有新的任务变化之前不重新提交门禁；主会话判断归属：能明确归属的用 `forge_decide` 的 fix 交给负责的任务（建 `.fx-n`，接着它的会话），归属不清或涉及多个任务的用 `forge_ask_architect(kind=change)` 交给架构师（10-17 改造，代替变更请求；stock 实验：task 都已完成，打回 6 秒后又回到等签收，打回白费）。判断"还有 task 等派发"只看当前阶段：后面阶段的 task 总是 pending，算进来时打回意见轮不到主会话（stock run-02）。审查轮数用尽的阻塞原因带上最新一轮审查者的说明，不只是首轮原文（run-02：首轮写"上限是 50"，第二轮已改成 30 只差测试，主会话看到的还是 50）。
- stage-qa 轮数用尽后集成分支又有了改动（打回后的修复、架构师的修改合入），门禁通过后再开一轮只确认的 stage-qa，不按改动之前的结论交给用户；没有新改动时照常交给用户（stock run-03：S2 修完后门禁两次都按旧结论判用尽，修复没人复验）。
- 等签收（awaiting_human）时又有任务合入集成分支（例如主会话没打回就让架构师修改），程序退回 active 重新验收：看最近一次验收出结果之后有没有任务的合入事件，从 needs_human 放行前合入的也算，批准时合入主分支不算。原来这些修改不经验收就随签收进主分支，只靠提示词约束（10-17）。
- 门禁失败建 `.fx-n`，2 轮；默认跑 test、acceptance、arch_check、contract_check，commands.yaml 没定义的跳过；覆盖率只报告（签收时给用户看），缺口不拦门禁（10-14 约束清点：按 AC 逐条补测试是测试代码膨胀的原因之一）。
- 问题归属（10-17 改造）：先看已完成任务实际改过的文件，再看 plan 的 paths（task.writes），页面文件归页面任务。一条问题只交给一个任务：唯一归属时接着那个任务的会话修，多个或找不到时交给一个 S0 architect 的修复任务（stock run-04 的 S4：同一条问题按文件拆成两个修复，两边各用一种做法修了同一个问题）。stage-qa 每条 must 附复现步骤、失败的请求或控制台报错、怀疑的归属（只在说明里要求，不拦）。
- stage-qa 在集成分支 HEAD 的临时 worktree 里运行，路径不能越出这个 worktree（主工作区、别的 worktree、`.forge/` 都拦）；系统临时目录可用，不查敏感文件（用户决定，10-14：club 与 m9 的 6 次运行里 stage-qa 被拦 33 次，全是 `rg -g '!*.pem'`、`printenv PORT` 与 `mktemp -d /tmp/…`）。
- 所有角色点名查看环境变量（`printenv PORT`）放行，只拦打印全部（不带参数的 `printenv`、`env`、`export` 等，拦下时提示用 `printenv 变量名`）：子进程继承 Pi 的全部环境变量，里面可能有 API key（用户决定，10-14）。
- 最后一个阶段批准时存交付汇报再 `--no-ff` 合入主分支；`/forge-status --metrics` 含速度、返工（含没提交就结束的 run 按类别计数）、成本、被拦下的操作。

### 架构师问答、fix 与小改动
- 架构师问答（10-17 改造，代替变更请求）：backend、frontend 与主会话用 `forge_ask_architect(question, kind: answer|change)` 提问。子 agent 提问时程序先建 consult 任务（architect），再把提问任务转为阻塞（blocked_by architect，不交给主会话）；architect 接着最近一次 architect 会话（S0 或上一个咨询；没有或太大时开新会话并带 `docs/arch/decisions.md`），用 `forge_answer` 回答，有改动时经合并队列合入；之后程序把回答写进提问任务的 handoff、把集成分支同步进它的 worktree，让它接着原会话继续。主会话提问的回答在下一次 forge_wait 返回；forge_wait 把等架构师的任务当作进行中（给了 task_id 也不因它在等架构师就返回）。consult 串行、不审查，改动由批次门禁的 contract_check 与 stage-qa 兜底；S0 与咨询用同一份技能列表，接着 S0 会话时提示缓存不失效。
- fix 与小改动都是单阶段 `X1` 的轻流程，直接合入主分支，最后由 X1.qa 确认（最多两轮）；同一时间只能有一个，build 运行时拒绝。小改动（用户决定）：`/forge-change --from <yaml>` 或 `forge_change`，1–3 个 impl task，不经批准，仍用 worker 角色；实现合入后程序强制 architect 的「更新架构图与契约」task，不需要改时直接无改动提交。

### 删掉与没做的
- 10-17 改造删除（用户决定，见改造计划）：P0 规格与 `forge_spec`、P1 与 plan.yaml、变更请求（`forge_change_request`、`forge_propose_plan`、`/forge-approve change:`）、预检与等待输入、软依赖与 writes 互斥、契约只追加检查（contract-diff、contract-check）、`scripts/ablation/`、`scripts/m9/`。原因：需求由用户在流程外写定，契约与计划由 architect 在 S0 一次做完并经批准；之后的技术问题走架构师问答。
- 10-12 删除（用户决定）：feature、adopt、规格修订、精简模式、test-author 与 `.at`、争议、范围申请。原因：后续功能由 agent 读架构图与 rules 完成，不走重流程。旧 workflow.yaml 里已删的键与工具只告警。
- 10-14 删除 researcher 角色（用户决定）：没有流程会派它，所有带 bash 的角色都已能联网。`web` 工具组（pi-web-access）留在模板里，默认不分配给任何角色，要用时在角色 tools 里加 `"@web"`。
- 10-13 删除 pi-serena：扩展工具只能只读或联网，写文件只用内置 write/edit。
- 10-13 评估「Stage 级共享工作区 + CAS」，不做：实验里 worktree 准备只要几秒、没有合并冲突，时间花在模型思考；共享工作区会让半成品互相干扰、失败算错人，bash 写入也无法纳入 CAS。

### 提示词与代码组织
- backend、frontend、worker 带 `tdd`、`simplicity`、`receiving-feedback`、`acceptance-tests`，reviewer 带 `code-review`、`tdd`、`simplicity`、`acceptance-tests`；单元测试写法与过度工程只作 suggest；规则编号 `R<n>`，每个文件不超过 6 条规则、5 条审查清单。
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
- stock run-03（10-15 晚，同 run-02 的 PRD、原型、隐藏测试与配置；代码 ca05b40 加未提交改动：笔记存进会话、主会话系统提示各阶段不变、浏览器检查、跨 task 审查提醒、打回意见只看当前阶段；方案 `~/pi-forge-runs/stock/PLAN-run-03.md`）：S3 的 stage-qa 进行中时用户叫停（约 7 小时 10 分钟，S3 四个 task 都已合入，S4 没做），未计分；叫停时一期隐藏测试 18/18。用时 P0 21、P1 15、S0 18、S1 100、S2 150、S3 120 分钟以上。观察：缓存命中主会话 99%（$3.1）、architect 94%（$2.0）、worker 98%、reviewer 与 stage-qa 93%，合计 $9.7；architect 的命中随调用增长，不再停在 1.7 万。worker 每次模型调用的耗时与 run-02 相同（9.1 秒对 9.4 秒），慢在调用次数：S1–S3 的工具调用 1669 次（run-02 S1–S4 共 1144 次；按消息 id 去重，续做的 run 会复制之前的会话，不去重是 1889 对 1910），其中浏览器命令 431 次；T-004、T-009 把浏览器脚本写进了项目的验收测试（`tests/acceptance/*/browser.js` 写死本机 `~/.pi` 下的路径），调试这些测试占了单个 run 的大半，审查没指出。stage-qa 用浏览器发现了登录页空顶栏（`display:flex` 盖掉 `hidden`）和启停把金额清零，S0 首页 favicon 404 也提了。S2 我打回 3 次（SKU 没转大写、q 只有空格不报 400、stage-qa 第 4 轮才提出的 PATCH 清零与长度上限），每次走一遍变更请求，主会话都自己提了变更请求；第 3 次修完后门禁仍以旧的 stage-qa 结论判轮数用尽、不再重新验收（`stage-rounds.ts` 的轮数按整个阶段算，变更请求的 task 不挂在任何一轮上），`/forge gate` 也一样，最后由主会话读代码核实后放行。其他：guard 把只读的 `git reflog` 当改写拦下。没跑完，不下效率结论。
- stock run-04（10-16，同 run-03 的 PRD、原型、隐藏测试与配置；代码 b4e76c8：浏览器只给 stage-qa、页面验收测试不开浏览器、任务说明带通用约定与计划里的说明、stage-qa 用尽后代码变了再确认一轮、放行只读 reflog；方案 `~/pi-forge-runs/stock/PLAN-run-04.md`）：跑完交付，隐藏测试 52/52，我用浏览器打开 13 个页面都没有打不开、控制台报错、失败请求、常驻错误提示；约 1.2 万行（server+public 5.9k、tests 5.0k）。用时 P0 19、P1 14、S0 37、S1 51、S2 70、S3 95、S4 46 分钟，共 5 小时 34 分钟（run-02 5 小时 4 分钟）。费用 $7.2（run-02 $31.6）：主会话 $1.1（命中 97%）、architect $1.4（94%）、worker $3.2（98%）、reviewer $0.7、stage-qa $0.8。
  - 字段规则：没有打回（run-03 的 S2 打回 3 次）；run-03 打回的几条（SKU 大写、q 空白 400、PATCH 只改给出的字段、名称与单位长度）我手测全对，stage-qa 的 must 里没有字段规则。介入只有一次：T-004 审查 7 轮、主会话两次决定用完后交给我，剩的是契约少写一个字段，我放行。
  - 浏览器：worker 0 次（run-03 431 次），tests/ 里没有浏览器脚本和本机路径；stage-qa 233 次，每期都用浏览器找到了逐 task 审查漏掉的页面缺陷（退出失败页面卡死、商品与仓库页没有"新建"按钮、仓库页一直"加载中"、字段错误位置错、库存页筛选下拉为空、调拨链接打不开、报表页没有导出按钮、下载文件名不对），修复后确认轮都一次通过。
  - 没变快：worker 工具调用 1837 次（去重；run-02 1144），多在返工——首次 run 之外的返工与冲突 run 27 个（run-02 11 个）：冲突 13 个（合并 5、同步 8），几乎都在 T-003 验收测试写死的页面清单那一行；审查打回与主会话重试 14 个。审查轮数 32（run-02 27），审查的 must 条数相近（17 对 16）。冲突解决后的审查是新的首轮，5 次里 3 次提了新 must；T-004 一个 task 9 个 run，前 5 轮是同一条 must 改了 4 次才对。并行更多（S2 5 个 task），墙钟只多 10%。
  - 10-16 已修：页面清单类断言、冲突后不再审查、reviewer 的 `sed -n`/`node --check`/`git -C`（见上文）。还没改：同一条 stage-qa 问题涉及两个 task 的文件时建成两个修复 task（S3 两边各修一半，是对的；S4 两边各用一种做法修了同一个问题，都合入了，页面正常）；stage-qa 的 sed 地址 `/REQ-002/,/REQ-003/p` 被当成路径拦；主会话窗口在修复确认通过后仍显示"阶段检查未通过 → /forge gate 重跑"，交付后状态栏仍是"等你批准合入"。产品小问题：销售单的客户筛选列出了供应商。
- stock native-01（10-16，对照组：同 run-04 的 PRD、原型与隐藏测试；不用 pi-forge，原生 Pi 1.1.0 一个会话，glm-5.3-flash high，只加载 playwright-browser 技能，没有 subagents；方案 `~/pi-forge-runs/stock/PLAN-native-01.md`）：84 分钟、$1.77，隐藏测试 52/52；我的 13 个页面浏览器检查全部正常；run-04 时手测的 11 条字段规则全对（run-04 也全对）。约 4.9k 行（server 1.7k、public 2.2k、test 1.0k；run-04 共 10.9k）。第一次说完成在 61 分钟，当时的快照已经 52/52；之后按方案回了 3 次「对照 PRD 检查」，每次都修了真问题（先 404 后 400 的检查顺序、单据明细行的字段错误位置、"导出中"状态）。模型调用 381 次、工具调用 390 次（run-04 的 worker 1837 次），浏览器命令 91 次，缓存命中 99%，上下文最多用到 23%（1M 窗口），没有压缩。同类小问题：采购单与销售单的往来单位筛选都列出了另一类单位（run-04 只有销售单）。
  - 结论（各只跑一次）：这个规模的项目，同一个模型单会话比工作流快 4 倍、便宜 4 倍，按隐藏测试、页面检查与字段规则看质量没有差别。工作流的拆分、契约、逐 task 审查与阶段验收在这里没有换来可测的质量提升；1M 上下文下单会话不需要压缩，"一个会话装不下"这个拆分的前提不成立。
- stock rework-01（10-17，改造后的新流程，**未运行**）：方案 `scripts/real-build-suites/stock/PLAN-rework-01.md`（max_parallel_backend 1 与 3 两组，对照 run-04 与 native-01）；PRD 由 `requirement.md` 改成 `PRD.md`（内容不变，16 条 REQ、63 条 AC、14 个页面）；驱动 `scripts/real-build.ts --suite stock`，各阶段耗时、各角色费用、返工 run、冲突、审查轮数的算法用 run-04 的 `.forge` 数据核对过，与上文数字一致。
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
- 10-16：`agents/worker.md` 开始一步改为读「计划里的说明」、不再提输入文件；`skills/plan-dag` 加 `description` 一行，`skills/change-request` 加一条；forge_claim 的工具说明去掉「输入文件」。worker 与 architect 的缓存各失效一次。
- 10-16：`skills/acceptance-tests` 的"不要断言"表加一行（菜单、页面清单、路由表不断言完整列表）。worker、reviewer 与 S0 的 architect 缓存各失效一次。
- 10-17：改造第 1 步：`agents/orchestrator.md` 删掉 P0 一节；删除 `skills/spec-from-prd`、`skills/grilling`，主会话系统提示不再带这两份技能；主会话工具去掉 `forge_spec`。主会话的缓存失效一次。worker 与 reviewer 任务说明里「通用约定」的标题改了，审查材料去掉术语表（都在用户消息里，不影响系统提示缓存）。
- 10-17：改造第 2 步：重写 `agents/architect.md`（只剩 S0 与暂留的变更请求一节）、`skills/design-contract`（openapi 与 page-api）、`skills/write-rules`（commands.yaml 与 rules/backend、frontend）、`skills/domain-modeling`（domain 划分与 domains.md，不再写术语表）；新增 `skills/plan-batches`，S0 的 architect 不再带 plan-dag 与 tdd。architect 的缓存失效一次，其他角色不受影响。

- 10-17：改造第 3–5 步：新增 `agents/backend.md`、`frontend.md`；改 `agents/architect.md`（咨询与修复两节，删变更请求）、`orchestrator.md`、`reviewer.md`、`stage-qa.md`、`worker.md`，`skills/tdd`、`stage-qa`、`code-review`、`acceptance-tests`、`receiving-feedback`、`simplicity` 与 `rules/global.md`；删除 `skills/change-request`、`plan-dag`；architect 的咨询与 S0 用同一份技能列表。所有子进程角色与主会话的缓存各失效一次。
- 10-17：鉴权拆分：`agents/architect.md`（鉴权只定接口与桩）、`agents/backend.md`、`agents/frontend.md`、`skills/domain-modeling`、`skills/plan-batches`、`skills/acceptance-tests`。architect、backend、frontend、reviewer 的缓存各失效一次。
- 10-17：`agents/architect.md`、`agents/backend.md`、`skills/plan-batches` 各改一处（domain 的 `reqs`，后端任务的 AC 来自「验收标准」）。architect 与 backend 的缓存各失效一次。
