---
title: "0026 — 插件扩展点扩充（v2）"
description: "新增6个平面清单字段，8个新运行时点，1个新hook（onBuildOptions），一个带有三次触发断路器的环绕式聊天中间件接口，全局插件模态栈，CSS-variable主题变体，平台功能命名空间，并复活2个废弃的UI槽位。仅添加;遗留命令APIs变成@deprecated垫。"
---

# ADR 0026 — 插件扩展点扩充

**状态：** 已接受 **日期：** 2026-05-19 **分支：** `feat/plugin-extension-points-v2`

## 当前状态修订（2026-08-13）

当前 plugin runtime 已具备从 URL/GitHub 安装与 sandboxed WebView contribution path，不应重复实现。`workspace-backend-registry` namespace 只随 workspace owner 原子迁移；历史目录位置不代表缺少运行时功能。

---

## 背景

`cognia-next` 发布了一个成熟的插件平台——23 项功能、25 个权限、5 种插件类型、27 个规范UI槽、~80 个hook点、每个插件的 Dexie 命名空间、一条消息总线、一个调度执行器、一个OCR 提供商注册表、工作流节点 + 触发器注册表，以及 16 个第一方插件。对树内插件进行的三代理审计发现了**17个真正的漏洞**：存在_implicitly_扩展点（主机注册表是有线的，但没有面向插件的API暴露），或者插件经常通过直接`lib/*`导入和单例设置器规避。被绕过最多的绕过有：

- `github-delivery`直接导入`registerNodeExecutor` + 调用 `setGithubRuntime` / `setIssueLoopDriver` / `setE2BBackend` 作为副作用。
- `ocr`插件假设主机在激活前调用了`installOcrRuntime()`;没有`ctx.ocr` API。
- `e2b-sandbox`调用`setE2BBackend()`来布线其工作区后端。
- `computer-use`和`workflow-ai`在`registerPluginI18n()`已经存在时`manifest.i18n`必然呼唤。
- 有三个插件直接调用`isTauri()`，因为没有`ctx.capabilities`。
- 没有任何插件能对聊天发送流水线（`lib/claude/build-options.ts`）、注册自定义消息部分渲染器、注册自定义模态、注入CSS变量，或注册OCR 提供商/工作区后端/AI助手。

这ADR通过**加法**的修改填补了这些空白，使现有的命令式APIs仍作为 `@deprecated` 的 shim。旧的树内插件会持续编译;新插件使用新的声明路径。

---

## 决策

1. **范围——全部17个空档**，分阶段投递（1→5）。
2. **防断裂——仅添加剂**。传统必然APIs成为`@deprecated`衬垫，授权新路径。
3. **权限模型——重用现有的25个`PluginPermission`值**;新合约通过`RUNTIME_POINT_PERMISSIONS`（`lib/plugin/contracts/plugin-points.ts`）映射到现有键。
4. **文档 — 新建ADR（此文件）+ 插件开发页面**。请勿触碰其他 ADRs。
5. **相位顺序**——聊天中间件→ 提供商 → UI →合约，→未实现的时隙+功能。
6. **显现形状——平坦的根田**，与现有`themes / connectors / mcpServerPresets / lspServers / skills / dexie / workflows / i18n`风格相符。
7. **聊天拦截——围绕中间件**，`(req, next) => Promise<Response>`;完全控制构建选项+助手转动。
8. **提供商 loading — 懒惰工厂。** Manifest 声明 `entry`（路径）+ `export`（函数名）;只有当注册表要求提供商时，Host 才会动态导入。
9. **AI 提供商范围——仅插件内部。** 主聊天循环保持在Claude Code SDK内部。分为`provider.ai-llm`+`provider.ai-embedding`。
10. **中间件安全网——每个中间件超时**（默认5秒，最多60秒），错误隔离（一次抛出会跳过该中间件），三次连续故障断路器，禁用插件并通知用户。
11. **消息表示器粒度——仅限消息部分。** 主机拥有消息 Chrome。
12. **调度器 — 重复利用现有基础设施**;暴露`ctx.scheduler.cron / .interval / .cancel`。

