---
title: "0026 — 插件扩展点扩充（v2）"
description: "新增 6 个扁平 manifest 字段、8 个运行时点位、1 个 hook（onBuildOptions）、围绕式聊天中间件（带 3 次熔断）、全局插件 modal 栈、CSS 变量主题变体、平台能力命名空间，并复活 2 个旧弃用 UI 槽。纯加法；旧的命令式 API 退化为 @deprecated shim。"
---

# ADR 0026 — 插件扩展点扩充

**状态：** Accepted
**日期：** 2026-05-19
**分支：** `feat/plugin-extension-points-v2`

---

## 背景

`cognia-next` 已经具备成熟的插件平台：23 种 capability、25 个 permission、5 类插件类型、27 个 UI 槽位、约 80 个 hook 点、按插件命名的 Dexie 表空间、消息总线、调度执行器、OCR provider 注册中心、workflow 节点+触发器注册中心，以及 16 个内置插件。

三个并发 Agent 对内置插件做了一次审计，发现 **17 个真实缺口**：要么 host 注册中心已经搭好但没有插件可用 API，要么插件靠直接 `import lib/*` 或 singleton setter 绕过。被绕过最多的：

- `github-delivery` 直接 `registerNodeExecutor` + side-effect 调用 `setGithubRuntime` / `setIssueLoopDriver` / `setE2BBackend`。
- `ocr` 插件假设 host 已经全局 `installOcrRuntime()`，没有 `ctx.ocr`。
- `e2b-sandbox` 直接 `setE2BBackend()` 注入 backend。
- `computer-use` 和 `workflow-ai` 命令式调用 `registerPluginI18n()`，明明 `manifest.i18n` 已经存在。
- 3 个插件直接 `isTauri()`，因为缺 `ctx.capabilities`。
- 没有插件能包裹 chat send 链路 (`lib/claude/build-options.ts`)，没法注册 message-part renderer、modal、CSS 变量、OCR / workspace / 内部 AI provider。

本 ADR 用 **加法** 把这些缺口补齐；旧的命令式 API 退化为 `@deprecated` shim，老插件不破。

---

## 决策

1. **覆盖范围 — 17 项全做**，分 5 阶段交付。
2. **破坏性容忍 — 加法为主**。旧命令式 API 退化为 `@deprecated` shim。
3. **权限模型 — 复用现有 25 个 `PluginPermission`**。新点位通过 `RUNTIME_POINT_PERMISSIONS` 映射到现有键。
4. **文档同步 — 新写本 ADR + plugin-dev 页面**，不动其它 ADR。
5. **阶段顺序** — 契约 → Provider 注册 → UI → Chat 中间件 → 未实装槽位 + capabilities。
6. **Manifest 形状 — 平铺到根字段**，与现有 `themes / connectors / mcpServerPresets` 等保持一致。
7. **Chat 拦截 — 围绕式中间件**：`(req, next) => Promise<Response>`，可短路。
8. **Provider 加载 — 懒加载工厂**：manifest 声明 `entry` + `export`，host 按需 dynamic-import。
9. **AI provider 边界 — 仅供插件内部使用**。主聊天链路永远走 Claude Code SDK。
10. **中间件安全网 — 每个中间件 5s 超时（最大 60s）、错误隔离、3 次连续失败熔断**。
11. **Message renderer 粒度 — 仅 message-part**。Host 拥有消息外壳。
12. **Scheduler — 复用现有基础设施**，对外曝露 `ctx.scheduler.cron / .interval / .cancel`。

---

## 交付内容

### Phase 1 · 契约

6 个新 manifest 根字段，统一采用懒加载工厂 `{ id, label, entry, export, ... }`：

| 字段                | 驱动                                        | 权限            |
| ------------------- | ------------------------------------------- | --------------- |
| `ocrProviders`      | `provider.ocr`                              | `network:fetch` |
| `workspaceBackends` | `provider.workspace-backend`                | `process:spawn` |
| `messageRenderers`  | `provider.message-renderer`                 | `extension:ui`  |
| `aiProviders`       | `provider.ai-llm` / `provider.ai-embedding` | `network:fetch` |
| `modalMounts`       | `modal.mount`                               | `extension:ui`  |
| `chatMiddlewares`   | `chat.middleware`                           | `agent:control` |

外加 `configComponent?: { entry, export }` 给每个插件提供自定义设置 UI。

8 个新 runtime 点位写入 `CANONICAL_RUNTIME_POINTS`，每个有指向注册中心 singleton 的 `binding`。`onBuildOptions` 作为新 hook 进入 canonical 列表，给只想改 SendOptions 但不需要短路的插件使用。

Validation 强制共享形状（`{ id, label, entry, export }`），加字段特定约束（`aiProviders.kind`、`messageRenderers.partType` 非保留、`chatMiddlewares.priority` 在 `[-100, 100]`、`timeoutMs` 在 `(0, 60_000]`）。路径穿越守护与 `themes-bridge` 对齐。

### Phase 2 · Provider 注册中心

`ctx.ocr` 和 `ctx.workspace` 进入 plugin context。workspace registry 把旧 `_e2bBackend` singleton 提升为 Map；`setE2BBackend` 退化为 `@deprecated` shim，以 id `"e2b"` 注册。新增 4 个 manifest 驱动桥：

- `lib/plugin/bridge/ocr-providers-bridge.ts`
- `lib/plugin/bridge/workspace-backend-bridge.ts`
- `lib/plugin/bridge/message-renderer-bridge.ts`
- `lib/plugin/bridge/ai-providers-bridge.ts`

