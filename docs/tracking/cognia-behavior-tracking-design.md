# Cognia 行为埋点设计文档

## 1. 基本信息

- 扫描范围：`lib/telemetry/events/`、`hooks/chat/`、`lib/workflow/`、`lib/connectors/`、`lib/ai/agent/`、`lib/headless/`、`components/logging/`
- package root：`/Users/bytedance/Project/cognia-next`
- SDK / 传输：OpenTelemetry OTLP/HTTP Logs；本仓未安装 Tea/ByteIO SDK
- Tea App：无；若后续接入 ByteIO，需补充 app/subAppId、环境和负责人
- 生成日期：2026-07-22
- 扫描文件：Tea 扫描器 531 个文件；人工复核生命周期收口、设置、传输、headless bootstrap 及相关测试
- 事件统计：物理 event 13；逻辑场景 13；已上报 13；仅声明 0
- 产物状态：**草稿，不可直接导入 ByteIO**。阻断项见 §8。

## 2. 事件模型

本项目采用直接事件模式：每次 `trackEvent(name, attributes)` 的 `name` 同时作为 OTel LogRecord 的 `body` 和 `event.name`，不存在“单物理 event + discriminator”。事件经以下闸门后，按设置分别写入本地 Dexie 和远程 OTLP Logs：

1. 总开关默认关闭；
2. 按 Chat、Workflow、Connector、Agent Team、System 分类授权；
3. 统一采样率；
4. 运行时仅接受最多 32 个标量属性，拒绝非有限数值、对象、数组、超长值和非法键名；
5. 通过共享 PII 检查；
6. 本地/远程目标独立启用；本地数据受保留天数和最大条数限制。

设置同时写入 renderer localStorage 和 canonical `AppSettings.behaviorTelemetry`。根级 `SettingsHydrator` 持续把同步后的 canonical 策略安装到 renderer runtime；Brain 则在 Workflow、Connector 和 Agent Team producer 之前加载策略，并通过 Dexie `liveQuery` 热更新。因此同一套分类、采样和本地保留策略可用于 renderer 与 headless 生命周期。Renderer 复用 Logging 中的 OTLP Logs 目标；Brain 使用标准 `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`（或 `OTEL_EXPORTER_OTLP_ENDPOINT`）和 `OTEL_EXPORTER_OTLP_LOGS_HEADERS`（或 `OTEL_EXPORTER_OTLP_HEADERS`）环境变量配置远程目标，未配置 endpoint 时会记录一次告警且不发送网络请求。

公共 OTel Resource 属性：`service.name=cognia-ai`。不会上报消息内容、提示词、响应内容、错误消息或密钥。

## 3. 已上报事件总览

