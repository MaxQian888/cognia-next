---
title: "0231 — 沙盒快照同时保存根文件系统与工作区"
description: "Docker 冷检查点保存停止容器的根文件系统，以及带 Git 引用固定的完整工作区。"
---

# ADR 0231 — 沙盒快照同时保存根文件系统与工作区

**状态：** 已接受
**日期：** 2026-10-17
**关联：** ADR-0182、ADR-0183、ADR-0213、ADR-0221、ADR-0229

## 决策

本地 Docker 沙盒快照由两个不可变产物组成：停止容器后提交的镜像，以及
宿主机挂载工作区的 Task Workspace 检查点。Docker 镜像本身不包含绑定挂载
的文件；工作区检查点本身也不包含容器的系统软件包、全局安装和主目录。

存在活动 agent 或 task turn 时，捕获以 `snapshot_busy` 拒绝。这是冷文件系统
检查点，不是进程挂起：内存、socket、tmpfs 和运行中的服务不会被捕获。
恢复时启动新进程。

完整捕获模式包含已跟踪、未跟踪、被忽略和生成的文件，以及空目录和文件权限。
用户声明的排除项记录在 manifest 中。超出预算会使捕获失败，不会静默删减内容。
每个检查点必须拥有独立的 Git 引用，防止记录的基线被垃圾回收。

## 持久归属与恢复

`task-workspaces.sqlite` 管理 `workspace_checkpoints`、`sandbox_snapshots`、
`snapshot_artifact_refs` 和 `snapshot_operations`。创建日志按
`preparing → workspaceCaptured → imageCommitted → ready` 推进。
失败时通过删除已提交镜像和释放检查点进行补偿。启动恢复会处理被中断的操作，
不能把未完成的记录当作 ready 暴露。

镜像使用 `cognia-snapshot-<deploymentHash>:<uuid>` 名称。账本记录不可变的
image ID；Docker label 不能授予访问权或删除权限。归属由部署身份和持久引用
确定，不能相信用户提供的 label。

## 分叉与恢复

分叉创建新的 task、workspace、执行根目录和 ADR-0229 端口租约，恢复记录的
commit 与检查点覆盖层，再从快照镜像创建容器。新运行时重新获得挂载和准入；
源工作区的租约、授权、会话和出口桥接不会被复制。使用允许列表的运行时必须
取得新的出口租约。生命周期钩子只重新运行 `postStart` 和 `postAttach`。
注入的 agent bundle 以 digest 记录，并在恢复工作区及后续获取运行时前检查。

只有已归档且可恢复的工作区允许原位恢复；其他情况通过分叉恢复。恢复检查点
不会授予源工作区的访问权，也不会扩大网络权限。

## 存储生命周期

`sandboxSnapshotBudgetBytes` 默认 1 GiB，与已有的 1 GiB 工作区 blob 预算
独立。保留期默认 30 天，支持显式固定。回收器先写入 tombstone，再调用预览
撤销钩子。只有不存在 runtime、fork 或进行中操作引用时，才删除本部署的镜像。
随后才能释放检查点的 Git 引用和 blob。任何操作都不能运行
`docker system prune`，也不能删除其他部署的镜像。

Phase 1a 提供预览撤销钩子。Phase 1b 在提供预览服务前把授权接入该钩子；
删除必须先撤销相关预览，才能继续清理产物。

## Phase 1b：本机所有者预览授权

预览权限是 Host 在同一工作区账本中持有的带版本授权。它绑定 project、
workspace、provider、container、运行时 generation、已批准端口、端口租约
和本机所有者。固定端口必须经过批准；`workspace-lease-offset` 根据目标
工作区的 ADR-0229 租约解析，因此分叉使用自己的新端口块，不继承源授权。

Capability 至少使用 256 bit 操作系统随机数。只存储哈希，以恒定时间校验；
内存中的进程 secret 让 Host 重启后的旧 capability 失效。授权默认有效
15 分钟，最多 1 小时。复制得到的 bootstrap 凭据只能兑换一次，有效期
60 秒。打开授权时获取新的 bootstrap 凭据。

