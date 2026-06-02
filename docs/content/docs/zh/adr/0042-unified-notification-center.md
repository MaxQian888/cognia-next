---
title: ADR-0042 — 统一通知中心
description: "一条 notify() 单管道，背靠持久化的 Dexie v68 notifications 表，把 scheduler、agent-team、plugin、connector、session、移动推送等通知路径统一到唯一数据源——含去重/合并、三态读取模型、暂停(snooze)、勿扰/安静时段、按偏好的渠道扇出(center/toast/os/push)、状态栏带两级角标的通知铃、通知中心面板、偏好设置区与移动端 feed。"
---

# ADR-0042 — 统一通知中心

**状态**：已接受 (2026-06-02)
**作者**：Max Qian + Claude Opus 4.8
**基于**：scheduler 通知集成 (ADR-0002)、agent-team notifier (ADR-0022 §3.4)、插件通知 API (ADR-0006/0026)、connector bus (ADR-0009)、移动推送 (ADR-0027)，以及 `lib/connectors/outbound-runner` 的安静时段评估器
**影响**：`types/notifications/`(新)、`lib/notifications/`(新)、`lib/db/notifications.ts` + `lib/db/schema.ts`(v68)、`stores/notifications/` + `stores/inbox/active-conversation-store.ts`(新)、`hooks/notifications/`(新)、`hooks/chat/use-session-notifications.ts`、`lib/scheduler/notification-integration.ts`、`lib/ai/agent/team/team-notifier.ts` + `agent-team-runtime-deps.ts`、`lib/plugin/api/notification-api.ts`、`components/notifications/` + `components/settings/notifications/` + `components/mobile/notifications/`(新)、`components/desktop/status-bar.tsx`、`components/providers/tauri-provider.tsx`、`app/inbox/c/[conversationKey]/`、`app/me/notifications/`、`lib/claude/types.ts`(`AppSettings.notificationPreferences`)、`i18n/messages/{en,zh-CN}.json`

## 背景

调研发现：应用的通知/反馈面**偏重投递，但没有统一管道，也没有持久化 UI**：

- **没有中央 store**。scheduler、插件(内存 `Map`)、agent-team、移动推送各有一条独立路径，各自管 toast/OS 路由。
- **没有应用内中心 / 历史 / 未读角标 / 偏好**。插件通知仅在内存(重载即失)；toast 转瞬即逝；无铃铛、无计数、无勿扰。
- **悬空接线**。插件 API 的 `setToastDispatcher` 导出却从未被调用；移动端 `subscribeToPushNotifications` 没有 UI 消费者；入站 connector 消息与 inbox 到达从不触发 OS 或角标。

目标(与用户对齐)：**统一出站通知中心**——一条 `notify()` 管道写持久记录 + 按偏好扇出——**并**把**入站事件**(connector 消息、移动推送、会话完成)接入同一管道。

### 成熟设计依据

对照 Slack、GitHub Inbox、Linear、MS Teams、VSCode、Novu/Knock 验证。采纳：三态读取(`unseen → seen → read → done`，GitHub/Novu)；按实体分组 + 合并计数；逐条 snooze + 同源新活动自动唤醒(Linear) + 全局 DND 时段(Knock 安静时段)；约 3 级打扰度且 `critical` 穿透 DND(Teams/VSCode；Novu `critical → readOnly` 偏好穿透)；焦点感知投递(查看该面时抑制 OS，Slack)；全局默认 + per-source 例外覆盖(非全矩阵)；两级角标(冲你来的=红计数，泛活动=圆点)；`dedupeKey` 窗口突发合并(Novu digest)；结构化可序列化 CTA。

刻意**不**采纳(Novu 企业级)：事件/消息双实体拆分、job-DAG 队列、topics 多播、多租户、provider 矩阵。嵌入式单用户桌面端用单一 `NotificationRecord`(带 `deliveredVia[]` 诊断字段)与进程内管道。

## 决策

### 单管道 `lib/notifications/notify(input, deps)`

