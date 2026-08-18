---
title: ADR-0133 — 基于持久宿主的终端会话分享（方案 A）
description: 通过授予已配对设备现有的远程终端能力并复用宿主的控制权租约来分享托管终端——宿主广播参与者名单，dock 新增分享对话框、状态 chip 新增参与者列表；删除休眠的邀请令牌 / editor 角色协作模型。
---

# ADR-0133 — 基于持久宿主的终端会话分享（方案 A）

| 字段 | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态 | 已接受                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 日期 | 2026-08-18                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 基于 | ADR-0031 / ADR-0033 集成终端（持久宿主、控制权租约）；ADR-0014 / ADR-0015 Capacitor 移动壳；ADR-0021 WebRTC WAN 传输；ADR-0059 主机画像 / 能力门禁；ADR-0082 远程主机；ADR-0132 §背景（发现休眠模型的那次审计）                                                                                                                                                                                                                                                                                  |
| 范围 | `crates/cognia-terminal/src/host.rs`（`SessionParticipant`、名单广播）、`src-tauri/src/terminal_host_bridge.rs`（`HostChannelEvent::SessionSnapshot`）、`lib/terminal/{types,base-session,session,transport-ws,session-registry}.ts`、`lib/terminal/collaboration/roster.ts`、`hooks/companion/use-remote-terminal-grant.ts`、`components/terminal/{terminal-share-dialog,terminal-session-chip,terminal-dock}.tsx`、`components/settings/companion/paired-devices-card.tsx`、i18n `terminal.share.*` |

## 背景

`lib/terminal/collaboration/{types,share-manager}.ts` 描述了一个协作模型——带 `Math.random` 令牌、令牌放在分享 URL 里的邀请对象，三个角色（`controller` / `editor` / `viewer`），一套私有的 `CollabMessage` 数据通道协议——**没有任何地方导入它**，宿主也无法强制它：持久宿主（`crates/cognia-terminal`）只有两个租约角色（控制者与经 `NotController` 只读的查看者），按已配对设备用一次性 socket ticket + `terminal.open` 能力鉴权远程客户端，并且在附着存活期间每秒重新校验该能力。与此同时宿主早已支持一个会话多个附着以及可 take/release 的控制权租约，但渲染端看不到**是谁**附着着：`SessionInfo` 只带 `attachedClients` 与 `currentController`，宿主也不会在名单变化时重发快照。

Grill 中权衡的方案：**A**——授予已配对设备现有的远程终端能力并复用宿主租约（不新增传输，不发令牌）；B——走 WAN 信令通路的每会话邀请令牌 / 链接；C——保持休眠。选 A：它是唯一已被现有安全边界强制的方案，且不需要新的帧类型或能力。

## 决策

1. **宿主拥有名单。** `HostSessionInfo` 新增 `participants: Vec<SessionParticipant { client_id, device_id, local, role: controller | viewer }>`（serde `#[serde(default)]`，加性）。`broadcast_participants` 在 attach、detach、take-control、release-control 与客户端断开之后向每个附着重发 `HostEvent::SessionSnapshot`。**不新增 `FrameKind`**——ADR-0031 的线协议兼容不变量成立；旧客户端忽略多出的字段与多出的主动（sequence 0）快照。
2. **桥转发主动快照。** `terminal_host_bridge::channel_event_for` 把 sequence 0 的 `SessionSnapshot` 帧映射为 `HostChannelEvent::SessionSnapshot { session }`（桌面自己请求的应答保留请求 sequence，由 pending 表结算）。其他地方的 `HostSessionInfo` fixture 补上该字段。
3. **渲染端原地应用快照。** `BaseTerminalSession.applySessionSnapshot` 逐字段替换 `info`（对象身份不变——消费者持有 `session.info`；宿主不再发送的键会被删除）并扇出给 `onInfo` 监听器；`session.participants` 是类型化访问器。`TerminalSession` 处理新的 `session_snapshot` 通道事件；`RemoteTerminalSession` 把 sequence 0 的 `SessionSnapshot` 帧走同一路径。会话注册表订阅 `onInfo` 并重新通知，`useSyncExternalStore` 消费者不需轮询。不做持久化：名单是宿主的实时状态，因此有意不加 terminal-store 切片。
4. **分享 = 每设备的远程终端授权。** 分享对话框（`components/terminal/terminal-share-dialog.tsx`，dock 的 **分享** 按钮，仅桌面宿主）列出会话名单（设备标签来自配对表，控制者 / 查看者徽章）与每台已配对设备及其授权开关。授权流程——签发宿主描述符 → 写 Dexie 镜像 → 翻转宿主，开启方向过生物识别门禁、宿主拒绝时回滚——从配对设备卡片抽到 `hooks/companion/use-remote-terminal-grant.ts`，两个界面共用一份实现。收回授权即「踢人」：LAN/WAN 适配器本就每秒重检并断开附着。授权是**设备级**而非会话级；对话框明说。宿主 `allowRemoteAccess` 关闭时对话框链接到「设置 → 终端」而不是自己翻转（那个开关还会重新签发宿主）。
5. **chip 报告分享。** `TerminalSessionChip` 新增「已与 N 台设备共享」状态（设备接入时重新展开），并在弹层里列出远程参与者及其租约角色；释放控制权的按钮以名单里的控制者为准。
6. **删除休眠模型。** `types.ts`、`share-manager.ts`、`index.ts` 及其测试移除；`lib/terminal/collaboration/roster.ts` 是基于 `SessionInfo.participants` 与配对表的纯渲染端投影（`projectRoster`、`mergeDevicesWithRoster`、`participantLabel`、`deviceIdOfClient`）。没有 `editor` 角色，因为宿主没有。

## 影响

- 分享搭乘现有安全边界：已配对设备 + 一次性 ticket + `terminal.open` + 每秒重检。任何秘密都不会出现在 URL 里。
- 附着到同一会话的每个窗口在一帧内看到名单与租约变化；「接管控制」/「释放控制」终于能显示从谁手里接管。
- 会话级作用域是本 ADR 的非目标：持有授权的设备可以附着到任意托管终端，与之前完全一致；如果将来需要会话级授权，它属于 ticket scope（`companion_api/api.rs`）与 `ws_terminal.rs`，不属于渲染端。
- 不适用 PII 门禁——发给已配对设备的 PTY 字节就是现有信任边界，未变。

## 验证

宿主：`roster_is_broadcast_to_every_attachment_on_attach_detach_and_lease_moves`、`dropping_a_client_updates_the_roster_for_the_others`（crate 套件全绿）。桥：`unsolicited_session_snapshots_reach_the_channel_as_roster_refreshes`。渲染端：base-session 快照测试、session / transport-ws 快照分发、注册表重新通知、名单投影、授权 hook（顺序、回滚、门禁）、分享对话框、chip 名单、dock 分享按钮。本次未做：真实配对设备上的 `tauri-smoke`（记为待办）。
