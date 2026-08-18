---
title: ADR-0131 — 跨壳收件箱中继
description: 为收件箱的每一次写入（人工回复、草稿审批、会话覆盖）建立唯一的、与壳无关的写路径，使手机、浏览器、以及驱动远端宿主的桌面端都能像运行机器人的那台机器一样操作平台会话；幂等贯穿端到端，推送只携带 id，绝不携带消息正文。
---

# ADR-0131 — 跨壳收件箱中继

| 字段     | 值                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态     | Accepted                                                                                                                                                                                                                                                                                                          |
| 日期     | 2026-08-18                                                                                                                                                                                                                                                                                                        |
| 基于     | ADR-0009 平台连接器；ADR-0025 统一订阅 / adapter 运行时；ADR-0027 移动端同步编排；ADR-0036 adapter 方法矩阵；ADR-0059 宿主画像与能力门；ADR-0060 伴生平面设备身份；ADR-0082 桌面驱动远端宿主；ADR-0089 出站投递语义                                                                                             |
| 范围     | `lib/connectors/inbox-writes/**`、`lib/connectors/inbox-relay/`、`lib/connectors/inbound-notifiability.ts`、`lib/sync/host-invalidate.ts`、`lib/sync/handlers/{connector-drafts,outbound-queue,conversation-overrides}.ts`、`lib/companion/{host-event-publisher,desktop-write-source}.ts`、`lib/db/schema.ts`（v173）、`protocol/companion-*.json`、`src-tauri/src/companion_api/{rpc,rpc/data_sync,rpc/service_plane,event_channels,commands,ws_bridge}.rs`、`components/inbox/` 下全部写入面、`components/chat/composer.tsx`、`hooks/use-draft-approval.ts` |

## Context

收件箱一直只在运行 adapter 的那台机器上真正可用。对三个壳的审计表明，缺的不是某个功能，而是一条**接缝**：每个回复面各自决定如何写入，而其中只有一种决定是有效的。

- **手机上的回复被静默丢弃。** `components/mobile/connector/draft-approval-panel.tsx` 把 `connector_approve_draft` 行写入 `mobileOutboundQueue`，而它到达的桌面 arm 只翻转草稿状态——不产生出站作业，因此从未真正投递。操作者看到"已批准"，客户什么也没收到。
- **`connector_send` 并不发送。** 名字如此，但它的宿主 arm 只追加一条本地 `user` 消息就返回。它是 share-target 的文本注入路径，从来不是投递路径；manifest 中没有任何 RPC 真正入队出站。
- **薄客户端写的覆盖会被覆盖回去。** 手机切换会话模式后写入本地 `conversationOverrides` 镜像；下一次 `sync_pull` 返回宿主的变更前行并将其覆盖。徽标翻转、翻回、再翻转。
- **浏览器能打开收件箱却什么都做不了。** 浏览器不运行任何 adapter，所有控件均为惰性——而 UI 渲染的是普通的空会话列表，读起来像"你没有会话"，而不是"此设备看不到它们"。
- **驱动远端宿主的桌面端读的是错的库。** `isRemoteHostActive()` 只改写 RPC 路由，不改写 Dexie，于是收件箱渲染的是一个无人对话的宿主的本地镜像。
- **完全没有实时信号。** `sync://invalidate` 只有一个发布者（Tauri `emit`，因此 headless brain 什么也不发），`claude://message-added` 推送触发器没有任何发射者。配对的手机只有在下次回到前台时才知道有新消息。
- **每个面各自推导路由。** 九个覆盖控件、两个草稿审阅面、composer 各自直接 import Dexie 原语。新增一个壳意味着改十二处调用点，而每一处都得自己把幂等做对。

## Decision

### 1. 唯一写接缝 —— `lib/connectors/inbox-writes/`

组件不再按壳分支。它们调用四个函数之一——`sendManualReply`、`approveInboxDraft`、`rejectInboxDraft`、`mutateConversationOverride`——由 `resolveInboxWriteRoute()` 选择执行者：

