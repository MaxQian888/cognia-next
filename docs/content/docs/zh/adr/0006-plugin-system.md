---
title: "ADR 0006：插件系统补完"
description: "把插件运行时接入 Cognia-next 的用户可见表面——设置、/plugins 路由、市场、composer、claude 适配器、内建插件。"
---

## 状态

已接受，2026-05。

## 背景

仓库已经在 `lib/plugin/` 下交付了一个 75 文件的插件运行时（API 表面、hook
分派器、沙箱、权限守卫、签名校验器、限流器、生命周期 hook）。数据库 schema v15
新增了五张插件表（`plugins`、`pluginPermissions`、`pluginReviews`、
`pluginAnalytics`、`pluginScheduledJobs`）。缺失的是：

- 没有插件的设置入口，没有 `/plugins` 路由，没有 UI 组件。
- SDK 消息泵（`hooks/chat/use-claude-chat.ts`）和请求构建处
  （`lib/claude/build-options.ts`）忽略了插件生命周期 hook 分派器。
- chat composer 不渲染插件贡献的扩展槽，也不暴露插件斜杠命令。
- 六个被宣称的内建插件里有三个是带 `runtime.browser.unsupported` 诊断的空 manifest
  外壳。
- 市场入口路径分别为技能走 `lib/skills/marketplace-install`、为插件走
  `lib/plugin/package/marketplace`，这意味着统一的店面无法同时承载两类内容。

任务简报（`hi-lovely-clover.md`）要求一个「完整、无捷径」、能与既有系统干净集成的
实现。

## 决策

### 1. 市场合并 —— 方案 C

插件复用技能市场作为面向用户的店面。我们按
`MarketplaceItem.type: "skill" | "plugin"` 区分，并在
`installMarketplaceItem` / `uninstallMarketplaceItem` 内部分派：

```ts
if (item.type === "plugin") {
  const { getPluginMarketplace } = await import("@/lib/plugin/package/marketplace")
  await getPluginMarketplace().installPlugin(item.pluginId ?? item.sourceId, item.version)
  return { kind: "plugin", pluginId, installed: true }
}
// …skills path unchanged
```

插件市场运行时仍是插件安装的事实来源（依赖解析、冲突检测、签名校验）。技能市场
只是路由请求。

否决的备选方案：

- **方案 A —— 共享 `lib/marketplace-shared`**：将要求统一类型系统，损害用户表达过的
  「复制并改写」偏好。
- **方案 B —— 让两者完全独立**：让用户面对两个店面去发现同样的内容。

### 2. 权限 UX —— manifest 授予 + 运行时对话框

在 `manifest.permissions[]` 中声明的权限会在安装时静默授予
（`PluginManager.installPlugin` 调用 `permissionGuard.registerPlugin`）。
`manifest.optionalPermissions[]` 与运行时请求的权限走 `permission-requests.ts`，
它通过对话框提示用户。危险权限
（`shell:execute`、`process:spawn`、`python:execute`、`filesystem:write`）
在整个权限 UI 中以红色高亮。

### 3. Configure 标签页 —— JSON-Schema 驱动的表单

`/plugins` 带有一个 `Configure` 标签页（按插件），它内省 `manifest.configSchema`
并渲染一个 shadcn 驱动的表单。支持
`string`、`number`、`boolean`、`enum`（`string` + `enum`）、`array<string>`。
不支持的字段形状降级为原始 JSON 预览，而不是崩溃。持久化使用 `setPluginConfig`；
管理器在下次激活时拾取新值。

### 4. 内建插件

cognia-next 随附六个内建插件：

