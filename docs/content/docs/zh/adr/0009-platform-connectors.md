---
title: "0009 — 平台连接器"
description: "cognia-next 获得一个多平台消息适配层，使 AI 角色可以接收来自 Telegram、Discord、Slack、飞书和 OneBot 的入站消息，并通过一个健壮的 FIFO 出站队列发送回复。"
---

# ADR 0009 — 平台连接器

**状态：** 已接受  
**日期：** 2026-05-05  
**分支：** `feat/platform-connectors-phase1`

---

## 背景

cognia-next 拥有成熟的 AI 聊天引擎、丰富的角色/技能系统，以及一个能够
近似某人写作风格的员工数字孪生。在本 ADR 之前，这些机器都无法
与真实的消息平台交互——用户只能手动复制粘贴内容。

平台连接器的目标，是把一个 cognia-next AI 角色变成 Telegram、Discord、Slack、
飞书和 QQ/NapCat（OneBot v11）上的 _真正的机器人_，具备：

- 三种运行模式：**auto**（AI 直接回复，无需审核）、**manual**（人工
  键入回复文本）、**draft**（AI 生成草稿，由人工批准后再发送）。
- 一个可靠的出站队列，带指数退避、按适配器的熔断器、限流
  器、幂等去重，以及按对话的 FIFO 顺序。
- 对每个入站和出站事件的简单审计日志。
- 一个插件扩展 API，使第三方平台无需给 cognia-next 打补丁即可加入。

---

## 决策

### 架构概览

```
Messaging platforms
  ↓  (HTTP / WS / reverse-WS)
Tauri Rust layer (axum)
  ↓  (Tauri commands / invoke)
TypeScript layer (renderer)
  ├── ConnectorBus         — fan-in (inbound) + fan-out (outbound registry)
  ├── Policy evaluator     — TriggerPolicy rules + blockers → route decision
  ├── Mode router          — auto / manual / draft branching
  ├── Outbound queue       — Dexie-backed FIFO, retries, circuit breakers
  └── ConnectorDrafts      — pending draft CRUD
```

### 数据库 schema（v18）

在 `lib/db/schema.ts` v18 中新增了八张 Dexie 表：

| 表                   | 键  | 用途                                           |
| ----------------------- | ---- | ------------------------------------------------- |
| `adapterInstances`      | `id` | 每个已配置的机器人一行（Telegram、Discord……） |
| `platformIdentities`    | `id` | 每个观察到的平台用户一行                |
| `inboundLedger`         | `id` | 去重台账（上限 1 万）                           |
| `outboundQueue`         | `id` | 出站投递任务                            |
| `conversationOverrides` | `id` | 按对话的模式/角色覆盖         |
| `connectorAudit`        | `id` | 有上限的审计日志（5000 行）                |
| `connectorDrafts`       | `id` | 等待人工批准的待定草稿            |
| `connectorAttachments`  | `id` | 缓存的平台附件                |

### 五个内置平台适配器

每个适配器遵循相同的分解方式：
`parse.ts` / `serialize.ts` / transport / `capability.ts` / `sigverify.ts` / `index.ts`。

| 平台      | 传输                           | 签名校验                        |
| ------------- | ----------------------------------- | --------------------------------------------- |
| Telegram      | 长轮询（`getUpdates`）或 webhook | X-Telegram-Bot-Api-Secret-Token (HMAC-SHA256) |
| Discord       | Gateway WS (v10)                    | Ed25519 (X-Signature-Ed25519)                 |
| Slack         | Events API webhook                  | HMAC-SHA256 (X-Slack-Signature v0)            |
| 飞书 / Lark | 长连接 WS（protobuf，**默认**）或事件回调 webhook | 长连接：app_id/app_secret WS 握手。Webhook：verification token（`header.token`）+ 可选 AES-256-CBC 解密（schema 2.0） |
| OneBot v11    | 反向 WS（设备主动连入）             | Bearer token（可选）                       |

### 出站执行器的保证

- **按适配器的熔断器**——在 10 个事件窗口内失败率达 50% 后跳闸；
  冷却 30 秒后重新开启。
- **按适配器的令牌桶**——容量 20，每秒补充 5 个令牌。
- **指数退避**——`min(60 000, 1 000 × 2^attempts) + jitter(0–500 ms)`。
- **5 次尝试后进入死信**——行转为 `deadlettered`；不再重试。
- **幂等 LRU**——1000 条缓存短路平台的重复投递。
- **按对话 FIFO**——`Map<conversationKey, Promise<void>>` 通道确保顺序。
- **静默时段 + 全局静音**——每个适配器实例可选的 `quietHours` 窗口和 `muted`
  标志会推迟出站任务，且不计为失败。

### 模式路由

三种模式由一个三层策略栈管控：
`adapter default → per-conversation override → event-level override`。

| 模式     | 行为                                                                     |
| -------- | ----------------------------------------------------------------------------- |
| `auto`   | 总线调用 `sendPrompt`（Phase 1 占位）；最终 AI 文本入队为出站。 |
| `manual` | 用户在 Composer 中键入回复；直接调用 `enqueueOutbound`。          |
| `draft`  | AI 生成一个 `ConnectorDraft`；用户经 Inbox UI 批准或拒绝。   |

### Inbox UI

`app/inbox/` 渲染一个 Inbox 外壳（`InboxShell`），带一个侧边栏（`InboxSidebar`），
列出所有绑定平台的 `ChatSession` 行，以及一个带 `ConversationHeader` /
`MessageList` / `DraftBanner` 的详情面板。`/inbox/[conversationKey]` 路由是一个
与 `output: "export"` 兼容的纯客户端静态页面。

