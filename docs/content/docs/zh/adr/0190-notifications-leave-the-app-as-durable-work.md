---
title: "0190 — 通知以持久化工作的形式离开应用"
description: "V1 通知中心只是一个收件箱，外加一条即发即弃的 IM 旁路：桌面 toast 和一次尽力而为的飞书消息共享同一个身份，没有重试、没有记录实际发出了什么，也没有在“运行结束”和“用户手机震动”之间的策略层。V2 保留中心作为规范收件箱，并在其背后加一条提交优先的持久化管线——事实在运行日志提交时同步派生，纯策略引擎对每个路由给出裁决，受治理的投递意图走既有的外发队列（或单向飞书 webhook 通道），带仅追加的尝试记录和崩溃安全的对账。投递以证据为准，绝不猜测：结果不确定的发送从其任务的回执中恢复，而不是盲目重发。"
---

# ADR 0190 — 通知以持久化工作的形式离开应用

**状态：** 已接受 — 已实现
**日期：** 2026-10-14
**相关：** [ADR-0042](./0042-unified-notification-center)（本 ADR 扩展而非取代的规范应用内中心）、[ADR-0025](./0025-connector-runtime)（连接器通道复用的受治理外发队列）、[ADR-0036](./0036-connector-inbox-writes)（IM 适配器契约）

## 背景

通知中心（ADR-0042）是个不错的收件箱：它记录、合并、暂停，并尊重按来源的静音和安静时段。但它只负责*展示*通知。把通知**发出去**——到飞书、到 webhook——过去只是一条单薄的旁路：`im-deliver` 解析一个会话、入队一条消息，然后就忘了。没人知道这条消息是发出去了、被拒了，还是根本没离开。也没有策略层——没法表达“只在 `error` 以上的失败才推到这个频道”，没有把一个啰嗦的运行汇总成摘要，也没有作用于网络而非 toast 的免打扰。

这种形状带来四个缺陷。

**失败的通知和成功的通知无法区分。** 一旦外发任务入队，通知的故事就结束了。如果任务进了死信，用户在中心看到的是绿色对勾，飞书里却是一片寂静。没有持久记录把“运行结束”连到“频道 X 在时间 Z 收到消息 Y，状态 W”。

**一次崩溃可能丢一条通知，也可能发两遍。** IM 路径与运行自身的提交不在同一事务里。日志追加和入队之间崩溃就整条丢失；发送和状态写入之间崩溃则诱发盲目重发，因为没有任何东西记录“已经有一次发送在飞”。

**没有地方说“先别发”或“这条不发”。** 每个事件要么立刻出去，要么永远不出去。静音 toast 的安静时段管不到推送；一个发了四十条进度心跳的运行没有摘要；事件开着时没有抑制；也没有“结果真的变了再告诉我”。

**每个目的地都是手工接线的。** 加通道就得改投递路径。没有“具名、有版本、经同意、带自己披露上限的目标”这个概念——没法告诉一个 webhook“你只收 `public` 摘要，永远收不到机密详情”。

## 决策

保留 ADR-0042 的中心作为规范收件箱，在其背后放一条**提交优先、持久化的投递管线**。一条要离开应用的通知变成持久事实、一次策略决策、一组投递意图——全部落库、全部可恢复、全部可观测。发送是持久记录的意图的结果，绝不是事件处理器的副作用。

### 事实与提交优先的触碰

生产者不再“发送”，而是提交。运行日志追加一条事件时，写这条事件的同一个 IndexedDB 事务还会**触碰该运行的一行持久 `notificationProjectionWork`**（`runId` + 期望 `seq`）。事务内不允许任何可等待的查询，所以作用域身份（`namespaceId` + `accountId`）在 `activateAccountDatabase` 时就被同步注入——早于任何一次运行写入——放进一个零依赖的 `identity-cache` 模块，`authorityHostId` 则在运行时启动时由 `primeNotificationScope` 补全。这是承重的不变量：**唤醒在生产者返回之前就已持久**，因此提交后崩溃不会丢通知。

一个宿主持有的**协调器**（`lib/notifications/delivery/coordinator.ts`）在租约下认领每行工作，按持久游标读取该运行的事件，把它们投影成 `DerivedNotificationFact`——每个都带稳定 `logicalKey`（`run:{runId}:{slot}`），重放同一运行是幂等的。每个事实也经由 `emit-center.ts`（原样复用 `notify()` 及其路由/合并）进入既有中心，因此收件箱始终是常开的记录。

### 策略——先纯决策，再持久提交

规划器（`lib/notifications/policy/planner.ts`）是一个纯函数：输入一个 `PlannerFact`、绑定该事实作用域/来源/运行的启用订阅、以及由既有通知偏好派生的 `NotificationPolicyContext`（安静时段、阈值、时区）。对每个候选路由它恰好产出一个裁决——`notified`、`deferred`、`digest`、`suppressed`、`pending-approval` 或某个 `denied`/`rejected` 分支——按固定顺序判定（同意 → 披露上限 → 安静时段 → 事件抑制 → 显式规则 → 配额）。安静时段以 `deferredUntil` 延迟；`aggregate` 规则把事实折进具名摘要桶而非发送；`suppress-if-unchanged` 用事实的 `contentHash` 对比已被接受的既往意图（实质性判断），抑制没有变化的重复。

