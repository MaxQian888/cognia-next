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

预览撤销钩子是独立预览任务的接入点。预览监听器、链接和 UI 不属于 phase 1a。

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
