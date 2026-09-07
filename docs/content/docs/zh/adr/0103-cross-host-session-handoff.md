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


## 结构化续接与恢复（2026-09-07）

新交接额外要求 `thread-handoff-structured-v1`，防止仍将规范消息降为纯文本的旧目标端确认结构化交接。导出复用已有 canonical codec，保留推理、文件和工具结果；不支持的消息部分会阻止导出，不会静默丢失。原生会话句柄仅保留来源信息，跨 Host 续接明确标为 contextual；未完成的历史工具调用按中断记录展示，不自动重放。

附件清单根据实际 canonical 字节计算。配对的独立移动端通过源会话授权的二进制接口获取媒体；远程 Host 复用可恢复的分块上传协议。目标预检核验 SHA-256、长度和媒体类型后建立持久媒体引用，暂存过程保持 canonical URI 与序列摘要不变。所有 carriage 模式都必须通过本地完整性核验才能接受。

远程 Host 交接由明确的用户操作发起，使用独立的已配置 Host transport，不改变当前路由。目标自行取得管理授权，先接受只读副本，再提交源端，最后解除目标锁。最后一次响应丢失时，重试仅完成目标提交，不重新导入。两条导入路径均将目标锁与消息原子写入；摘要或附件清单不匹配会在导入前拒绝。

服务端权威共享会话不能通过复制移交：更换执行端必须保留 collaboration identity，并使用共享会话的授权执行租约。历史归属缓存按账户数据库、runtime target 和 routing generation 隔离，在连接变化及交接提交后失效；过期作用域的异步响应不能发布归属，也不能写入新选择的账户。