---

## 降落了什么

### 第一阶段 ·合同（`types/plugin/*`、`lib/plugin/contracts/plugin-points.ts`、`lib/plugin/core/validation.ts`）

六个新的平坦清单田，呈懒散工厂形状`{ id, label, entry, export, ... }`：

| 场地 | 驾驶 | 许可 |
| ------------------- | ------------------------------------------- | --------------- |
| `ocrProviders` | `provider.ocr` | `network:fetch` |
| `workspaceBackends` | `provider.workspace-backend` | `process:spawn` |
| `messageRenderers` | `provider.message-renderer` | `extension:ui` |
| `aiProviders` | `provider.ai-llm` / `provider.ai-embedding` | `network:fetch` |
| `modalMounts` | `modal.mount` | `extension:ui` |
| `chatMiddlewares` | `chat.middleware` | `agent:control` |

另外每个插件的自定义设置`configComponent?: { entry, export }` UI。

新增了八个运行时点，每个`CANONICAL_RUNTIME_POINTS`点有一个`binding`字段指向拥有贡献的注册单例。一个新的hook（`onBuildOptions`），用于只需转换`SendOptions`而不短路链的插件。

验证强制执行共享形状规则（`{ id, label, entry, export }`）以及字段特定的附加内容（例如`aiProviders.kind`判别规则，`messageRenderers.partType`非保留规则，`[-100, 100]`中`chatMiddlewares.priority`，`(0, 60_000]`中`chatMiddlewares.timeoutMs`）。路径穿越守卫镜像`themes-bridge`。

### 第二阶段 ·提供商登记册

`ctx.ocr`（`lib/plugin/api/ocr-api.ts`）和`ctx.workspace`（`lib/plugin/api/workspace-api.ts`）加入插件上下文。工作区注册表（`lib/github/workspace-backend-registry.ts`）将遗留单例推广`_e2bBackend`——`setE2BBackend`成为一个`@deprecated` shim，在id `"e2b"`下注册。四个新的清单驱动桥接：

- `lib/plugin/bridge/ocr-providers-bridge.ts`
- `lib/plugin/bridge/workspace-backend-bridge.ts`
- `lib/plugin/bridge/message-renderer-bridge.ts`
- `lib/plugin/bridge/ai-providers-bridge.ts`

AI-provider桥将新的`PluginLlmProvider`/`PluginEmbeddingProvider`形状调整到现有的主机`AIProviderDefinition`形状（`createAIProviderAPI`），使现有的settings-UI投影继续有效。

### 第三阶段 ·UI 接口

- **模态堆栈** — `stores/plugin-runtime/plugin-modal-store.ts`（Zustand LIFO）、`lib/plugin/api/modal-api.ts`（`ctx.modal.openModal()`），`components/plugins/plugin-modal-root.tsx`在`app/layout.tsx`中挂载一次。每个模态的错误边界镜像`<PluginExtensionSlot>`。
- **每个插件设置 UI** — `manifest.configComponent` + `lib/plugin/bridge/config-component-bridge.ts`（懒惰加载 + per-pluginId缓存）。
- **Composer下拉组** — `chat.input.menu`规范扩展点;安装在`components/chat/composer/bottom-toolbar.tsx`，紧邻现有`chat.input.actions`槽。
- **主题CSS变量**——第三个并`PluginThemeContribution`变体`{ cssVariables: Record<string, string> }`;`themes-bridge`将名称净化至`^--[a-z][a-z0-9-]*$`，值为≤200字元，拒绝`</style>`。

### 第四阶段 ·聊天中间件 + onBuildOptions

`lib/claude/chat-middleware/registry.ts`（带有三击断路器+监听事件的注册表）和`lib/claude/chat-middleware/runner.ts`（类似Koa的链跑器，`Promise.race`-driven超时+try/catch隔离）组成`ctx.chat.use(middleware, { id?, priority?, timeoutMs? })`。插件清单条目（`chatMiddlewares[]`）在后续迁移中会通过桥接层流动;命令路径是v1 接口。

