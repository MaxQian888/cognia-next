---
title: ADR-0040 — Hooks 机制完善（内置 Agent + 外部 Agent）
description: "补全 Claude Code 风格的 settings.json hook 运行时（Phase-1 只接了 UserPromptSubmit + PreToolUse）。纯 Rust 分类器把内置 Agent 的 SDK 事件流映射到完整生命周期（PostToolUse/Failure、Stop/StopFailure、SessionStart/End、SubagentStop、Notification、PostCompact、Task*、PermissionRequest/Denied、PostToolBatch）；新增 run_agent_hook Tauri 命令让 TS 外部 Agent 管理器（claude-code/codex/opencode）复用同一套运行时；实现 webhook 处理器；project/local 作用域在 Rust 强制的 workspace-trust 门控下加载；并接上两个孤儿 System-A 插件 hook。"
---

# ADR-0040 — Hooks 机制完善

**状态**：Accepted（2026-06-01）
**作者**：Max Qian + Claude Opus 4.8
**扩展**：`src-tauri/src/hooks/` 的 Phase-1 运行时（仅接了 `UserPromptSubmit` + `PreToolUse`）

## 背景

代码库中存在两套并行的 “hook” 系统：

- **系统 A** —— 进程内插件 hook（`lib/plugin/messaging/hooks-system.ts`，74+ 种）。已成熟，但 `dispatchExternalAgentToolCall` / `dispatchExternalAgentPermissionRequest` 定义后从未被调用（孤儿）。
- **系统 B** —— Rust 中的 Claude Code 风格 `settings.json` hook 运行时（`src-tauri/src/hooks/`）。源码注释标注为 **Phase 1**：只有 `UserPromptSubmit`（在 `claude_send`）和 `PreToolUse`（在 sidecar 的 `permission_request` 处理）会触发；其余 25 个事件可 round-trip 但从不触发；webhook 处理器是 stub；project/local 作用域从不加载（硬编码 `cwd: None`）；外部 Agent（claude-code/codex/opencode）零集成。

本 ADR 在内置 Agent **与** 外部 Agent 上补全系统 B，并闭合系统 A 的孤儿。

## 决策

### 注入模型 —— 一套运行时，两条到达路径

Rust 的 `external_agent` 模块是纯 stdio 透传，不解析 ACP/opencode 协议，因此看不到外部 Agent 的工具/权限事件——这些只在 TS 层被解析。而内置 Agent 的 sidecar 会把完整 SDK 事件流转发给 Rust。因此：

| Agent | 注入层 | 理由 |
|---|---|---|
| 内置（sidecar） | **Rust** —— `claude::sidecar` reader + `claude_send` | Rust 已能看到 SDK 流，且已托管 PreToolUse/UserPromptSubmit。|
| 外部（claude-code/codex/opencode） | **TS** —— `manager.ts`（`executeStreaming` + `execute`），经新命令 `run_agent_hook` 回到同一套 Rust 运行时 | 只有 TS 有解析后的事件；命令复用运行时而非复制。|
| 系统 A 孤儿 | **TS** —— 同 `manager.ts` 接缝 | 纯进程内插件分发。|

已否决：在 sidecar（Node）里注册 SDK 原生 `hooks` —— 会绕开并复制 Rust 的 settings.json 运行时。

### 内置 Agent 事件映射（Rust）

`hooks/classify.rs` 是对转发的 SDK 消息的纯函数分类器（穷尽测试）：

- `system/init` → SessionStart；`system/compact_boundary` → PostCompact；`system/notification` → Notification；`system/task_started` → TaskCreated；`system/task_notification` → TaskCompleted + SubagentStop。
- `result/success` → Stop；`result/error_*` → StopFailure；`tool_use_summary` → PostToolBatch；`session_ended` → SessionEnd（带 error 时附加 StopFailure）。
- assistant 的 `tool_use` 块按会话记录；匹配的 `tool_result`（user）块触发 PostToolUse，`is_error` 时触发 PostToolUseFailure。
- `PermissionRequest` + `PermissionDenied` 在 `permission_request` 路径上与既有 PreToolUse 一同触发。

观察型 hook 可贡献 `additionalContext`（以紧凑日志行呈现），但无法在流中途重新注入；阻断仅保留在权限往返上。

### 外部 Agent 映射（TS）

`lib/ai/agent/external/agent-hooks.ts` 按 `ExternalAgentEvent` 触发：SessionStart、PostToolUse/Failure、Stop + SessionEnd、StopFailure，以及系统 A 的 `onExternalAgentToolCall`。在 `permission_request` 上运行阻断型 PreToolUse：`executeStreaming` 中阻断会拒绝权限并 `continue`（真正抑制）；headless `execute` 路径中仍强制拒绝（无权限 UI 可抑制）。

### Trust 门控（Rust 强制）

`hooks/trust.rs` 持有从 Dexie ledger 经 `set_trusted_workspaces` 注入的进程级可信路径集；`resolve_trusted_cwd` 仅在受信任时返回项目 `cwd`，否则 `None`（仅 user 作用域）。在 Rust 强制，使被攻陷的 renderer 无法从不受信目录加载 project/local hook。前端在启动（`HookTrustSyncProvider`）及每次 trust 变更（`trustWorkspace`/`revokeWorkspaceTrust`）后同步。

### Webhook

`hooks/webhook.rs` 实现了此前 stub 的 webhook 处理器：以配置的 headers + 超时 POST JSON payload，复用命令处理器的响应决策解析，使 `permissionDecision`/`additionalContext` 语义一致。

### 无触发源的事件

`PreCompact`、`ConfigChange`、`FileChanged`、`WorktreeCreate/Remove`、`CwdChanged`、`InstructionsLoaded`、`Elicitation(Result)`、`UserPromptExpansion`、`TeammateIdle` 当前在 Agent 路径中没有真实来源。它们在 settings 中仍可 round-trip，但在设置 UI 中**显式标注**（“暂无触发源”），而非静默 stub。

## 结果

- settings.json hook 现已在内置 Agent 与三种外部 Agent 上触发；PreToolUse 可在每条路径阻断工具。
- project/local hook 可用，但安全地以 workspace trust 门控、由 Rust 强制。
- 无 Dexie schema 变更（trust 表已存在）。
- 局限：无 `permission_request` 即自执行的外部 Agent 工具只能被观察（经 `tool_use_start`），无法阻断——这是协议边界，如实记录而非绕过。
