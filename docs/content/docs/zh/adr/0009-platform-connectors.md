---
title: "0009 — 平台连接器"
description: "cognia-next 拥有多平台消息适配器层AI字符可以接收来自 Telegram、Discord、Slack、Lark 和 OneBot 的入站消息，并通过强大的FIFO出站队列发送回复。"
---

# ADR 0009 — 平台连接器

**状态：** 已接受 **日期：** 2026-05-05 **分支：** `feat/platform-connectors-phase1`

---

## 背景

Cognia-Next拥有成熟的AI聊天引擎、丰富的character/skill系统，以及能够模拟个人写作风格的员工数字孪生。在此ADR之前，这些机制都无法与真实的消息平台交互——用户只能手动复制粘贴内容。

Platform Connectors 的目标是让 cognia-next AI 角色在 Telegram、Discord、Slack、Lark（Feishu）和 QQ/NapCat（OneBot v11）上成为_actual bot_，支持：

- 三种操作模式：**自动**（AI回复而不审阅）、**手动**（人工输入回复文本）、**草稿**（AI生成草稿，人工审核后发送）。
- 一个可靠的出站队列，配备指数回撤、每个适配器的断路器、速率限制器、幂等性重叠以及FIFO每次对话的排序。
- 为每个入站和出站事件做一个简单的审计日志。
- 一个插件扩展API可以添加第三方平台而无需修补 cognia-next。

---

## 决策

### 架构概述

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

### 数据库模式（v18）

v18 新增了八个`lib/db/schema.ts` Dexie表：

| 表格 | 说明 | 目的 |
| ----------------------- | ---- | ------------------------------------------------- |
| `adapterInstances` | `id` | 每个配置好的机器人（Telegram、Discord等）只有一行 |
| `platformIdentities` | `id` | 每个观察到的平台用户一行 |
| `inboundLedger` | `id` | 去压账本（10k上限） |
| `outboundQueue` | `id` | 出境配送任务 |
| `conversationOverrides` | `id` | 每次对话mode/character覆盖 |
| `connectorAudit` | `id` | 封顶审计日志（5,000行） |
| `connectorDrafts` | `id` | 待审稿，等待人工审核 |
| `connectorAttachments` | `id` | 缓存平台附件 |

### 五个内置平台适配器

每个适配器遵循相同的分解：`parse.ts` / `serialize.ts` / 传输 / `capability.ts` / `sigverify.ts` / `index.ts`。

| 纲领 | 传输 | 签名验证 |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| 电报 | 长轮询（`getUpdates`）或网钩 | X-Telegram-Bot-Api-Secret-Token（HMAC-SHA256） |
| Discord | Gateway WS（v10） | Ed25519（X-Signature-Ed25519） |
| 松弛 | webhook API事件 | HMAC-SHA256（X-Slack-Signature v0） |
| Lark / 非书 | 长连接WS（protobuf，**默认**）或事件回调webhook | 长连接：app_id/app_secret WS握手。Webhook：验证令牌（`header.token`）+ 可选AES-256-CBC体解密（模式2.0） |
| OneBot v11 | Reverse-WS（设备连接） | 持有人令牌（可选） |

### 出站跑者保证

- **每个适配器断路器** — 在10次事件窗口内，故障率达到50%后跳闸;冷却30秒后重新开启。
- **每个适配器的令牌桶** — 容量20,5 tokens/s补充。
- **指数级退缩** — `min(60 000, 1 000 × 2^attempts) + jitter(0–500 ms)`。
- **5次尝试时为死符** — 行转为`deadlettered`;不再重试。
- **幂零LRU** — 1,000条缓存短路平台重送。
- **每段对话FIFO** — `Map<conversationKey, Promise<void>>`通道确保点餐。
- **安静时间 + 全局静音** — 可选的 `quietHours` 窗口和每个适配器实例的 `muted` 标志可以延迟外发作业，但不计入失败。

### 模式路由

三种模式由三层策略栈管理：`adapter default → per-conversation override → event-level override`。