预览监听器与 Companion API 分离，只绑定 loopback。每个授权使用自己的
`p-<id>.localhost` 主机名。计划中的 `127.0.0.1` 每授权独立端口回退暂不可用：
端口隔离 origin，但不能隔离应用 cookie。Host 拒绝该模式，UI 禁用该选项，
直到具备独立 cookie 存储或另行验证的主机名替代方案。无法解析该主机名的
目标在本阶段不能使用预览。预览凭据不会转发给服务。精确 Host 校验拒绝其他
主机名，包括 DNS rebinding 尝试。

`/__cognia_bootstrap#<token>` 将凭据放在 HTTP URL 之外。页面通过 POST
提交 fragment，并从导航历史清除它，兑换 HttpOnly、host-only、
SameSite=Strict cookie 后导航到 `/`。Bootstrap 响应不能缓存。持久化浏览
历史和 dock 标签页必须排除 bootstrap URL。

每个 HTTP 请求与 upgrade 都重新检查归属、授权状态、运行时 generation
和端口批准。撤销与过期还会取消活动 HTTP body、SSE 和 WebSocket。转发
复用 `environment_ports.rs`，通过 `open_port` 访问服务；包括 `network=none`
运行时在内，都不会发布 Docker 端口。

Phase 1b 拒绝已配对设备 audience，下文的 phase 2 启用了它。仍然不提供
匿名公开预览访问。单独持有 capability 不能扩大所有者权限边界。

## Phase 2：已配对设备预览、provider 声明与审计

- **Audience。** `pairedDevice { deviceId }` 指定一台设备。所有者的选择即对该
  设备访问此项目与端口的批准；创建时该设备还必须当前持有 `workspace.write`。
  不创建监听器，也不生成 bootstrap 密钥：授权的 origin 是
  `/api/sandbox/previews/<id>/`，所有者无法在本机打开。
- **Host 路由。** `GET /api/sandbox/previews` 列出调用者的有效授权；
  `/api/sandbox/previews/{grant}/…` 以该设备自己的上下文经 `environment_ports.rs`
  代理。准入：未知或属于其他设备的授权 → 404，失去控制权限或审批权限 → 403，
  已撤销/过期/失效 → 410。中继每两秒重新授权设备，授权取消会关闭活动流。
- **客户端。** 只有桌面应用能打开这些授权，复用已有的原生 loopback 中继，由它
  用设备密钥为每个请求签名。手机、浏览器和 WAN 通道没有带签名的 HTTP 流通路，
  因此该 audience 对它们在类型、UI 和测试三方面都标注为未启用。WAN 流适配器
  不在本阶段范围内。
- **Provider。** `RemoteProvisioner::snapshot_capabilities()` 声明远程 provider
  的能力（默认无；E2B 声明暂停与内存恢复），Host 再与自身能力取交集。
- **审计与指标。** 快照与预览的修改操作按项目审计，actor 为 `host-service`；
  被拒绝的设备请求记录设备 id。`/metrics` 导出两组封闭标签的计数器。

## Provider 与 Host 契约

Provider 能力分别为 `filesystemCheckpoint`、`forkFromCheckpoint`、
`pauseResume` 和 `memoryResume`。本地 Docker 支持前两项。E2B 保留已有的
暂停与恢复行为；在验证 provider API 前，检查点分叉不受支持，并返回带明确
原因标识的拒绝结果。

Host 暴露 `sandbox_snapshot_create`、`sandbox_snapshot_list`、
`sandbox_snapshot_get`、`sandbox_snapshot_delete`、`sandbox_snapshot_pin`、
`sandbox_snapshot_fork` 和 `sandbox_snapshot_restore`。Tauri 与 Companion
使用同一个后端权限源；TypeScript client 负责传输适配。

## 验证边界

Fake Docker 测试覆盖忙碌拒绝、状态推进、失败补偿、崩溃恢复、预算、排除项、
分叉隔离与按部署限定的清理。真实 Docker 往返测试默认显式忽略，执行时需要
本地 daemon。无法访问 Docker 或绑定 socket 的沙盒检查，不代表已通过原生
容器或预览链路验证。
