# pi-forge 开发笔记

记录已核实的事实（版本、Pi API）、偏离规格（`docs/BUILD_PROMPT.md`）的决定、真实模型实验的结论。实现细节以代码与测试为准，这里只写"为什么这样做"。
偏离记录的编号不变；新增条目往后追加，一条 1–3 行，被后来的条目修订时注明。代码注释里的"第 N 条"在 M0 迁入的文件中指 pi-flow `NOTES.md` 的编号，改编时逐步换成本文的编号。

## 已验证版本

| 组件 | 版本 | 说明 |
|---|---|---|
| Node | 24.18.0 | 要求 ≥22；测试用原生 TS 类型剥离（只用可擦除语法） |
| git | 2.50.1 | 要求 ≥2.30（worktree） |
| Pi | `@earendil-works/pi-coding-agent` **1.0.0**（本机全局安装） | 与 pi-flow 已验证的版本相同；npm 上已有 1.1.0，未验证 |
| typebox | 1.3.27 | Pi 内置核心包，`peerDependencies: "*"`，不打包 |
| minimatch 10.2.6、proper-lockfile 4.1.2、yaml 2.9.0 | | 与 pi-flow 相同，不新增运行时依赖（规格第 1 节第 6 条） |
| typescript 5.9.3、@types/node 22 | | 开发依赖 |
| 复用来源 | pi-flow `~/Documents/Code/program/pi-flow`：运行时 `31f3f15`，流程层 `7006e7d` | 见偏离第 1 条 |

## Pi API（已核实）

**实测**＝用真实 pi 进程（探针在 `playground/probes/`，假模型在 `test/fixtures/fake-llm/`）；**源码**＝读 `.d.ts`、源码或官方文档。

| 能力 | 结论 | 核实 |
|---|---|---|
| 安装 | `pi install <npm:包 \| 本地路径>`，`-l` 写项目 `.pi/settings.json`（需信任项目）；本地路径不复制、不替你装依赖 | 源码、实测 |
| 包清单 | `package.json` 的 `pi.extensions/skills/prompts`；扩展 .ts 由 jiti 加载，能解析包自己的 node_modules | 实测 |
| 斜杠命令 | `registerCommand(name, {handler(args, ctx)})`，`args` 是原始字符串；`pi -p "/cmd"` 不调用模型 | 实测 |
| 交互 UI | `ctx.ui.select/confirm/input/notify`；RPC 模式经 `extension_ui_request/response`；print 无 UI | 实测 |
| 工具 | `registerTool({name, parameters, execute})`；`setActiveTools` 在 `session_start` 中生效 | 实测 |
| 拦截工具调用 | `on('tool_call')` 返回 `{block, reason}`；**按扩展加载顺序执行，后面的看到前面改过的 input**，guard 必须最后加载；`event.input` 可原地修改（用于补 bash 超时） | 实测、源码 |
| 追加系统提示 | `before_agent_start` 改 `systemPromptOptions.appendSystemPrompt` | 实测 |
| 事件 | `session_start`、`before_agent_start`、`turn_end`、`message_end`（assistant 消息带 usage）、`agent_end`、`session_shutdown` | 源码、实测 |
| 子进程 | `pi --mode json -p --session-dir <目录> [--fork <会话文件>] --no-extensions --no-skills --no-prompt-templates --no-context-files -e <扩展>… --model p/id --thinking <级别> --tools a,b --append-system-prompt <文件> -- "<提示>"`；**stdin 必须关闭**；`--fork` 复制旧对话为新会话，系统提示按本次参数重建 | 实测 |
| 用量 | assistant `message_end.message.usage = {input, output, cacheRead, cacheWrite, cost}`，`input` 不含缓存；另有 `provider/model/stopReason/errorMessage` | 实测 |
| 重试 | Pi 对限流、过载、5xx、网络错误自动重试 3 次；额度用完类不重试，错误在 `errorMessage` | 源码（pi-ai `retry.js`） |
| bash | `timeout` 单位秒；超时对整个进程组 SIGKILL；`pi -p` 收到 SIGTERM 会结束自己跟踪的 bash 进程组 | 源码、实测 |
| 思考级别 | `off/minimal/low/medium/high/xhigh/max`，按模型收窄（glm-5.3-flash 只支持 low/high/xhigh） | 实测 |
| codemode | `-e builtin:codemode` 且 `--tools` 含 codemode；脚本里每个工具调用都经过 `tool_call`（guard 照常拦截计违规） | 实测 |
| 配置目录 | `getAgentDir()` = `~/.pi/agent`（`PI_CODING_AGENT_DIR` 可改）；导出 `VERSION` | 源码 |
| 工具图片结果 | `AgentToolResult.content` 支持 text/image 联合；图片为 `{ type: 'image', data: <base64>, mimeType }`，forge_read 已去掉临时断言 | 源码：`dist/core/extensions/types.d.ts`、`dist/core/tools/read.js:87-88`；真实 Pi + fake LLM 文本工具流程实测 |
| 开始主会话讨论 | `sendUserMessage(text, { deliverAs: 'followUp' })`；交互模式用于入库/打回后续讨论，print 模式由下一条用户提示和每轮状态注入推进 | 文档：`docs/extensions.md`；源码：`dist/core/extensions/types.d.ts`；真实 Pi print + fake LLM 实测 |
| 路径解析 | Unicode 空格归一、去 `@`、展开 `~`、`file://`；guard 按同样规则 | 源码 |