`PluginEventHooks.dispatchBuildOptions(options)`（在`lib/plugin/messaging/hooks-system.ts`中）运行`onBuildOptions`变换流水线——每个插件返回一个`Partial<BuildOptionsHookInput>`;调度器按优先顺序在每个字段进行浅层合并。需要短路控制流的插件使用`chat.middleware`;仅调整选项指令的插件使用`onBuildOptions`。

### 第五阶段 ·能力 + 复活槽位 + i18n

- `ctx.capabilities` （`lib/plugin/api/capabilities-api.ts`） — 只读`{ tauri, mobile, web, browser, platform }`在上下文创建时计算一次。
- `chat.message.actions`复活——悬浮动作条安装在`components/chat/message-renderer.tsx`中，与`chat.message.footer`主动作列不同。
- `settings.ai`复兴——安装在`components/settings/api-key-section.tsx`顶部，这样发布统一AI-settings卡的插件就有一个稳定的主机。
- `manifest.i18n`自动钢丝已经在`lib/plugin/core/manager.ts:1057-1071`;为完整性在此记录。

### 那些**保持弃用**的老虎机

- `sidebar.right.top` / `sidebar.right.bottom`——如今主机中已无右轨接口;复活它们需要发明本ADR不提出的接口。
- `panel.header` / `panel.footer` — 没有通用的面板壳包裹;复活需要发明一种。

---

## 插件权限门禁

插件权限保持不变。新的运行时点通过 `lib/plugin/contracts/plugin-points.ts` 中的 `RUNTIME_POINT_PERMISSIONS` 重用现有权限键。不会引入新的权限字符串——当插件声明新 manifest 块时，隐含要求桥接器 运行时 检查所需的相同权限集。

---

## 第一方插件的迁移路径

这些插件目前通过遗留垫片仍然正常工作，但后续版本应会迁移：

| 插件 | 来自 | 前往 |
| --------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `plugins/ocr` | 全球性 `installOcrRuntime()` | `ctx.ocr.registerProvider(...)`或`manifest.ocrProviders[]` |
| `plugins/e2b-sandbox` | `setE2BBackend()` | `ctx.workspace.registerBackend(...)`或`manifest.workspaceBackends[]` |
| `plugins/github-delivery` | 副作用`registerNodeExecutor`（×12） | `manifest.workflows.nodes[]`（已输入） |
| `plugins/computer-use` | `registerPluginI18n()`必然 | `manifest.i18n`（自动接线） |
| `plugins/workflow-ai` | `registerPluginI18n()`必然 | `manifest.i18n`（自动接线） |
| `plugins/{clipboard-history, web-tools, workspace-tools}` | `isTauri()`直接进口 | `ctx.capabilities.tauri` |

---

## 风险 + 缓解措施

- **R1 — 中间件引起的延迟。** 缓解措施：每个中间件超时5秒，审计遥测暴露p99链延迟，运行报告每回合包含`timedOut`。
- **R2 — github-delivery迁移回归。** 缓解措施：遗留副作用导入仍滞后`@deprecated`;节点注册表的更改是每个插件的选择加入。
- **R3 — 主题CSS注入逃逸。** 缓解措施：限制为CSS变量映射，正则表达式验证名称、长度上限值`</style>` 已拒绝。
- **R4 — AI 提供商范围蔓延。** 缓解措施：锁定插件内部使用（`ctx.ai.complete`）;主聊天流水线从未解决插件提供商。绕中间件路径（`chat.middleware`）是通往主聊天流的唯一批准路径，且由`agent:control`+三次触发断路器限制。
- **R5 — 槽位不弃用漂移。** 两个插槽（`chat.message.actions`、`settings.ai`）已反转弃用→实现;两者都绑定在同一变更集中添加的主机JSX挂载。

---

## 超出范围