AI-provider 桥负责把新 `PluginLlmProvider` / `PluginEmbeddingProvider` 形状适配到现有 `AIProviderDefinition`，旧设置 UI 完全保留。

### Phase 3 · UI 层

- **Modal 栈** — Zustand LIFO store + `ctx.modal.openModal()` + `<PluginModalRoot />`（在 `app/layout.tsx` 挂一次）。每个 modal 有独立 error boundary。
- **每个插件的自定义设置 UI** — `manifest.configComponent` + `config-component-bridge.ts` 懒加载 + 按插件 id 缓存。
- **Composer 下拉菜单** — `chat.input.menu` 作为新的 canonical 槽位，挂在 `components/chat/composer/bottom-toolbar.tsx`，与现有 `chat.input.actions` 并列。
- **主题 CSS 变量** — `PluginThemeContribution` 联合类型新增第三个变体 `{ cssVariables: Record<string, string> }`，`themes-bridge` 限制变量名 `^--[a-z][a-z0-9-]*$`、值长度 ≤200、拒绝 `</style>`。

### Phase 4 · Chat 中间件 + onBuildOptions

`lib/claude/chat-middleware/registry.ts`（含 3 次熔断 + 监听事件）和 `runner.ts`（Koa 风格链 + `Promise.race` 超时 + try/catch 隔离）组合成 `ctx.chat.use(middleware, { id?, priority?, timeoutMs? })`。

`PluginEventHooks.dispatchBuildOptions(options)` 跑 `onBuildOptions` 变换管道——每个插件返回 `Partial<BuildOptionsHookInput>`，dispatcher 按优先级做浅合并。需要短路的插件用 `chat.middleware`；只调字段的用 `onBuildOptions`。

### Phase 5 · Capabilities + 复活槽位 + i18n

- `ctx.capabilities`：read-only `{ tauri, mobile, web, browser, platform }`，context 创建时计算一次。
- `chat.message.actions` 复活：在消息上方挂 hover action bar，与 `chat.message.footer`（host copy/regenerate）区分。
- `settings.ai` 复活：在 `components/settings/api-key-section.tsx` 顶部挂载，给统一 AI 设置卡片提供稳定 host。
- `manifest.i18n` 在 `lib/plugin/core/manager.ts:1057-1071` 已经自动 wire 进去，本 ADR 仅记录。

### 保持 deprecated 的槽位

- `sidebar.right.top` / `sidebar.right.bottom` — host 今天没有右侧栏。
- `panel.header` / `panel.footer` — host 没有通用 panel-shell 包装组件。

---

## 一线插件迁移路径

旧链路通过 shim 仍可用，但建议在后续 PR 迁移：

| 插件                                                      | 旧                                     | 新                                                                     |
| --------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `plugins/ocr`                                             | 全局 `installOcrRuntime()`             | `ctx.ocr.registerProvider(...)` 或 `manifest.ocrProviders[]`           |
| `plugins/e2b-sandbox`                                     | `setE2BBackend()`                      | `ctx.workspace.registerBackend(...)` 或 `manifest.workspaceBackends[]` |
| `plugins/github-delivery`                                 | side-effect `registerNodeExecutor` ×12 | `manifest.workflows.nodes[]`（类型已存在）                             |
| `plugins/computer-use`                                    | `registerPluginI18n()` 命令式          | `manifest.i18n`（已自动 wire）                                         |
| `plugins/workflow-ai`                                     | `registerPluginI18n()` 命令式          | `manifest.i18n`                                                        |
| `plugins/{clipboard-history, web-tools, workspace-tools}` | 直接 `isTauri()`                       | `ctx.capabilities.tauri`                                               |

---

## 风险

- **R1 — 中间件叠加引入延迟。** 5s 默认 + 60s 上限超时；runner 报告 per-turn 超时清单。
- **R2 — github-delivery 迁移回归。** 旧 side-effect 路径保留为 `@deprecated`；节点注册变更 opt-in。
- **R3 — 主题 CSS 注入逃逸。** 仅限 CSS 自定义属性映射，正则校验 + 长度上限 + `</style>` 拒绝。
- **R4 — AI provider 范围蔓延。** 锁定插件内部用途；`chat.middleware` 经 `agent:control` 权限 + 熔断器。
- **R5 — 槽位复活漂移。** `chat.message.actions` + `settings.ai` 复活，host JSX mount 在同一 changeset 内加入。

---

## 不在范围

- 移动端 signaling / WebRTC 插件整合。
- VS Code 扩展复用层扩展。
- 插件市场 install-from-URL。
- 把 workspace-backend registry 从 `lib/github/` 移出到 `lib/workspace/`。
- 复活 `sidebar.right.*` / `panel.header` / `panel.footer`。

## 2026-07 修订 — Context Workbench

[ADR-0083](./0083-context-workbench) 建立了本 ADR 通过时尚不存在的共享右侧宿主，因此取代上面两处槽位结论：

- `sidebar.right.top`、`sidebar.right.bottom`、`panel.header`、`panel.footer` 已在 `ContextWorkbench` 实装，并接收清洗后的资源上下文。
- `manifest.contextPanels` 以懒加载 `{ id, entry, export }` 方式贡献可信 React 面板，包括资源类型、canonical activity、插件本地 `labelKey` 与必填 `label` fallback、安全 icon、capabilities、preferred mode 和 retention。
- `ctx.contextPanels` 提供 `register`、受控 `reveal`、清洗后的 `getActiveContext` 与 `onDidChangeActiveContext`。
- 面板要求 `extension:ui` 与对应资源 read 权限。权限变化会立即重算可用性，disable/uninstall 会清理贡献。
- Sandboxed Webview 面板仍不在范围内。