第三方插件（读源码核实）：pi-serena 0.9.20（20 个工具，文件参数 `relative_path`；`serena_rename_symbol` 等不分配给角色）；pi-codegraph 0.1.10（8 个工具，参数是符号）；pi-web-access 0.35.0（默认不激活，需 `setActiveTools`）；pi-rules 0.6.0（不能按角色挑规则，所以不用）；pi-subagents 0.74.0（对照实验用）。

上表从 pi-flow `NOTES.md`（@ 31f3f15）原样搬来，只改了工具名前缀，都是在 Pi 0.99.2 / 1.0.0 上核实的。本机仍是 1.0.0，M0 的真实 pi 测试（`orchestrator-session`、`crash-recovery`、`pi-subprocess`）全部通过；用到新的 Pi API 时先查文档或源码再补进本表。

## 待确认与已知局限

- 继承自 pi-flow：serena 的 `prepareArguments` 在 `tool_call` 之前还是之后未核实；guard 管不到脚本文件内部（`bash x.sh`、`npm run`），兜底是提交时的 diff 检查；打码只认识常见密钥形态。
- Pi 版本：M1 到 M8 保持 1.0.0。M8 结束、M9 开始前单独做一次升级评估（读 1.0.0 → 1.1.0 的变更记录、核对上面的 Pi API 表、跑全量测试，单独提交）；M9 的实验与原生 Pi 对照组都在升级后的版本上跑。
- M1 已接通 v3.2 的 schema、状态机、配置和运行时，删除旧 D0/D2/E 流程层。M2 已接上 P0 讨论、规格提交、人工审批与修订；批准后停在 P1 active，契约与计划由 M3 实现，真实预检、审查和阶段验收分别由 M4/M5/M6 接入。主会话角色按用户决定沿用 orchestrator。
- stage-qa 的 bash 是 full，现有 guard 拦不住 shell 重定向改源码，而规格第 14 节要求 stage-qa 不能写（临时目录除外）。M6 实现 stage-qa 时在 guard 里补上，并加测试。

## 偏离记录

**M0（2026-10-09）**