### 设置 UI

`components/settings/connections/connections-section.tsx`——位于设置中
`?section=connections` 的分标签外壳。标签：Overview / Adapters / Conversations / Inbox /
Outbound / Audit。每个标签是 `./tabs/` 下的一个独立组件。

### 插件扩展 API（任务 110）

`PluginManifest.connectors[]`（新增到 `types/plugin/plugin.ts`）让插件声明
适配器工厂。`lib/plugin/bridge/connectors-bridge.ts` 桥接会在插件启用时发现并把它们
注册到 `ConnectorBus`，并在禁用时注销。

### Web 模式降级（任务 111）

适配器需要 Tauri 桌面运行时。在 web 模式下：

- `ConnectionsSection` 显示一个顶部横幅，解释该限制。
- `ConversationHeader` 的模式切换器被包进一个 `pointer-events-none` 的禁用 span。
- 对于绑定平台的会话，Composer 的发送按钮被禁用。

### 经由调度器的主动出站（任务 108）

两个新的 `SchedulerEventType` 条目：

- `connection:outbound:send`——直接把一个出站任务入队（无 AI）。
- `connection:scheduled:digest`——Phase 1 占位；将在 Phase 1+ 调用 `sendPrompt`。

两者都经由 `lib/connectors/scheduled-outbound.ts` 注册为 `TaskExecutor`。

---

## 实现结果（相对原始规格的差异）

| 方面                          | 原始规格          | 实际实现                                                        |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| 数据库 schema 版本         | v16                    | v18（v16 新增 canvas，v17 外部桥接，v18 连接器）           |
| ADR 编号                      | 0008                   | 0009（0008 已被外部桥接占用）                                  |
| axum 版本                    | 0.7                    | 0.8（实现时的最新稳定版）                            |
| auto 模式下的 AI 运行             | 完整 `sendPrompt`      | Phase 1 占位——记录审计 + 占位任务；推迟到任务 40+  |
| `segmentsToPlainText` 分隔符 | 未指定            | `" "`（跨 text/markdown 段以单个空格连接）                |
| Tauri Rust HTTP 代理         | axum                   | cognia-next `connectors_http_request` Tauri 命令                   |
| Phase 1 E2E 范围              | 完整 auto/manual/draft | 仅 auto+manual 冒烟；draft 模式待真实 `sendPrompt` 后再做 |

---

## 后果

**正面**

- cognia-next AI 角色成为 5 大平台上的真正机器人。
- 出站队列久经考验（熔断器、限流、退避、死信）。
- 插件 API 让社区连接器无需分叉即可实现。
- Web 用户获得清晰的降级路径，而非静默失败。

**负面 / 已推迟**

- `auto` 模式的 AI 循环是占位的；完整的 `sendPrompt` → 回复 → 出站集成
  是 Phase 1+ 的工作（任务 40+）。
- 附件缓存（`connectorAttachments` 表）只有 schema；抓取流水线是
  Phase 2。
- Slack/Lark 的 OAuth 流程部分接入；生产令牌需要 Tauri keyring
  集成和一个托管的重定向 URL。

---

## 修订 — 2026-07（飞书链路完整性补齐）

一次连接器链路审计发现若干「写好却没接通」的飞书/公共管线缺口。本次补齐它们
（纯 TypeScript——无 Rust 改动；Rust 侧附件缓存与 OAuth 完成处理器早已存在）：

- **入站富媒体摄取（关闭「附件缓存 Phase 2」标记）。**
  `lib/connectors/adapters/lark/inbound-media.ts:enrichLarkInboundMedia` 作为适配器
  `dispatchEnvelope` 的第二遍,经既有加密缓存(`connectors_attachment_fetch` /
  `connectors_attachment_read`)下载图片/文件字节,挂上内联 `dataBase64`(被已接线的入站
  OCR + 模型视觉路径消费),文档类文件再经 `processDocumentAsync` 抽取文本。
  `parse.ts:buildSegments` 现在把 `post` / `file` / `audio` / `media` 投影成类型化 segment,
  而非 `[type]` 占位。
- **以用户身份发送（关闭「OAuth 部分接入」标记）。**
  `auth.ts:getUserAccessToken` / `refreshUserToken` 解析并静默刷新 OAuth 处理器持久化的
  `user_token`;`index.ts:doRequest` 使用它(opt-in `settings.sendAsUser`),带 401 刷新与
  优雅回退到机器人身份。`lark-config.tsx` 新增「以我的身份发送」区块:OAuth **连接账号**
  按钮(打开授权 URL,由 deep-link 路由完成回调)+ opt-in 开关。
- **公共管线修复:** `cooldown-after-bot-reply` blocker 现在真正被回写
  (`ConnectorBus.recordBotReply`,由出站 runner 的 `onDelivered` 接线——默认群聊反刷屏冷却
  此前从未生效);团队/工作流的 IM 派发现在与单角色路径过同一条 fail-closed PII 网关
  (`runtime.ts`,关闭一处已确认的红线绕过);异步出站序列化器尊重显式 open_id/user_id/email
  路由;`larkInboundToA2UI` 正确解包真实事件信封;死模块 `segments-to-a2ui.ts` 与孤儿
  `connectors_bind_webhook_route` invoke 已移除。

---

## 参考

- 原始规格：`C:\Users\qwdma\.claude\plans\d-project-agentforge-astrbot-fluttering-cerf.md`
- 实现计划：`docs/superpowers/plans/2026-05-05-platform-connectors.md`
- 关键文件：`lib/connectors/`、`types/connectors/`、`src-tauri/src/connectors/`、
  `components/settings/connections/`、`components/inbox/`、`app/inbox/`
