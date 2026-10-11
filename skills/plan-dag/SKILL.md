---
name: plan-dag
description: 把规格与契约拆成分阶段的任务计划（plan.yaml）：纵向切片、produces/requires 声明、粒度跟模型、尽早并行
---

# 拆分阶段与任务

（吸收 pi-flow 的 plan-modules 与 decompose-dag，以及 mattpocock/skills 的 to-tickets（MIT）中的切分规则。）

你**不画依赖边**，只声明每个 task 产出什么（produces）、需要什么（requires）。依赖边、环检测、互斥、覆盖检查都由程序计算。
声明准确，DAG 就是对的；声明漏了，程序会报"缺少生产方"。

## 阶段

- **S0 骨架**（固定，只能有 1 个 task）：启动脚本、数据库连接与初始迁移、测试运行命令、tests/acceptance/_support/ 的登录与请求助手、一条最薄的端到端链路（桩实现也可以）。
  **不建**类型生成、客户端生成、契约检查、DOM 模拟；exit 涉及的 AC 最多 4 条，选一两条最核心的 REQ。
  所有命令都要遵守程序注入的 PORT、FORGE_PORT_BASE、FORGE_DB_NAME、FORGE_TMP，以便并行运行。
  项目有 test-author 且 acceptance_list 要在隔离工作区里运行时，需要额外导出的子包清单与可缓存的依赖目录，写进 commands.yaml 的 `acctest_workspace: { include, cache }`。
  S0 的 worker 自己写 tests/acceptance/_support/ 公共工具和一个冒烟测试 tests/acceptance/S0-smoke/（唯一例外）；S0 exit 的 AC 测试由 test-author 在 worker 完成后写（`test_author` 关闭时由 worker 自己写）。
- **S1…Sn**：每个阶段交付一组用户能感知、能演示的能力。按依赖排序：被依赖的业务（团队、权限）在前。
  标准模式阶段数通常是 2 到 5 个；阶段越多，阶段之间的串行屏障越多。
  **lean 模式只分 S0 + S1 两个阶段**，S1 的 AC 超过 40 条才拆成 S1、S2：每多一个阶段，就多一次阶段审查、修复、复审与签收（实测 S0 的这一段 19 分钟，S1 13 分钟）。
- 每条 MVP REQ 恰好出现在一个阶段的 exit 中。
- 每条本阶段 AC 都要能用本阶段或之前交付的入口准备数据、执行动作、观察结果。需要后续接口时，调整阶段归属或合并紧耦合的切片，不留隐含的反向依赖。
- 不适用的工程产物（代码生成、类型检查、lint、e2e）不要列进 S0，也不配进 commands；不让 worker 为凑命令而自建工具。零第三方依赖的项目，前端交互写进 manual_checks。

## 任务

- **一个 task 一个纵向切片**：贯穿数据、接口、界面与单元测试，做完能单独验收。不按层拆给不同的 worker。
- **例外**：size 为 L 且是真实的 REST 边界时，可以拆成 `api` 和 `ui` 两个 task，ui 对 api 的接口用 `~` 软依赖，前端对着生成的 mock 开发。
- **粒度跟 worker 的模型走**（任务说明里列出了模型）：强模型一个 task 可以是一整块业务（10 到 30 个文件）；弱模型一次会话能做完（1 到 8 个文件）。
  每个 task 都有固定开销（重新读上下文、预检、审查、全量测试），拆得越细越慢。
- **规模小**（size_estimate.loc 低于任务说明给出的阈值）：选 `mode: lean`，每个阶段一个 task。
- **铺垫性重构、大范围机械改动**（改名、改共享类型）：单独成 task，排在依赖它的 task 前面。

## 每个 task 的字段

| 字段 | 写什么 |
|---|---|
| `ac` | 负责的 AC 编号（不含 manual）。每条 MVP AC 恰好分给一个 task |
| `writes` | 具体目录（前端、后端、迁移、单元测试都包括）。不同 task 尽量不重叠，重叠的不能同时运行 |
| `shared` | 几个 task 都要追加的公共文件（路由注册、菜单、i18n 文案）。登记后不算互斥 |
| `produces` | 本 task 实现的契约符号：`api:POST /api/x`、`table:x`、`error:X`、`fn:m#name`、`page:/x`、`lib:name` |
| `requires` | 本 task 用到的、别的 task 产出的符号。只需要契约就能开工的加 `~` 前缀（软依赖：并行开工，预检和合并都排在生产方之后） |
| `test_interface` | 允许的测试入口（任务说明里渲染成『允许的测试入口』一节）：`HTTP /api/datasources*`、`page /datasources`、`fn:m#name` |
| `size` | S、M、L，决定时间预算 |
| `layers` | 涉及的层，决定注入哪些 rules/<layer>.md |
| `module` | 所属模块，决定 worker 能追加哪个契约文件（paths/<模块>.yaml、errors/<模块>.yaml） |
| `risk` | 涉及权限、计费、删除数据时写 high（审查用强模型） |
| `review` | 一般不写，由程序推导；只在需要覆盖推导结果时写 skip、auto 或 strong |
| `manual_checks` | 需要用户打开应用确认的内容（来自 AC 的 manual 条目与界面效果） |

## 尽早并行

- 总耗时取决于关键路径，不取决于 task 总数。看程序返回的报告：开头几层只有一个 task 在跑的时间越短越好。
- 能用 `~` 的地方都用 `~`：只要契约写清楚了，消费方就可以对着契约开工。只有真的需要对方的代码才能运行时，才用硬依赖。
- 热点文件：路由与菜单按目录自动发现，不集中登记；迁移文件用时间戳命名；依赖与锁文件只由 S0 修改。

## 提交

用 forge_propose_plan 提交 plan.yaml，同时附上 assumptions 与 extras。程序返回：

- 错误（符号找不到、缺少生产方、重复生产、跨阶段反向依赖、环、AC 未覆盖或重复分配）：改了再提交。
- 报告（task 数、关键路径、并行宽度、互斥对、提醒）：有提醒时优先调整。