1. 复用基线分两层（规格 v2/v3 第 1、16 节，DECISIONS-R1 第 1 条）：运行时文件取 pi-flow HEAD `31f3f15`，流程层取 `7006e7d`。M0 拷贝 `31f3f15` 的整个 `src/` 与 `test/`；`7006e7d` 的流程层（core 的 stages、revision、acceptance、final-review、requirements、gates，modes 的 plan、fix，tools 的 module-tools、orchestrator-tools 及其测试）与 `5100d6b^` 的 stage-review、state-machine 放在 `legacy/` 作参考，不参与构建。`5100d6b^` 目录写成 `legacy/5100d6b-parent/`（`^` 在 shell 中需要转义）。
2. 改名只改产品与命名空间：`pi-flow` → `pi-forge`（包名、`refs/pi-forge/state` 与检查点 refs、`pi-forge.json`、git 身份、消息类型），`.flow/` → `.forge/`，`PI_FLOW_*` → `PI_FORGE_*`，工具名 `flow_*` → `forge_*`，命令 `/flow`、`/flow-*` → `/forge`、`/forge-*`，状态提交前缀 `forge-state:`，文件 `commands/flow.ts`、`flow-config.ts`、`flow-watch.ts`、`scripts/flow-view.*` 改成 forge。**领域名词 flow（一个流程实例）保留**：`FlowFile`、`flowId`、`.forge/flows/<id>/`、`active_flow`、事件与 run 的 `flow` 字段、实体名 `'flow'`、工具种类 `'flow'`、集成分支 `flow/<id>/integration`；TS 标识符（`runFlowCommand`、`FLOW_TOOLS`、`piFlowSubagent` 等）也不改，改编时按需更换。改名脚本按明确的正则替换，之后逐条核对残留。
3. pi-flow 的包内容（agents、skills、rules、templates、prompts @ 31f3f15，已改名）放在 `test/fixtures/pi-flow-package/`，运行时测试经 `test/helpers/package.ts` 的 `PKG_CONTENT` 引用；pi-forge 自己的 `agents/`、`skills/`、`rules/`、`templates/workflow.yaml` 是 v3 内容，迁入的 config 还解析不了（M1 改）。为了让真实 pi 进程的测试也用夹具，`src/pi-adapter/extension.ts` 新增 `CONTENT_ROOT`（环境变量 `PI_FORGE_CONTENT_ROOT`，默认包根目录），角色提示、技能、模板、init 的来源都改从它读取；子进程扩展路径仍取包根目录。这是 M0 唯一的 `src/` 行为改动，M1 迁移完成后删除。（M1 已落实，见第 13、14 条。）
4. M0 不 skip 测试（DECISIONS-R2 第 3 节）：拷贝的是 HEAD 的流程层，测试全部能过，留着保护改名。通知测试（`test/unit/state-recovery6.test.ts`）原来让两个通知进程追加同一个文件，负载高时内容交错、偶发失败；改为每个事件写单独的文件（只改测试）。
5. `.npmrc` 设 `legacy-peer-deps=true`：pi-flow 的锁文件没有 Pi 的 peer 依赖（Pi 由宿主提供，扩展经 jiti 加载时解析到全局安装），npm 7 起默认会安装 peer 依赖，导致 `npm ci` 报锁文件不同步。
6. 没有拷贝 pi-flow 的 `scripts/demo*`、`bench5-native.ts`、`measure-merge.ts`、`playground/`、`docs/`；`package.json` 去掉 `demo` 脚本与 `prompts` 清单（`prompts/stage-kickoff.md` 是 pi-flow 主会话的提示模板，只放进夹具）。`templates/AGENTS.md`、`templates/gitignore.append` 从 pi-flow 拷贝（`init` 要用，v3 没有提供）。
7. 契约"只能追加"的判定规则（DECISIONS-R1 第 21 条，规格第 12.1 节）：新增 path、operation、响应状态码、可选的请求或响应字段、schema、错误码、`modules/*.md` 的函数小节、数据表、可空列算追加；删除或改名、改已有字段的类型、格式、默认值，给请求新增必填字段，改动任何 `required` 数组或 `enum`（包括新增取值），改已有错误码的 http 状态或含义，改已有列、新增非空且没有默认值的列，都算修改，要走变更请求。M5 实现时以规格第 12.1 节的表为准。

**M1（2026-10-09）**

