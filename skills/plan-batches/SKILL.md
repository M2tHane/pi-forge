---
name: plan-batches
description: 写 docs/plan.md：按批次排 domain 与页面顺序，最后一节是程序读取的 yaml 区块
---

# 拆分批次

批准后程序按 plan.md 生成任务：每个批次一个阶段；每个 domain 一个后端任务，并行开发；前端只有一个 agent，按你写的页面顺序一页一页做（第 1 批先做前端基础）；本批的页面和 domain 都完成后，前端接入真实接口，然后浏览器验收、用户签收。
你只排批次、domain 和页面顺序，任务、依赖和调度都由程序生成。

## 批次

- **每个批次交付一组用户能看到、能演示的功能。** 被依赖的业务在前：登录与布局、基础资料，然后是单据、报表。
- 批次数通常是 2 到 4 个。每多一批，就多一轮"接入 → 验收 → 签收"，也多一次等用户。
- 每条 REQ 放进且只放进一个批次（`reqs`）；不在本期做的不放，在「风险与假设」里写明。
- 每批的需求要能用本批或之前批次的页面与接口演示：页面要的接口，它的 domain 在本批或之前的批次里。

## domain 与页面

- `backend` 列出本批要实现的 domain，名字和 docs/arch/domains.md 一致。一个 domain 只出现在一个批次里；后面的批次要扩充它，写进那一批的说明，由那一批的 domain 任务去做时再拆出新 domain 名（例如 `inventory-report`）。
- **identity 放第 1 批，别的 domain 不写 `after: [identity]`。** 它们只依赖 S0 定的鉴权接口，开发和测试时用桩，和 identity 并行；本批「接入真实接口」与批次门禁时 identity 已经合入，所有接口都在真实鉴权下再跑一遍。（stock run-01：登录 → 分类 → 商品三环依赖，把 4 个本可以并行的任务拖成了串行。）
- `after` 只写真的要等对方代码完成才能开发的 domain。domain 之间的接口在 S0 已经定好、有空实现，多数 domain 不需要 `after`。`after` 可以指向前面批次的 domain（视为已满足）。
- `frontend` 是页面 id 的列表，按开发顺序写；页面 id 和 PRD「页面」表里的一致。先写布局、列表这类被别的页面复用的，再写详情和表单。
- `paths`（可选）：这个 domain 的代码目录。只用来在批次验收时判断问题该交给谁修，不限制写入。
- `shared`：几个任务都要追加的公共文件（错误码、枚举、路由注册、菜单）。开发 agent 只能往里追加，要修改找你。

## 文件格式

上半部分写给人看：总览、domain 表、各批次的目标和演示方式，以及固定的一节「## 风险与假设」（PRD 没说清时采用的方案、本期不做的、可能返工的地方）。用户批准时会看到这些。
最后一节标题固定为「## 程序读取的部分」，里面放一个 yaml 代码块，程序只读这一块：

```yaml
max_parallel_backend: 3          # 可选：同时开发的 domain 数
batches:
  - id: B1
    title: 基础资料
    reqs: [REQ-001, REQ-002, REQ-003]
    backend:
      - { domain: catalog, paths: ["src/main/java/**/domain/catalog/**"] }
      - { domain: partner }
      - { domain: inventory, after: [catalog] }
    frontend: [login, layout, products, partners]
  - id: B2
    title: 单据
    reqs: [REQ-006, REQ-007]
    backend:
      - { domain: purchase, after: [inventory] }
    frontend: [purchase-orders, purchase-order-detail]
shared: ["types/**", "src/main/resources/db/common/**"]
```

## 程序的检查

提交时退回（改了再提交）：缺少「## 程序读取的部分」或不是合法的 YAML、批次 id 重复、domain 重名、`after` 指向不存在的 domain 或更晚的批次、`after` 成环、批次既没有 backend 也没有 frontend。

只提醒（看过再决定要不要改）：PRD 里的 REQ 没进任何批次、批次里的 REQ 或页面 id 在 PRD 里找不到、有 domain 写了 `after: [identity]`、identity 不在第 1 批。
