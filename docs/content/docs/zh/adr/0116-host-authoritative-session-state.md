---
title: "ADR-0116：Host 权威的多端会话状态"
description: "Agent RPC v2 之上的 AHP-inspired 有序状态 channel"
---

# ADR-0116：Host 权威的多端会话状态

- 状态：已接受，分阶段发布
- 日期：2026-08-14

## 背景

Cognia 已有唯一的运行时协议 Agent RPC v2、远程 Transport、可 replay 的
Companion EventBus、target 隔离数据库、table sync、持久化客户端队列和 TUI
standalone JSONL store，但 Web、Mobile、Desktop、headless 与 TUI 仍缺少一个
对共享会话意图进行排序的 owner。直接 runtime 调用与 table invalidation
并行时，可能发生重连重复 turn 或旧 draft 覆盖新 draft。

Microsoft Agent Host Protocol 中 channel、snapshot cut、ordered action、
optimistic reconciliation 和版本协商值得借鉴。其实现仍在快速演进，因此
Cognia 只采用这些概念，不增加 AHP 依赖，也不建立第二套 runtime 协议。

## 决策

活动 Desktop/headless Host 是每个实时 session 的唯一权威。
`HostStateProtocolV1` 位于 Agent RPC v2 之上：

- `cognia://target/{targetId}/sessions` 保存有界 session 摘要；
- `cognia://target/{targetId}/sessions/{sessionId}` 保存共享 draft、queue、
  active turn、decision 状态和 transcript revision；
- 客户端 action 必须先写入持久化 outbox，才允许 optimistic projection；
- Host 在同一 Dexie 事务中写入物化 projection、现有业务 repository 和语义
  receipt，再以同一 action id dispatch Agent RPC；未 dispatch/未 broadcast
  ledger 可恢复；
- 10 秒 heartbeat、30 秒 lease 对旧 Host generation 进行 fencing；
- 客户端先订阅现有 `host-state://action` EventBus topic，再获取 snapshot。
  EventBus carrier sequence 仍是 transport replay cursor，
  `{hostGeneration, hostSeq}` 负责状态顺序验证。

## 复用边界

本决策不新增 socket、EventBus、RPC runtime、target registry、queue runner、
React Provider 或 TUI session store，而是增强：

- `Transport.call/subscribe`、Companion WS/RTC replay、`BridgeTransport`；
- 作为 attached surface action outbox 的 `mobileOutboundQueue`；
- `RuntimeTargetRegistry` 与 account/target 数据库激活；
- 现有 session、message、draft、transcript、tombstone repository；
- 现有 Web/Mobile boot provider 与 chat store projection；
- 本地 TUI 的 endpoint file 与 dev-token validator。

Agent RPC v2 继续拥有 provider、turn、tool、permission 与 runtime event 生命周期。
历史 transcript 分页不进入 snapshot。WebDAV 与 Companion table sync 是数据复制
机制，不是实时 session 权威。TUI standalone 始终保留本地 JSONL，绝不静默
合并到 attached session。

## 兼容与回滚

Host 通过 `HostFeatureManifestV2` 发布 `session.state-sync@1`。缺少能力时使用
legacy table sync/direct RPC。每个 target 按 `legacy-authoritative`、`shadow`、
`hoststate-read`、`hoststate-authoritative`、`legacy-projection-only`、`retired`
推进。关闭 feature 后停止新 HostState action，冻结 pending outbox，并继续保留
legacy repository；无需破坏性反向迁移。

## 结果

现有 RPC cache 与长期 semantic ledger 共同保证重复 transport delivery 不会重复
执行。revision conflict 和永久 rejection 会持续可见。代价是持久化 ledger、
snapshot projection、lease recovery 与兼容窗口。snapshot 上限为 512 KiB，并排除
device-local UI 状态、secret、local path、附件二进制和完整 transcript 历史。
