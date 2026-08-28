---
title: "0103 — 跨宿主会话接力"
description: "通过两阶段、单写者协议，在可信 Host 之间继续 Cognia 会话，同时不转移环境权限与绝对路径。"
---

# ADR 0103 — 跨宿主会话接力

**状态：** 已接受  
**日期：** 2026-08-28  
**相关：** [ADR-0062](./0062-external-agent-session-import)、[ADR-0116](./0116-host-authoritative-session-state)、[ADR-0136](./0136-cross-device-placement)、[ADR-0149](./0149-a-person-is-not-a-device)、[ADR-0153](./0153-the-host-obtains-the-confirmation)

## 背景

同步后的逐字记录并不等于可转移的执行会话。继续运行还需要目标端可用的模型与凭据、可解析的 Workspace、附件，以及「哪一份副本允许写入」的明确结论。若先复制、后决定所有权，就可能产生两份可写历史。原生 runtime handle 与宿主绝对路径既不可移植，也不应跨端传输。

## 决策

接力采用由 `thread-handoff-v1` 能力标识的 ticket 两阶段协议。Desktop Host、Cloud Host、CLI 与 standalone mobile 都可以成为所有者；普通 paired browser/mobile 仍只承担控制面角色。

每个 ticket 在 Dexie 中以 `[ticketId+role]` 保存两行，分别代表 `source` 和 `target`。两端共享五个状态：`preparing`、`frozen`、`accepted`、`committed`、`aborted`。投递复用 `hostDispatchQueue` 的 `thread-handoff` domain。

协议始终保持唯一可写副本：

1. 源端补全历史、计算 digest、持久化 ticket 与 `handoffLock`，然后冻结会话。
2. 目标端检查 provider、model、credential、Workspace、协议与附件，并把规范会话导入为只读 `accepted` 副本。
3. 源端收到经过认证的 accepted 回执后，把自身永久提交为只读。
4. 目标端只有在取得源端 commit 证明后，才能成为可写的 `committed` 副本。

故障恢复期间允许暂时没有可写副本，绝不允许两份可写副本。`accepted` 不得因超时自行获得写权限。协调 abort 只有在证明目标从未接受，或已删除目标只读副本后，才可恢复 frozen 源端；否则进入人工处理。

所有会话写操作都经过同一 write guard，包括消息、继续运行、标题和元数据修改、Workspace 移动、分支与删除。只检查 Workspace move 并不足够。

## 可移植性与权限

附件复用现有 chunk 传输；绝对路径不跨宿主。原生 runtime handle 与 Host 工具不转移，无法恢复时由目标端进行 transcript-seeded continuation。历史工具授权不转移，目标端重新询问。

Standalone mobile 保留本地 Dexie 与 BYOK 推理。只有在 Companion 配对声明 `thread-handoff-v1` 后才接收 ticket，且不安装完整 HostState 镜像。重连后通过 `thread_handoff_status` 恢复。

六条 Companion 操作为 `offer`、`preflight`、`accept`、`commit`、`abort`、`status`。`accept` 与 `commit` 需要 `host.admin` 和 step-up。请求按 ticket、角色和状态幂等；非法状态跃迁返回冲突。

## Kill switch

从协商能力中移除 `thread-handoff-v1` 后，新的 offer 与所有权变更会被禁用，但 status 和恢复数据仍可读取。该能力同时承担协议版本信号与发布 kill switch。

