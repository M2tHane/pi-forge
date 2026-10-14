# pi-forge

## 术语
**流程（Flow）**：
一次从需求到交付的完整工作，编号 B-xxx；状态在 `.forge/flows/<id>/`。
_不要叫_：项目、pipeline

**任务（Task）**：
流程里的一个工作单元（impl、review、qa、fix…），编号 T-xxx；由子进程（run）执行。
_不要叫_：job、ticket

**运行（Run）**：
执行一个 task 的一次子进程（pi 子会话），记录在 `.forge/runs/`，有 started_at 与 ended_at。
_不要叫_：session、进程

**阶段（Stage）**：
实施的一个批次（S0、S1…），结束时过门禁与阶段验收。
_不要叫_：里程碑、phase

**守卫（Guard）**：
`src/core/security/guard.ts`：对子进程每次工具调用做命令与路径校验，越界的拒绝并记录 violation。
_不要叫_：拦截器、防火墙

**快照测试（Snapshot test）**：
`test/unit/status-snapshots.test.ts`：把视图输出与 `test/unit/__snapshots__/status/*.txt` 比较，`UPDATE_SNAPSHOTS=1` 重新生成。
_不要叫_：黄金测试

**用户（User）**：
在 Pi 主会话里使用 /forge-* 命令的人。
_不要叫_：操作员

**子 agent（Subagent）**：
由 pi-forge 派发的 pi 子进程里的角色（worker、reviewer、stage-qa、architect）。
_不要叫_：机器人