- 移动信令/WebRTC插件集成（独立子系统）。
- VS 代码扩展再利用层扩展（独立图纸）。
- 插件市场install-from-URL。
- 将工作区后端注册表从`lib/github/`提升到`lib/workspace/`命名空间。
- 复活`sidebar.right.*` / `panel.header` / `panel.footer`（没有宿主接口存在）。

## 2026-07年修订——背景工作台

[ADR-0083](./0083-context-workbench) 创建了该ADR 已接受时不存在的共享右侧主机。因此，它取代了上述两个插槽决策：

- `sidebar.right.top`、`sidebar.right.bottom`、`panel.header`和`panel.footer`均以`ContextWorkbench`实现，并获得经过净化的资源上下文。
- `manifest.contextPanels` 添加了懒惰`{ id, entry, export }`可信的 React 贡献，包括资源类型、规范活动、插件本地`labelKey`及必需`label` 回退、安全图标、能力、首选模式和保留。
- `ctx.contextPanels`暴露`register`、受控`reveal`、消毒`getActiveContext`和`onDidChangeActiveContext`。
- 面板需要`extension:ui`及相应的资源读取权限。权限变更会立即重新解析可用性;禁用和卸载，移除贡献。
- 沙盒Webview面板依然超出范围。

## 2026-07-26 修订——`tool-renderer`能力

这个`messageRenderers` ADR作为*插件渲染接缝“发布，显示插件的自定义输出是自定义`part.type`。这个读数有漏洞：**工具调用不是自定义零件类型。**

工具结果以 `tool-<name>` / `dynamic-tool` 形式出现，且两者都是主机拥有的——`message-part-api.ts` 保留 `tool-` 前缀，并且`message-renderer.tsx`在查询插件零件注册表之前，将每个工具零件路由经过 `renderToolPart`。因此，自带 MCP 工具的插件永远无法将自己的结果渲染成超过 `McpContentBlocksCard` / `ToolBody` 的丰富内容，而第一方工具则在 `mcp-tool-card.tsx` 年中从硬编码表中获得专用卡。漏洞出在合同中，而非单一实现。

`tool-renderer`关闭它，逐条镜像`message-renderer`链接：

- `manifest.toolRenderers[]`——懒惰`{ toolName, entry, export, label? }`，由`lib/plugin/bridge/tool-renderer-bridge.ts`解决并通过`module-bridge-map.ts`的 `tool-renderer` 条目发送（所以禁用时间拆解是免费的）。
- `ctx.toolResult.registerToolResultRenderer(toolName, component)` —— 命令式路径，适用于无法获取独立条目文件的内置插件。
- `lib/plugin/api/tool-result-renderers.ts` — 注册表，基于`bareToolName(...)`，因此一个注册同时涵盖了扁平的AI-SDK名称和命名空格的`mcp__cognia-plugin-tools__*`表单。
- 许可门禁 `extension:ui`，匹配`message-renderer`。

有两个值得记录的决定，因为它们很容易在相反方向上犯错：

**优先级取代保留的名称列表。** 首先会参考主机内置的卡片表，因此注册`Read`的插件是惰性的，而非已拒绝。插件API内内置工具名称的第二份副本，必然会与真实列表偏离——这正是这个仓库不断付出的代价。排序是保证;API只会警告。

**`isStructuredMcpToolPart`必须学习注册表。** 该谓词决定了工具部件是否能到达`MCPToolCard`。注册卡而不加宽，会产生一个完整构建、经过充分测试、永久无法访问的功能——正是工作规则中提到的休眠状态。现在该功能对插件声称的工具恢复为真，`MCPToolCard`和`MessageRenderer`都通过`useSyncExternalStore`订阅注册表，因此启用插件会重新绘制已渲染的消息，而无需重新加载。

**以JSX方式渲染，而非调用函数。**内置`McpCardWithFallback`直接调用其卡，以便检测`null`返回并回退。插件卡则被渲染为元素：`React.ComponentType`允许`memo()`/`forwardRef()`，这些元素不可调用，支持所有组件类型比回退更重要。无法渲染载荷的插件拥有自己的空状态。
