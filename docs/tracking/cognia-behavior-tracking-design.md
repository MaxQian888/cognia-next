# Cognia 行为埋点设计文档

## 1. 当前契约

- 权威事件清单：`lib/telemetry/events/catalog.ts`，截至 2026-08-19 共 35 个 typed events。
- 统一入口：`trackEvent(name, attributes)`。
- 本地目的地：Dexie `behaviorEvents`，受保留天数与最大条数限制。
- 远程目的地：通用 OTLP Logs、PostHog managed、PostHog BYO；三者可独立启用并双发/多发。
- PostHog 使用 `posthog-js@1.418.1`；仅在总授权和有效目的地同时存在时动态加载。
- 本文描述代码事实，不是 Tea/ByteIO 导入规范；仓库未接入 Tea/ByteIO SDK。

## 2. 发送闸门

事件必须依次通过以下闸门：

1. `BehaviorTelemetrySettings.enabled` 总开关，默认关闭；
2. Chat、Workflow、Connector、Agent Team、System 分类授权；
3. 统一采样率；
4. 最多 32 个标量属性，键名、长度和有限数值校验；
5. 共享 PII 检查；
6. 按目的地授权。通用 OTLP 仍受 `destinations.remote` 控制；PostHog product scope 不能绕过总开关。

关闭某个 PostHog product 目的地时会立即 opt out，并清空该具名 SDK 实例尚未发送的内存批次，
不会在撤回授权后补发。managed 与 BYO 相互独立。

## 3. 远程隐私白名单

允许：事件名、schema version、category、runtime、app version、model/provider、token usage、
latency、cost、tool 名称、成功/失败状态，以及 installation/session/trace/span 等 opaque ID。

禁止：prompt、completion、system prompt、消息内容、tool schema/arguments/results、文件内容或路径、
URL/referrer、异常 message/stack/body、账号、邮箱和硬件标识。

PostHog 只使用随机 installation ID 作为 pseudonymous `distinct_id`。SDK 配置永久关闭
autocapture、pageview/pageleave、session replay、surveys、feature flags、person profiles 与自动异常采集；
`before_send` 会再次执行属性白名单。BYO 只接受公开 project ingestion token，不接受 Personal API Key，
设置界面始终以 password input 掩码。

## 4. 当前事件 catalog（35）

### Chat 与 conversation list（12）

`chat.message.sent`、`chat.turn.completed`、`chat.turn.failed`、`chat.list.opened`、
`chat.list.created`、`chat.list.searched`、`chat.list.reordered`、`chat.list.row.action`、
`chat.list.layout.changed`、`chat.list.view.changed`、`chat.list.section.toggled`、`chat.list.filtered`。

搜索事件只发送 query length/result count，不发送 query；layout/filter 只发送稳定枚举、计数与布尔值。

### Voice（6）

`voice.connection.ready`、`voice.first-audio`、`voice.interrupted`、`voice.reconnect`、
`voice.tool.completed`、`voice.error`。

### Workflow（4）

`workflow.run.started`、`workflow.run.completed`、`workflow.run.failed`、
`workflow.run.cancelled`。

### Connector（2）

`connector.message.received`、`connector.message.sent`。

### Agent Team（3）

`agent.teammate.started`、`agent.teammate.completed`、`agent.teammate.failed`。

### System、execution 与 support（8）

`telemetry.preference.changed`、`telemetry.posthog.test`、`agent.execution.resolved`、
`agent.execution.shadow`、`support.session.opened`、`support.diagnostics.consent.changed`、
`support.feedback.draft.opened`、`support.feedback.draft.exported`。

`telemetry.posthog.test` 只能在行为遥测、System 分类和至少一个合格远程目的地均启用并保存后发送。

## 5. 多目的地模型

`track-event.ts` 先生成一次 `BehaviorEventEnvelope { name, category, at, attributes }`，再 fan-out：

- OTLP exporter 把 envelope 转成 OTLP Logs JSON；
- managed/BYO 各自拥有具名 PostHog 实例、独立 SDK batch/retry queue 与撤回授权清理；
- 单个目的地失败不会阻断本地写入或其他目的地；结果使用 `Promise.allSettled` 汇总。

AI observability 不使用本行为事件管道，也不会因 product analytics 开启而自动启用。它通过 renderer
agent-trace OTLP 转换或 sidecar AI SDK 7 OTel processor 发往独立的 `/i/v0/ai/otel` endpoint。

## 6. 配置与验证证据

- 事件类型与分类：`lib/telemetry/events/catalog.ts`。
- consent、采样与本地限制：`lib/telemetry/events/settings.ts`。
- envelope、PII 和 fan-out：`lib/telemetry/events/track-event.ts`。
- PostHog SDK 隐私配置与撤回清理：`lib/telemetry/posthog-product.ts`。
- 目的地解析及 runtime 安装：`lib/logging/bootstrap.ts`。
- Settings UI：`components/logging/log-settings.tsx`。
- 本地存储/导出：`lib/db/behavior-events.ts`。
- 契约测试：上述模块的 co-located tests，以及 `sidecar/telemetry.test.mjs` 和
  `src-tauri/src/telemetry.rs` 单元测试。

`docs/tracking/cognia-behavior-byteio-import.csv` 仍是历史草稿，不应直接导入；任何 ByteIO 接入都必须
重新生成 schema、确认 app/subAppId/负责人/数据治理，并解决点分事件名和 boolean 类型兼容性。
