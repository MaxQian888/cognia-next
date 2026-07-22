---
title: "0089 — 话题级 IM 会话运行时"
description: "为 IM 连接器提供持久化的话题隔离、激活、派发、恢复与能力降级展示。"
---

# ADR 0089 — 话题级 IM 会话运行时

- **状态：** Accepted
- **日期：** 2026-07-22
- **Schema：** Dexie v120
- **替代范围：** ADR-0009 的内存入站 FIFO/恢复机制，以及 ADR-0025 的执行进度展示路径

## 背景

一个 IM 群并不等于一个会话。飞书群可以同时包含多个话题；每个话题都必须拥有独立的
上下文、回复锚点、历史窗口、执行队列、审批和进度卡片。拆解 `conversationKey` 反推投递
目标、拉取整群历史、或在执行前提交去重记录，都可能造成跨话题泄漏或崩溃后丢消息。

## 决策

核心代码将 `conversationKey` 视为不透明稳定标识。适配器提供 `ConversationAddress`，每次
入站事件刷新持久化的 `ConversationDeliveryTarget`，其中包含适配器自有引用、来源消息与
最新回复锚点。会话、执行绑定、历史、卡片、回调、审批和主动发送统一解析此目标。

入站消息先创建持久化任务，再由 `ConnectorBus` 结合适配器默认值、话题覆盖、激活状态、
身份和 readiness 执行准入。策略包括 `mention_each`、`mention_activates`、`always` 和
`direct_only`。飞书话题默认首次 @ 激活，24 小时按真人消息滑动过期；父群与其他话题互不
影响。免 @ 必须通过显式探测：管理员确认控制台配置后启动探测，运行时实际观察到未 @ 的
群消息才标记 `all_messages_verified`。

`connectorInboundJobs` 是入站执行的事实来源。`queue` 保留每条独立 FIFO turn；`steer`
仅在当前运行时与阶段明确支持安全注入时使用，否则原始消息和附件会持久化，并在最早安全
边界逐条重放。运行租约过期会进入 `recovery_required`，不会假设模型或工具副作用可恢复。

历史新接口接收完整 target 和强类型 cursor。飞书只接受时间戳/page token，按群分页后在
本地严格过滤目标 `thread_id`；消息 ID 永远不会被当作时间戳。

展示统一到 durable execution presentation runner，删除未接线的 `TurnActivityDispatcher`。
每个适配器声明 `ConnectorRuntimeCapabilityMatrix`；隔离、身份、授权、去重、持久化派发与恢复
不可降级，只有流式/卡片/编辑等展示能力可以显式降级。

飞书 CardKit 使用稳定 element ID。文本预览走流式内容更新，阶段和按钮走组件更新，结构变化
与最终冻结才使用整卡替换。每次 mutation 先持久化 `{sequence, uuid, operation}`，成功确认前
重试必须复用；`200810`、序列冲突、实体缺失/过期、30 KB 限制和 14 天有效期均分类处理。

## 结果

- Dexie v120 新增 `connectorConversationStates` 与 `connectorInboundJobs`。
- 激活策略与运行中派发模式（`queue` / `steer`）相互独立，默认 `queue`。
- 话题是共享协作上下文，但每条消息保留真实发送者身份。
- 静态机器人菜单只承载 status/new/help；CardKit 是持久进度面。跟随气泡通过
  `push_follow_up` 仅在机器人单聊作临时增强，群聊/话题明确降级为 CardKit 按钮。
- 第三方适配器可以降低展示丰富度，但必须显式声明，并在远端无幂等能力且结果不确定时进入
  reconciliation，而不是自动重复发送。