DI 风格(仿 `team-notifier`)，让编排无需 Dexie/sonner/Tauri 即可单测。流程：构造/合并记录 → **去重合并**(`dedupeKey` 在窗口内命中则递增既有 `count` 而非新建) → **路由**(`source × level → channels`，受 per-level OS/push 阈值、per-source 静音、DND 约束；`critical` 全部穿透) → **持久化**写 Dexie + 推入响应式 store → **best-effort 扇出**(toast→sonner、os→Tauri、push→移动)，记录 `deliveredVia` → best-effort **保留**裁剪。真实依赖由 `lib/notifications/runtime.ts` 一次性接线。

### 数据模型 (`types/notifications/`)

`NotificationRecord` 是持久"中心"条目：`id, source, level, title, body?, createdAt, updatedAt, readState, snoozedUntil?, dedupeKey?, groupKey?, count, href?, actions?, sourceRef?, pluginId?, directed, deliveredVia[], expiresAt?`。`notifications` 表(**v68**)索引 `dedupeKey、groupKey、createdAt、readState`，外加复合 `[readState+createdAt]`(最新未读 feed + 角标)与 `[source+createdAt]`(按来源 feed)。Action **可序列化**(`{ id, label, command, args? }`)——点击时经 `action-registry` 解析，绝不存闭包。`NotificationPreferences` 以 JSON 挂在 `AppSettings` 单例上(无迁移)，用 `DEFAULT_NOTIFICATION_PREFERENCES` 兜底合并。

### 三条遗留路径真统一

- **Scheduler** `notifyTaskEvent` 构造 `NotificationInput`(`desktop → os`、`toast → toast`)调核心。**webhook** 留在 scheduler(它是出站 HTTP 集成而非用户通知)。`TaskNotificationConfig` 不变 → 向后兼容。
- **Agent-team** `team-notifier` 新增单一 `deliver` 出口：每事件只发一次，核心按 level 路由(`info → center`、`warn → +toast`、`critical → +toast+os+gate`)。dedupe/suspend/`openGate` 语义不变；默认 deps 懒加载核心。
- **插件**：经 `plugin-bridge` 实现悬空的 `setToastDispatcher` → 插件通知升为一等中心条目(有历史)，action 闭包注册成可序列化 command。

### 入站接线

被动的 `ConnectorBus.subscribeInbound` 观察者把有意义的消息(`kind = create`、非自身、非空)转为按 `conversationKey` 归类的中心通知；`mentions.selfMentioned`/私聊标记为 `directed`。**焦点感知**：窗口聚焦且正在看该会话时(由 `stores/inbox/active-conversation-store` 跟踪，inbox 路由设置)，抑制 OS 渠道而中心照常记录。移动端悬空的 `subscribeToPushNotifications` 消费者已接线(背景推送=仅 center，因 OS 已展示；前台=center+toast)。`use-session-notifications` 改走核心(center 记录 + OS)，web 端也记录。`installNotificationBridges()` 经 `TauriProvider` 一次性挂载 plugin/connector/push。

### UI

状态栏**铃铛**带两级角标(`directed` 未读=红计数，泛活动=圆点)，打开**中心**面板(分组活跃 feed、来源过滤、批量全部已读、归档视图、逐行打开/处置)。**偏好**设置区(`设置 → 通知`)编辑渠道、级别门、安静时段、per-source 静音、声音/角标、焦点感知、snooze 自动唤醒与保留，并含 OS 权限 CTA。**移动 feed**(`/me/notifications`)复用行组件并对触屏常显菜单。

## 影响

- 唯一数据源：各子系统通知共享历史、去重、偏好与读取状态。关闭某来源仍记录到中心(历史不丢)，仅静音其打扰渠道。
- `critical` 保证必达(安全/审批)，穿透静音与 DND。
- webhook 渠道与易失 toast/OS 的逐渠道投递状态刻意不超出 `deliveredVia[]` 追踪；若日后需逐渠道重试，单实体可扩展出 `messages` 子表而不重塑调用方。
- schema 版本 **v68** 须被并发分支尊重(它与无关的 eval **v69** 同期落地)。
