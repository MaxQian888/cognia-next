---
title: ADR-0074 — 原生 OpenTelemetry 管道
description: "桌面 OTLP 统一经 Rust 出口，密钥存入操作系统安全存储，以 W3C trace context 串联 renderer、Rust 与 sidecar，并让用户行为遥测保持独立、显式选择开启。"
---

# ADR-0074 — 原生 OpenTelemetry 管道

**状态**：已采纳（2026-07-16）

## 背景

Cognia 已经会发出 agent span，但桌面 CSP 会阻止 renderer 的 `fetch` 访问
collector。另一个 OpenTelemetry 开关只包装了并不存在的全局 provider，因此不会导出任何
数据。Rust 与 Node sidecar 不在 trace 中，凭据以明文保存在 renderer localStorage，产品
行为事件也没有类型化、经用户同意的事件层。

## 决策

- 桌面出口使用基于 `reqwest` 的窄 Tauri command，只接受 HTTP(S) 端点、JSON payload
  和非敏感 header。Grafana 与 Langfuse Authorization 均由 Rust 从操作系统安全存储中
  构造；renderer 只能写入密钥，密钥绝不通过 IPC 返回。相关 command 显式登记在应用
  manifest 与主窗口 telemetry capability 中。
- 保留既有 agent-trace OTLP transport 作为唯一 trace 出口开关，删除不会工作的
  `OtelTransport` 及其重复设置项。
- 显式传播 W3C `traceparent`。renderer 根 span 仍是事实来源；Rust 把父上下文挂到
  `tracing` span，sidecar 在 AI SDK 或 Anthropic 工作开始前恢复父上下文。
- sidecar 使用 NodeSDK 与 OTLP/HTTP。AI SDK telemetry 不记录输入与输出；Anthropic
  路径用手写 span 包住异步 query 生命周期。collector 凭据只经子进程环境变量传入，绝不
  放入 argv。
- Rust 原生出口由 `otel-export` Cargo feature 控制，并且**默认关闭**，以保留
  ADR-0067 的编译提速成果。开启后由 `tracing-opentelemetry` 桥接既有 span，并把性能
  exporter 挂到可热重载 layer 上，因此设置变更无需重启即可启用或替换原生 provider；性能
  registry 的每条真实观测直接记录到 OTLP Histogram。
- 产品行为事件使用类型化 `<domain>.<object>.<action>` 名称与 OTel Logs
  (`event.name`)。默认关闭、必须显式同意、统一经过 PII 闸门，保存在 Dexie v112，并能独立
  导出与清除。工程 trace 与行为事件使用不同开关。
- 事件 catalog 的变更由仓库维护者通过 CODEOWNERS 把关。

## 结果

桌面遥测不再需要放宽 CSP，凭据也不再位于 renderer 可读的持久存储。一条 trace 可以串联
renderer、原生层与 sidecar。较重的 Rust 依赖只影响显式选择该 feature 的构建。仅仅配置
endpoint 不会暗中启用行为分析。

## 2026-08-19 修订——PostHog 目的地

PostHog 是新增目的地，不替换通用 OTLP、Langfuse、本地 agent-trace 存储或原生遥测。
托管项目和自带项目（BYO）分别提供产品分析与 AI 可观测性授权，四个开关全部默认关闭。
产品事件仍须经过行为遥测总开关、分类、采样、标量校验和 PII 闸门；AI 可观测性使用独立授权。

产品分析直接调用 PostHog 批量采集 API（`POST {host}/batch/`），不再内嵌浏览器 SDK。
本集成只做手工 capture——不需要 autocapture、页面生命周期采集、会话回放、问卷、功能开关、
用户画像和自动异常采集——SDK 提供的能力全部用不到，反而会从渲染进程自行发起连接，被桌面端 CSP 拦截。
因此批量请求在 Tauri 上与其他所有出站请求走同一条 Rust 通道（`telemetry_otlp_export`，
credential 为 none；project token 以 `api_key` 放在 body 中），在 Web/移动端走 `fetch`。
事件累积到 20 条或 2 秒后发送。

Headless brain（`cognia-agent serve`）在 OTLP logs sink 之外安装同一个 exporter，
配置来自 `COGNIA_POSTHOG_HOST` / `COGNIA_POSTHOG_PROJECT_TOKEN`（可回退到
`NEXT_PUBLIC_POSTHOG_*`）。它没有按目的地的授权 UI，因此其 PostHog 目的地改为受账户级
「远程导出」授权约束：运维设置环境变量只是配置目的地，不构成使用该目的地的授权。
其 distinct id 必须通过 `COGNIA_OBSERVABILITY_INSTALLATION_ID` 固定——brain 的
`localStorage` 是内存 shim，自动生成的 id 每个进程都不同，会让同一个安装在每次重启后
被计为新的 person。未设置时该目的地保持关闭并输出说明日志。

AI 遥测使用 AI SDK 7 的 `@ai-sdk/otel` `OpenTelemetry`，以及
`@posthog/ai@8.8.0` 的 provider-independent `PostHogTraceExporter`。Sidecar 只创建一个
`NodeSDK`，按已启用的通用 OTLP 或 PostHog 目的地组合 processor；PostHog 固定使用
`/i/v0/ai/otel`，绝不据此派生 logs 或 metrics endpoint。

远程白名单只允许标识符、运行时/版本、provider/model、用量、延迟、成本、工具名和成功/失败状态。
prompt、completion、system instruction、工具 schema/参数/结果、文件内容、URL 与异常正文/堆栈
会在导出前再次删除。随机 installation ID 是唯一的 PostHog `distinct_id`——在产品事件上作为
`distinct_id` 字段，在渲染端与 sidecar 的 AI span 上作为 `posthog.distinct_id` span 属性，
使同一轮对话归属同一个 person；禁止账号、邮箱和硬件标识。
PostHog project token 仅限公开 ingestion token；策略明确拒绝 Personal API Key，并在 UI、日志和诊断中掩码。

## 未采用的方案

- 给 CSP 添加 `https:` 或运行时 host：范围过宽，也无法安全表达用户自定义 endpoint。
- 只引入 Tauri HTTP 充当代理：无法同时建立本决策需要的 Rust tracing 与密钥边界。
- 用 span event 表达产品行为：会污染耗时瀑布；OTel Logs 更符合瞬时事件的语义。
