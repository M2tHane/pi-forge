# pi-forge 开发笔记

记录已核实的事实（版本、Pi API）、偏离规格（`docs/BUILD_PROMPT.md`）的决定、真实模型实验的结论。实现细节以代码与测试为准，这里只写"为什么这样做"。
偏离记录的编号不变；新增条目往后追加，一条 1–3 行，被后来的条目修订时注明。代码注释里的"第 N 条"在 M0 迁入的文件中指 pi-flow `NOTES.md` 的编号，改编时逐步换成本文的编号。

目录：[已验证版本](#已验证版本) · [Pi API（已核实）](#pi-api已核实) · [待确认与已知局限](#待确认与已知局限) · [偏离记录](#偏离记录)（第 1–70 条，按里程碑 M0–M7 分组） · [M1 删除、由 Mx 重建](#m1-删除由-mx-重建) · [M2 删除按层角色](#m2-删除按层角色) · [真实模型实验](#真实模型实验) · [缓存提醒](#缓存提醒)。用户文档见 `README.md`，流程图见 `docs/flow.md`。

## 已验证版本

| 组件 | 版本 | 说明 |
|---|---|---|
| Node | 24.18.0 | 要求 ≥22；测试用原生 TS 类型剥离（只用可擦除语法） |
| git | 2.50.1 | 要求 ≥2.30（worktree） |
| Pi | `@earendil-works/pi-coding-agent` **1.0.0**（本机全局安装）；**1.1.0 已评估、兼容**（10-10，见下方升级评估） | 本机全局仍是 1.0.0，是否升级等用户决定；M9 在升级后的版本上跑 |
| typebox | 1.3.27 | Pi 内置核心包，`peerDependencies: "*"`，不打包 |
| minimatch 10.2.6、proper-lockfile 4.1.2、yaml 2.9.0 | | 与 pi-flow 相同，不新增运行时依赖（规格第 1 节第 6 条） |
| typescript 5.9.3、@types/node 22 | | 开发依赖 |
| 复用来源 | pi-flow `~/Documents/Code/program/pi-flow`：运行时 `31f3f15`，流程层 `7006e7d` | 见偏离第 1 条 |

## Pi 1.0.0 → 1.1.0 升级评估（10-10）

- **变更记录**（1.0.1–1.1.0）：对 pi-forge 有影响的只有两处，都不需要改代码。
  - 1.0.4 起 `--tools` 不再移除 MCP 工具（codemode 脚本仍能调用）。pi-forge 的子进程带 `--no-extensions`，内置 MCP 不加载（已读 1.1.0 源码 `core/resource-loader.js`：`noExtensions` 时只加载 `-e` 显式给出的扩展）；guard 的工具白名单也会拦下未授予的工具（第二层）。主会话（用户的交互 pi）上的 MCP 工具同样被 guard 白名单拦下。
  - 1.1.0 的 `--tools` 支持 `+name`/`-name`；pi-forge 的工具名不以 `+`、`-` 开头，不受影响。
- **扩展 API**：对比 1.0.0 与 1.1.0 的 `dist/core/extensions/types.d.ts`、`dist/index.d.ts`，只有新增：`tool_execution_end.durationMs`、`agent_settled.aborted`、`registerToolRenderer`、`ToolLoadout.getPromptGuidelines`、渲染上下文的 `durationMs`/`outputPad`。pi-forge 用到的 API（registerTool、registerCommand、tool_call、before_agent_start、setActiveTools、sendUserMessage、ui、RPC 事件与 usage）没有变化。
- **实测**：真实 Pi 测试（`pi-subprocess`、`orchestrator-session`、`crash-recovery`、`orchestrator-p0`，共 11 个，fake LLM）在 1.0.0 与 1.1.0（临时目录安装，不动全局）上结果相同：10 通过、1 失败。失败的是 `pi-subprocess` 的"合并时全量测试失败退回"，两个版本一样，原因是 M4 起测试改在预检阶段失败、不再走到合并，测试本身过时，留到统一 e2e 修。
- **结论**：可以升级到 1.1.0，不需要改代码。注意 1.0.3 把 Azure 提供方从 `azure-openai-responses` 改名为 `azure`，用 Azure 模型时要改 workflow.yaml 与角色设置里的模型名。

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
- Pi 版本：M1 到 M8 保持 1.0.0。M8 结束、M9 开始前单独做一次升级评估（读 1.0.0 → 1.1.0 的变更记录、核对上面的 Pi API 表、跑全量测试，单独提交）；M9 的实验与原生 Pi 对照组都在升级后的版本上跑。（10-10 已完成评估，结论兼容，见「Pi 1.0.0 → 1.1.0 升级评估」；全局安装是否升级等用户决定。）
- M4 已接上资源隔离、bash 白名单、test-author 隔离工作区与 .at、真实预检、争议、验收测试单独合并与范围申请规则；e2e 按用户要求留到全部开发完统一运行（M4 到 M7 的 e2e 都是这样处理的，M9 之前统一跑一遍）。
- M1 已接通 v3.2 的 schema、状态机、配置和运行时，删除旧 D0/D2/E 流程层。M2 已接上 P0 讨论、规格提交、人工审批与修订；M3 已接上 P1：architect 起草契约与计划、forge_propose_plan 校验、doc 预检、P1 闸门、批准后生成 S 阶段与 task 并进入 S0。真实预检、验收测试 task、审查与契约锁定检查、阶段验收分别由 M4/M5/M6 接入（均已完成，见偏离第 32、44–62 条）。主会话角色按用户决定沿用 orchestrator。
- stage-qa 的 bash 是 full，现有 guard 拦不住 shell 重定向改源码，而规格第 14 节要求 stage-qa 不能写（临时目录除外）。M6 改为由隔离兜底：stage-qa 和阶段审查在集成分支 HEAD 的临时 detached worktree 里运行，没有任何流程从这个 worktree 提交，结束后删除。重定向和 write 工具仍按可写范围（空）拦截。仍然留着的缺口：full bash 命令参数里写主工作区的绝对路径（例如 `cp x /项目/...`）是否被拦截，没有专门的测试。留到统一 e2e 时核对。
- M6 的 e2e（`test/e2e/stage-acceptance.test.ts`）只写了，没有运行。旧的 `test/e2e/gates.test.ts` 按模块生成 `T-NNN` 修复任务；现在改为按 task 生成 `.fx-n`，需要在统一 e2e 时更新。测试项目的 `PROJECT_YAML` 默认 `qa: false`，M6 的测试显式打开。
- 阶段被打回（stage_reopened）后，再跑 stage-qa 与阶段审查时，旧的轮次仍计入 `qa.max_rounds` 和 `review.max_rounds`。M7 没有处理，留作已知局限：签收被打回后，用户可以用 `/forge accept` 放行。
- M7 的 e2e（`change-request`、`fix`）只写了，没有运行。没有为 feature 和 adopt 写 e2e，它们由单元测试覆盖。提示词已按用户决定在 M8 补上 `modifies`、adopt 与 feature 的写法（见缓存提醒 10-10）。
- 变更请求的 `cancelled` 状态在 store 里有（`StateStore.cancelChange`），但没有接命令，也没有调用者（M8 文档阶段核对：仍然如此）。
- 流程图按用户要求延后（含 drawio）：`docs/flow.md` 是 M8 subagent 写的 mermaid 草稿，未审阅，之后再整理。
- 工作流视图（`scripts/forge-view.*`）按用户要求延后：M8 subagent 的改编已合入，只做过渲染冒烟（能打开、无脚本错误），界面与数据未审阅，之后再整理。
- M8 文档阶段发现的小问题已修正：帮助文本补上 `change:<id>`，删掉不存在的 `/forge stop`，旧写法 `/forge-build "<描述>"` 改为 `--prd`，`templates/AGENTS.md` 改为 v3 的阶段与目录。

## 偏离记录

**M0（2026-10-09）**

1. 复用基线分两层（规格 v2/v3 第 1、16 节，DECISIONS-R1 第 1 条）：运行时文件取 pi-flow HEAD `31f3f15`，流程层取 `7006e7d`。M0 拷贝 `31f3f15` 的整个 `src/` 与 `test/`；`7006e7d` 的流程层（core 的 stages、revision、acceptance、final-review、requirements、gates，modes 的 plan、fix，tools 的 module-tools、orchestrator-tools 及其测试）与 `5100d6b^` 的 stage-review、state-machine 放在 `legacy/` 作参考，不参与构建。`5100d6b^` 目录写成 `legacy/5100d6b-parent/`（`^` 在 shell 中需要转义）。
2. 改名只改产品与命名空间：`pi-flow` → `pi-forge`（包名、`refs/pi-forge/state` 与检查点 refs、`pi-forge.json`、git 身份、消息类型），`.flow/` → `.forge/`，`PI_FLOW_*` → `PI_FORGE_*`，工具名 `flow_*` → `forge_*`，命令 `/flow`、`/flow-*` → `/forge`、`/forge-*`，状态提交前缀 `forge-state:`，文件 `commands/flow.ts`、`flow-config.ts`、`flow-watch.ts`、`scripts/flow-view.*` 改成 forge。**领域名词 flow（一个流程实例）保留**：`FlowFile`、`flowId`、`.forge/flows/<id>/`、`active_flow`、事件与 run 的 `flow` 字段、实体名 `'flow'`、工具种类 `'flow'`、集成分支 `flow/<id>/integration`；TS 标识符（`runFlowCommand`、`FLOW_TOOLS`、`piFlowSubagent` 等）也不改，改编时按需更换。改名脚本按明确的正则替换，之后逐条核对残留。
3. pi-flow 的包内容（agents、skills、rules、templates、prompts @ 31f3f15，已改名）放在 `test/fixtures/pi-flow-package/`，运行时测试经 `test/helpers/package.ts` 的 `PKG_CONTENT` 引用；pi-forge 自己的 `agents/`、`skills/`、`rules/`、`templates/workflow.yaml` 是 v3 内容，迁入的 config 还解析不了（M1 改）。为了让真实 pi 进程的测试也用夹具，`src/pi-adapter/extension.ts` 新增 `CONTENT_ROOT`（环境变量 `PI_FORGE_CONTENT_ROOT`，默认包根目录），角色提示、技能、模板、init 的来源都改从它读取；子进程扩展路径仍取包根目录。这是 M0 唯一的 `src/` 行为改动，M1 迁移完成后删除。（M1 已落实，见第 13、14 条。）
4. M0 不 skip 测试（DECISIONS-R2 第 3 节）：拷贝的是 HEAD 的流程层，测试全部能过，留着保护改名。通知测试（`test/unit/state-recovery6.test.ts`）原来让两个通知进程追加同一个文件，负载高时内容交错、偶发失败；改为每个事件写单独的文件（只改测试）。
5. `.npmrc` 设 `legacy-peer-deps=true`：pi-flow 的锁文件没有 Pi 的 peer 依赖（Pi 由宿主提供，扩展经 jiti 加载时解析到全局安装），npm 7 起默认会安装 peer 依赖，导致 `npm ci` 报锁文件不同步。
6. 没有拷贝 pi-flow 的 `scripts/demo*`、`bench5-native.ts`、`measure-merge.ts`、`playground/`、`docs/`；`package.json` 去掉 `demo` 脚本与 `prompts` 清单（`prompts/stage-kickoff.md` 是 pi-flow 主会话的提示模板，只放进夹具）。`templates/AGENTS.md`、`templates/gitignore.append` 从 pi-flow 拷贝（`init` 要用，v3 没有提供）。
7. 契约"只能追加"的判定规则（DECISIONS-R1 第 21 条，规格第 12.1 节）：新增 path、operation、响应状态码、可选的请求或响应字段、schema、错误码、`modules/*.md` 的函数小节、数据表、可空列算追加；删除或改名、改已有字段的类型、格式、默认值，给请求新增必填字段，改动任何 `required` 数组或 `enum`（包括新增取值），改已有错误码的 http 状态或含义，改已有列、新增非空且没有默认值的列，都算修改，要走变更请求。M5 实现时以规格第 12.1 节的表为准。（已被第 54 条细化）

**M1（2026-10-09）**

8. 一次切换到 v3.2：删除 HEAD 的规划、需求讨论、独立验收、最终审查、修订与 fix 流程层，后续按 legacy 分别在 M2–M7 重建。`/forge-build` 只建流程、停在 P0，不启动主会话讨论。
9. M1 临时预检集中在 `passthroughPrecheck()`，等待最新验收测试与软依赖、同步后直通 queued_merge；合并时仍执行全量验证。M4 替换，M4 验收必须确认直通代码和标记已删除。（已被第 47、48 条修订）
10. bash allowlist 在 M4 前按 readonly 处理，保留 `bashAllow` 配置；**命令白名单尚未生效**，不能因此放行有副作用的命令。（已被第 41 条修订）
11. 暂时保留 HEAD 的门禁失败修复任务机制，kind 改为 fix；两轮用尽进入 needs_human。M6 由 stage-qa 取代；M1 的 accept 只接状态机已有的人工例外路径，最终合入仍需用户签收。（已被第 59、60 条修订）
12. 主会话角色沿用 orchestrator，不采用规格中的 main（用户决定）；规格中的 main 都指 orchestrator。范围授权来源和超时复核设置也使用 orchestrator，主分支名与 main_branch 保持原样。
13. `.forge` 格式版本从 1 开始，无内置旧格式迁移；保留迁移框架、更新版本拒写与缺失迁移提示。不提供旧 pi-flow 流程兼容路径（修订 M0 第 3 条的临时夹具方案）。
14. **已撤销（M2，见第 21 条）**：名字以 `-engineer` 结尾的角色按 worker 校验专属工具，保留按层的运行时测试夹具；仓库角色来自包根目录与项目覆盖目录，不再使用 CONTENT_ROOT。
15. run_timeout 计入 attempts（规格第 8.1 节），保留超时复核和续跑上限；已有超时复核决定优先于重复失败看守，避免其提前截断续跑。unblock 默认保留计数，--reset 仅清零阻塞原因对应的计数。
16. `testing.adjust_tests` 按模板保留，仅 impl/fix 可适配已有测试，新增与删除不放行；独立的 `tests/acceptance/**` 从适配白名单中排除。
17. risk 枚举暂定为 low、normal、high；M1 仅校验形状，计划的语义检查与 DAG 推导留给 M3。
18. `canAppendInterfaces` 保留，路径改为 `docs/contracts/**`，提交例外只认 `Facts.contract_additions`；M5 判定实现前传空数组，不能将 agent 的声明当成已核实的追加。（已被第 54 条修订）
19. 模型升级读取 attempts、precheck_failures、merge_failures、review_rounds 的合计，不改写各独立计数；合并验证日志按 merge_failures 编号，避免旧 attempts 编号覆盖重试证据。
20. intake 的输入导入与独立索引提交原语暂时保留，输入放进 `docs/spec/inputs/`；M2 改为规格流程。旧真实构建脚本移除，M9 再实现真实模型实验。

**M2（2026-10-09）**

21. 删除按层测试角色，运行时测试改用 pi-forge 七角色重写；撤销第 14 条的 engineer 后缀兼容。旧断言的替代见下方“M2 删除按层角色”。
22. `/forge-build` 的 `--prd` 必填，不支持无 PRD 的想法讨论；原件不解析，流程标题取 PRD 文件或目录名，原型可省略。
23. forge_read 的 ref 白名单只认存在的本地主分支与 flow 的集成/任务分支，不接受 HEAD、SHA、revision 或状态引用，避免读到状态与检查点。
24. 同一流程只允许一份 proposed 规格修订；多个审批对象必须明确 stage/amend，change 留给 M7，避免误批准或叠加未批准修订。（change 已由第 64 条实现）
25. spec 增量页面按路由整页替换，权限按资源操作合并角色单元格；没有删除页面语法，空页面小节与无数据行的合法权限表表示没有变更。
26. 删除的 REQ 编号不得复用，仍计入历史最大编号；额外拒绝不可解析的需求/AC/术语、空基线、删除标题带 AC、重复 feature 文件名或小节，避免静默猜测。
27. intake 清单持久化为 `{ prd, prototype_path?, files }`，替换第 20 条的兼容投影；TypeBox 1.3.27 的 Memory.Clone 会剔除 `prototype` 键，故内部改名，公开 intake 接口仍为 `{ prd, prototype?, files }`。
28. 输入入库保留原件字节、相对目录和可执行位；拒绝空目录、符号链接、敏感/状态路径，保留 500 文件/30 MiB 上限；forge_read 沿用 2000 行/50 KiB 完整行分页，超长单行明确提示。
29. P0 的 spec-lint 错误整体拒绝且不落文件/事件；通过后独立索引提交，闸门重读集成分支并必须人工批准；P1 只留 M3 占位，不派发（已被 33 修订）。恢复 awaiting_gate 时由引擎重跑闸门。
30. 修订先只保存提案与 AC/task 影响，批准才提交 feature；批准前重新 lint 并对比影响，变化时要求打回重提。日期回拨时不早于已有 feature 的日期，保持文件名叠加顺序；architect 变更请求留 M7。（已被第 64、67 条修订）
31. AC 的全局编号统一为 `REQ-001.AC1`（规格第 7.1 节、acceptance-tests 技能的写法），task.ac、spec 的 diffAcs/acTexts、修订影响分析都用它，不做转换。规格文件/修订内容单份限 120000 字符，修订名最多 80 字且只含文字、数字、下划线、短横线。
32. 验收测试 task（`.at`）的推导已实现（`deriveTasks` 的 `acctest` 开关），但 M3 不创建（`ACCTEST_TASKS_M4 = false`）：独立工作区、同步进 impl 预检和报告路径在 M4，现在创建会让 impl 的输入一直不就绪。M4 打开并补 e2e。（M4 第 3 步已打开，常量删除。）
33. P1 由程序驱动：进入 P1、打回或闸门失败时引擎新建 architect 的 doc task（接着上一个 task 的会话，`fork_from_task`），不经主会话、不受 auto_dispatch 影响，直接派发（与 merge-fix 同路径）。返工原因存在 `flow.plan_rework`，写进新 task 的 handoff，派发后清除。
34. task 编号全流程连续：architect 的 doc task 也占编号，plan.yaml 从下一个空号起（brief 写明起始号，冲突时校验给出建议编号）。不用临时编号再映射。
35. `forge_propose_plan` 在 architect 的 worktree 上跑完整 P1 校验（契约结构、术语表只追加、计划），通过后保存 `plan-proposal.json`（含 plan 的 sha256、assumptions、extras、报告）。doc 预检要求提案存在且 plan.yaml 未再改；闸门在集成分支上重跑同样的校验。
36. 术语表在 P1 只能追加：对比 `flow.spec.sha` 时的版本，已有术语的定义不能改、不能删。
37. 契约锁定只记录 `flow.contracts_base`（批准 P1 时集成分支的提交）。实施阶段对契约只能追加的强制检查放在 M5（审查/契约检查）。（已被第 54、66 条修订）
38. 批准 P1 时先在主工作区应用规则与命令草案（单独提交，包括 `acctest_workspace`），并同步更新运行中的配置，再生成 S 阶段与 task。P1 不算最后阶段，不提示合入主分支。
39. 规则文件除按 scope 选择外，还按 task 的 `layers` 附上 `rules/<layer>.md`（存在时）。architect 写的规则草案按层命名，worker 就能拿到。
40. 资源端口段在 41000–60000 内按 10 对齐，从随机位置开始找，登记前逐个端口探测能否监听。程序步骤（预检、门禁、合并验证）用带前缀的标签（`pc-`、`gate-`、`merge-`）代替 run id；条目的 pid 记分配它的引擎进程，回收条件是 run 已结束或该进程已不存在。
41. bash 白名单：`bash_allow` 引用的命令拆成简单命令，`{files}` 占位及其后的词去掉，调用时逐词前缀匹配；其余按只读档位处理。"读其他提交"的拦截范围是：`git show`、`cat-file`、`archive`，`log` 的 `-p`/`-L` 等，`diff`/`blame`/`grep` 在 `--` 之前带版本参数。只读档位比较工作区改动要写成 `git diff -- <路径>`；reviewer 的 diff 按第 10.2 节附在提示里（M5）。
42. 隔离工作区的 guard 由 `GuardContext.isolatedWorkspace` 打开（第 3 步对 acctest task 设置），不按角色名判断。
43. 验收测试分支名用 `flow/<流程>/acc/<impl>`（规格写 `acc/<task>`），与任务分支同一命名空间，按流程清理；`.at` 与 `.at-n` 都写进原 impl 的目录和分支。
44. test-author 提交时，task 的每条 AC 都要有以 `[REQ-xxx.ACn]` 开头的测试，否则拒绝（规格只说"统计覆盖率"，这里按"能用程序判断的不交给 LLM"直接检查）；覆盖情况存为 evidence `coverage.json`。越界改动由程序还原后拒绝（test-author 的 bash 不能用 git 还原）。
45. 隔离工作区的基线提交包含导出文件与 codegen 产物，依赖目录写进 `.git/info/exclude`；缓存命中时用 Node 逐文件硬链接（macOS 的 cp 没有 -l）。准备失败时 task 转 blocked 交给用户，不反复重试。工作区目录名取首次派发的 run id，返工派发复用。
46. 资源端口段长度取 `limits.port_block`（默认 10），已登记区间按重叠判断。
47. 预检第 3 步（diff 越界、验收测试未改）沿用 forge_submit 时的状态机检查，预检不再重复；程序合入、内容与 acc 分支一致的本 task 测试文件不算 worker 的改动。"契约只能追加"留了 `contractAppendCheck` 接入点，M5 实现。逐任务审查在 M5 接入，M4 预检通过一律 `precheck_pass_skip`。
48. 预检在后台运行（与合并一样被跟踪），同一 task 不并发；resume 后 checking 的 task 由下一次 pump 重新预检（第 8.3 节"丢弃结果重跑"）。计划派生的 impl 带 `verify: [typecheck, lint, test]`（已定义的），合并时据此跑全量。
49. 争议依据的核对：`docs/spec/…`、`docs/contracts/…` 的文件存在（`:行号` 在范围内、`#标题` 能在文件中找到），或规格中存在的 AC 编号；实现代码不算。同一测试争议次数超过 `testing.max_disputes` 时 forge_dispute 直接转用户裁决，不再建 .at-n。
50. 验收测试在合并验证时全量运行（加到 typecheck、lint、test、merge_check 之后），失败按输出里出现的 `tests/acceptance/<task>/` 目录归属：全在别的 task → 第 9.4 节；acctest 单独合并时全在本目录或认不出 → .fx-n，有目录外的 → integration_broken。认不出目录的普通 task 失败按原来的合并失败处理。
51. 新 task 字段：`acctest_round`（.at-n 的来由）、`changed_tests`（report 时记录）、`waits_for`（第 9.4 节等待的 .at-n，由 foreign_tests_broken 写入、inputs_ready 清除）。.at-n、.fx-n 的 stage 取当前阶段，保证可调度。"最新验收测试"一律忽略已取消的轮次。
52. impl 已 done、test-author 没改测试时提交被拒（没有可单独合并的内容），需要 forge_block 说明。验收测试 task 不参与批量合并。
53. 范围申请（第 14 节）：硬限制在 `checkScope` 里直接拒绝；与已开工 task 重叠的 forge_request_scope 直接拒绝，forge_resolve_scope 批准时再查一次（申请后才开工的也拒绝）。`forge_service` 与范围申请的授予在 M1 配置里已限定为 worker、stage-qa / worker。
54. 契约追加的结构化判定（第 12.1 节，`contract-diff.ts`）：只在集合位置允许新增键（路径表、operation、responses、properties、content、components/errors 根、tables、columns），其他位置新增都算修改；任何数组（含 required、enum）必须不变，因此新增 property 只可能是可选字段，请求与响应用同一条规则。新增列须 `nullable: true` 或带 `default`。已有错误码只比较 http 与 message。forge_submit 与预检用同一套规则（替换原来的按行删除检查），通过的契约改动作为 `contract_additions` 不受 writes 限制。修改已有契约的提示改为 forge_block（forge_change_request 在 M7）。
55. 契约冲突（第 12.2 节）：rebase 冲突文件全部在 docs/contracts 时做三方合并（stage 1 祖先、2 集成分支、3 任务提交，已实测）；混有其他文件或合并不了时放弃，本模块的契约文件与根 openapi.yaml、data-model.yaml 的冲突走 merge-fix，merge-fix 可写自己 conflict_files 里的契约文件。
56. 逐任务审查：`.rv` 用被审查 task 的 worktree（只读，不新建也不删除）；审查输入完整放进提示（`reviewBrief`），不走 handoff 通道（handoff 只保留末尾 6000 字）。`review.max_rounds` 接到状态机的 `limits.review_max_rounds`：第 k 轮仍有 must 走 review_changes，k 达到上限时由计数器转 blocked（review_exhausted），不单独用 review_exhausted 触发器。strong 审查受 `escalation.enabled` 约束用升级模型。结论存 evidence（review-input/report/confirm.json），suggest 由程序提交到集成分支 `docs/review/suggestions.md`。返工前已通过的审查不重审。测试夹具 `mkTask` 默认 `review: 'skip'`，避免旧用例多出审查派发。
57. "合并队列选第一个合格的 task"在 M1 已实现（软依赖未完成的跳过）；由于软依赖在 inputs_ready 时已检查，实际不会出现队首不合格，保留作保护。
58. 阶段级 task 的编号挂在阶段上：`S1.rv`、`S1.rv-2`（精简模式的阶段审查）、`S1.qa`、`S1.qa-2`（stage-qa）。规格只规定了 `T-xxx` 的后缀，所以 TaskId 的模式放宽到"阶段编号.rv/.qa"。`acctest_round.kind` 增加 `coverage`。
59. 阶段验收的编排在 `stage-acceptance.ts`。流程是：精简模式先做阶段审查 → 门禁命令与覆盖率（`runImplementationChecks`，不转移阶段状态）→ stage-qa → 修复 → 重跑门禁与覆盖率 → stage-qa 只确认一轮 → 签收。stage-qa 运行期间阶段保持 `awaiting_gate`，state-store 允许 qa task 在这个状态下派发。修复期间阶段回到 `active`（触发器 gate_failed）。只有门禁通过时的 HEAD 和最近一轮 qa 的 HEAD 都等于当前集成分支 HEAD，才进入签收。各类轮数用尽或问题找不到负责的 task 时转 `needs_human`（触发器 gate_exhausted）。
60. 覆盖率缺口生成的 `.at-n` 和门禁修复共用 `MAX_GATE_ROUNDS = 2`，记在 `gate_rounds` 里，command 为 `coverage`。覆盖率报告提交到集成分支的 `docs/qa/<阶段>.md`，阶段 evidence 里再存一份 `coverage.md`。只在计划里有的 S 阶段（`s_stages`）计算覆盖率。
61. fix task 的归属（第 11.1 节）：文件归"writes 覆盖它、已 done 的 impl task 中编号最大的一个"，因为 task 没有时间戳。验收测试目录 `tests/acceptance/<T>/` 里的失败直接归 T，`writes` 用 T 的 writes，因为 worker 不能改测试。fork 的会话取该 impl 最近一个已 done 的 `.fx-n`，没有时取 impl 本身。stage-qa 和阶段审查生成的 fix 用标题里的"（S1.qa 第 k 轮）"识别轮次，不新增字段。
62. stage-qa 与阶段审查复用 reviewer 的出处校验、降级和"确认轮不能新增问题"规则。结论存为 evidence：`qa-input.json`、`qa-report.json`、`qa-confirm.json`。它们没有自己的 worktree，派发时在集成分支 HEAD 建临时 detached worktree，结束后删除。`forge_service` 在没有 worktree 时直接拒绝，不再回退到主工作区。
63. 精简模式跨阶段接着会话：impl 没有 `fork_from_task` 时，派发时 fork 上一阶段 impl 谱系里最后一个 worker task。会话大小和 `continue_session` 仍由 `forkSource` 检查。签收汇总与交付汇报在 `signoff.ts`（改编自 pi-flow finish-report）：`/forge report` 显示；最后一个阶段批准时把汇报存为阶段 evidence `delivery.md`，再 `--no-ff` 合入主分支。第 17 节的指标由 `/forge-status --metrics` 显示。
64. 变更请求（第 12.3 节）存为 `changes/C-001.json`，状态依次为 drafting → proposed → approved/rejected。同一流程同时只能有一个未结束的变更请求，第二个直接拒绝，不排队。architect 在当前阶段的 doc task 里改计划，用 `forge_propose_plan` 提交。对已开始或已完成的 task 的修改，写成新 task 加 `modifies: T-xxx`（计划新增的字段，只在变更请求里允许），程序把它变成硬依赖原 task 的后续 task。批准时在一个事务里落地：新增、调整、取消 task，`.at-n`（kind `change`），以及 `stages_revised`。
65. 变更请求在 proposed 时就暂停被它调整的 task，而不是等合并之后。有未结束的变更请求时，阶段门禁等待。architect 对契约的修改在用户批准前就合入集成分支。当前计划取自最近一个已批准变更请求的 `plan_text`，没有时取 `contracts_base` 上的 plan.yaml，所以被打回的修订不会污染基线。
66. 契约只能追加的检查，基线改为任务 worktree 与集成分支的合并基点（`contractBaseOf`）：任务 forge_sync 之后，已批准变更请求对契约的修改不算 worker 的改动。
67. 规格修订批准后，如果计划已批准且 AC 有变化，程序自动发起变更请求（source `amend:A-xxx`）。已有未结束的变更请求时只提示，不发起。
68. fix 模式（第 13.4 节）由 `src/modes/fix.ts` 驱动，改编自 7006e7d。T-001 是 worker 的 impl，writes 为 `**`，不派 `.at`，不做审查，合并时跑全量直接进 main。之后派 X1.qa（stage-qa，只读），在阶段 active 时运行，和 S 阶段不同。must 生成 `.fx-n`，然后 X1.qa-2 只确认，最多两轮，之后转 needs_human，`/forge accept --note` 放行。修复日志写在 `.forge/fixes/<日期>-nnn.md`。`implementation_gate.qa: false` 时跳过确认。`fix_max_files` 只写进 handoff，程序不强制。
69. feature 模式：增量规格文件名带"日期-000-"前缀，规格写的是 `<名字>.md`，加前缀是为了按文件名叠加的顺序稳定。修改过的权限行记在 `flow.spec.permission_changes`，在批准页单独列出。P1 计划只要求新增或变化的 AC 有归属，因为基线里的 AC 已经实现。main 上已有的契约从流程开始就锁定，只能追加。没有 `docs/contracts/` 时 `/forge-build --feature` 拒绝，并提示先运行 `/forge init --adopt`。
70. `/forge init --adopt ["<说明>"] [--force]` 用一个 feature 流程，只有一个阶段 `ADOPT`。architect 的 doc task 只写 `docs/contracts/**` 和 `docs/arch/**`，只描述现有行为；契约结构检查通过后由用户批准，批准时 `--no-ff` 合入 main。`--force` 用于以后纳管更多模块，此时已有契约只能追加。`/forge-add` 只把需求交给主会话整理成 `forge_spec_amend`，不改状态。

## M1 删除、由 Mx 重建

下列为删除的整个测试或单个用例，保留的运行时用例已迁移配置、角色与提交状态链。跨里程碑用例标出后续参与的里程碑；门禁、同步等机制另有 M1 运行时测试继续保护。

**M2：规格与 P0**

- `test/e2e/flow6.test.ts`：「第六轮全流程：带 PRD 与原型进来 → 就绪检查后提交需求说明（没有 AC 编号被退回）→ 主 agent 规划（缺项目规则被退回、用户打回一次）→ 底座先行、两个模块并行 → 验收不通过交回修复再复查 → 合入主分支」（亦涉及 M3/M6）。**M2 已重建：`p0-flow.test.ts` 的拒绝/打回/批准，`orchestrator-p0.test.ts` 的真实 Pi P0；契约与实施部分仍由 M3/M6 重建。**
- `test/e2e/flow6.test.ts`：「没有 PRD 时退回讨论；规划闸门设为自动通过时提交模块清单后直接开工并应用规则草案；输入路径写错时不建流程」（亦涉及 M3/M6）。**M2 不再适用：PRD 必填且 P0 必须人工批准；路径错误由 commands.test.ts 覆盖，规划/规则部分留 M3/M6。**
- `test/e2e/commands.test.ts`：「/forge-build：--direct 缺少描述报错；已有进行中的流程时拒绝并提示 /forge resume」。**M2 已重建：commands.test.ts 的必填/旧参数拒绝、输入错误不建流程与活动流程限制；--direct 不再适用。**
- `test/e2e/orchestrator-session.test.ts`：「真实 pi：空仓库执行 /forge-build（没有 PRD），主 agent 逐轮问用户、自己查代码，用户确认后提交需求说明，检查通过直接进入规划」。**M2 不再适用：PRD 必填；等价提交链由 orchestrator-p0.test.ts 覆盖，P0 改为等待用户批准。**
- `test/e2e/orchestrator-session.test.ts`：「真实 pi print：首次接收与新进程恢复都把集成分支 PRD 原文放进模型请求」。**M2 已重建：orchestrator-p0.test.ts 首次接收与打回后的新进程恢复；持久化清单注入提示、forge_read 原文进入模型请求。**

**M3：契约与计划**

- `test/e2e/commands.test.ts`：「renumber：临时编号映射到流程内新编号，依赖一起改写」。**M3 不再适用：计划直接用流程编号（偏离 34），冲突与建议编号由 `plan.test.ts` 覆盖。**
- `test/e2e/rules-draft.test.ts`：「批准规划阶段（D2）时：规划时写的项目专属规则草案在无界面时自动应用」。**M3 已重建：`p1-flow.test.ts` 批准 P1 时应用规则与命令草案（含 acctest_workspace）并同步运行中的配置。**
- `test/unit/prompt-assembler.test.ts`：「规划模块时附上实现者的模型（第六轮注入主会话）：强模型时模块可以大一些，否则要小一些」。**M3 已替换：worker 的模型写进 architect 的 brief，`p1-flow.test.ts` 断言。**

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
- 10-10（M8）：`agents/architect.md` 增加 feature 模式、变更请求（完整计划与 `modifies`）、纳管（--adopt）三节；`skills/change-request/SKILL.md` 改为写完整计划、已开始的 task 用 `modifies`，删掉 N-001 编号；`agents/orchestrator.md` 增加 feature 模式的增量规格写法。architect 与 orchestrator 的提示缓存各失效一次。