| 路由            | 条件                                                                | 执行                                                    |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| `"remote"`      | 本桌面正在驱动远端宿主（`isRemoteHostActive()`）                    | 持久化 `mobileOutboundQueue` → 配对宿主上的 RPC         |
| `"local"`       | 本壳拥有连接器运行时（`hasCapability("connector-runtime")`）        | `local.ts`，作用于本进程的 Dexie 与投递网关             |
| `"remote"`      | 存在活跃的 companion target（已配对手机、web companion）            | 持久化队列 → RPC                                        |
| `"unavailable"` | 独立浏览器 / 未配对手机                                             | 抛出 `InboxWriteUnavailableError`；UI 显示 `RequiresHost` |

顺序是有意义的：驱动远端宿主的桌面端在基线里仍然声明 `connector-runtime`，但远端激活期间它的本地运行时已被拆除，因此必须让 `"remote"` 胜出——否则这条回复会变成一个没有任何运行中 adapter 会投递的出站作业。

`local.ts` 保存三个原语，是从 composer 中原样抽出的。**宿主 RPC arm 调用同一批函数**，所以手机发起的回复与桌面发起的回复产生逐字节相同的 `outboundQueue` 与 `messages` 行。不存在第二份实现，也就无从漂移。

### 2. 幂等是端到端的，不是逐跳的

客户端每次写入只铸造**一个** `crypto.randomUUID()`，并贯穿每一层：`mobileOutboundQueue` 行的 `idempotencyKey`、Rust 账本去重所依据的 `Idempotency-Key` 头、以及出站 runner 去重所依据的 `OutboundRequest.metadata.idempotencyKey`。宿主 arm 入队前先按该 key 查 `outboundQueue`，命中即返回既有作业。

草稿审批的 key 由草稿 id 派生（`cdr-approve:<id>`）而非铸造，因此即使客户端丢失了队列行，也不可能为同一草稿产生第二个出站作业。

`sendManualReplyLocally` 还处理"作业已入队但消息未写入"的崩溃窗口：重放时若发现作业存在而消息不存在，补写消息而非重新发送。

### 3. 覆盖以单个可序列化 mutation 传输

`ConversationOverrideMutation` 是十个分支的联合（`upsert`、`patch`、`configSection`、`setStatus`、`setAssignee`、`addLabel`、`removeLabel`、`setPinned`、`setArchived`、`delete`）。同一个值：

- 在宿主由 `applyConversationOverrideMutation` 应用，它分发到**既有的** `lib/db/conversation-overrides.ts` 原语，因此审计行与分配轨迹保持完全相同的语义；
- 在客户端由 `applyOptimisticOverrideMutation` 镜像，**只写 mutation 点名的字段**——无审计、无轨迹。宿主是权威，随后同步回来。

`setPinned` / `setArchived` / `delete` 按 `conversationKey` 寻址（尽管旧原语接受行 id）：薄客户端只知道 key，而 key 就是唯一索引。

覆盖被冲掉的问题由 `pending-overrides.ts` 关闭：存在在途 mutation 的会话 key 会被同步 handler 跳过。它读两个来源——覆盖"队列行持久化之前"那个窗口的内存引用计数，以及此后的持久化队列本身（后者能跨重载存活）。

`callerDeviceId` 由 Rust 层从已验证的设备上下文服务端注入，并成为分配轨迹上的 `via: "device:<id>"`，因此手机发起的改派依然可追溯。

### 4. 两个刻意区分的实时信号

`sync://invalidate` 表达的是*"表 X 变了，重新拉取"*。它按表划分、总是发送，宿主侧合并 150 ms（`lib/sync/host-invalidate.ts`），客户端再按表合并 100 ms。只有当窗口内每一次写入都指向同一会话时才附带 `conversationKey`；混合突发会丢弃它，让客户端做一次全表拉取而非 N 次按 key 拉取。当本桌面自身是薄客户端时完全跳过——它的行是镜像而非权威。

`connector://message-added` 是**可通知**的那个信号：每条入站真人消息一帧，携带 id 与 `/inbox/c?key=…` 深链。Rust 在其上注册推送触发器，因此 WebSocket 已关闭的手机仍能收到锁屏通知。

该帧刻意不含三样东西：

- **消息正文。** 它要经过 APNs/FCM。Rust 侧的正文构造器只写发送者与平台；正文在 App 打开后经已认证的同步获取。
- **非真人事件。** 编辑、删除、表情回应以及机器人自己的出站回声由 `isNotifiableInboundEvent` 过滤——该谓词从 `lib/notifications/inbound-connector.ts` 抽出，因此中继与桌面通知中心对"什么算新消息"永远不会产生分歧。
- **重复唤醒。** 操作者正在查看该会话、会话已静音、或处于免打扰时段时抑制；判定精度与出站 runner 使用同一套优先级。

