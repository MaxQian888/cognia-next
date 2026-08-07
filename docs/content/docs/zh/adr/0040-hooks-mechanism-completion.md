---
title: ADR-0040 — Hooks 机制完善（内置 Agent + 外部 Agent）
description: "完成Claude-Code-style settings.json hook 运行时（ADR仅布线的Phase-1 UserPromptSubmit + PreToolUse）。纯Rust分类器将内置代理的SDK事件流映射到完整的生命周期（PostToolUse/Failure、Stop/StopFailure、SessionStart/End、SubagentStop、通知、PostCompact、任务*、PermissionRequest/Denied、PostToolBatch）;薄run_agent_hook Tauri 命令让TS外部代理管理器（claude-code/codex/opencode）能够访问SAME 运行时;实现了Webhook 处理器;负载project/local-scope hook在Rust强制的工作区信任门禁背后;两个孤立的System-A插件hook（onExternalAgentToolCall / onExternalAgentPermissionRequest）是有线连接的。"
---

# ADR-0040 — Hooks 机制完善

**状态**：已接受（2026-06-01） **作者**：Max Qian + Claude Opus 4.8 **扩展**：`src-tauri/src/hooks/`阶段1 hook 运行时（仅有线`UserPromptSubmit` + `PreToolUse`）**影响**：`src-tauri/src/hooks/{mod,classify,commands,trust,webhook,command,types}.rs`、`src-tauri/src/claude/{sidecar,commands}.rs`、`src-tauri/src/lib.rs`、`lib/ai/agent/external/{agent-hooks,manager}.ts`、`lib/claude/hook-trust-sync.ts`、`lib/db/trusted-workspaces.ts`、`components/providers/hook-trust-sync-provider.tsx`、`components/settings/hooks/hooks-section.tsx`、`app/layout.tsx`、`i18n/messages/{en,zh-CN}.json`

## 背景

存在两个平行的“”hook“系统：

- **系统A**——正在进行中的插件hook（`lib/plugin/messaging/hooks-system.ts`，74+种类）。成熟，但`dispatchExternalAgentToolCall`/`dispatchExternalAgentPermissionRequest`被定义且从未调用（孤儿）。
- **系统B**——Rust（`src-tauri/src/hooks/`）中的Claude-Code-style `settings.json` hook 运行时。其自身评论标记了**第一阶段**：仅`UserPromptSubmit`（`claude_send`）和`PreToolUse`（sidecar `permission_request` 处理器）触发。其余25个事件轮转设置但未触发;webhook 处理器被触发;project/local范围从未加载（`cwd: None`硬编码）;外部代理（claude-code/codex/opencode）完全没有hook集成。

该 ADR 完成了系统 B 在内置代理 ** 和 ** 外部代理之间，并关闭了System-A孤儿。

## 决策

### 注入模型——一种运行时，有两种方式

Rust `external_agent`模块是纯粹的stdio直通：它从不解析ACP/opencode消息，因此无法看到外部代理tool/permission事件——这些事件只在TS中被解析。相比之下，内置代理的sidecar会将完整的SDK事件流转发到Rust。因此：

| Agent | 注入层 | 理由 |
|---|---|---|
| 内置（sidecar） | **Rust** — `claude::sidecar` 普通读者 + `claude_send` | Rust已经看到SDK直播并主持PreToolUse/UserPromptSubmit。 |
| 外部（claude-code/codex/opencode） | **TS** — `manager.ts`（`executeStreaming` + `execute`），新`run_agent_hook` Tauri 命令进入SAME Rust 运行时 | 只有TS拥有解析后的事件;命令会重复使用运行时而不是复制。 |
| System-A孤儿 | **TS**——`manager.ts`接缝一样 | 纯粹的进程中插件调度。 |

已拒绝：在sidecar（节点）注册SDK的原生`hooks`选项——它会绕过并复制Rust settings.json 运行时。

### 内置代理事件映射（Rust）

`hooks/classify.rs` 是对转发SDK消息进行纯粹且经过详尽测试的分类器：

