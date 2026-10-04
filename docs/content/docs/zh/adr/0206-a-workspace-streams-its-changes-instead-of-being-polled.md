---
title: "0206 — 工作区推送自己的变更，而不是被轮询"
description: "协同平面为每个组织提供 WebSocket 变更流，仅携带失效通知（{entity, id, workspaceId, revision}），每帧按工作区权限过滤。镜像保持唯一刷新路径，由推送决定刷新部分和时机。60 秒轮询保留为降级机制。共享聊天、Canvas 和协同流共用 SocketHub 的一次性票据与按键广播。"
---

# ADR 0206 — 工作区推送自己的变更，而不是被轮询

**状态：** 已接受，已实现（2026-09-30）**日期：** 2026-09-30 **相关：** [ADR-0149](./0149-a-person-is-not-a-device)（协同平面）、[ADR-0158](./0158-artifacts-and-canvas)（Canvas 流）、[ADR-0207](./0207-a-collaboration-event-reaches-people-who-are-not-in-the-room)（复用这条推送流）、[ADR-0208](./0208-edits-to-different-fields-merge) **来源研究：** `docs/plans/2026-09-30-collaboration-multi-device-gap-analysis.md`（缺口 A2）

## 背景

共享的议题、计划、运行、工作区和成员关系只通过一条路径到达客户端：`refreshCollabPlane`（`lib/collab/refresh.ts`）。它依次拉取成员关系、工作区、议题、计划与运行数据，写入可重建的 Dexie 镜像；拉取失败时镜像保持原样。何时刷新由 `installCollabRefreshScheduler`（`lib/collab/refresh-scheduler.ts`）决定：

- 启动、获得焦点、恢复联网、窗口变为可见时各刷新一次；
- 窗口可见期间每 `COLLAB_REFRESH_INTERVAL_MS = 60_000` 刷新一次；
- 失败后退避，最长 15 分钟。

所以队友挪动一张卡片后，你最多要过一分钟才看到，而且前提是窗口在前台。每个空闲客户端还会每分钟把所有列表重新拉一遍。Linear、Figma、Notion 用同一种方式避开这两个问题：服务端推送一条工作区级的变更流，客户端据此反应。

服务端其实已经会推送。共享聊天（`chat_api.rs`）和 Canvas（`canvas_api.rs`）各带一份相同的机制：

- 一张 30 秒过期、带清扫的一次性票据表；
- 一个 `RwLock<HashMap<key, broadcast::Sender<Frame>>>`；
- 一个遇到 `RecvError::Lagged` 或 `Closed` 就结束的流循环。

两份副本的测试断言的是同样的性质。议题和计划却没有这样的流。

## 决定

### 1. 一个中枢，三条流

`crates/cognia-collab-server/src/socket_hub.rs` 提供 `SocketHub<K, F>`，负责票据的签发、消费与清扫、按键广播，以及按用户吊销票据（聊天在成员离开时已经需要这项）。聊天和 Canvas 迁到它上面，这是一次不改变行为的重构：它们现有的测试照常通过，中枢本身另有测试，覆盖以下性质：

- 票据只能用一次；
- 过期票据会被清扫；
- 被吊销的用户失去手上所有票据；
- 落后的接收方会被明确告知，而不是被静默跳过。

### 2. 推送流只携带失效通知，不带数据

- `POST /v1/orgs/{org_id}/feed/tickets` 签发票据，要求调用者是组织成员，票据绑定调用者的 `usr_`；
- `GET /v1/orgs/{org_id}/feed?ticket=` 升级为 WebSocket。

帧里没有数据，只有失效通知：

```json
{ "kind": "invalidate", "entity": "issue", "id": "iss_…", "workspaceId": "ws_…", "revision": 7 }
```

- `entity` 取值为 `issue | issue_event | plan | run | workspace | membership`；
- 成员关系帧写明受影响的 `usr_`，不带修订号。

客户端不直接应用帧，而是让镜像刷新该实体所属的那一段。这样写入镜像的路径仍然只有**一条**，也就是 `lib/collab/sync.ts` 已经保证的那条：拉取失败时镜像保持原样，任何时候都不做乐观改写。刷新进行中到达的帧只把该段标记为「再跑一轮」，不会排起第二个并发拉取。

帧在存储提交之后，由完成写入的处理器发布：`create_issue`、`patch_issue`、`append_event`、计划与运行的处理器，以及成员管理的处理器。若在提交前发布，就可能宣告一个被回滚的事务根本没有产生的修订。

### 3. 每一帧都检查权限