| 模式 | 行为 |
| -------- | ----------------------------------------------------------------------------- |
| `auto` | 公交呼叫`sendPrompt`通过`runConnectorDigestTurn`;最后AI文本被排队为出站。 |
| `manual` | 用户输入回复，Composer;`enqueueOutbound`直接拨打。 |
| `draft` | AI生成`ConnectorDraft`;用户通过收件箱UI批准或拒绝。 |

### 收件箱UI

`app/inbox/` 渲染一个收件箱壳（`InboxShell`），带有侧边栏（`InboxSidebar`），列出所有平台绑定的`ChatSession`行，以及一个包含 `ConversationHeader` / `MessageList` / `DraftBanner` 的详细信息面板。`/inbox/[conversationKey]`路由是一个仅客户端的静态页面，兼容 `output: "export"`。

### 设定UI

`components/settings/connections/connections-section.tsx` — 设置中的标签壳，`?section=connections`。标签页：概览 / 适配器 / 对话 / 收件箱 / 外包 / 审计。每个标签页都是`./tabs/`下的独立组件。

### 插件扩展API（任务110）

`PluginManifest.connectors[]`（添加到`types/plugin/plugin.ts`中）允许插件声明适配器工厂。`lib/plugin/bridge/connectors-bridge.ts`桥在启用插件时发现并注册它们，启用插件时`ConnectorBus`会取消注册。

### 网页模式降级（任务111）

适配器需要Tauri桌面运行时。网页模式：

- `ConnectionsSection`会显示一个顶部横幅，解释了这个限制。
- `ConversationHeader`模式切换器被包裹在`pointer-events-none`的禁用区间内。
- Composer的发送按钮在平台会话中被禁用。

### 通过调度器主动出站（任务108）

两条新`SchedulerEventType`条目：

- `connection:outbound:send` — 直接排队出站作业（无AI）。
- `connection:scheduled:digest` — 调用`runConnectorDigestTurn`，驱动`sendPrompt`并排入助理回复。

两者都通过`lib/connectors/scheduled-outbound.ts`注册为`TaskExecutor`。

---

## 实现结果（与原始规范的差异）

| 相位 | 原始规格 | 实现情况 |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| 数据库模式版本 | 第16卷 | V18（V16 增加了 canvas，v17 外部桥接器，v18 连接器） |
| ADR号 | 0008 | 0009（0008 由外部桥接） |
| 阿克苏姆版本 | 0.7 | 0.8（实现时的最新稳定版） |
| AI以自动模式运行 | 全`sendPrompt` | 通过`runConnectorDigestTurn`实现;输出作为出站队列 |
| `segmentsToPlainText`分离符 | 未说明 | `" "`（跨text/markdown段的单一行格连接） |
| Tauri Rust HTTP代理 | 阿克苏姆 | Cognia-Next `connectors_http_request` Tauri 命令 |
| 初始E2E范围 | 全auto/manual/draft | 最初采用自动+手动烟雾;后期完成了牵引和real-AI路径运行时 门禁 |

---

## 后果

**阳性**

- Cognia-Next AI 角色会在五大平台上成为真正的机器人。
- 出站队列经过实战验证（断路器、速率限制、退后、死信）。
- 插件API支持社区连接器而无需分叉。
- 网页用户则能获得清晰的降级路径，而非无声的失败。

**当前关闭状态**

- `auto`模式AI环路和`connection:scheduled:digest`路径现在在`lib/connectors/scheduled-outbound.ts`中共享`runConnectorDigestTurn`。
- 附件缓存现在TS调度器`lib/connectors/attachment-fetcher.ts`，Rust cache/fetch实现`src-tauri/src/connectors/attachments.rs`。
- Slack/Lark OAuth代码交换通过`lib/connectors/oauth-registry.ts`和平台特定 OAuth 处理器部署仍需有效的重定向URL。

---

## V38 — IM完工轨道（2026-05-18，见 ADR-0025）

Schema 在 v18 → v38 之间增加了三个内容：

