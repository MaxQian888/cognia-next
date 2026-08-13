---
title: "ADR-0064 — 外部 CLI 驱动的子智能体调度补全（Claude Code / Codex / …）"
description: "完成半成功能，主代理派遣由外部CLI代理支持的子代理（Claude Code、Codex、Gemini、Cursor 等）。修复启动命令 ACP故障，使命名代理真正生成，停止无声的错误引擎降级，线程 MCP 服务器 + 实时进度进入两个调度接口（Agent Team队友 A1 和任务工具子代理 A2），优先使用原生Codex应用服务器，并为外部子代理添加一流的设置创作UI。"
---

# ADR-0064 — 外部 CLI 驱动的子智能体调度补全（Claude Code / Codex / …）

**状态**：已接受（2026-07-06）**作者**：Max Qian + Claude Opus 4.8 **构建内容**：ADR-0022（Agent Team 运行时+`dispatchTeammate`原语）、ADR-0032（Agent Team插件集成;子代理能力）、ADR-0048/0049/0051（外部代理子系统：ACP / Codex应用-服务器/OpenCode适配器、进程硬化、插件适配器类型）。

## 背景

两个调度接口允许主代理在外部CLI代理上运行子代理，且都已提交但仅完成了 ~90% 的完成：

- **A1 — Agent Team队友。** `lib/ai/agent/team/dispatch-teammate.ts`叉`TeammateChannel = "sidecar" | "text" | "external"`;non-`claude` `teammate.config.runtime`（或`externalAgentPresetIds`能力）会有`runExternalBacked()` → `ExternalAgentManager.execute()`的路由。
- **A2 — 主聊天代理的任务工具子代理。** `AgentDefinition.externalPresetId` → `lib/plugin/agent-sdk/dispatch.ts:runExternalSubagent()` →同一个管理器。

整个执行平面（管理器、四个协议适配器、加固的Rust进程层、presets/ecosystem 接口、权限级联）是生产级的，且被原封不动地重复使用。一次全面的链评发现了具体的空白，ADR无遗漏地弥补了这些空白。

## 决策

### 1 ·纠正ACP启动命令（标题修正）

`ecosystem-adapters.ts`发布的发售命令永远无法生成指定特工——已与当前ACP文档核实：

- **Claude Code** 运行`npx @anthropics/claude-code --stdio`（不存在包，无原生 ACP 条目）。Claude Code只能通过官方的Zed适配器ACP：`npx -y @zed-industries/claude-code-acp`。
- **双子座CLI**通过`--stdio`，进入交互模式并挂起;ACP入场旗帜为`--experimental-acp`。
- **光标CLI**运行一个没有ACP子指令的裸`cursor-agent`;ACP服务器通过`cursor-agent acp`开始。

Codex（`@zed-industries/codex-acp` shim 和 native `codex app-server`）已经是正确的。所有可执行预设命令现在都被锁定在参数化测试中。

### 2 ·绝不要悄无声息地降级到错误的发动机

之前有一位外部备份的队友，其CLI无法联系（browser/mobile壳体或CLI未安装），曾无信号地通过内置发动机——“Codex队友”默默地变成了Claude队友。`dispatchTeammate`现在会在回退前发出`warn`“外部运行时不可用”通知;`runExternalSubagent`（A2）会以可操作的错误为大声失败，而不是不透明度的生成失败。

### 3 ·线程MCP服务器+实时流到外部路径

这两个外部调度功能此前仅转发systemPrompt/permission/cwd/signal。他们现在还包括：

- **转发MCP服务器。** 新`resolve-acp-mcp-servers.ts`将队友的解析MCP-server ID映射到`AcpMcpServerConfig[]`（stdio → command/args/env;http/sse → url/headers），通过管理器已经读取的执行上下文传递。设计上是保守的——只有明确授予队友的身份证会被转发;外接CLI无论如何都会保留自己的MCP配置。
- **实时进度直播。** 新`external-event-progress.ts` `ExternalAgentEvent` → `CaptureStreamEvent`，外部teammate/subagent会点亮与内置面板相同的活动面板/`SubagentPart`进度，而不是只显示start/terminal标记。

模型选择是有意**不是**强制给外部CLI：Claude Code/Codex通过自己的订阅拥有自己的型号+认证，所以推送Cognia型号ID是错误的。设置UI中明确说明了这一点（“外部代理使用自己的模型和授权”）。

### 4 ·更倾向于原生Codex应用服务器

一名拥有运行时 `"codex"`的队友现在在安装`codex` CLI（通过现有`resolvePreferredCodexExecutablePresetId`探针）后升级到第一方 `codex app-server`，退回ACP垫片——与外部特工画廊的快速添加相匹配。

### 5 ·外部子代理的一级创作（A2）

主代理可以派遣外部子代理，但没有一流的“创建*子代理（只有markdown frontmatter/plugin SDK）。`SubAgentConfig`获得`externalPresetId`;`projectSubagentTemplate`将它带到可调度`AgentDefinition`;子代理模板编辑器会获得一个“外部运行时”选择器，列出所有可执行预设（双语，仅桌面提示）。共享`BUILTIN_EXECUTABLE_PRESET_IDS`（源自`EXTERNAL_AGENT_PRESETS`，无漂移）是外部运行时选矿器的唯一来源。

## 超出范围（追踪后续）

- **将`TeammateRuntime`联集扩展到每个可执行预设。** Teammate 运行时下拉菜单仍列出12个可执行CLIs中的5个;另外7个可以通过`externalAgentPresetIds`功能访问，但下拉菜单无法访问。扩大联盟是一个独立的变化：它波及整个基于`TeammateRuntime`的运行时可用性+流媒体子系统（`lib/agent-team/use-runtime-availability.ts`的详尽`Record<TeammateRuntime,…>`、`runtime-streamers.ts`、`runtime-targets.ts`、`team-runtime-dispatcher.ts`、`components/agent/workspace/members.tsx`），其中多个同时运行。推迟了，以避免在重构过程中破坏那些详尽的地图。
- **自动作曲提出外部 运行时。** 自动编排Composer从不分配外部 `runtime`;外部队友只能通过能力叠加层到达。在`ProposedTeammate` + 实体化+名单编辑器中添加经过验证的`runtime`是有界的后续操作。
- **MCP A2子代理的转发 defs.** `PluginSubagentDef`没有MCP-id列表，因此A2外部子代理依赖外部CLI自身的MCP配置。

## 后果

- 该功能宣传的外部代理——尤其是Claude Code和Codex——实际上负责启动、直播并承载团队的 MCP 工具，或者在无法使用时大声失败。
- 外部路径保持在重用且加固的管理器上作为薄路由层;没有引入执行平面复制。
- `runtime`/`externalPresetId`接缝和共享预设列表使延迟的并宽和自动合成工作成为加法变化。

## 验证

玩笑：在9个绿色套件中，共进行了207项测试（生态系统适配器、外部事件进度、resolve-acp-mcp-servers、预设、agent-sdk/dispatch、调度团队成员、解析-外部备份、子代理、子代理模板-标签）。`tsc --noEmit`：任何更改的文件都没有错误。i18N 密钥 对等性 0/0（en + zh-CN，聚合重建）。以五个独立可回退提交的形式交付。

## 当前状态修订（2026-08-13）

历史上的五 runtime 限制已经关闭。`TeammateRuntime` 消费可执行 preset catalog（明确排除不可执行的 custom/preview 条目），auto-compose 也通过同一 runtime owner 消费 external presets。兼容工作必须扩展该 catalog，不得重新引入按 runtime 分叉的 dispatch 路径。
