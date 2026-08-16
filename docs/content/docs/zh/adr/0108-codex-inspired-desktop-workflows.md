---
title: ADR-0108 — 受 Codex 启发的桌面工作流
description: "持久化对话执行上下文、项目环境、统一审查、受控浏览器开发模式与可检查的 Agent 线程。"
---

# ADR-0108 — 受 Codex 启发的桌面工作流

**状态**：已接受（2026-08-06）

> **由 ADR-0111 修订（2026-08-07）。** ADR-0108 继续作为持久化 `SessionExecutionContext`、项目环境、统一审查、Browser Adjust 与隐藏 Agent 线程视图的权威。Worktree 所有权、真实的 `baseRef` 后端输入、跨根原子 Apply、敏感路径授权、`WorktreeCreate` / `WorktreeRemove` hook 激活以及 scheduled 运行 fail-closed 的行为迁移到 ADR-0111。`developer.taskWorkspace` 转为一个发布周期的 rollback kill switch。详见 ADR-0111。

## 背景

Cognia 已拥有 Guild/DM/Team/Canvas 桌面壳、终端、调度器、浏览器批注、Computer Use、Job Center、skills、plugins、MCP、通知、subagents、Git UI，以及 ADR-0086 定义的任务级资源模型。相较当前 Codex 桌面工作流，缺少的是持久绑定对话的 Worktree、统一的审查到 PR 流程、项目本地初始化环境、临时 Browser Adjust 与受控 CDP、快速任务入口，以及隐藏 Agent 线程的全局视图。

## 决策

ADR-0086 继续作为隔离、快照、补丁、冲突、撤销、固定、清理和 30 天保留策略的唯一权威。`SessionExecutionContext` 将一个持久化对话绑定到本地目录或一个托管 Task Workspace 身份。重复轮次和计划任务复用该身份；计划任务的托管执行和环境初始化失败时必须关闭执行。Local→Worktree 交接会预览脏基线，`.worktreeinclude` 是显式且识别敏感信息的允许列表，非 Git 根目录复用现有影子隔离。历史恢复会重建所选已结束轮次，并拒绝与运行中的子任务竞争。

`ProjectEnvironment` 定义仅存于当前设备，包含按操作系统覆盖的初始化脚本和可复用操作、非敏感变量，以及指向 Cognia 现有系统钥匙串的不透明引用。密钥值只在 Rust 中解析，只注入子进程，并在 IPC 前脱敏。初始化始终在最终的本地或托管执行根目录中运行。交互式执行可以显式跳过一次失败；计划任务永不跳过。

审查边界与供应商无关。审查范围包括最后一轮、未提交改动、单个提交或跨所选根目录的分支对比。评论使用 SHA-256 内容身份，过期锚点必须关闭映射而不能猜测。现有 hunk 控件继续负责接受、拒绝、暂存和评论。可编辑的 `ReviewFeedbackBundle` 作为一份审查发布。`PullRequestProvider` 以 GitHub 为首个适配器，并保留认证、查找、提交/推送、草稿创建、拒绝和可恢复离线状态。

Browser Adjust 只应用临时实时预览，并在取消、导航、卸载或接受时恢复页面；接受操作生成结构化反馈，不永久修改页面。CDP 权限仅限本地 Tauri，并绑定 Cognia 任务、嵌入式浏览器会话、精确 origin、能力集合和到期时间。每条命令都必须同时通过渲染端和原生端门禁。授权、使用、拒绝、撤销和过期元数据不可变追加，且不包含请求体、响应体、查询参数或密钥。远程、Companion、云端和 Web 目标全部拒绝。

项目固定和最近访问只扩展 Cognia 现有工作区切换器。Quick Chat 复用 Cmd/Ctrl+N 入口，创建普通持久化任务，并继承当前项目的主根目录和默认环境。全局 Agent 线程浏览器按谱系投影隐藏的 subagent 会话，作为桌面状态栏可自定义的 `agentThreads` 段落（位于「运行中的任务」旁）呈现，仅在存在 subagent 会话后显示，并以角标显示运行中子线程数量；打开线程会跨项目和任务导航；提升已完成子线程会通过既有分支语义创建新的主任务快照。实时所有权不会转移，运行中的子线程不能提升。

Dexie 中的环境、CDP 授权和 CDP 审计表明确排除在同步、导出、备份和设备清理表面之外。非 Tauri 平台可以检查持久化对话和审查数据，但不能执行本地环境、托管原生操作或 CDP 命令。

## 影响

- Cognia 继续只维护一套任务隔离与补丁账本，不创建 Codex 形状的重复系统。
- 初始化和 CDP 密钥不会进入渲染端持久化或跨设备同步。
- 对话、计划任务、终端、审查和恢复操作对同一个执行根目录达成一致。
- GitHub 行为可被替换，而不会削弱共享审查契约。
- 桌面壳补齐缺失流程，但不在视觉上复制 Codex。

## 验证

同目录 TypeScript/RTL 与 Rust 测试覆盖持久绑定与复用、脏目录和非 Git 交接、累积应用/冲突/撤销/恢复、环境重试和计划任务禁止跳过、所有审查范围与供应商失败、Browser Adjust 恢复、CDP 会话隔离与审计、项目固定/Quick Chat，以及嵌套 Agent 提升保护。认证后的 Playwright 路径和真实 Tauri 冒烟测试覆盖原生命令注册与权限允许列表。
