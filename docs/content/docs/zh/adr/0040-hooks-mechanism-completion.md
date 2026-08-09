---
title: ADR-0040 — Hooks 机制完善
description: "为 Claude Agent SDK、Codex、OpenCode 与外部 Agent 定义统一、能力感知的生命周期 Hook 架构，覆盖原生处理器、失败策略、PII 门禁、递归限制和规范审计事件。"
---

# ADR-0040 — Hooks 机制完善

**状态：** 已接受（2026-06-01），修订于 2026-08-06  
**研究记录：** `docs/research/hooks-agent-fleet-gap-analysis-2026-08-06.md`

## 背景

Cognia 历史上有两套部分重叠的系统：

- TypeScript 进程内的产品/插件 Hook；
- 从 `settings.json` 加载、兼容 Claude Code 的生命周期 Hook。

生命周期实现又分散在 Rust 兼容运行时、Node sidecar 的 SDK 事件和各外部 Agent 适配器中。这造成部分内置事件重复执行、事件目录静态且不完整、处理器支持不一致，以及出站数据保护和审计不完整。

2026-08-06 的复核依据上游一手资料，检查了固定版本 Claude Agent SDK `0.3.220`、本机 Codex `0.145.0` 和 OpenCode SDK `1.17.13`。Claude 暴露 31 个 Hook 事件；本机 Codex schema 证明 11 个。仅凭 provider 名称或版本字符串，不能证明运行时能力。

## 决策

### 一个语义核心，每条运行时路径只有一个执行者

所有原生事件先归一化为 Cognia 的规范 Hook envelope。匹配、决策、策略、脱敏、诊断和审计共用一套语义契约，但每条运行时路径只有一个执行者：

| 运行时路径 | 执行者 | 原因 |
| --- | --- | --- |
| 内置 Claude Agent SDK | Node sidecar 中的 SDK 原生 Hooks | SDK 提供完整事件与决策契约；Rust 不得预执行同一事件。 |
| Rust 兼容/外部桥接 | 通过类型化命令调用 Rust Hook 运行时 | 外部适配器已解析 provider 协议，并复用统一的设置与信任边界。 |
| 产品/插件 Hooks | 现有 TypeScript 分发 | 它仍是独立的进程内扩展 API，不是第二套生命周期执行器。 |

内置 `UserPromptSubmit` 的 Rust 重复预执行已移除；SDK 原生 callback 是内置生命周期的唯一执行者。

### 能力协商

静态 provider manifest 只是安全上限，不代表运行时已经证明支持。有效能力取以下三者交集：

1. Cognia 审计过的事件和处理器目录；
2. 已安装运行时探测到的 schema 或 SDK surface；
3. 所选 runtime adapter 已实现的控制能力。

固定版本 Claude SDK 的 31 个事件为：

`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`Notification`、`UserPromptSubmit`、`UserPromptExpansion`、`SessionStart`、`SessionEnd`、`Stop`、`StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、`PermissionRequest`、`PermissionDenied`、`Setup`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`Elicitation`、`ElicitationResult`、`ConfigChange`、`WorktreeCreate`、`WorktreeRemove`、`InstructionsLoaded`、`CwdChanged`、`FileChanged`、`DirectoryAdded`、`MessageDisplay`。

Codex 安装会调用 `codex app-server generate-json-schema`，提取 `HookEventName`，并与 Cognia 审计过的 11 事件上限求交集。探测失败时不猜测，而是降级为没有可安装的 Codex 事件。

### 处理器契约

规范处理器类型为：

- `command`：本地子进程，从 stdin 读取事件 JSON；
- `http`：出站 HTTP POST；旧 `webhook` 继续作为读取兼容别名；
- `mcp_tool`：调用一个已声明的 MCP 工具；
- `prompt`：一次模型驱动的 Hook 判断；
- `agent`：有边界的模型驱动 Agent 任务。

设置页只展示有效运行时支持的可选项。未支持的类型必须给出明确原因，不能静默显示为可用。

### 失败与安全策略

用户自定义 Hook 在超时、进程失败、网络失败或原生 adapter 不可用时 fail-open，并产生可见诊断。`policyClass: "managed"` 的受管 Hook 在相同条件下 fail-closed。

任何 `http`、`webhook`、`mcp_tool`、`prompt` 或 `agent` 处理器接收本地文本前，Cognia 都会先对序列化 payload 脱敏，再执行深层残余 PII 检查。若仍检测到敏感内容，则阻止出站调用。

项目/本地范围设置仍必须通过 Rust 强制的可信工作区门禁。工作区不受信任或尚未同步时，只加载用户范围 Hook。

### 模型驱动处理器

原生处理器通过固定版本 Claude Agent SDK adapter 执行，并满足：

- prompt 注入 `<hook-origin depth="1" />`；
- 使用 `settingSources: []` 且不注册嵌套 Hooks，从结构上阻止递归；
- turn 上限：`prompt` 为 1、`mcp_tool` 为 2、`agent` 为 3；
- 共享 Hook budget governor（每个执行上下文默认上限 USD 0.25）；
- 工具收窄：`prompt` 不允许工具，`mcp_tool` 只允许指定 MCP 工具。

深度大于等于 1 时拒绝执行。预算耗尽时直接阻断，不启动未计费的模型 turn。

### 规范审计

每个匹配的处理器都会发出结构化规范 Hook 审计事件，至少包含：

- Hook id 与事件；
- provider 与处理器类型；
- 策略类别与结果；
- 延迟；
- 出站数据是否脱敏；
- 阻断原因或警告。

SDK 规范事件映射器将其持久化为 `kind: "hook"`、`phase: "completed"` 的事件。日志和 UI 提示只是投影，不是审计事实来源。

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

- 内置生命周期 Hook 不再重复执行。
- 事件与处理器选项由运行时证据决定，不再依赖 provider 名称猜测。
- Claude 当前五种处理器均通过有预算、有审计的路径执行。
- 用户定制保持 fail-open，集中管理的策略保持 fail-closed。
- 出站 Hook 无法绕过 PII 门禁。
- 外部适配器保留各自协议入口，但汇聚到相同语义决策和信任规则。
- 旧设置中的 `webhook` 继续兼容；新配置统一写入 `http`。

## 一手资料

- [Claude Code Hooks 参考](https://code.claude.com/docs/en/hooks)
- [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Codex 高级配置：Hooks](https://developers.openai.com/codex/config-advanced/#hooks)
- [OpenAI Codex](https://github.com/openai/codex)
- [OpenCode](https://github.com/anomalyco/opencode)
