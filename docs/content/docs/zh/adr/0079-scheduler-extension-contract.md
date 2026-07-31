---
title: ADR-0079 — 调度扩展点契约
description: 定义 scheduler 的可扩展轴、source adapter、插件边界与 OS 提升能力规则。
---

# ADR-0079 — 调度扩展点契约

**状态**：已接受（2026-07-16）

## 背景

Cognia 同时拥有 TypeScript 进程内调度器、Rust cron daemon 驱动的 workflow trigger，以及
OS 原生提升后端。过去这些扩展点发生了漂移：插件写操作绕过活跃调度器，统一运行历史绕过
source registry，OS capability 列表也被多处复制。

## 决策

1. `TaskScheduler` 是唯一生命周期写路径。只写存储不会正确 arm/disarm driver，不是受支持的扩展点。
2. Executor 名与 event 名是开放字符串。新的计时生产者通常应调用
   `triggerEventTask(eventType, source, data)`，而不是增加第五种 `TaskTriggerType`。
3. 统一调度 kind 保持闭合，由 `SCHEDULED_ITEM_KINDS` 定义。每种 kind 由一个
   `ScheduledItemSource` 表示；可选运行历史通过 source 的 `listRuns()` 暴露。
4. 插件只有在 manifest 声明 `scheduler` capability 后才能使用现有 trigger。插件任务就是
   SchedulerDB 中普通的 `type: "plugin"` 任务，不再有第二套插件调度存储。
5. 插件不能注册 timing driver、增加统一 kind，也不能把 JavaScript handler 提升成 OS service。
   自定义 workflow 计时应使用带前缀的 workflow-trigger registry。
6. OS 提升仅支持各后端明确报告的 trigger/action 组合。Capability 从
   `SystemTriggerKind` 穷尽派生；无法表达的 cron 必须拒绝，不能近似执行。
7. Workflow cron 在边界接受五或六字段，拒绝 `L` 与 `#`，并按指定 IANA timezone 计算
   wall-clock 时间；缺省时使用宿主时区。

## 后果

- 新 driver 可通过 `initSchedulerSystem(driver)` 注入，无需修改 singleton consumer。
- 新增 system trigger 变体时，编译器会要求补齐 kind 映射和所有后端的 capability 决策。
- 新增统一 kind 时必须更新穷尽元组并注册 adapter；运行历史无需修改聚合 hook。
- OS 提升和插件调度会对过去“接受但不生效”的输入给出可操作的拒绝错误。