| 插件                       | 状态                    | 表面                                                                                                                     |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cognia-clipboard-tools`   | 已存在                  | `clipboard_status`                                                                                                       |
| `cognia-workspace-tools`   | 空壳 → 完整实现         | `workspace_list_files` / `workspace_read_file` / `workspace_search`（浏览器兜底返回 `desktop-only` 诊断）                |
| `cognia-web-tools`         | 空壳 → 完整实现         | `web_fetch` / `web_download`（浏览器兜底到 `<a download>`，桌面经 Tauri fs 写入）                                        |
| `cognia-screenshot`        | 新增                    | `take_screenshot` agent 工具 + `/screenshot` 斜杠命令                                                                    |
| `cognia-prompt-templates`  | 新增                    | `/template`、`/template-add`、`/template-remove`、`/template-list` 斜杠命令；模板持久化在插件存储中                       |
| `cognia-clipboard-history` | 新增                    | `clipboard_history_*` agent 工具 + `/clipboard-history` 斜杠命令；经 `setSecure`/`getSecure` 加密缓冲区                  |

`browser-builtin-registry.ts` 不再携带 `runtime.browser.unsupported` 诊断；每个条目
都有一个返回 `PluginDefinition` 的 `load` 函数。

### 5. 插件点契约

- 30 个 `CANONICAL_EXTENSION_POINTS`（27 个已实现 + 3 个弃用别名）
- 108 个 `CANONICAL_HOOK_POINTS`
- 10 个 `CANONICAL_ACTIVATION_PATTERNS`

从每个契约到消费它的宿主文件的映射维护在
`lib/plugin/contracts/extension-point-consumers.md`。`plugin-points.ts` 中的
`auditPluginPointContracts()` 函数生成一份「已验证 / 缺失证明」报告，由
Plugins → Audit 设置子标签页实时渲染。

治理有两种模式（`warn` / `block`），在 `localStorage` 中以 `cognia.plugins.policy`
键持久化。

### 6. composer 集成

- 插件斜杠命令流经 `lib/chat/slash-command-registry` 的 `source: "plugin"` 通道；
  `composer.tsx` 把它们改写成旧的 `SlashCommand` 形状，使既有的 popover 能把它们
  与内建命令并列渲染。
- `chat.input.above` 与 `chat.input.below` 扩展槽包裹 composer 主体。
  `chat.input.actions` 向底部工具栏注入至多 3 个插件工具栏项。
- 插件抛出的扩展隔离在按扩展的 `ErrorBoundary` 之后，使崩溃的插件无法拖垮聊天。

### 7. Claude SDK 集成

`lib/claude/adapter-hooks.ts` 用一个 `hasListeners()` 短路包裹来自生命周期分派器的
每个 `dispatchOn*`。今天有三个集成点会触发：

- `dispatchUserPromptSubmit` —— 在 `sendPrompt` 之前触发。可阻止、修改或放行。
- `dispatchChatError` —— 在带错误的 `session_ended` 上触发。
- `dispatchPostChatReceive` —— 在助手轮次封口时触发。

`lib/claude/build-options.ts` 惰性 import
`getPluginAgentBridge().getPluginTools()`，并把已启用的插件工具折叠进
`SendOptions.allowedTools`。

### 8. 设置页 —— 8 个子标签页

`components/settings/sections/plugins-section.tsx` 镜像 data 区的标签式外壳：
Overview / Installed / Marketplace / Permissions / Scheduled / Devtools / Audit /
Settings。URL 状态同步到 `?pluginsTab=`。Devtools 子标签页被
`NODE_ENV === "development"` 或 `cognia.plugins.developerMode` localStorage 标志闸住。

### 9. /plugins 路由 —— 完整 M5C 表面

`app/plugins/page.tsx` 挂载 `<PluginPanel/>`。该面板由 `components/plugins/` 下
28 个新组件组成：

- 面板外壳：`plugin-panel`、`plugin-panel-context`、`plugin-panel-header`、
  `plugin-panel-tabs`、`plugin-panel-toolbar`、`plugin-panel-grid`
- 卡片与详情：`plugin-card`、`plugin-detail`、`plugin-detail-panel`、
  `plugin-marketplace-card`、`plugin-marketplace-detail`、
  `plugin-signature-badge`
- 市场：`plugin-marketplace`、`plugin-discovery`、
  `plugin-category-sidebar`、`plugin-filter-sheet`
- 对话框宿主：`plugin-delete-dialog`、`plugin-import-dialog`、
  `plugin-conflict-dialog`、`plugin-update-dialog`、
  `plugin-rollback-dialog`、`plugin-permission-review`、
  `plugin-config-form`
- 专用表面：`plugin-batch-actions-bar`、
  `plugin-scheduled-jobs`、`plugin-devtools-panel`、
  `plugin-dependency-graph`、`plugin-resource-manager`、
  `plugin-analytics`、`plugin-backup-panel`、`plugin-extension-slot`

每个组件都有一个并置的 `.test.tsx`。状态机状态存在
`stores/plugins/plugins-store.ts`；实时数据 hook 位于 `hooks/plugins/` 下。

### 10. 国际化

`plugins.*` 与 `settings.plugins.*` 命名空间被加入
`i18n/messages/en.json` 和 `i18n/messages/zh-CN.json`（每个 locale 约 280 个键，
结构 1:1 镜像）。

## 后果

- 插件运行时现在处处都有用户可见的出口：设置外壳、完整面板、composer、聊天错误
  显示。
- 技能与插件在单一店面中共存，不向用户暴露两个相互竞争的市场。
- 内建插件示范了完整的 API 表面（agent 工具、斜杠命令、安全存储、configSchema
  驱动的配置）。
- 未来增加一个新的 SDK 生命周期事件表面是机械性的——`adapter-hooks.ts` 是唯一
  需要增长的文件。

## 后续（2026-05）

一次一致性收尾清除了原始实现后遗留的五项债务：

1. **桩移除** —— `lib/plugin/index.ts` 不再随附兜底的 `pluginManager` 或重复的
   `validatePluginManifest`。唯一的规范校验器位于 `lib/plugin/core/validation.ts`，
   并从包入口 re-export。`stores/plugin-runtime/plugin-store.ts` 现在会传入当前的
   `governanceMode`，弥补了一处运行时同步的 manifest 跳过契约校验的静默缺口。
2. **静默 catch 策略** —— 12 处 `catch { /* ignore */ }` 切换为
   `recordSilentFailure`，它仅在失败属于意料之外时（即桌面模式下的 Tauri
   invoke 失败，而非预期内的 web 模式不可用）才写入诊断存储。
   `PluginPointDiagnostic` 放宽以接受新的 `"runtime"` `pointKind` 和一个
   `"plugin.silent-failure"` code，使静默失败条目与治理诊断流经同一存储。
3. **诊断面板** —— Audit 子标签页增加了一个由 `subscribePluginPointDiagnostics`
   驱动的实时「Plugin runtime diagnostics」面板，带严重度过滤和按插件清除操作。
4. **IPC 字节大小正确性** —— `messaging/ipc.ts` 现在测量真实的 UTF-8 字节长度而非
   UTF-16 码元，修复了非 ASCII 载荷上一处静默的超限放行 bug。
5. **文档漂移** —— hook 点数量从 102 更正为 108，激活模式从 11 更正为 10，与
   `plugin-points.ts` 一致。

Tauri 后端缺口（31 个没有 Rust handler 的 `plugin_*` invoke 调用）被有意推迟到
ADR 0007。在其落地之前，桌面用户会对每个绑定后端的操作看到静默失败诊断——这块
吵闹的面板就是下个周期的工作项登记表。

## 后续 #6（2026-05-09）—— 插件系统补完（ADR 0016）

ADR 0007 被主题渲染占用，因此桌面运行时缺口仍然敞开。一次新的审计发现该缺口比
估计大 2.6 倍：是 **82** 个不同的 `plugin_*` invoke 命令，而非 31 个。ADR 0016 分
五层处理：T0 校真、T1 静默 catch 迁移 + 布局修复、T2 hook 宿主接线（带显式降级）、
T3 分批的 Rust handler（3a/3g/3b/3c/3d）、T4 文档收尾。见
[ADR 0016 — Plugin System Completion](./0016-plugin-system-completion)。

## 参考

- [`lib/plugin/contracts/plugin-points.ts`](https://github.com/.../plugin-points.ts)
- [`lib/plugin/contracts/extension-point-consumers.md`](https://github.com/.../extension-point-consumers.md)
- [`stores/plugins/plugins-store.ts`](https://github.com/.../plugins-store.ts)
- [`components/plugins/`](https://github.com/.../components/plugins/)
- 计划文件：`~/.claude/plans/hi-lovely-clover.md`
