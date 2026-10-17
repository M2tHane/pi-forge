# pi-forge 项目说明（给 Claude Code）

pi-forge 是 Pi 的多 agent 开发工作流插件：用户在流程外写好 `docs/PRD.md` 与 `docs/prototype/`，之后只批准架构、签收每个批次；中间的架构、实现、审查、合并、验收都交给流程（架构师 S0 → 后端按 domain 并行、前端单人按页面 → 每批浏览器验收）。

## 设计原则（改任何东西之前先对照）
1. **默认放权。** agent 在项目里可以读、写、执行任何东西。guard 只拦禁止列表：`.forge/`、`.git/`、`workflow.yaml`、密钥、项目目录之外的路径、`docs/PRD.md` 与 `docs/prototype/`（对 backend、frontend 还有契约与架构文档），以及 `guard.ts` 的 `IMPL_FORBIDDEN`。
2. **加约束要有事故。** 新增任何拦截、闸门、必填项、"校验不过就拒绝"之前，先写出它防住了哪一次真实运行里发生过的事。说不出就不加。能提醒就不拦；能事后检查，就不事前拦。
3. **程序只做必须由程序做的事：**状态转移、调度、合并、计数与超时，以及执行 install、test、acceptance、serve。怎么写代码、跑哪些检查，由 agent 自己决定；程序给的是参考信息（`commands.yaml`、`rules/`、项目知识），不是约束。
4. **碰壁先问墙该不该存在。** 真实运行里 agent 被拦、卡住、反复失败时，先判断是不是约束本身错了。删约束优先于加绕过它的新机制。
5. **能删就不加。** 解决问题优先删代码、删步骤。汇报里写明这次净增减了多少行。
6. **状态只由程序写。** `.forge/` 只经 `state-store.ts` 写；agent 只能通过 `forge_*` 工具提交申请。

## 真实模型实验（花钱，只在用户明确要求时跑）
- **开跑前写清楚：**假设、配置（各角色的模型与思考强度）、指标、隐藏测试。驱动脚本是 `scripts/real-build.ts`（全流程），实验输入放在 `scripts/real-build-suites/`。
- **跑的过程中不改代码。** 发现程序问题先记下来，跑完再修。除非用户叫停或基础设施故障，跑完为止。
- **结论只从跑完的数据得出。** 跑了一半的，只汇报看到了什么，不下效率或效果的结论。结论写进 `NOTES.md` 的"真实模型实验"。

## 记录
- **现状以代码与 `NOTES.md` 为准。** 最初的规格 `docs/BUILD_PROMPT.md` 已删除（见 git 历史），不要去找它。
- **设计决定写进 NOTES。** 新的决定写到"偏离规格"对应主题下，改写或追加 1 到 3 行，只写现状与原因；被取代的直接删掉，历史看 git。已核实的 Pi API、验证过的版本号也记在 NOTES。
- **代码注释与测试不引用 NOTES 的条目**，原因直接写在注释里。
- **Pi API。** 先查文档或源码再用，不凭记忆；Pi 安装在 `$(npm root -g)/@earendil-works/pi-coding-agent`，文档在其 `docs/`。

## 结构
- `src/core/`：业务逻辑，不依赖 Pi。**下层不得 import 上层**（`test/unit/core-layers.test.ts` 检查，新增目录先登记层号）。自下而上：
  - `state/`（1）：`state-store.ts` 是 `.forge/` 唯一的读写入口；`state-machine.ts` 是转移表；`config.ts` 读 workflow.yaml，`project-commands.ts` 读 commands.yaml。
  - `security/`、`workspace/`（2）
  - `verify/`、`insight/`（3）
  - `spec/`（4）：`prd.ts` 解析与检查 PRD（REQ、AC、页面表）；启动前检查与 PRD、原型入库
  - `acceptance/`（5）：验收测试、覆盖率、修复任务的生成与归属
  - `plan/`（6）：架构阶段的提交检查与批准（`plan-flow.ts`）、`docs/plan.md` 的批次解析与任务生成（`batches.ts`）、只追加的自动合并
  - `stage/`（7）：审查、批次门禁、stage-qa、签收
  - `engine/`（8）：`dispatcher.ts` 是引擎
  - `ops/`（9）：斜杠命令背后的运维与查看
- `src/tools/`：`forge_*` 工具；`src/commands/`：斜杠命令；`src/modes/`：fix 与小改动流程。
- `src/pi-adapter/`：**唯一**可以调用 Pi API 的目录。
- `agents/`、`rules/`、`skills/`、`templates/`：角色提示（orchestrator、architect、backend、frontend、reviewer、stage-qa；worker 只给 fix 与小改动）、规则、技能、项目模板。
- 生成的项目里：`docs/PRD.md` 与 `docs/prototype/` 是用户的需求与原型（agent 只读）；`workflow.yaml` 是流程配置（用户的，agent 只读）；`commands.yaml` 是项目命令（architect 写，开发 agent 可补充）；`docs/plan.md` 末尾的 yaml 区块是程序读取的批次计划。
- `schemas/*.json` 由 `npm run gen:schemas` 从 `src/core/state/schemas.ts` 生成。

## 测试
- **测试不依赖真实 LLM：**用单元测试、`test/fixtures/fake-subagent`、`test/fixtures/fake-llm`。
- **改动过程中**跑 `npm run typecheck` 和 `npm run test:fast`（纯函数，1 秒；后面加文件路径就只跑这些文件）。**改完**再跑 `npm run test:slow`（用到 git 的单元测试）。
- **e2e**（`npm run test:e2e`，约 25 分钟）只跑这次改到的文件；全量 e2e 在用户要求时、或一大块改动收尾时跑。汇报里写明哪些没跑。

## 代码约定
- 只用可擦除的 TypeScript 语法：不用参数属性、enum、namespace。
- 标识符和文件名用英文；面向用户的提示、错误信息和文档用中文。用户界面只显示高层阶段（架构 → 开发 → 交付），细节放在 `--detail`。
- 改 `agents/`、`rules/`、`skills/` 会让子进程系统提示的稳定前缀变化，提示缓存失效一次。要在 `NOTES.md` 的"缓存提醒"里记一笔，并在汇报中提醒用户。
- 不读取、不打印任何密钥。