- `inboundLedger.namespace`（默认`"inbound"`），使相同的去重机制用于连接器回调;回填升级hook每个遗留行标签。
- 新的`connectorCallbackBindings`表——由每个平台的 A2UI 映射器在出站时编写，`ConnectorBus.dispatchConnectorCallback` 读取以恢复线路动作 ID 的 `(surfaceId, componentId, conversationKey)`。
- `adapterInstances.lastKnownCapabilities` — 每个适配器注册点的缓存`A2UICapabilityMatrix`由`ConnectorBusProvider`刷新。

第二阶段关闭：

- `runConnectorDigestTurn`驱动整个`resolveSendOptions → safeSendPrompt → assistantReplyToSegments → enqueueOutbound`管道。PII门控在每IM-driven回合前通过`lib/connectors/ai-loop/safe-send-prompt.ts`运行。
- A2UI 接口原生地投影到 Slack Block Kit / Lark Interactive Card / Telegram InlineKeyboardMarkup / Discord Embed + Components / OneBot 文字和图像中。每个平台的覆盖范围都在 ADR-0025 的能力表中。
- 入站回调（`block_actions` / `INTERACTION_CREATE` / `callback_query` / `im.interactive_message.action_triggered_v1`）会在`ConnectorBus.dispatchConnectorCallback` → `builtin:a2ui-bridge` MCP服务器（新的`a2ui_handle_connector_action`工具）→AI-loop轮流。
- 默认情况下，计算机使用IM会话被列入黑名单;选择加入权限仍存在于`ConversationOverrideRow.allowComputerUse`。

### V39（2026-05-20）——`im-gleaming-quail` Completeness Pass（完全性通行证）

对IM连接器的端到端审计接口产生了十五项混凝土改进。所有这些都被寄送到同一个`~/.claude/plans/im-gleaming-quail.md`的平面文件后面。

**修复漏洞（链环）:**

- **Telegram `webhookSecret`持久性** — `credentialsRef.accounts`现在同时声明`botToken`和`webhookSecret`;现有行在编辑时自动迁移，因此秘密在重启后依然存在并抵达Tauri验证器。（`components/settings/connections/forms/telegram-config.tsx`）
- **Lark TAT 401 自动刷新** — 新`lib/connectors/adapters/lark/auth-retry.ts`导出`LarkApiError`、`isLarkTatInvalidation`和`withTatRefresh`。封装`doRequest`、`send`和`edit`（用于上传预通过）意味着适配器能在一次重试中恢复服务器端TAT撤销，而无需等待长达两小时等待自然的TTL。
- **回调绑定TTL** — `recordCallbackBinding`现在默认`expiresAt = createdAt + 30 d`。新`lib/connectors/callback-binding-cleanup.ts`每天在`ConnectorBusProvider`启动时运行;它会获得明确的过期
  - pre-default-TTL行超过60天宽限期。无需模式提升——`expiresAt`列已经存在。

**诊断/可观测性：**

- **心跳携带运行时快照**——`CircuitBreaker.snapshot()`和`TokenBucket.snapshot()`是新的纯读访问者;`outbound-runner.ts`通过新的模块级`getAdapterRuntimeStateSnapshot(adapterId)`发布每个适配器的状态映射。心跳审计行的`fields`块现在包含`breakerState`、`breakerOpenedAt`、`breakerFailureRate`、`breakerEventCount`、`rateAvailable`、`rateCapacity`、`rateRefillPerSec`、`rateNextRefillAt`。
- **出站行徽章** — 新`lib/connectors/derive-job-badge.ts`纯助手。`outbound-tab.tsx`实时查询`outboundQueue` + `adapterInstances` + 最新心跳，因此每行待处理的行都带有衍生叠加层：`paused-muted`，`paused-quiet-hours`（带ETA）、`circuit-blocked`。使用跑者使用的相同`isInQuietHours`/`msUntilQuietEnd`助手，因此UI和运行时始终一致。
- **审计对话键过滤+导出**——`audit-tab.tsx`在 `conversationKey` 上增加了子字符串过滤器，并新增了导出菜单（CSV / JSON），并由新的纯`lib/connectors/audit-export.ts`支持。文件命名为`cognia-audit-<scope>-<YYYYMMDDHHmm>.{csv,json}`，并通过标准的 `URL.createObjectURL`+锚点模式进行流式处理。
- **健康详情面板运行时卡** — 接口断路器小板（闭/半开/开，时间戳为开启）和带下一次加注ETA的速率桶表。`useAdapterHealth` hook现在显示了`breaker`和`rateBucket`从最新心跳行生成的打字快照。
- **收件箱头适配器降级徽章 + 重新连接** — 当适配器状态为`degraded` / `down` / `unknown`时，amber/red徽章。点击后打开带有重新连接按钮的弹出覆盖，驱动现有`requeueAdapter`生命周期hook。重用`useAdapterHealth`，因此不会新增实时查询管道。

