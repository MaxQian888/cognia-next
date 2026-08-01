---
title: ADR-0102 — 统一可观测性与崩溃诊断
description: "采用跨运行时的版本化事件契约、本地优先的抗崩溃队列、有界恢复、经用户同意的诊断上传，以及自托管多租户诊断服务。"
---

# ADR-0102 — 统一可观测性与崩溃诊断

**状态**：已采纳（2026-08-01）

## 背景

Cognia 已经具备成熟的 renderer 日志包、IndexedDB 与原生 transport、Tauri panic
hook、进程外 minidump monitor、崩溃报告 UI 和 OpenTelemetry 接入。但这些能力使用
不同的持久化结构、保留规则、关联边界和用户入口；Capacitor、CLI、Sidecar、插件与远程
服务也尚未共享同一套崩溃生命周期和能力模型。常规日志出网与崩溃提交还必须拥有相互独立
的同意和隐私控制。

既有 `StructuredLogEntry` 与原生崩溃报告仍在使用，其中的数据必须继续可读。因此本决策
扩展现有 owner，并通过兼容适配器迁移，而不是替换已经工作的管道。

## 决策

- 采用 `ObservabilityEventV1` 作为 `log`、`span`、`crash`、`lifecycle`、
  `metric` 的版本化 wire/spool envelope。新 writer 写 V1；双向适配器在分阶段
  dual-read/dual-write 窗口内继续读取 `StructuredLogEntry`。
- 在 HTTP、Tauri IPC、子进程、Sidecar、Companion、移动端、CLI 与插件边界显式传播
  W3C Trace Context。异步任务使用不可变 scoped logger；共享可变 trace/span 状态只作为
  旧接口兼容，并在调用点迁移后移除。
- 每个运行时拥有有界、抗崩溃的本地 spool。低等级事件批量写入，`warn` 快速转发，
  `error`、`fatal`、crash marker 与终态 lifecycle 使用该运行时可提供的最强 flush。
- 常规日志默认不远程上报。崩溃 bundle 始终先保存在本地，并在预览后征得同意；只有用户
  另行开启自动提交时才可跳过逐次确认。minidump 与当前状态截图默认不勾选。
- 在本地持久化、IPC、导出和上传前应用同一份版本化隐私 manifest，服务端再做流式扫描。
  除限时、本地 debug session 外，原始 prompt、消息、tool I/O 与文件正文一律不采集。
- 桌面端继续由既有 Tauri panic/minidump 管道负责；iOS 第一方 Capacitor 插件封装
  KSCrash 与 MetricKit，Android 封装 ACRA 与 `ApplicationExitInfo`。每个平台只声明
  真实可用的能力。
- 同一 build 在十分钟内出现两次不健康启动后进入安全模式。renderer reload 与子进程
  重启均有次数限制；稳定运行十分钟后重置计数。安全模式先启动诊断最小壳，再通过健康检查
  逐组恢复子系统。
- 新建 Rust/Axum 诊断服务，使用 PostgreSQL 与 S3 兼容对象存储，提供租户级上传授权、
  可恢复上传、receipt、删除、服务端脱敏、符号化、分组、保留、告警、审计及 OIDC 控制台。
- 本地查看统一进入 `/logs`；设置页只配置策略并跳转到该响应式工作台。CLI/TUI 提供等价
  的日志与崩溃命令，并支持 human、JSON 与 NDJSON 输出。
- 诊断状态完全排除在普通业务数据备份和同步之外。唯一可携带格式是经校验、可选加密的
  `.cognia-diagnostic`，其中包含签名的 SHA-256 manifest。

## 结果

同一 incident 可以在 renderer、Rust、Sidecar、服务、CLI、插件、Companion 与
Capacitor 之间关联，同时不会暗中上传常规活动。崩溃恢复从无界重启变为可检查的有界状态机；
支持人员获得稳定 receipt 与符号化分组，用户仍拥有预览、撤回和删除权。

代价是新增诊断服务、对象存储、符号管道、移动端原生依赖、保留任务与多租户安全责任。因此
发布必须保持 feature gate 和向后可读；关闭远程处理不得删除本地报告，也不得让 V1 spool
不可读。

## 未采用的方案

- 替换既有 logger 与 crash monitor：会丢弃已测试的 transport、格式与原生采集行为。
- 把所有日志交给托管第三方：与常规日志本地优先、自托管、删除和租户隔离要求冲突。
- 让移动端经配对桌面上传：会破坏 standalone 模式，并把 pairing 变成崩溃交付依赖。
- 默认上传 minidump 或截图：其隐私面显著大于 metadata、stack 与已脱敏 breadcrumb。
- 在浏览器使用全局异步 trace stack：并发 turn 与嵌套进程会造成上下文串扰。

## 实施记录

完整契约、状态机、发布闸门、容量限制与验证矩阵见
[`docs/plans/2026-08-01-unified-observability-crash-diagnostics.md`](../../../../plans/2026-08-01-unified-observability-crash-diagnostics.md)。