8. 一次切换到 v3.2：删除 HEAD 的规划、需求讨论、独立验收、最终审查、修订与 fix 流程层，后续按 legacy 分别在 M2–M7 重建。`/forge-build` 只建流程、停在 P0，不启动主会话讨论。
9. M1 临时预检集中在 `passthroughPrecheck()`，等待最新验收测试与软依赖、同步后直通 queued_merge；合并时仍执行全量验证。M4 替换，M4 验收必须确认直通代码和标记已删除。
10. bash allowlist 在 M4 前按 readonly 处理，保留 `bashAllow` 配置；**命令白名单尚未生效**，不能因此放行有副作用的命令。
11. 暂时保留 HEAD 的门禁失败修复任务机制，kind 改为 fix；两轮用尽进入 needs_human。M6 由 stage-qa 取代；M1 的 accept 只接状态机已有的人工例外路径，最终合入仍需用户签收。
12. 主会话角色沿用 orchestrator，不采用规格中的 main（用户决定）；规格中的 main 都指 orchestrator。范围授权来源和超时复核设置也使用 orchestrator，主分支名与 main_branch 保持原样。
13. `.forge` 格式版本从 1 开始，无内置旧格式迁移；保留迁移框架、更新版本拒写与缺失迁移提示。不提供旧 pi-flow 流程兼容路径（修订 M0 第 3 条的临时夹具方案）。
14. **已撤销（M2，见第 21 条）**：名字以 `-engineer` 结尾的角色按 worker 校验专属工具，保留按层的运行时测试夹具；仓库角色来自包根目录与项目覆盖目录，不再使用 CONTENT_ROOT。
15. run_timeout 计入 attempts（规格第 8.1 节），保留超时复核和续跑上限；已有超时复核决定优先于重复失败看守，避免其提前截断续跑。unblock 默认保留计数，--reset 仅清零阻塞原因对应的计数。
16. `testing.adjust_tests` 按模板保留，仅 impl/fix 可适配已有测试，新增与删除不放行；独立的 `tests/acceptance/**` 从适配白名单中排除。
17. risk 枚举暂定为 low、normal、high；M1 仅校验形状，计划的语义检查与 DAG 推导留给 M3。
18. `canAppendInterfaces` 保留，路径改为 `docs/contracts/**`，提交例外只认 `Facts.contract_additions`；M5 判定实现前传空数组，不能将 agent 的声明当成已核实的追加。
19. 模型升级读取 attempts、precheck_failures、merge_failures、review_rounds 的合计，不改写各独立计数；合并验证日志按 merge_failures 编号，避免旧 attempts 编号覆盖重试证据。
20. intake 的输入导入与独立索引提交原语暂时保留，输入放进 `docs/spec/inputs/`；M2 改为规格流程。旧真实构建脚本移除，M9 再实现真实模型实验。

**M2（2026-10-09）**

21. 删除按层测试角色，运行时测试改用 pi-forge 七角色重写；撤销第 14 条的 engineer 后缀兼容。旧断言的替代见下方“M2 删除按层角色”。
22. `/forge-build` 的 `--prd` 必填，不支持无 PRD 的想法讨论；原件不解析，流程标题取 PRD 文件或目录名，原型可省略。
23. forge_read 的 ref 白名单只认存在的本地主分支与 flow 的集成/任务分支，不接受 HEAD、SHA、revision 或状态引用，避免读到状态与检查点。
24. 同一流程只允许一份 proposed 规格修订；多个审批对象必须明确 stage/amend，change 留给 M7，避免误批准或叠加未批准修订。
25. spec 增量页面按路由整页替换，权限按资源操作合并角色单元格；没有删除页面语法，空页面小节与无数据行的合法权限表表示没有变更。
26. 删除的 REQ 编号不得复用，仍计入历史最大编号；额外拒绝不可解析的需求/AC/术语、空基线、删除标题带 AC、重复 feature 文件名或小节，避免静默猜测。
27. intake 清单持久化为 `{ prd, prototype_path?, files }`，替换第 20 条的兼容投影；TypeBox 1.3.27 的 Memory.Clone 会剔除 `prototype` 键，故内部改名，公开 intake 接口仍为 `{ prd, prototype?, files }`。
28. 输入入库保留原件字节、相对目录和可执行位；拒绝空目录、符号链接、敏感/状态路径，保留 500 文件/30 MiB 上限；forge_read 沿用 2000 行/50 KiB 完整行分页，超长单行明确提示。
29. P0 的 spec-lint 错误整体拒绝且不落文件/事件；通过后独立索引提交，闸门重读集成分支并必须人工批准；P1 只留 M3 占位，不派发。恢复 awaiting_gate 时由引擎重跑闸门。
30. 修订先只保存提案与 AC/task 影响，批准才提交 feature；批准前重新 lint 并对比影响，变化时要求打回重提。日期回拨时不早于已有 feature 的日期，保持文件名叠加顺序；architect 变更请求留 M7。
31. AC 的全局编号统一为 `REQ-001.AC1`（规格第 7.1 节、acceptance-tests 技能的写法），task.ac、spec 的 diffAcs/acTexts、修订影响分析都用它，不做转换。规格文件/修订内容单份限 120000 字符，修订名最多 80 字且只含文字、数字、下划线、短横线。

## M1 删除、由 Mx 重建

下列为删除的整个测试或单个用例，保留的运行时用例已迁移配置、角色与提交状态链。跨里程碑用例标出后续参与的里程碑；门禁、同步等机制另有 M1 运行时测试继续保护。

**M2：规格与 P0**