**验证+UX完成：**

- **发送测试消息** — 新`SendTestMessageSection`安装在适配器→配置详情标签页中，驱动一个真实`getBus().sendOutbound`通过总线的整个流水线（任何平台）。与现有`AdapterWhoamiPanel`（探针腿）配对，使每个平台同时拥有“凭证有效？”和“端到端可行？”的条件。
- **安静时段自定义时区+响应式网格**——12区下拉菜单现在提供了一个`Custom…`选项，可以切换为自由IANA输入并`Intl.DateTimeFormat`验证。在窄屏（`grid-cols-1 sm:grid-cols-3`）中，网格布局降至一列。
- **ConversationsTab CU徽章**——接口 `ConversationOverrideRow.allowComputerUse === true`为小型徽章，方便操作员一眼识别电脑频道。
- **Discord `publicKey`第二阶段清理**——字段现在标记为`[Phase 2]`并带有内联通知;第一阶段不再写入密钥环值（避免幽灵凭证步枪），因为门户传输不消耗它。

**高级：**

- **出站死号批量重试** — 当过滤器设置为`deadlettered`且可见一行或多行时，芯片条中会出现“全部重试”按钮。在Dexie `bulkPut`中重复使用现有的单一任务重试语义。
- **入门禁统计**——新的纯汇总器`lib/connectors/at-gate-stats.ts:summariseAtGateBlocks`汇总现有`inbound.policy_blocked`审计行（无需新仪器）。健康详情接口“入站过滤器（24小时）：N被丢弃，原因：......”。通过`topN`选项将长尾数据折叠到`other`桶中。

**本分支未提及后续问题：**

- 今天的OneBot reverse-WS探测器通过`onebot-config.tsx`中现有的`handleVerify`流发射，该流程监听`connectors://onebot/<adapterId>/open` Tauri事件，并有10秒的超时。一个专门接口 `connectors_onebot_probe` Tauri 命令实时`ws_server.connected_clients()`表是明确的下一步——计划中列为任务3.2的Rust段。

---

## 修订版 — 2026-07（Lark链接完整性检查）

连接链审计发现了几个Lark/pipeline间隙，这些漏洞是建成但未接线的。这次处理会封闭它们（TypeScript-only——没有Rust变化;Rust附件缓存和OAuth补全 处理器 已经存在）：