headless brain 没有 Tauri 运行时，因此 `lib/companion/host-event-publisher.ts` 给两种宿主同一个调用：已注册的 publisher（brain，经 `companion_event_publish` 管道）→ Tauri `emit`（桌面）→ no-op。`ws_bridge.rs` 在发布前用**封闭白名单**校验 topic：桥接对端虽已认证，但允许它任意命名 topic 会让被攻陷的 brain 伪造客户端视为权威的帧。

### 5. 协议与同步面

`connector_enqueue_outbound` 是新命令（target `execution`，要求幂等），它才是 `connector_send` 被误认为的那个命令；`connector_send` 保留其文档化的、更窄的含义。`connectors_discord_upload` 与 `connectors_onebot_probe` 从 client 平面移到 service 平面，使 headless brain 可以执行——刻意**不加** headless 宿主门，因为两者都是不需要 `AppHandle` 的纯函数，而加门会给一条只能收缩的基线增加 class-C host-parity 条目。

Dexie **v173** 为 `outboundQueue` 与 `connectorDrafts` 增加带索引的 `updatedAt`（从 `createdAt` 回填），使二者加入 companion 同步——同步是基于 `updatedAt` 游标的增量。`outboundQueue` 以**投影**方式同步并带 `syncedFromHost: true`，而非新建一张表，因此既有读者（`use-outbound-saturation`、`OutboundStatusPill`）无需改动即可工作；`listDueNow` / `pickNextDue` / `recoverStaleSendingJobs` 会过滤掉这些行，本地 runner 绝不会派发镜像。

### 6. 交接是一等状态

丢失运行时租约与卸载、与让位给远端宿主，是三件不同的事。`installConnectorRuntime` 接受拆除原因；在 `"lease-lost"` 时立即回收在途入站作业（`reclaimAllRunning: true`），使它们呈现为 `recovery_required`，而不是顶着"running"却无人在跑，并回调 `onRuntimeReleased`。`ConnectorBusProvider` 按 30 秒 → 5 分钟退避重新获取，每次先查 `isRemoteHostActive()`。

到达已不再持有运行时的进程的中继写入会抛出 `connector_runtime_not_owner`。**措辞是承重的**：`lib/queue/retry-policy.ts` 将其归类为**可重试**，因此手机的持久化队列会跨越交接窗口重放（5 次尝试 ≈ 31 秒），而不是把这条回复投入死信。

### 7. 独立壳会自我说明

独立浏览器标签页或未配对手机可以读收件箱，但永远无法写入。这是永久设计而非缺口，因此按 CLAUDE.md 规则 7 要求的三个轴全部记录：surface contract 为 `standalone: "explain"` 并由 `standaloneInboxRequiresHost` 承载原因，`StateCard.RequiresHost` 渲染它并指向 `/pair`，两者均由测试钉住。

## 非目标

- **对入站消息做 AI 分诊。** 路由仍由规则与分配驱动。
- **把会话转交给其他 bot 或第三方 agent。**
- **个人微信的出站媒体。**
- **由 `configSchema` 驱动的设置渲染器。**
- **按 adapter 的 Python 连接器开关。**

## Consequences

- 新增一个壳从此是路由问题，而不是十二处调用点。新面调用 facade 即继承幂等、可用性门与乐观镜像。
- 宿主 arm 与桌面 UI 无法漂移，因为它们就是同一批函数。
- 手机上的回复能在飞行模式、断连与租约交接中存活，且不会在平台上重复。
- 推送扇出绑定 `AppHandle`，因此**纯 headless** 部署只能触达前台 WebSocket 客户端，触达不了锁屏。此处如实记录而非绕过；要关闭它需要一条不经 Tauri 的推送路径。
- `outboundQueue` 中现在存在本地 runner 绝不能派发的行。`syncedFromHost` 过滤是承重的，在三条查询路径外加 per-target 数据库中共同保证。

## References

- 切片计划：`~/.claude/plans/im-mattpocock-skills-grill-me-shimmying-naur.md`
- ADR-0009（投递歧义契约）、ADR-0036（adapter 方法矩阵）、ADR-0082（远端宿主激活）、ADR-0089（引用回复与后续气泡）
