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

## 未采用的方案

- 给 CSP 添加 `https:` 或运行时 host：范围过宽，也无法安全表达用户自定义 endpoint。
- 只引入 Tauri HTTP 充当代理：无法同时建立本决策需要的 Rust tracing 与密钥边界。
- 用 span event 表达产品行为：会污染耗时瀑布；OTel Logs 更符合瞬时事件的语义。
