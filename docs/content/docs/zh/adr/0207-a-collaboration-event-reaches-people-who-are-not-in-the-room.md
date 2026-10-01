---
title: "0207 — 协同事件能送达不在房间里的人"
description: "当某件事指向某个人时——被指派、在议题评论中被明确提及、被请求审批、被邀请——协同服务端为每位接收者写一行通知。通知行受 RLS 约束、可去重，并带已读状态。客户端通过 ADR-0206 推送流收到它，并用游标拉取补齐。客户端把每一行交给现有的 ADR-0042 notify() 管道，来源记为 \"collab\"，因此渠道偏好、安静时段、系统通知、手机推送和 IM 投递都沿用现有实现。在任一设备上读过，其他设备上也会随之清除。"
---

# ADR 0207 — 协同事件能送达不在房间里的人

**状态：** 已接受，已实现（2026-10-01）
**日期：** 2026-09-30
**相关：** [ADR-0042](./0042-unified-notification-center)（通知管道）、[ADR-0149](./0149-a-person-is-not-a-device)（把此事留作「第二轮再议的问题」）、[ADR-0206](./0206-a-workspace-streams-its-changes-instead-of-being-polled)（本方案依托的推送流）、[ADR-0177](./0177-a-room-is-one-conversation-shape)（共享聊天中的人工提及，仍在「以后」）
**来源研究：** `docs/plans/2026-09-30-collaboration-multi-device-gap-analysis.md`（缺口 A3）

## 背景

在协同平面上，人可以对别人做一些事：

- 指派共享议题（`api.rs` 中的 `validate_human_assignee`）；
- 在共享聊天中请求审批（`chat_approval_requests`）；
- 邀请某人加入共享会话（`chat_session_invites`）。

但被指向的那个人得不到任何通知。仅有的信号是聊天流的广播和下一次镜像刷新，两者都只能送达此刻正开着该房间或看板的人。等着某位离开的队友处理的审批请求，只能一直等到他碰巧去看。

ADR-0149 当初有意推迟了这件事：通知只留在本地，协同通知的投递是「第二轮再议的问题」。此后本地这一侧已经完备。`notify()`（ADR-0042，`lib/notifications/notify.ts`）已经能够：

- 去重与合并；
- 应用按来源、按项目的偏好，以及勿扰和安静时段；
- 投递到通知中心、toast、系统通知、经配对 Host 的手机推送（`lib/notifications/inbound-push.ts`、`device-channel-gate.ts`），以及 IM（`lib/notifications/im-deliver.ts`）。

缺的是服务端的那一半：一份持久的记录，写明某件事指向了谁。Linear 的收件箱、GitHub 通知和 Slack 都做同样的划分：服务端拥有按接收者的记录及其已读状态，各设备自行决定如何呈现。

## 决定

### 1. 服务端为每位接收者写一行

迁移 `0013_notifications.sql` 添加 `collab_notifications`：

| 列 | 说明 |
| --- | --- |
| `id` | `ntf_…` |
| `org_id`、`recipient_user_id` | 在 `app.tenant_id` 上做 RLS；读者只能看到发给自己的行 |
| `workspace_id` | 可空；读取时用于权限检查 |
| `kind` | `issue.assigned`、`issue.mentioned`、`chat.approval_requested`、`chat.invited` |
| `subject` | 要打开的对象，形如 `{entity, id}`：`issue`、`chat_session` 或 `chat_invite` |
| `actor_user_id` | 由谁引起 |
| `dedupe_key` | 按 `(recipient, dedupe_key)` 唯一，例如 `issue.assigned:iss_…:rev7` |
| `seq` | 按接收者单调递增，作为拉取游标 |
| `created_at`、`read_at` | 在任一设备读过之前 `read_at` 为空 |

完成写入的处理器在存储提交之后记录这些行，与 ADR-0206 推送流的规则相同。通知是写入的结果，而不是写入的一部分：通知被指派者失败了，指派依然成立。这种失败会记录日志，不会把一次已成功的写入变成 500。

去重键由这次写入派生：`issue.assigned:<id>:rev<n>`、`issue.mentioned:<事件 id>`、`chat.approval_requested:<审批 id>`、`chat.invited:<邀请 id>`。重试的写入会重放同一修订或同一事件，因此不会重复记录。

`seq` 取自按接收者的游标行（`collab_notification_cursors`），插入期间锁住该行。所以同一接收者的通知按 `seq` 顺序提交，按 `afterSeq` 翻页的客户端不会漏掉晚提交的行。

