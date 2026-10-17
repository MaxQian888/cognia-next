---
title: "0230 — Best-of-N 尝试共享冻结基线"
description: "Host 账本管理独立尝试、物理工作区写锁、预算和人工胜者授权。"
---

# ADR 0230 — Best-of-N 尝试共享冻结基线

**状态：** 已接受
**日期：** 2026-10-17
**关联：** ADR-0198、ADR-0217、ADR-0227、ADR-0229

## 决策

一次请求在同一个 Host、同一个 Git 仓库中分配 2–4 个独立尝试。
`task-workspaces.sqlite` 的 `best_of_n_groups` 和 `best_of_n_candidates`
是权威数据源；前端及未来同步投影均可重建。request ID 唯一，重复请求返回
已有分配。Host 只解析一次已提交的 base SHA，并记录原 checkout 是否存在
未提交修改；这些修改不会复制给候选。每个候选拥有独立 child session，
使用 `base: { kind: "gitRef", gitRef: baseSha }` 获取 managed bundle。

`lib/best-of-n/service.ts` 的 `startBestOfN` 是未来 slash command 和 composer
共用入口，接管本次发送，不会再给父会话发送一遍消息。纯核心通过 durable
team dispatch 执行固定 N 个任务，不规划、不分享答案、不自动选择、不综合。
agent/model 和预算通过 capability grant 进入 `resolveSendOptions`，不修改
返回的 SendOptions。

## 所有权、预算和恢复

Host 修改使用 version CAS 和有期限的 owner lease，并由 SQLite 事务保护。
执行期间续租失败即停止。重启后重新绑定账本；执行中断或候选工作区消失时
进入 `recoveryRequired`，不会自动重放可能已经产生副作用的操作。

durable 写锁以 Host canonicalize 后的物理根目录为键，跨 run 和 repository
alias 生效。不同物理根可以同时修改相同相对路径；同一根的别名共享锁。
原有 isolated-parallel 模式仍在同一物理根内检查不重叠的文件所有权。
端口块复用 ADR-0229。

组有有限时长预算；可选 USD 预算平均分配给固定的候选，以只能收紧的 grant
下发。Host 累计已知费用，未知费用保持 `null`，绝不替换为 0。Host 同时检查
累计费用和执行时长。`isolateFailure` 保留失败候选的 checkpoint 和证据，
不会暂停其他候选。零成功候选进入恢复状态；没有代码变化的成功候选可展示，
但不能被选择发布。

配置 USD 上限时，最终 runtime 必须支持执行该上限；第一阶段在发送前拒绝
不支持该能力的组合。仅限制时长的尝试仍可运行；AI-SDK 默认的零费用按未知处理。

## 选择和发布

正常状态为 `preparing → running → awaitingSelection → publishing → published`，
另有 `cancelling`、`cancelled` 和 `recoveryRequired`。归档进度独立记录，
清理失败不能覆盖已经发布成功的状态。

只有受信任的交互式应用调用可选择胜者；Companion、plugin 和 unattended
调用不能通过请求字段伪造交互来源。选择固定 candidate ID 和 captured head
SHA，并停止尚未结束的候选。没有 AI judge。默认创建新的结果分支，只有明确
选择目标时才更新已有分支；永不 push。

frontend plugin 与主 renderer 共享运行环境，因此 Host 还要求原生窗口中由
用户确认候选、记录的 head 和目标分支。确认绑定账本 version，过期后必须重新确认。

changeset 捕获在 progress 关联 changeset ID 之前就识别候选 session/workspace，
并始终与冻结基线比较，即使结果分支尚未创建。integration prepare 和 publish
分别检查所选胜者、准确 head、目标分支、单 changeset 和 `onConflict: "stop"`，
通用 SCM 路径也无法发布落选候选。发布复用 ADR-0227 integration queue。

## 交付边界

第一阶段包含账本、Host commands/catalogs、固定任务驱动、恢复、预算和发布
守卫。slash command、composer chip、比较 UI、人工选择后的集成交互、异构
外部 agent 和公开 CLI/plugin 产品入口属于后续阶段。内部 schema 可供后续
接入，但不授予自动选择权限。

定向测试覆盖幂等分配、冻结基线、owner/CAS、物理别名写锁、独立失败、提前
取消、未知费用、人工 exact-head 选择以及 prepare/publish 双重守卫。