| 序号 | 物理 event                     | 中文名称       | 类型 | 触发时机                                             | 端/模块                     | 参数                                                     | 上报证据                                               |
| ---: | ------------------------------ | -------------- | ---- | ---------------------------------------------------- | --------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
|    1 | `chat.message.sent`            | 聊天消息提交   | 行为 | 用户消息通过阻断检查并进入执行态                     | Renderer / Chat             | `sessionId, provider, surface`                           | `hooks/chat/use-claude-chat.ts:1149`                   |
|    2 | `chat.turn.completed`          | 聊天回合成功   | 结果 | SDK、外部 Agent 或无结果的正常结束首次落定           | Renderer / Chat             | `sessionId, provider, surface, durationMs?`              | `hooks/chat/use-claude-chat.ts:1387,2280,2701`         |
|    3 | `chat.turn.failed`             | 聊天回合失败   | 结果 | 外部 Agent、发送前、sidecar 退出或永久 provider 错误 | Renderer / Chat             | `sessionId, provider?, surface, errorType?, durationMs?` | `hooks/chat/use-claude-chat.ts:1284,1522,2169,2262`    |
|    4 | `workflow.run.started`         | 工作流开始     | 行为 | durable run logger 写入 `run_started` 时             | Renderer / Workflow         | `runId, trigger`                                         | `lib/workflow/runtime/event-log.ts:203`                |
|    5 | `workflow.run.completed`       | 工作流成功     | 结果 | durable run logger 写入 `run_completed` 时           | Renderer / Workflow         | `runId, durationMs?`                                     | `lib/workflow/runtime/event-log.ts:207`                |
|    6 | `workflow.run.failed`          | 工作流失败     | 结果 | durable run logger 写入 `run_failed` 时              | Renderer / Workflow         | `runId, durationMs?, errorCode?`                         | `lib/workflow/runtime/event-log.ts:211`                |
|    7 | `workflow.run.cancelled`       | 工作流取消     | 结果 | live abort、跨 executor cancel signal 或 soft cancel | Renderer/Brain / Workflow   | `runId, durationMs?`                                     | `lib/workflow/runtime/cancel-run.ts:38,52,58`          |
|    8 | `connector.message.received`   | 连接器收到消息 | 行为 | inbound 去重成功后、进入路由前                       | Renderer / Connector        | `adapterId, platform`                                    | `lib/connectors/bus.ts:367`                            |
|    9 | `connector.message.sent`       | 连接器发送结果 | 结果 | 直接发送及 queued outbound 的成功、失败、缺失和异常  | Renderer/Brain / Connector  | `adapterId, platform, outcome, errorCode?`               | `lib/connectors/outbound-runner.ts:970,1022,1058,1065` |
|   10 | `agent.teammate.started`       | 队友任务开始   | 行为 | 成功 claim 队友并发布 Agent 开始事件后               | Renderer/Brain / Agent Team | `runId, teamId, role`                                    | `lib/ai/agent/team/dispatch-teammate.ts:417`           |
|   11 | `agent.teammate.completed`     | 队友任务成功   | 结果 | 队友结果校验、记账和释放成功时                       | Renderer/Brain / Agent Team | `runId, teamId, channel, durationMs?`                    | `lib/ai/agent/team/dispatch-teammate.ts:443`           |
|   12 | `agent.teammate.failed`        | 队友任务失败   | 结果 | 执行异常或结果校验失败并释放队友时                   | Renderer/Brain / Agent Team | `runId, teamId, errorType, durationMs?`                  | `lib/ai/agent/team/dispatch-teammate.ts:450`           |
|   13 | `telemetry.preference.changed` | 遥测总开关变化 | 行为 | Logging、Data、Mobile 或 data reset 显式变更同意     | Renderer / Settings         | `enabled`                                                | `components/logging/log-settings.tsx:346,354`          |

## 4. 事件详情

### 4.1 `chat.message.sent`

- 状态：已上报；物理 event 与逻辑事件相同。
- 触发时机：仅用户实际提交的新消息；内部 fallback/静默 continuation 不重复计数。
- 参数：`sessionId:string`、`provider:string`、`surface:string`，均必传；`surface=chat`。

### 4.2 `chat.turn.completed`

- 状态：已上报。
- 触发时机：同一用户回合只在第一个成功终态上报；成功后清除内存中的开始时间，避免 SDK result 与 `session_ended` 双计数。
- 参数：`sessionId:string`、`provider:string`、`surface:string` 必传；`durationMs:number` 可选、为非负整数毫秒。

### 4.3 `chat.turn.failed`

- 状态：已上报。
- 触发时机：仅永久失败；发生 provider fallback 时保留原始回合并等待最终终态。
- 参数：`sessionId:string`、`surface:string` 必传；`provider:string`、`errorType:string`、`durationMs:number` 可选。只发送错误类/HTTP 状态类，不发送错误消息。

### 4.4–4.7 Workflow 生命周期

- 状态：4 个事件均已上报。
- 触发时机：开始、成功和失败复用 durable `createRunLogger` 收口；取消仅在共享 `cancelWorkflowRun` 入口覆盖 live abort、跨 executor signal 与 soft cancel，避免保留无生产调用的重复终态 API。
- 参数：`runId:string` 必传；开始事件的 `trigger:string` 必传；终态 `durationMs:number` 可选；失败的 `errorCode:string` 可选。错误消息不进入行为事件。

### 4.8–4.9 Connector 消息

- 状态：2 个事件均已上报。
- 触发时机：inbound 在去重后上报；outbound 同时覆盖 `ConnectorBus.sendOutbound` 的直接调用与生产环境 `startOutboundRunner` 队列收口，在成功、返回失败、adapter 缺失和异常路径上报。重试会按真实 wire attempt 计数。
- 参数：`adapterId:string`、`platform:string` 必传；发送结果的 `outcome:string` 必传（`succeeded|failed`），`errorCode:string` 可选。

### 4.10–4.12 Agent Team 队友生命周期

- 状态：3 个事件均已上报。
- 触发时机：仅成功 claim 后开始；所有经 `release` 的成功、执行异常和输出校验失败均有终态。
- 参数：开始事件含 `runId:string`、`teamId:string`、`role:string`；成功含 `channel:string`（`text|sidecar|external`）；失败含 `errorType:string`；终态可含 `durationMs:number`。

### 4.13 `telemetry.preference.changed`