操作者本人不会因自己的操作收到通知。写入时无权读取该对象所在工作区的接收者，不会得到这一行。这里再次使用 `resolve_workspace_access` 检查，因为把一个人无权打开的东西通知给他，会同时泄露它的存在和标题。

通知行只存引用，不存内容。客户端展示的标题从自己的镜像解析；镜像尚未追上时，对该对象发一次 `GET`。

### 2. 提及靠声明，不靠解析

议题评论（`append_event`）的载荷新增可选字段 `mentions: usr_[]`。服务端逐个核对其是否为工作区成员，未知 id 返回 400，而不是静默丢弃。该字段由评论编辑器的人员选择器填写。服务端从不解析自由文本中的 `@名字`：显示名并不唯一，猜错就会通知错人。

共享聊天中的人工提及仍在 ADR-0177 的「以后」里。落地后，它通过同一张表产生 `chat.mentioned` 行。

### 3. 投递：连着推送流时靠推送流，否则靠游标拉取

- `GET /v1/orgs/{org_id}/notifications?afterSeq=&limit=&readAt=&readSeq=` 列出调用者本人在 `afterSeq` 之后的通知，从不列出别人的：
  - 调用者已无权读取其工作区的行会被隐去，但 `nextAfterSeq` 照样越过它；
  - 同一响应还带 `reads`，即自 `(readAt, readSeq)` 游标以来被标为已读的行，一台设备上的已读就是这样传到其他设备的；
  - 游标取一对值，是因为一次「全部标为已读」会给许多行打上同一时刻。
- `POST /v1/orgs/{org_id}/notifications/read` 接收 `{ids}`（最多 500 个）或 `{upToSeq}`，二者只能取其一，把调用者的未读行标为已读，可重复调用。
- ADR-0206 推送流的按用户帧 `{kind: "notification", seq}` 只发往该用户自己的连接：写入新行时发送，该用户标记已读时也发送。帧里不带内容，客户端据此拉取。

只有高风险的审批请求才会通知别人。普通请求只能由发起者本人处理（`resolve_approval`），没有其他人需要被询问。高风险请求会发给会话中所有 `authorize_session_action` 允许审批高风险的成员，发起者除外。

`chat.invited` 只为指名了对象的邀请发送。现在，被指名的人可以通过 `POST /v1/orgs/{org_id}/chat-invites/{invite_id}/accept` 直接接受邀请，无需令牌：邀请本身已写明谁可以加入，而已登录的调用者证明了自己是谁。其他人得到的答复与邀请已被使用时相同。没有这条路由，通知指向的就是接收者无法处理的东西。

组织邀请完全不发通知。它们是不指名的持有者令牌，在有人兑换之前，没有可以通知的对象。

新增 `lib/collab/notifications-sync.ts`，把游标存在 `localStorage` 中，与 `lib/collab/connection.ts` 保存按账户协同状态的做法一致。游标是 `{afterSeq, readAt, readSeq}`，外加尚未提交的本地已读 id，按本地账户、服务端和组织分别保存。在以下时机拉取：

- 收到推送流的帧，以及推送流每次（重新）连上时，因为连接断开期间发出的帧没有送达任何人；
- 启动、获得焦点、恢复联网、窗口变为可见，与镜像刷新的触发时机相同。

### 4. 客户端把每一行交给已有的管道

每条新通知对应一次 `notify()` 调用：

- `source: "collab"`，这是 `NotificationSource` 的新成员，用户可以在「设置 → 通知」中按来源静音或改道；
- `dedupeKey`：取该行的 `dedupe_key`。本地 `seq` 游标是防止重放拉取的第一道防线，游标及以下的行永远不会被交出去。去重键是第二道防线：与游标竞争的第二个标签页只会刷新已有记录（`lib/notifications/dedup.ts`），不会再建一条；
- `sourceRef: {kind: "collab-notification", id}`，外加一个打开该对象的动作：议题深链或共享会话；
- 所有类型都设 `directed: true`，每一条都指向这个人本身，所以计入红色数字角标，而不是环境活动的小圆点；
- `level`：审批请求为 `warning`，因为有一次运行在等它；其余为 `info`。

没有新的界面管道，没有新的推送路径，也没有新的 IM 路径。通知去通知中心、系统、手机还是飞书，由这个人已有的偏好决定。

在本地通知中心把通知标为已读时，会向服务端发送 `read`。于是同一个人的其他设备在下次拉取时清除它，而推送流会立即触发那次拉取。本地通知中心已显示为已读的条目，不会因服务端的 `read_at` 再弹一次。