- **进入富媒体摄取（关闭“第二阶段附件缓存”标记）。** `lib/connectors/adapters/lark/inbound-media.ts:enrichLarkInboundMedia`作为适配器`dispatchEnvelope`的第二遍运行，通过现有加密缓存（`connectors_attachment_fetch` / `connectors_attachment_read`）下载image/file字节，附加内联`dataBase64`（被已有有线的OCR+模型视野路径消耗），文档文件则通过`processDocumentAsync`提取文本。`parse.ts:buildSegments`现在把`post` / `file` / `audio` / `media` 投影成类型段，而不是`[type]`存根。
- **以用户身份发送（关闭“OAuth部分”标记）。** `auth.ts:getUserAccessToken` / `refreshUserToken` resolve + OAuth 处理器持续存在时静默刷新`user_token`;`index.ts:doRequest`（选择加入`settings.sendAsUser`）配合 refresh-on-401 并优雅地退回机器人身份。`lark-config.tsx`会获得一个“以我身份发送”的部分，带有一个OAuth**连接账户**按钮（打开授权URL;深度链接路由器完成）+ 选择加入开关。
- **流水线修复：** `cooldown-after-bot-reply`拦截器现在实际上被输入（`ConnectorBus.recordBotReply`，从出站跑道`onDelivered`有线——默认群聊反垃圾邮件冷却从未触发）;team/workflow IM调度现在通过与单字符路径相同的失败闭合PII 门禁（`runtime.ts`，关闭确认的红线绕过）;异步出站串行器尊重显式open_id/user_id/email路由;`larkInboundToA2UI`展开真实事件包络;而死`segments-to-a2ui.ts`模块+孤儿`connectors_bind_webhook_route`召唤者则被移除。

---

## 修订版 — 2026-08-06（治理与有界运行时）

本次在保留 `PlatformAdapter` 与 `getBus()` 兼容门面的前提下，收紧连接器的发送和生命周期边界：

- **受治理发送：** AI、Workflow、Skill、Plugin、人工发送、草稿批准、Remote Control、Inbox
  与通知发送统一进入 `ConnectorDeliveryGateway.enqueue()`，批量扇出使用事务化的
  `enqueueMany()`。自动化来源通过深层 PII gate fail-closed；人工审阅来源保持原语义并记录
  provenance。直接 adapter send 仅用于明确标注的传输诊断。旧 Plugin `send` / `sendText`
  仅保留一个迁移周期，并写入 `delivery.legacy_direct` waiver audit。
- **单一生命周期所有者：** `ConnectorRuntimeSupervisor` 统一拥有内置和 Plugin transport。
  每个 adapter 使用串行 operation lane、generation fencing、全局 4 路启动 semaphore、真实的
  desired/observed snapshot，以及 stop 失败时的 fail-closed 行为。凭证轮换、人工重启、resume
  和 row fingerprint reconcile 全部进入同一条 lane。
- **有界队列调度：** Dexie schema v151 增加单调 `orderSeq`、
  `[conversationKey+orderSeq]`、`[status+claimedAt]` 与 inbound `[status+updatedAt]` 索引。
  Runner 每批最多读取 128 条 due job，最多执行 16 个平台发送，每个会话只保留 head job，并在
  空闲时回收 lane。`enqueueMany()` 在单个 Dexie 事务中分配稳定序列区间，且只唤醒一次 runner。
- **保留与健康状态：** terminal inbound payload 立即压缩；成功、仅历史与已忽略 job 保留 7 天，
  failed 与 recovery-required 保留 30 天。Audit 按 security 30 天、operational 14 天、diagnostic
  7 天分级保留；heartbeat pruning 移入 housekeeping；backlog 包含 pending、failed、sending。
  Settings Health 读取 supervisor generation/state 和全局 connector ExecutionBroker snapshot。
- **投递歧义契约：** Slack 调整为 `reconciliation_required`，Lark 保持
  `remote_idempotent`。Contract test 强制任何声明远端幂等的 adapter serializer 必须实际传递稳定
  idempotency key。

---

## 修订版 — 2026-08-13（共享连接器能力启用）

本次仅将既有连接器能力安全接入现有入口，不新增 Adapter 或传输栈：

- Runtime build 只有在两个能力探测都成功后，才通过一次更新同时持久化
  `lastKnownCapabilities` 与 `lastKnownSkillCapabilities`。缺少 skill probe 表示权威空列表；
  probe 抛错时保留两份旧缓存并使 build 失败。
- `defaultMode` 统一由共享 Adapter detail editor 编辑；各平台表单仍只负责平台专属配置。
- Dexie v161 将 QQ Official 旧的 `settings.transport` 归一化到
  `AdapterInstanceRow.transportMode` 并移除旧字段。Runtime 构建、入站服务器注册、重建指纹以及
  Gateway/Webhook 选择器都只读取这一字段。