- `test/e2e/flow6.test.ts`：「第六轮全流程：带 PRD 与原型进来 → 就绪检查后提交需求说明（没有 AC 编号被退回）→ 主 agent 规划（缺项目规则被退回、用户打回一次）→ 底座先行、两个模块并行 → 验收不通过交回修复再复查 → 合入主分支」（亦涉及 M3/M6）。**M2 已重建：`p0-flow.test.ts` 的拒绝/打回/批准，`orchestrator-p0.test.ts` 的真实 Pi P0；契约与实施部分仍由 M3/M6 重建。**
- `test/e2e/flow6.test.ts`：「没有 PRD 时退回讨论；规划闸门设为自动通过时提交模块清单后直接开工并应用规则草案；输入路径写错时不建流程」（亦涉及 M3/M6）。**M2 不再适用：PRD 必填且 P0 必须人工批准；路径错误由 commands.test.ts 覆盖，规划/规则部分留 M3/M6。**
- `test/e2e/commands.test.ts`：「/forge-build：--direct 缺少描述报错；已有进行中的流程时拒绝并提示 /forge resume」。**M2 已重建：commands.test.ts 的必填/旧参数拒绝、输入错误不建流程与活动流程限制；--direct 不再适用。**
- `test/e2e/orchestrator-session.test.ts`：「真实 pi：空仓库执行 /forge-build（没有 PRD），主 agent 逐轮问用户、自己查代码，用户确认后提交需求说明，检查通过直接进入规划」。**M2 不再适用：PRD 必填；等价提交链由 orchestrator-p0.test.ts 覆盖，P0 改为等待用户批准。**
- `test/e2e/orchestrator-session.test.ts`：「真实 pi print：首次接收与新进程恢复都把集成分支 PRD 原文放进模型请求」。**M2 已重建：orchestrator-p0.test.ts 首次接收与打回后的新进程恢复；持久化清单注入提示、forge_read 原文进入模型请求。**

**M3：契约与计划**

- `test/e2e/commands.test.ts`：「renumber：临时编号映射到流程内新编号，依赖一起改写」。
- `test/e2e/rules-draft.test.ts`：「批准规划阶段（D2）时：规划时写的项目专属规则草案在无界面时自动应用」。
- `test/unit/prompt-assembler.test.ts`：「规划模块时附上实现者的模型（第六轮注入主会话）：强模型时模块可以大一些，否则要小一些」。

**M4：输入同步与流水线**

- `test/e2e/modules.test.ts`：「forge_sync：把其他模块已合入的代码合进自己的工作区；公共文件冲突时留下标记，解决后再调用一次完成；提交只算自己的改动」。
- `test/e2e/modules.test.ts`：「merge_check：合并时和全量测试一起跑，失败退回实现者」。

**M5：审查（阶段审查亦涉及 M6）**

- `test/e2e/final-review.test.ts`：「最终代码审查：模块都验收后审查整个流程的改动；必须改交给负责的模块（接着原会话）修一轮，建议由用户挑选，之后执行闸门」。
- `test/e2e/final-review.test.ts`：「最终代码审查默认关闭：模块验收通过后直接执行闸门；/forge review 提示怎么开启」。

**M6：阶段验收与交付**

- `test/e2e/modules.test.ts`：「验收两轮修复后仍不通过：转"需要你处理"，依赖它的模块继续等待；/forge accept 人工放行后开工」。
- `test/e2e/modules.test.ts`：「实施阶段闸门的全量测试失败：按日志交给写过那个文件的模块修复（接着原会话）；修好后闸门通过」。
- `test/e2e/modules.test.ts`：「要用户自己查看的检查项：规划时写的与验收者标为 manual 的条目，模块验收通过后列给用户与主会话；manual 不算未通过」。
- `test/e2e/finish.test.ts`：「收尾：全部完成后状态栏显示"完成（待合入）"，主会话拿到收尾汇报，/forge report 可查看」。
- `test/unit/prompt-assembler.test.ts`：「验收任务：逐条验收列出全部条目，复查只列没通过的条目与上次结论；结尾指明用哪个工具提交」。

**M7：变更请求、规格修订与 fix 模式**