一帧只发往其用户能读取 `workspaceId` 的连接，判定使用 `cognia-tenant-auth` 中的 `resolve_workspace_access`。结果按连接、按工作区缓存 5 秒；一旦收到指名该连接用户本人的成员关系帧，缓存立即失效。所以把某人移出工作区后，他的推送流在下一帧就停止，这与 Canvas 对写入的保证（ADR-0158）一致。

读者看不到的工作区的帧直接丢弃，而不是脱敏后发送：一个 id 就足以泄露某物的存在，而无权访问的调用者在其他所有地方收到的都是 404。

### 4. 客户端：推送流驱动调度器，轮询作为降级

新增 `lib/collab/feed.ts`，通过 `CollabClient` 所用的同一传输打开连接：平台 fetch，桌面端遵循代理设置，每次连接尝试都用新票据。推送流连通期间：

- `installCollabRefreshScheduler` 停掉 60 秒定时器；
- 启动、获得焦点和恢复联网时照常刷新，以补上连接断开期间漏掉的变更；
- 帧按段合并 250 ms 后，带着段过滤调用 `requestCollabRefresh`。`refreshCollabPlane` 新增可选参数 `legs: CollabRefreshLeg[]`，默认仍刷新全部段；
- 遇到 `Lagged`，或任何非正常关闭，先做一次全量刷新，再按调度器现有的退避重连。

推送流断开期间，60 秒轮询原样恢复。过期徽标（`components/issues/collab-refresh-stale-badge.tsx`）依旧读取 `lastSuccessAt`，无论哪种方式在运行都准确。

### 5. 上线方式

- 服务端：由 `COLLAB_FEED_ENABLED` 控制，**默认开启**。推送流只是让已有的读取更及时，不授予任何新权限。
- 客户端：推送流自行降级。没有这条路由的服务端在签发票据时返回 404，客户端继续轮询，直到下次启动才再尝试签发。

## 后果

- 队友的改动在一秒内到达已打开的客户端，而不是最多 60 秒；空闲客户端不再每分钟重拉所有列表。
- 聊天、Canvas 和推送流共用一份票据与广播实现，票据过期或吊销的修复只需改一处。
- [ADR-0207](./0207-a-collaboration-event-reaches-people-who-are-not-in-the-room) 可以在同一连接上投递按用户的通知帧，无需第四条流。
- `tokio::broadcast` 只在进程内有效。与今天的聊天和 Canvas 一样，推送流假定每个组织只由一个 collab-server 实例服务，见「尚未决定」。
- 新增测试：
  - `socket_hub.rs` 的文件内测试；
  - `feed.rs` 中逐帧权限与缓存失效的测试；
  - `lib/collab/feed.test.ts`；
  - `refresh-scheduler.test.ts` 补充推送流与轮询交接的用例。

## 尚未决定

- **增量载荷。** 帧可以携带变更后的行，让客户端省掉一次拉取。但那需要写入镜像的第二条路径，而今天的各项保证都建立在只有一条路径之上。等大型组织的分段拉取真的成为瓶颈时再考虑；在列表路由上加 `since` 游标是更便宜的第一步。
- **多个服务端实例。** 跨实例扇出需要 Postgres `LISTEN/NOTIFY` 或外部消息总线。这同样适用于聊天和 Canvas，应由第一个需要横向扩展的 ADR 解决。
- **为配对手机提供推送流。** 使用协同平面的手机与桌面端一样直接连服务端；不打算经由 companion Host 中转推送流。

## 实现说明（2026-09-30）

- 推送流按**组织**建立（`/v1/orgs/{org}/feed`），而不是按工作区：身处多个工作区的人只持有一条连接，其余交给逐帧的范围过滤。
- `socket_hub.rs`（`TicketBook`、`Channels`）现在同时支撑共享聊天、Canvas 和推送流。Canvas 票据补上了聊天早已有的容量上限（待兑换超过 8,192 张时返回 `429`）。
- 处理器在存储返回后才发布：议题、议题事件（以所属议题命名）、计划、运行，以及所有成员关系写入。被拒绝的写入不发布任何帧（`api.rs` 中的测试 `a_committed_patch_is_announced_on_the_feed_and_a_refused_one_is_not`）。
- 客户端：`lib/collab/feed.ts`，由 `components/providers/initializers/issue-tracker-initializer.tsx` 挂载，服务端地址变化时重新绑定。`refreshCollabPlane` 接受 `legs`；身份与读者自己的成员关系始终刷新。无头主机继续轮询（`lib/headless/runtimes/collab-refresh.ts`）。
- 通知帧按接收者过滤。ADR-0207 落地后，每当为某人写入一行通知，或这个人把通知标为已读，都会发布一帧。客户端收到后拉取通知，而不是刷新镜像。
