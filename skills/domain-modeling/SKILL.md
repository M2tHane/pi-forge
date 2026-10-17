---
name: domain-modeling
description: 划分 domain，写 docs/arch/domains.md（职责、表、对外接口、依赖、负责的 API、代码里的叫法）；难以撤销的决定记进 decisions.md
---

# 领域建模：domain 划分

（部分改编自 mattpocock/skills 的 domain-modeling，MIT 许可，Copyright (c) 2026 Matt Pocock。）

每个 domain 由一个后端 agent 独立开发，和别的 domain 并行。划分得好，agent 之间只经接口打交道；划分得不好，就会互相改对方的代码、等对方的表。

## 怎么划分

- **按业务能力分，不按技术层分。** 一个 domain 拥有自己的表、领域模型、服务和 controller，对外只暴露接口。
- **一张表只属于一个 domain。** 别的 domain 要读写它，只能调用拥有者的接口；只存对方的 id，不复制对方的数据。
- **大小**：一个后端 agent 一次能做完。通常一个 domain 对应 PRD 的一到三条 REQ；PRD 里 REQ 很多时宁可多分几个，并行的收益更大。
- **依赖少而单向。** 画出 domain 之间的调用，不能成环；被很多 domain 依赖的（用户、基础资料）放在前面的批次。
- "用户管理"可以作为普通 domain；登录与令牌校验、获取当前用户、权限检查是 S0 的公共代码。

## docs/arch/domains.md

每个 domain 一节：

```md
## inventory（库存）
- 职责：库存数量与出入库流水；不负责商品资料。
- 拥有的表：stock、stock_movement
- 对外接口：InventoryService.reserve(productId, qty)、InventoryService.onHand(productId)（接口在 types/inventory/，由 inventory 实现）
- 依赖：catalog（CatalogService.get）
- 负责的 API：GET /api/stock、POST /api/stock-movements
- 对应需求：REQ-004、REQ-005
```

文件开头放一张名词表：PRD 里的业务名词 → 代码里用的英文名，每个概念只选一个叫法（例如 商品 → product，不叫 item、goods）。所有 domain、接口、表、页面都用它。

## decisions.md

难以撤销的决定记进 docs/arch/decisions.md，一条几行：背景、决定、原因。只记三条同时满足的：

1. **难以撤销**：以后改主意代价很大；
2. **没有上下文会让人意外**：以后的人看代码会问"为什么这么做"；
3. **确实有取舍**：有真正的备选方案，因为具体原因选了这个。

值得记的例子：模块之间的集成方式、有锁定成本的技术选择（数据库、认证）、边界与范围的决定（"用户数据归 user，其他 domain 只存 id"）、故意偏离常规的做法。
