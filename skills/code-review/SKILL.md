---
name: code-review
description: 审查一个 task 的 diff：只依据清单与出处判定必须改；坏味道只作建议；第二轮只确认
---

# 代码审查

（改编自 pi-flow 的 code-review，原技能改编自 mattpocock/skills 的 code-review，MIT 许可，Copyright (c) 2026 Matt Pocock。
pi-forge 的改动：必须改需要可校验的出处；加入契约一致性与测试质量；第二轮只确认。）

pi-flow 的教训：开放式审查时，强模型每一轮都能挑出新问题，修复循环停不下来。所以本技能把"必须改"严格限定在**有出处**的问题上，其余一律是建议。

## 先找依据

- 本 task 的 AC 原文、相关契约片段（openapi.yaml、errors/*.yaml、data-model.yaml、modules/）、permissions.md。
- 本 task 涉及的 rules/<layer>.md，以及每个文件末尾的审查清单；还有 rules/global.md。
- worker 声明的 deviations：已声明并且合理的不算问题；未声明的偏离算问题。
- 工具已经在管的（格式化、lint、类型检查）不提，预检已经通过。

## 什么可以是"必须改"（basis 只能是这四种）

| basis | 例子 |
|---|---|
| `contract:<位置>` | 返回 400 而契约规定 422；字段名 `teamID`，契约是 `team_id`；用了 errors/*.yaml 里没有的错误码却没有追加 |
| `rule:<文件>#<条目>` | rules/backend.md 第 4 条"查询必须带 team_id 过滤"未满足 |
| `ac:<编号>` | 测试通过了，但实现只处理了 MySQL，而 AC 要求 MySQL 和 PostgreSQL（验收测试没覆盖到的部分） |
| `defect:<输入 → 后果>` | "名称包含单引号时 SQL 拼接出错"；"并发创建同名数据源时，两个请求都成功" |

写不出这四种出处之一的，就是 suggest。

## 必看的几类缺陷

- 越权：查询或修改没有按当前用户的团队或角色过滤（对照 permissions.md）。
- 注入、拼接 SQL 或命令、未校验的外部输入。
- 事务边界、并发写入、资源泄漏（连接、文件句柄、定时器）。
- 吞掉的错误：空的 catch，或者 catch 之后返回成功。
- 测试质量：单元测试绑定实现、同义反复；删除、放宽或跳过了已有测试（test-adjust 改过的测试要逐个核对）。

## 坏味道基线（只能作为 suggest）

名字说不清、重复代码、依恋情结、数据泥团、基本类型偏执、重复的分支、霰弹式修改、发散式变化、夸夸其谈的通用性、过长的调用链、中间人、被拒绝的遗赠
（出自 Fowler《重构》第 3 章；是什么、怎么改，见 pi-flow 的原技能）。项目规则明确认可的写法，不按坏味道提。

## 写法

- 每条问题写清：level、basis、file、location（函数名或行号范围）、problem、expected。
- 只审这次改动里的代码；改动之外的老问题不提。
- 同一类问题合并成一条，列出所有位置。没有问题就 pass。

## 第二轮

只拿到上一轮的 must 清单。逐条核对是否解决：resolved 为 true 或 false，note 写依据。不提新问题；清单之外的发现写进 note，交给阶段验收。
