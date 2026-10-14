# 需求

## 背景与目标
pi-forge 是一个 Pi 插件：多 agent 开发工作流（规格 → 契约与计划 → 实施 → 交付）。本轮是六项小改进，全部在 `src/core/` 的纯函数与视图层，不涉及 Pi API。

## 需求清单
### REQ-001 度量里的并行度 [MVP]
角色：用户
- AC1：Given 流程里有已结束的 run When 查看 /forge-status --metrics Then 「速度」段多一行「并行：平均同时运行 x 个子进程，峰值 y 个」，x 保留 1 位小数、y 是整数
- AC2：Given 两个 run 的时间区间完全重叠、第三个 run 与它们都不重叠 When 计算并行度 Then 峰值为 2，平均值按时间加权（有 run 运行的时间段内的平均同时运行数）
- AC3：Given 流程里没有任何 run When 查看 --metrics Then 不出现「并行」这一行

### REQ-002 计划报告的层级 [MVP]
角色：用户
- AC1：Given 一个没有依赖的 task When 计算层级 Then 它的层级是 1
- AC2：Given T-003 依赖 T-001 与 T-002，T-002 依赖 T-001 When 计算层级 Then T-001 是 1、T-002 是 2、T-003 是 3（层级 = 所有依赖（hard 与 soft）的最大层级 + 1）
- AC3：Given 计划有多个 task When 生成计划报告（formatPlanReport） Then 报告含一行「层级：1 层 T-001、T-004；2 层 T-002；…」，按层级升序，同层按 task 编号排序

### REQ-003 规格检查：术语别名提醒 [MVP]
角色：用户
- AC1：Given 术语表里「看板」的「不要叫」列出了「面板」，需求里某条 AC 的文本含「面板」 When 运行规格检查 Then warnings 里有一条规则为 glossary-alias 的提醒，写明该 AC 的编号与别名「面板」，errors 不因此增加
- AC2：Given 需求文本没有用到术语表里任何别名 When 运行规格检查 Then 没有 glossary-alias 提醒
- AC3：Given 别名只出现在术语表自身的「不要叫」行里 When 运行规格检查 Then 不算使用别名，只检查需求文件里的需求标题与 AC 文本

### REQ-004 脱敏 Bearer 令牌 [MVP]
角色：用户
- AC1：Given 文本含「Authorization: Bearer abc.def-ghi」 When 调用 redactSecrets Then 令牌部分被替换为 ***、「Bearer」前缀保留，count 加 1
- AC2：Given 文本含现有规则已覆盖的密钥（API key、私钥块） When 调用 redactSecrets Then 行为与改动前一致（现有测试全部通过）

### REQ-005 guard：curl 可写工作区内文件 [MVP]
角色：子 agent
- AC1：Given worker 的 bash 命令是 curl -o 指向当前任务 worktree 内（或本次运行的临时目录内）的文件 When 经 guard 校验 Then 放行
- AC2：Given curl -o 或 --output 指向工作区外的路径（例如 /tmp/x.out） When 经 guard 校验 Then 拦下，拒绝原因提示改用工作区内的路径
- AC3：Given curl 使用 -O、--remote-name 或 --output-dir When 经 guard 校验 Then 仍然拦下

### REQ-006 状态视图的进度条 [MVP]
角色：用户
- AC1：Given 流程处于实施阶段、本阶段 4/10 个任务完成 When 查看 /forge-status Then 进度行形如「进度：S1 [████░░░░░░] 4 / 10 个任务完成…」，10 格、按完成比例向下取整填充
- AC2：Given 本阶段任务全部完成 When 查看 /forge-status Then 进度条 10 格全满
