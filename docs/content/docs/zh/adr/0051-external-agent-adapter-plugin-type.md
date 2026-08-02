---
title: "ADR-0051 — 外部智能体适配器作为动态加载的插件类型"
description: "闭合了让外部代理只剩一半插件类型的循环：预设本来就可以通过插件贡献，但赋予新代理目标行为（握手、会话生命周期、流式传输、健康状态）的协议适配器是硬编码的。添加外部代理适配器功能，使插件能在内置使用protocolAdapterRegistry中贡献全新的外部代理协议，在enable/disable register/unregister，并交付完整的动态加载代理（适配器 + 匹配预设）。"
---

# ADR-0051 — 外部智能体适配器作为动态加载的插件类型

**状态**：已接受（2026-06-20）**作者**：Max Qian + Claude Opus 4.8 **基于**构建内容**：ADR-0049（外部代理进程管理加固）、ADR-0032（代理-团队插件集成;overlay/module-bridge贡献模式）、外部代理子系统（`lib/ai/agent/external/`）和插件模块-桥调度（`lib/plugin/contracts/module-bridge-map.ts`）。

## 背景

外部代理子系统干净利落地分为**统一**层和**目标**层：

- **统一**——通用的Rust进程层（`command_resolver` →事件汇→ `kill_on_drop` →生成，ADR-0049中加固）以及预设→配置→ `addAgent`流水线。每个代理一条代码路径;没有按提供商分支。
- **被定向**——四个协议适配器（`acp`、`codex-app-server`、`opencode`、`a2a`），它们分别拥有每个协议的握手、会话生命周期、流语义、健康探针和会话扩展。

插件已经可以贡献统一的一半：`external-agent-preset`能力将配置注册为运行时覆盖层，预设则可以搭载内置协议。但**targeted**半部分是关闭的——`ExternalAgentManager.registerDefaultAdapters()`将四个适配器硬编码进`protocolAdapterRegistry`，该注册表从未暴露给插件运行时。一个`protocol`不在四者中的预设`Unsupported protocol` `addAgent`。（同名的`protocolAdapters`插件功能无关——它针对的是**LLM-provider**注册表`lib/ai/providers/protocol-adapter-registry.ts`，而非外部代理。）

所以“外部代理是一种动态加载的插件类型”这句话只有一半正确：插件可以描述它已经理解的代理在哪里，但无法教会主机一个*新的*代理协议。

## 决策

通过现有模块桥机制添加一流的**`external-agent-adapter`**插件能力——`external-agent-preset`的目标行为孪生体——使插件能够无新建Rust地交付完整、动态加载的外部代理（适配器+匹配预设）。

### 1 ·插件追踪覆盖在现有注册表上

`lib/ai/agent/external/protocol-adapter.ts`会获得一个插件叠加层（`registerPluginProtocolAdapter` / `unregisterPluginProtocolAdaptersByPlugin` + 所有者映射）。贡献的适配器注册到**同一个**，`protocolAdapterRegistry`四个内置软件使用——因此`addAgent`的 `protocolAdapterRegistry.create(protocol)`与来源无关，管理器从不分支协议是主机还是插件提供。注册时会以`${pluginId}:${id}`命名;覆盖层拒绝覆盖内置或其他插件的协议，而插件的禁用功能则会直接移除其适配器。

### 2 ·仅编码模块桥接

`lib/plugin/bridge/external-agent-adapters-bridge.ts`（镜像LLM协议适配器桥）在渲染器（插件代码合法运行的地方）对每个导出`externalAgentAdapters[].entry`——一个`() => ProtocolAdapter`工厂——进行懒惰导入，并将其注册到覆盖层中。它连接到现场驱动的`MODULE_BRIDGE_CAPABILITIES`地图，因此经理的调度enable/disable会自动接收。祈祷双生`ctx.agent.registerExternalAgentAdapter(id, factory)`涵盖了激活时间注册。

### 3 ·注册表感知执行门控（全链正确性）

`getExternalAgentExecutionBlock`之前阻止了任何超出静态支持范围的协议。现在它也接受当前注册在`protocolAdapterRegistry`中的协议，因此贡献的代理在其提供的插件被启用时是可执行的，并且在插件被禁用且适配器未注册后，代理会正确恢复到被阻断且明确说明的状态（“启用贡献它的插件”）。`addAgent`的未知协议错误同样件识别。

### 4 ·一类合同 + 参考书

`PLUGIN_CAPABILITY_CONTRACTS`条目（`support: "supported"`）携带主机绑定、TS + Python SDK 辅助工具（`defineExternalAgentAdapter` / `define_external_agent_adapter`）以及参考插件`plugins/external-agent-adapter-example/`（一个自包含的回声适配器和匹配的预设，端到端地执行）。Rust离线linter的能力列表（`crates/cognia-cli/src/cmd_lint.rs`）与典范列表保持集合相等（由`rust-capability-parity.test.ts`保护）。

## 后果

- 插件现在可以端到端集成真正新的外部代理，而无需更改主机代码——导致外部代理仅为半个插件类型的最后一个空白被填补了。
- 产卵停留在硬化的通用Rust层（ADR-0049）;贡献的适配器只拥有渲染器端的protocol/session逻辑。进程生成从不委托给插件JS。
- 目标层现在通过一个注册表合同由主机和插件统一贡献，而统一层（进程+预设）保持不变——“统一与目标”的划分保持不变，而非模糊。
- 引用插件协议的存储代理配置在插件被禁用时会优雅地降级（明确且可操作的块状原因），而非不透明地失败。