决策先持久（`notificationPolicyState`），再提交：每条 `notified`/`deferred` 路由铸出一条 **`NotificationDeliveryIntent`**——“对这个目标执行这一次外发”的持久记录。

### 两条投递通道，一套意图模型

连接器目标（已绑定会话）经由既有的**受治理外发队列**投递：意图与其 `outboundQueue` 任务在一个事务里写入，任务带 `source: "notification"` 和共享的 `notificationOperationKey`，并保留按会话的 `orderSeq` 顺序。**feishu-webhook** 目标是单向的——没有会话——因此走独立的持久意图发送器（`webhook-sender.ts` + `feishu-webhook.ts`），**仅在发送时**从凭据库引用（`{service}:{account}`）解析端点与签名密钥，以 10 秒超时 POST 一个带或不带签名的飞书负载，并归类结果（`accepted` / `rejected` / `rate-limited` / `auth-failed` / `invalid-target` / `network-error` / `timeout-unknown`）。原始 URL 绝不落库到目标、绝不记日志、绝不导出。

每次发送都向仅追加的 `notificationDeliveryAttempts` 账本追加一条。意图沿 `prepared → queued → sending → accepted` 流转，或进入终态 `rejected` / `failed` / `cancelled` / `expired`，或者——刻意地——在结果无法确定时进入 **`delivery-unknown`**。unknown 是粘性的、绝不自动重试，因为一次 `timeout-unknown` 的发送可能早已送达。

### 对账——凭证据恢复，而非重发

一个宿主持有的 worker（`delivery/worker.ts`，装入连接器运行时启动流程）按定时节拍并在唤醒提示下，以有界批次清扫本账户的作用域前缀。**对账器**重新认领过期的投影租约，把终态外发任务状态折回其意图（回执漂移），**通过投影任务自身的证据**恢复卡住的 `sending` 认领——`pending` 任务让意图回到队列，`sent` 任务标记它已被接受——并触发到期定时器（quiet-release 重新入队被延迟的意图；digest-flush 标记桶已关闭、留给下一轮）。错误按条计数并汇总进结果，绝不抛过清扫。任何可能已发出的东西都不会被重发；对账器只会把意图移动到一个证据本就支持的状态。

### 目标、订阅、作用域

**`NotificationTarget`** 是一个有版本、经同意的目的地——`connector` 会话或 `feishu-webhook`——带标签、披露上限、语言/时区，以及运营者记录的 `consent` 授权（`origin-reply` 或 `proactive`）。它的语义指纹（`addressFingerprint`）独立于凭据标识目的地，因此指向同一处的两个别名是同一个投递槽，地址变更会重规划待发的意图。**`NotificationSubscription`** 把一个作用域/来源/运行绑定到一组目标，带 `minLevel`、`maxDisclosureProfileId`，以及可选 `rules`（deny / defer / aggregate / suppress-if-unchanged）和单事实意图配额。两者都是 CAS 版本化的；提交时遇到过期版本就重规划或拒绝，而不是发往已搬走的地址。

所有东西都挂在 **`NotificationScope`**——`{namespaceId, accountId, workspaceId?, businessProjectId?, …}`——编码成稳定的 `scopeKey`，索引每张持久表、限定每次对账清扫的范围。

### UI

设置在既有通知区块下新增一个**投递**面板（`notification-delivery-panel.tsx`）：按凭据库引用（绝不填 URL）注册飞书 webhook、启停/删除目标，并绑定订阅（作用域/来源/运行 + 目标 + 最低级别 + 披露上限）。通知条目显示一个**投递徽标**，聚合该事实的逐目标结果。运行详情页新增**通知**标签页，列出该运行产出的每一条外发——目标、用途、状态、时间——从意图账本实时读取。

## 影响

- 应用内中心作为事实来源保持不变；外发是增量的。一条事实无论是否离开应用都先落进收件箱。
- 外发投递是**证据化**的：每一跳都是一行持久记录，所以“发没发”是一次查询，“为什么没发”是一次决策修订 + 尝试历史，而不是翻日志猜。
- 崩溃恢复与正常路径同构——对账器重新驱动同一个协调器、同一批意图——因此没有一条单独的、会腐化的恢复路径。
- 密钥不进持久存储；webhook 的 URL 只存在于凭据库，仅在发送时解析。
- **排除：** Apprise/ntfy、新的邮件/短信通道、分布式自动宿主接管，以及任何对业务执行状态机的改动。不引入 Kafka/Redis/Novu，不用 Next.js API 路由——整条管线完全跑在宿主的静态客户端 + 连接器运行时架构里。