- Connections 在 `?connectionsTab=tunnel` 挂载既有 Tunnel 页面。QQ Official 使用
  `/webhook/qq-official/:adapterId`，连接器配置链接统一跳转到该页签。Tauri 保留 start/stop；
  配对的 Web/mobile 仅以只读方式投影主机 `companion_endpoints`。
- `/status` 对当前字面 `/status` 事件复用 `matchDispatchRule` 与
  `resolveImEffectiveConfig`，展示命中的规则、实际路由、回复 Adapter 与模型归属，并按优先级列出
  启用规则，同时明确说明后续消息会独立重新匹配。

## 修订版 — 2026-08-13（Matrix E2EE 完整接入）

Matrix 现在把既有 matrix-sdk-crypto machine 作为强制传输边界：

- 详细 `whoami` 必须同时返回 `user_id` 和 `device_id`。缺少设备身份时 Adapter 进入降级状态，
  不启动 sync，也不发送明文。`connectors_matrix_crypto_close` 只移除进程内 machine，因此 awaited
  stop 或设备轮换可以重新打开保留的磁盘 store。
- 单个可中止 request pump 串行处理 key upload/query/claim 与 to-device 流量；只有验证 Matrix HTTP
  响应后才标记请求已发送，并遵循 `retry_after_ms`。Sync state 先于 timeline 应用；重启、入群和 gap
  通过 `/joined_members` 对齐权威 joined 成员集合。无法确定房间加密状态时 fail-closed。
- 消息、编辑、reaction 与媒体统一通过 room-event 加密边界；redaction 和 typing 保留协议规定的路径。
  加密 `file` 与 `thumbnail_file` 对象复用既有有界 uploader、downloader 和加密附件缓存。
- Dexie v162 增加仅本地的 `matrixPendingEncryptedEvents` 恢复队列。无法解密的事件会在推进
  `next_batch` 前持久化，按 Adapter/event id 去重，并在 key 变化、pump 完成、重启和有界 backoff
  后重试；连续失败后保留为 `recovery_required`。活跃行达到 10,000 时暂停 cursor，使 homeserver
  重放该批次而不是丢失事件。

## 参考文献

- 原始规格：`C:\Users\qwdma\.claude\plans\d-project-agentforge-astrbot-fluttering-cerf.md`
- 实施计划：`docs/superpowers/plans/2026-05-05-platform-connectors.md`
- 关键文件：`lib/connectors/`、`types/connectors/`、`src-tauri/src/connectors/`、`components/settings/connections/`、`components/inbox/`、`app/inbox/`

## 修订 — 2026-08-18（ADR-0131 跨壳收件箱中继）

投递不再是桌面端的私事。

- **`connector_send` 不是投递命令。** 它的宿主 arm 只追加一条本地 `user` 消息就返回，名字属于历史遗留。真正入队出站作业的是 **`connector_enqueue_outbound`**（ADR-0131 §5）。两者各自保留 manifest 条目，旧客户端继续可用。
- **人工回复、草稿审批与拒绝只有一份实现。** 原语位于 `lib/connectors/inbox-writes/local.ts`；桌面 UI 与宿主 RPC arm 调用同一批函数，因此手机发起的回复产生逐字节相同的 `outboundQueue` + `messages` 行。
- **投递歧义由客户端铸造的唯一幂等 key 关闭。** 该 key 同时出现在队列行、`Idempotency-Key` 头与 `OutboundRequest.metadata.idempotencyKey` 上。结合上文已记录的各 adapter 幂等（Lark / Matrix `remote_idempotent`、Discord nonce、QQ `msg_seq`），任一层的重试都收敛到同一条平台消息。
- **`outboundQueue` 现在还保存镜像行**（`syncedFromHost: true`），同步给薄客户端用于状态展示。`listDueNow` / `pickNextDue` / `recoverStaleSendingJobs` 会过滤掉它们——本地 runner 绝不能派发镜像。
