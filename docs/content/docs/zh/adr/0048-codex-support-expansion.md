---
title: "ADR-0048 — Codex 支持扩展（用量跟踪 · 聊天提供商 · ACP 保真度）"
description: "扩展OpenAI Codex支持，超越现有的 凭证 重用 + ACP-execution 层：在 Anthropic 对等性 添加背景usage/limits追踪，使Codex成为一流聊天提供商，支持ChatGPT-login模式（ChatGPT 后端响应 API + 头部）和 api_key 模式，并加固ACP permission-mode/terminal-write保真度差距。记录先前研究、纠正传输设计的openai/codex上游研究，以及批准的D→B→C计划。"
---

# ADR-0048 — Codex 支持扩展（用量跟踪 · 聊天提供商 · ACP 保真度）

**状态**：已接受（2026-06-18）**作者**：Max Qian + Claude Opus 4.8 **基于**：ADR-0025（统一订阅金库;Codex 凭证重用）、ADR-0010（使用跟踪管道）、ADR-0043（LLM 提供商执行/管道`resolveSendOptions` 凭证）以及外部代理 ACP层（`lib/ai/agent/external/`、`src-tauri/src/external_agent/`）。

## 背景

Codex在这项工作之前已经**成熟于三层**，由先前ADRs确立，并通过只读研究扫描确认：

- **凭证 / 订阅重用**（ADR-0025）：`lib/subscription/codex/` + `src-tauri/src/subscription/codex/` — 发现`~/.codex/auth.json`和Codex-CLI的密钥环、设备代码OAuth、ChatGPT-bearer与API-key模式、多账户保险库、预设、云同步。
- **ACP执行**：`AgentRuntime="external"`通过`npx @zed-industries/codex-acp` Codex ACP/stdio（唯一的*可执行*预设）运行。
- **配置互操作**：MCP-server同步到`~/.codex/config.toml`，subagent导入，TUI主题重用。

研究发现了三个真实的空白，本书ADR对此进行了充分的解决，且未遗漏或简化：

- **B — 使用跟踪**：无背景usage/limits循环（Anthropic有一个）;按需限制源误解析了后端响应形状。
- **C — 聊天提供商**：Codex 不能作为聊天模型选择——只有外部代理路径可以运行;它在`packages/provider-core`和内置的提供商目录中都没有出现。
- **D — ACP保真度**：权限模式被输入但未被`plan`/`dontAsk`，`acceptEdits`仅覆盖写入，缺少`terminal/write` 处理器，Rust terminal/process模块无测试。

### 上游研究（`openai/codex`）塑造了设计

- **ChatGPT-login 传输** 在ChatGPT后端使用 **Responses API**（`https://chatgpt.com/backend-api/codex`），** not** `api.openai.com/v1`;`chat/completions`被移除。它需要`Authorization: Bearer`、`ChatGPT-Account-Id`、`Originator`、`OAI-Product-Sku: codex`、`OpenAI-Beta`、`User-Agent: codex-cli`。这纠正了最初的错误假设，也是C阶段的核心。
- **速率限制**：`RateLimitSnapshot { primary, secondary, credits }`，每个窗口 `{ used_percent, window_minutes, resets_at }` —— 驱动了 Phase B 源修复（之前代码已读 `reset_at`，省略 `window_minutes`）。
- **Native `codex app-server`**（JSON-RPC `thread/start` / `turn/start` / `item/*` approvals）作为 zed-codex-acp shim 的第一方替代方案存在——作为未来作品录制;这条山口加固了现有的ACP路径。

## 决策

将这三个间隙作为**独立、风险递增的阶段（D → B → C）**实现，每个阶段都有自己的提交，并有共址的测试和门禁。聊天提供商支持涵盖**两种**认证模式（不简化）。

### D阶段——ACP执行忠实度
`lib/ai/agent/external/acp-client.ts`：尊重`plan`和拒绝`dontAsk`（自动拒绝无UI——`plan`=不执行，`dontAsk`=除非事先批准否则拒绝）;扩展`acceptEdits`自动批准read/list操作（副作用类仍提示）;添加`terminal/write` 处理器（代理到现有`acpTerminalWrite`原生绑定）。把缺失的`#[cfg(test)]`模块加入`src-tauri/src/external_agent/{terminal,process}.rs`。

### B阶段——Codex usage/limits追踪（人形对等性）
修复`lib/subscription/limits/sources/codex.ts`解析`resets_at` + `window_minutes`（保留遗留回退）。添加`probeCodexUsage`（统一`queryAccountLimits`+`recordLimitsSnapshot`的薄包装）和一个可视化感知`startCodexUsageScheduler`重用共享的踏频底。启动时通过`CodexUsageSchedulerInitializer`挂载（仅桌面，`probeEnabled`自门），这样可以访问，而不是休眠。接口 探针控制在Codex订阅标签中，双语。不改动地重用整个`providerLimits`持久化+光量渲染栈。

### C阶段——Codex一流的聊天平台提供商
注册`codex`在`BUILT_IN_PROVIDER_IDS`+目录+`PROVIDERS`元数据中（通过目录快速添加快捷方式，类似opencode 接口）。添加 `resolveCodexVaultCredential`（镜像 opencode 聊天桥）：**api_key** →真OpenAI;**chatgpt** → ChatGPT后端 + 所需头部;预设baseUrl覆盖了这两种情况。强制提供商核客户端和sidecar适配器的Codex响应API（ChatGPT后端主机不`*.openai.com`，所以真正的端点检查会错误地选择聊天完成）。端到端线程新的`providerCredentials.headers`字段：`resolveSendOptions` → 个Rust `ProviderCredentials`结构（严格类型结构体会在边界处丢弃它）到sidecar `createOpenAI`→。

## 后果

- 重复使用的ChatGPT Codex订阅（或OpenAI API密钥）可以直接在聊天中使用，无需额外设置——这和Anthropic/OpenCode订阅路径已经具备的便利性一样——并且可以作为后台使用量表使用。
- 聊天发送`codex`通过与其他提供商相同的**PII编辑门禁**（仅凭证解析;无新发送路径）。
- `providerCredentials.headers`现在是其他对头敏感提供商可以重复使用的通用功能。
- 超出范围（未来）：原生`codex app-server`适配器;Codex credit/balance除窗口使用外的适配器;claude-code/gemini-cli/cursor-cli预设的可运行生成定义。

## 验证

Jest 316 / 11组曲;sidecar `node --test` 63;Rust `cargo test` 14;typecheck 0 新增于已有开发基线的错误;ESLint干净;i18N键对等性+排序OK;六个项目审计员（测试-缺口、I18N、静态-出口、Tauri-Rust、PII-门禁、布线）干净利落。
