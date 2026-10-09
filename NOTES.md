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
| 路径解析 | Unicode 空格归一、去 `@`、展开 `~`、`file://`；guard 按同样规则 | 源码 |

第三方插件（读源码核实）：pi-serena 0.9.20（20 个工具，文件参数 `relative_path`；`serena_rename_symbol` 等不分配给角色）；pi-codegraph 0.1.10（8 个工具，参数是符号）；pi-web-access 0.35.0（默认不激活，需 `setActiveTools`）；pi-rules 0.6.0（不能按角色挑规则，所以不用）；pi-subagents 0.74.0（对照实验用）。

上表从 pi-flow `NOTES.md`（@ 31f3f15）原样搬来，只改了工具名前缀，都是在 Pi 0.99.2 / 1.0.0 上核实的。本机仍是 1.0.0，M0 的真实 pi 测试（`orchestrator-session`、`crash-recovery`、`pi-subprocess`）全部通过；用到新的 Pi API 时先查文档或源码再补进本表。

## 待确认与已知局限

- 继承自 pi-flow：serena 的 `prepareArguments` 在 `tool_call` 之前还是之后未核实；guard 管不到脚本文件内部（`bash x.sh`、`npm run`），兜底是提交时的 diff 检查；打码只认识常见密钥形态。
- M0 之后运行时仍是 pi-flow 第六轮的流程（D0 接收 → D2 主 agent 规划 → E 模块实施与独立验收），角色名也还是 orchestrator、implementer、acceptor。pi-forge 的 v3 角色、技能和模板还没接上（M1 起）。

## 偏离记录

**M0（2026-10-09）**

1. 复用基线分两层（规格 v2/v3 第 1、16 节，DECISIONS-R1 第 1 条）：运行时文件取 pi-flow HEAD `31f3f15`，流程层取 `7006e7d`。M0 拷贝 `31f3f15` 的整个 `src/` 与 `test/`；`7006e7d` 的流程层（core 的 stages、revision、acceptance、final-review、requirements、gates，modes 的 plan、fix，tools 的 module-tools、orchestrator-tools 及其测试）与 `5100d6b^` 的 stage-review、state-machine 放在 `legacy/` 作参考，不参与构建。`5100d6b^` 目录写成 `legacy/5100d6b-parent/`（`^` 在 shell 中需要转义）。
2. 改名只改产品与命名空间：`pi-flow` → `pi-forge`（包名、`refs/pi-forge/state` 与检查点 refs、`pi-forge.json`、git 身份、消息类型），`.flow/` → `.forge/`，`PI_FLOW_*` → `PI_FORGE_*`，工具名 `flow_*` → `forge_*`，命令 `/flow`、`/flow-*` → `/forge`、`/forge-*`，状态提交前缀 `forge-state:`，文件 `commands/flow.ts`、`flow-config.ts`、`flow-watch.ts`、`scripts/flow-view.*` 改成 forge。**领域名词 flow（一个流程实例）保留**：`FlowFile`、`flowId`、`.forge/flows/<id>/`、`active_flow`、事件与 run 的 `flow` 字段、实体名 `'flow'`、工具种类 `'flow'`、集成分支 `flow/<id>/integration`；TS 标识符（`runFlowCommand`、`FLOW_TOOLS`、`piFlowSubagent` 等）也不改，改编时按需更换。改名脚本按明确的正则替换，之后逐条核对残留。
3. pi-flow 的包内容（agents、skills、rules、templates、prompts @ 31f3f15，已改名）放在 `test/fixtures/pi-flow-package/`，运行时测试经 `test/helpers/package.ts` 的 `PKG_CONTENT` 引用；pi-forge 自己的 `agents/`、`skills/`、`rules/`、`templates/workflow.yaml` 是 v3 内容，迁入的 config 还解析不了（M1 改）。为了让真实 pi 进程的测试也用夹具，`src/pi-adapter/extension.ts` 新增 `CONTENT_ROOT`（环境变量 `PI_FORGE_CONTENT_ROOT`，默认包根目录），角色提示、技能、模板、init 的来源都改从它读取；子进程扩展路径仍取包根目录。这是 M0 唯一的 `src/` 行为改动，M1 迁移完成后删除。
4. M0 不 skip 测试（DECISIONS-R2 第 3 节）：拷贝的是 HEAD 的流程层，测试全部能过，留着保护改名。通知测试（`test/unit/state-recovery6.test.ts`）原来让两个通知进程追加同一个文件，负载高时内容交错、偶发失败；改为每个事件写单独的文件（只改测试）。
5. `.npmrc` 设 `legacy-peer-deps=true`：pi-flow 的锁文件没有 Pi 的 peer 依赖（Pi 由宿主提供，扩展经 jiti 加载时解析到全局安装），npm 7 起默认会安装 peer 依赖，导致 `npm ci` 报锁文件不同步。
6. 没有拷贝 pi-flow 的 `scripts/demo*`、`bench5-native.ts`、`measure-merge.ts`、`playground/`、`docs/`；`package.json` 去掉 `demo` 脚本与 `prompts` 清单（`prompts/stage-kickoff.md` 是 pi-flow 主会话的提示模板，只放进夹具）。`templates/AGENTS.md`、`templates/gitignore.append` 从 pi-flow 拷贝（`init` 要用，v3 没有提供）。
7. 契约"只能追加"的判定规则（DECISIONS-R1 第 21 条，规格第 12.1 节）：新增 path、operation、响应状态码、可选的请求或响应字段、schema、错误码、`modules/*.md` 的函数小节、数据表、可空列算追加；删除或改名、改已有字段的类型、格式、默认值，给请求新增必填字段，改动任何 `required` 数组或 `enum`（包括新增取值），改已有错误码的 http 状态或含义，改已有列、新增非空且没有默认值的列，都算修改，要走变更请求。M5 实现时以规格第 12.1 节的表为准。

## M1 起随改编替换的流程层测试

这些测试覆盖 pi-flow 第六轮的流程（接收、主 agent 规划、模块验收、计划修订、最终审查、fix），M0 照常运行；对应的流程层改编时，换成 pi-forge 流程的测试或删除：

- e2e：`flow6`、`tools6`、`modules`、`replan`、`final-review`、`fix`、`finish`、`orchestrator-session`、`orchestrator-tools`、`commands`、`rules-draft`
- unit：`revision`、`state-recovery6`（命令草案与检查点部分保留）、`status-view`、`config`（模板部分）、`init-doctor`（模板部分）
- 夹具：`test/fixtures/pi-flow-package/`、`workflow-legacy.yaml`、`fixtures/agents/*`、`fake-llm/scripts/*`

## 真实模型实验

（M9 开始记录。对照数据见 pi-flow `NOTES.md` 与 `docs/EXPERIMENTS-4.md`：看板项目原生 Pi 17.6 分钟、隐藏测试 39/40。）

## 缓存提醒

修改 `agents/`、`rules/`、`skills/` 会改变子进程系统提示的稳定前缀，提供商的提示缓存失效一次。改动时在此追加一行。

- 10-09（M0）：`agents/`、`rules/`、`skills/`、`templates/` 是用户提供的 v3 全文，M0 没有改动；运行时还没有使用它们。