- `test/e2e/modules.test.ts`：「/forge-add：只有一个未完成的模块时送到它（写进笔记与 handoff）；多个模块时记为修订请求交给主 agent」。
- `test/e2e/modules.test.ts`：「/forge-add：运行中的模块收到插话（steer），并写进笔记」。
- `test/e2e/replan.test.ts`：「执行中修订计划：/forge replan 交给主 agent，主 agent 直接提交修订，校验拒绝改动已开始的任务；用户批准后新增、调整依赖、取消；进行中的任务不受影响；打回后带着意见重做」。
- `test/e2e/replan.test.ts`：「修订待批准期间，被点名调整或取消的任务暂停派发；打回后恢复」。
- `test/e2e/fix.test.ts`：「/forge-fix：一个实现者定位并修复（回归测试）→ 合并时全量测试 → 直接合入主分支 → 独立验收 → 日志含成本」。
- `test/e2e/fix.test.ts`：「fix 与 build 流程：流程运行中拒绝；等待审批时需确认；同时只允许一个修复」。
- `test/e2e/fix.test.ts`：「成本汇总与 runs 记录一致；返工统计来自事件日志」。
- `test/unit/revision.test.ts`：「修订校验：阶段不能早于当前或是设计阶段；调整依赖造成环、指向不存在的任务都被拒；只报告修订引入的错误」。
- `test/unit/revision.test.ts`：「修订可以取消已阻塞的任务（依赖它的任务要一并调整），不能取消进行中的任务」。
- `test/unit/revision.test.ts`：「调整依赖可以指向本次新增的任务，批准时改写为正式编号」。

**M1 已替换或按规格删除**

- `test/unit/migrations.test.ts`：「迁移 1 → 2（第六轮）：删除原型阶段；停在原型阶段的流程转到规划由主 agent 进行；designer、architect 未结束的任务取消；未结束的修订任务转为修订请求」；第一批删除，格式版本与迁移框架用例替代，不在后续重建。
- `test/unit/migrations.test.ts`：「迁移 1 → 2：停在原型阶段进行中的流程进入规划」；第一批删除，格式版本与迁移框架用例替代，不在后续重建。
- `test/e2e/orchestrator-tools.test.ts`：「forge_dispatch / forge_wait / forge_status」中的手动 dispatch 子路径；wait/status 保留，派发改为程序调用，规格第 13.1 节没有 forge_dispatch，不重建该工具。

## M2 删除按层角色

角色语义已删除，原有机制用例全部保留并重写；角色固定为 orchestrator、architect、worker、test-author、reviewer、stage-qa、researcher。

| 失去意义的旧断言 | 替代覆盖 |
|---|---|
| engineer 后缀自动拥有 worker 工具 | config：只有真实 worker 可用，custom-worker/custom-engineer 与其他角色拒绝 |
| 后端/前端角色自带不同范围，chaos/scout 别名 | guard、DAG、state-store、合并和同步：按 task writes 区分范围；七角色敏感读取、reviewer/stage-qa 只读工具配置 |
| 实施角色默认 medium 升 strong，researcher cheap | 默认升级用 test-author，worker strong 无上一档；e2e 用局部 medium worker，researcher 精确断言 medium 与 unset |
| 设计角色无插件，backend/shared 规则及 frontend 知识隔离 | test-author 无插件，worker 用 Serena/CodeGraph；code/research 知识隔离，global 与局部 code 规则选择 |
| worker 申请角色范围外公共源码；已有测试适配越过后端范围 | task writes 与其他任务 shared 冲突的申请、无重叠自动授权；task writes 外既有单测适配，禁止新增/删除 |
| database 规则默认缺失告警 | init-doctor 显式移除 rules/global.md，断言同级别告警与具体路径 |

crash-driver 与恢复引擎统一读取仓库 agents/，删除绕过旧驱动器的项目 worker 提示覆盖；没有新增或保留按层角色。

## 真实模型实验

（M9 开始记录。对照数据见 pi-flow `NOTES.md` 与 `docs/EXPERIMENTS-4.md`：看板项目原生 Pi 17.6 分钟、隐藏测试 39/40。）

## 缓存提醒

修改 `agents/`、`rules/`、`skills/` 会改变子进程系统提示的稳定前缀，提供商的提示缓存失效一次。改动时在此追加一行。

- 10-09（M0）：`agents/`、`rules/`、`skills/`、`templates/` 是用户提供的 v3 全文，M0 没有改动；运行时还没有使用它们。
- 10-09（M1）：`agents/main.md` 改名为 `agents/orchestrator.md` 并同步 frontmatter；`skills/domain-modeling/SKILL.md`、`skills/change-request/SKILL.md` 将主会话用词改为 orchestrator。运行时开始使用包内角色与技能，稳定前缀改变，提示缓存会失效一次。