### 5. 保留期

已读行 90 天后清理，任何行 180 天后清理。清理是惰性的，按接收者进行：为某个接收者写入下一行时，在同一事务中删除他已过期的行。

没有采用后台清扫。这些表启用了 FORCE 行级安全，清扫要么需要一个绕过 RLS 的特权角色，要么需要逐个租户循环。

不再收到任何通知的接收者，最多保留 180 天的行。清理不会复用 `seq`。被清理的行在所有地方都消失；清理前从未见过它的设备什么也不显示。半年之后，这正是合理的结果。

## 后果

- 被指派者、被提及的队友或审批人，不必开着房间，也能在自己选好的渠道上收到通知，包括手机和 IM。
- `NotificationSource` 新增 `"collab"`，需要在通知设置的拆分源里补 `en` 和 `zh-CN` 标签键，并设定按来源的默认值。
- 服务端第一次有了成员关系以外的个人状态。Postgres RLS 测试（`tests/postgres_rls.rs`）必须证明一个用户既列不出、也标记不了另一个用户的通知。该测试已经在 CI 中运行：只要 `crates/cognia-collab-server/` 有改动，`.github/workflows/test.yml` 中的 `postgres-rls` 任务就会对 Postgres 服务运行这些被忽略的测试。
- 新增测试：
  - 迁移与存储测试，覆盖按接收者唯一和 seq 单调；
  - 处理器测试，覆盖不通知本人和无权限不通知；
  - `lib/collab/notifications-sync.test.ts`，覆盖重放去重和已读传播；
  - 补充 `NotificationSource` 的穷尽性测试。

## 尚未决定

- **邮件。** 需要外发邮件服务商和按人的地址策略。暂不提议。
- **托管推送中继。** 推送仍经由此人自己配对的 Host 及其 APNs/FCM 凭据。既没有配对 Host、也没打开应用的人，要到下次打开时才看到通知。中继是来源研究中路线图的 P2-13 项。
- **摘要合并。** 把多条通知合并成「X 上有 5 条更新」，交给本地 `notify()` 已有的合并机制。暂不提议服务端摘要。

## 实现说明（2026-10-01）

- 服务端：
  - `crates/cognia-collab-server/src/notifications.rs` 包含存储 trait、内存与 Postgres 两种存储、`deliver` 和路由。
  - 迁移 `0013_notifications.sql` 添加通知行和按接收者的游标表，两者都受租户 RLS 约束。
  - 产生通知的位置：`create_issue` 和 `patch_issue`（仅在负责人易手时）、`append_event`（`payload.mentions`）、`create_approval`（仅限高风险）、`create_invite`（仅限指名邀请）。
  - `accept_targeted_invite` 是新增的按 id 接受。
  - Postgres 测试 `notifications_are_per_recipient_ordered_and_deduplicated_in_postgres` 和 `a_targeted_invite_is_accepted_by_its_target_alone_in_postgres` 在 `postgres-rls` 任务中运行。
- 客户端：
  - `lib/collab/notifications-sync.ts` 与推送流一起在 `issue-tracker-initializer.tsx` 中挂载。
  - 某个账户和组织的第一次拉取（尚无游标）只把未读积压放进通知中心（`channels: ["center"]`），不弹 toast，不发系统通知、推送或 IM。首次见到时已读的行不导入。
  - 服务端的已读会标记本地记录（`logicalKey: collab-notification:<id>`），且不回传。本地已读（包括全部标为已读和归档）先排队，再分批提交；提交失败会在下次拉取时重试。
- 链接：
  - 议题打开 `/issues?id=<id>&source=collab`。议题页现在识别 `source`，因为协同议题和本地议题的 id 都以 `iss_` 开头。
  - 审批请求打开 `/?session=<本地 id>`。根页面现在会处理只带会话的链接（`hooks/chat/use-session-link.ts`）；在此之前，所有 `buildSessionHref` 链接都打不开任何东西。
  - 邀请打开 `/?acceptInvite=<id>&org=<org>`，先征得同意再接受，然后打开该对话。
- 提及：评论编辑器带队友选择器（`hooks/collab/use-collab-mention-candidates.ts`，读取实时的工作区成员名单），只发送 `@名字` 仍留在文本中的那些 id。
- 推送：`crates/cognia-companion-rpc/src/command_services.rs` 中的配套推送允许列表缺少 `issue`、`site` 和 `collab` 三种来源，导致它们的手机推送被静默拒绝。现在三者均已放行。
