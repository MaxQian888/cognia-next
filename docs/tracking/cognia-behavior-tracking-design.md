# Cognia 行为埋点设计文档

## 1. 当前契约

- 权威事件清单：`lib/telemetry/events/catalog.ts`，截至 2026-08-22 共 40 个 typed events，均有生产上报点。
- 统一入口：`trackEvent(name, attributes)`。
- 本地目的地：Dexie `behaviorEvents`，受保留天数与最大条数限制。
- 远程目的地：通用 OTLP Logs、PostHog managed、PostHog BYO；三者可独立启用并双发/多发。
- PostHog 产品事件直接调用 `{host}/batch/`；不加载浏览器 SDK。仅在总授权和有效目的地同时存在时入队。
- 本文描述代码事实，不是 Tea/ByteIO 导入规范；仓库未接入 Tea/ByteIO SDK。

## 2. 发送闸门

事件必须依次通过以下闸门：

1. `BehaviorTelemetrySettings.enabled` 总开关，默认关闭；
2. Chat、Workflow、Connector、Agent Team、App、System 分类授权；
3. 统一采样率；
4. 最多 32 个标量属性，键名、长度和有限数值校验；
5. 共享 PII 检查；
6. 按目的地授权。通用 OTLP 仍受 `destinations.remote` 控制；PostHog product scope 不能绕过总开关。

关闭总授权或某个 PostHog product 目的地时会立即清空尚未发送的内存批次，不会在撤回授权后补发。
Web Product 请求会通过 `AbortSignal` 取消；Tauri Product 请求携带 opaque request ID，撤回授权时 renderer
调用具名 cancel command，Rust 会 abort 对应的 native reqwest task，并阻止后续重试或递归子批次。
若网络请求已经到达服务端则仍无法撤回。
headless 正常关闭时会等待队列排空；renderer 在 `pagehide` 时 best-effort flush，Web fetch 使用 `keepalive`，
但 abrupt desktop/window exit 无法同步等待 renderer IPC。managed 与 BYO 相互独立。

## 3. 远程隐私白名单

允许：事件名、schema version、category、runtime、app version、model/provider、token usage、
latency、cost、tool 名称、成功/失败状态，以及 installation/session/trace/span 等 opaque ID。

禁止：prompt、completion、system prompt、消息内容、tool schema/arguments/results、文件内容或路径、
URL/referrer、异常 message/stack/body、账号、邮箱和硬件标识。

PostHog 产品事件使用 Product 专属的随机 installation ID 作为 pseudonymous `distinct_id`，并设置
`$process_person_profile: false`。该 ID 与 AI observability 的 installation ID 分开持久化，避免同一
PostHog project 中 identified AI span 把 personless Product ID 升格为 person。AI span 为了让
renderer/sidecar 落到同一个 pseudonymous installation，会携带 AI 专属的 `posthog.distinct_id`，
因此属于 identified pseudonymous telemetry，而不是 personless event。
预置的 Product ID 若包含 PII 或与 AI ID 相同会被拒绝/轮换；最终 `/batch/` JSON 在发送前还会
整体通过一次共享 PII gate。
两条路径都不发送账号、邮箱或硬件标识。BYO 只接受公开 project ingestion token，不接受 Personal API
Key，设置界面始终以 password input 掩码。`$geoip_disable` 关闭产品事件的 GeoIP enrichment；源 IP 是否丢弃
仍由 PostHog 项目的 “discard client IP” 设置决定，BYO 项目由其 operator 负责。

## 4. 当前事件 catalog（40）

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

### App（6）

`app.launched`、`app.screen.viewed`、`app.command.executed`、`app.search.opened`、
`app.search.activated`、`app.plugin.installed`。

### System、execution 与 support（7）

`telemetry.preference.changed`、`telemetry.posthog.test`、`agent.execution.resolved`、
`support.session.opened`、`support.diagnostics.consent.changed`、
`support.feedback.draft.opened`、`support.feedback.draft.exported`。

`telemetry.posthog.test` 只能在行为遥测、System 分类和至少一个合格远程目的地均启用并保存后发送。

## 5. 多目的地模型

`track-event.ts` 先生成一次 `BehaviorEventEnvelope { name, category, at, attributes }`，再 fan-out：

- OTLP exporter 把 envelope 转成 OTLP Logs JSON；
- managed/BYO 各自拥有具名 direct-HTTP exporter、独立内存 batch、有限重试与撤回授权清理；
- Product `/batch/` 在发送前按序列化 UTF-8 大小执行 19 MiB 上限；超限的多事件 batch 会递归分包，服务端返回 `413` 时也会保留原 UUID 递归缩小重发，单事件仍超限则记录为 transport drop；
- 单个目的地失败不会阻断本地写入或其他目的地；结果使用 `Promise.allSettled` 汇总。
- Product exporter 的 queue、retry、drop 与最后错误会并入 Logs Overview 的 transport health。

AI observability 不使用本行为事件管道，也不会因 product analytics 开启而自动启用。它通过 renderer
agent-trace OTLP 转换或 sidecar AI SDK 7 OTel processor 发往独立的 `/i/v0/ai/otel` endpoint。
renderer 会在 4 MB 序列化请求上限内递归分包，只重试 OTLP 允许的状态码并遵循 `Retry-After`；
正常关闭等待在途批次，撤回同意会取消在途 renderer 请求。

## 6. 配置与验证证据

- 事件类型与分类：`lib/telemetry/events/catalog.ts`。
- consent、采样与本地限制：`lib/telemetry/events/settings.ts`。
- envelope、PII 和 fan-out：`lib/telemetry/events/track-event.ts`。
- PostHog direct-HTTP 隐私投影、重试、排空与撤回清理：`lib/telemetry/posthog-product.ts`。
- 目的地解析及 runtime 安装：`lib/logging/bootstrap.ts`。
- Settings UI：`components/settings/logs/panels/telemetry-panel.tsx`（草稿状态在 `hooks/logging/use-log-settings-draft.ts`）。
- 本地存储/导出：`lib/db/behavior-events.ts`。
- 契约测试：上述模块的 co-located tests，以及 `sidecar/telemetry.test.mjs` 和
  `src-tauri/src/telemetry.rs` 单元测试。

`docs/tracking/cognia-behavior-byteio-import.csv` 仍是历史草稿，不应直接导入；任何 ByteIO 接入都必须
重新生成 schema、确认 app/subAppId/负责人/数据治理，并解决点分事件名和 boolean 类型兼容性。