- `system/init` → SessionStart;`system/compact_boundary` → PostCompact;`system/notification` →通知;`system/task_started` → TaskCreated;`system/task_notification` → TaskCompleted + SubagentStop。
- `result/success` → 停止;`result/error_*` → StopFailure;`tool_use_summary` → PostToolBatch;`session_ended` → SessionEnd（+ 错误时StopFailure）。
- 每个会话记录`tool_use`（助手）块;匹配的`tool_result`（用户）块触发PostToolUse，`is_error`时触发PostToolUseFailure。
- `PermissionRequest` + `PermissionDenied` 与`permission_request`路径上的现有PreToolUse并列射击。

观测hook可以贡献`additionalContext`（以紧凑对数线形式浮出），但不能在溪流中途重新注入;阻断保持在许可的往返状态。

### 外部代理映射（TS）

`lib/ai/agent/external/agent-hooks.ts`点火次数，按`ExternalAgentEvent`：SessionStart（`session_start`）、PostToolUse/Failure（`tool_result`）、停止+SessionEnd（`done`）、StopFailure（`error`）加上System-A `onExternalAgentToolCall`（`tool_use_start`）。在`permission_request`上运行阻挡PreToolUse：在`executeStreaming`中，阻挡拒绝许可和`continue`s（真正的抑制）;在无头 `execute`路径中，拒绝仍然被执行（没有许可，UI抑制）。

### 信任门禁（Rust强制执行）

`hooks/trust.rs` 持有一个进程全局可信路径集，通过 `set_trusted_workspaces` 从Dexie账本做种。`resolve_trusted_cwd` 只有在被信任时返回项目`cwd`，否则 `None`（仅限用户范围）。在 Rust 强制执行，使被攻破的渲染器无法从不受信任的 Dir 加载project/local hook。前端在启动时（`HookTrustSyncProvider`）和每次信任变更后（`trustWorkspace` / `revokeWorkspaceTrust`）同步账本。

### Webhook

`hooks/webhook.rs`实现了之前被 stubed 的 webhook 处理器：HTTP POST JSON 载荷 配置的头部 + 超时，重复使用命令 处理器的响应决策解析器，使`permissionDecision` / `additionalContext` 语义保持一致。

### 无触发源的事件

`PreCompact`、`ConfigChange`、`FileChanged`、`WorktreeCreate/Remove`、`CwdChanged`、`InstructionsLoaded`、`Elicitation(Result)`、`UserPromptExpansion`，`TeammateIdle`目前代理路径中没有真正的源。它们在设置中仍可往返，但会在设置UI中**明确标注**（“尚无触发源”），而不是默然触发。

## 后果

- Settings.json hook现在可以跨越内置代理和三个外部代理发射;PreToolUse可以屏蔽所有路径上的工具。
- Project/local hook可用，但安全地被工作区信任封锁，Rust强制执行。
- 没有Dexie模式更改（信任表已经存在）。
- 局限性：外部代理工具在无`permission_request`的情况下自动执行只能被观察（通过`tool_use_start`），不能被阻挡——这是协议边界，需要文档记录而非绕过。

## 补充记录（2026-08-06）——版本化能力与执行归属

对于内置 Claude Agent SDK 运行轨，上述原始注入模型已被取代。Sidecar 现在负责 SDK 原生
hook 分发，因为只有该层能完整保留 SDK 按事件区分的输入、输出、并发和中止语义。Rust
仍负责外部 Agent 与兼容性命令的执行。每个事件实例只能有一个所有者；Rust host 不得先执行
`UserPromptSubmit`，再将同一 hook 注入 SDK。

Hook 支持被定义为版本化能力矩阵，而不是单一的全局事件或 handler 列表。固定版本的
Claude Agent SDK 与其 31 个公开事件做一致性校验。Codex 和 OpenCode adapter 只发布从已安装
runtime/client 中验证过的能力。TypeScript、Rust、CLI、Settings 和 Fleet 共享事件标识与一致性门禁，
但保留每个 provider 特有的 matcher、超时、并发、阻断和输出语义。

不支持的 handler 和输出必须生成明确诊断，而不能静默忽略。旧的 `webhook` 设置仍可作为 Cognia
HTTP handler 的兼容形式读取。所有出站 HTTP/模型/MCP 路径都必须经过共享 PII 门禁；持久化 trace
只保留脱敏后的输入、决策、耗时和错误。