- 状态：已上报。
- 触发时机：Logging Advanced、Data & Privacy、Mobile Preferences 和 data section reset 使用同一顺序：关闭时在撤销同意前尝试记录；开启时在保存同意后记录。
- 参数：`enabled:boolean` 必传。Boolean 不符合 ByteIO 参数类型，见 §8。

## 5. 参数字典

| 参数         | 统一含义                     | 代码类型      | ByteIO 类型 | 使用事件                 | 取值                                    |
| ------------ | ---------------------------- | ------------- | ----------- | ------------------------ | --------------------------------------- |
| `sessionId`  | Chat 会话标识                | string        | string      | Chat                     | opaque ID                               |
| `provider`   | 实际或预期 provider          | string        | string      | Chat                     | `anthropic/external/unknown/...`        |
| `surface`    | AI 执行表面                  | string enum   | string      | Chat                     | `chat`（类型还允许其他内部表面）        |
| `durationMs` | 生命周期耗时                 | finite number | integer     | Chat/Workflow/Agent Team | `>=0`                                   |
| `errorType`  | 不含正文的错误分类           | string        | string      | Chat/Agent Team          | Error name、`http_<status>`、稳定原因码 |
| `runId`      | Workflow/Agent Team 运行标识 | string        | string      | Workflow/Agent Team      | opaque ID                               |
| `trigger`    | Workflow 触发类型            | string        | string      | Workflow                 | `trigger.manual/...`                    |
| `errorCode`  | 稳定失败码                   | string        | string      | Workflow/Connector       | 稳定 code；可选                         |
| `adapterId`  | Connector 实例标识           | string        | string      | Connector                | opaque ID                               |
| `platform`   | Connector 平台               | string        | string      | Connector                | `telegram/lark/.../unknown`             |
| `outcome`    | 发送结果                     | string enum   | string      | Connector                | `succeeded/failed`                      |
| `teamId`     | Agent Team 标识              | string        | string      | Agent Team               | opaque ID                               |
| `role`       | 队友角色                     | string        | string      | Agent Team               | 配置中的稳定角色值                      |
| `channel`    | 队友执行通道                 | string enum   | string      | Agent Team               | `text/sidecar/external`                 |
| `enabled`    | 行为遥测总开关               | boolean       | **不兼容**  | System                   | `true/false`                            |

## 6. 声明未上报

无。`TELEMETRY_EVENT_CATALOG` 中 13 个事件均有实际 `trackEvent` 上报路径和单元测试证据。

## 7. 候选未埋点交互

Tea 扫描器启用 `--candidates` 后给出 87 个 handler 候选。它们主要是日志筛选、复制、鼠标交互、adapter 内部 handler 和 workflow 节点回调。按已确认口径，这些均为“启发式候选，需人工确认”，不机械补成按钮级埋点。本次通过 Chat、Workflow、Connector、Agent Team 的共享收口点覆盖核心生命周期。

## 8. 规范风险与待确认

1. 当前为 OTel Logs，不是 Tea/ByteIO；没有 app/subAppId、ByteIO schema 或线上验证通道。
2. 事件名使用点分 `<domain>.<object>.<action>`，不符合 ByteIO 要求的小写 snake_case；CSV 保留代码事实，禁止直接导入。
3. `enabled` 实际类型为 boolean，ByteIO 仅接受 `integer|string|float`；需先明确序列化契约。
4. `durationMs` 代码类型是 number，但语义为整数毫秒；接入 ByteIO 前需用真实上报验证确认。
5. 负责人、成本业务线、管理业务线、需求链接与截图未知，CSV 留空。
6. ID 为本地 opaque 标识，不包含内容，但接入外部分析平台前仍需完成数据治理和保留策略评审。

## 9. 扫描与验证证据

- Tea 扫描命令：`scan-tea-tracking.mjs lib/telemetry/events components/logging hooks/chat lib/connectors lib/workflow lib/ai/agent --root . --candidates`
- 扫描结果：531 文件；Tea SDK 0；Tea event 0；启发式候选 87。
- OTel 事件清单来源：`lib/telemetry/events/catalog.ts`。
- 传输、PII、分类、采样和目标路由：`lib/telemetry/events/track-event.ts`。
- 本地保留与导出：`lib/db/behavior-events.ts`。
- 单元测试覆盖：catalog、settings、track-event、behavior-events、headless policy bootstrap，以及 Chat、Workflow、Connector direct/queued outbound、Agent Team 和 Settings 控制面的 co-located tests。
- CSV：`docs/tracking/cognia-behavior-byteio-import.csv`；需要通过 27 列结构检查，但因 §8 风险保持草稿状态。
