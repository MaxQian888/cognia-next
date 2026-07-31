---
title: "0016 — 插件系统补完"
description: "补齐 ADR 0006 遗留的桌面运行时缺口。审计发现 82 个没有 Rust 处理器的 plugin_* invoke 命令（而非 ADR 0006 估计的 31 个）、38 个已编写但缺失宿主调用点的钩子分发器，以及 8 处绕过诊断 store 的静默 catch。"
---

# ADR 0016 — 插件系统补完

**状态：** 提议中
**日期：** 2026-05-09
**后续取代：** ADR 0006 §「Tauri 后端缺口」

---

## 背景

ADR 0006 交付了插件运行时 —— `lib/plugin/` 下 75 个源文件、五张 Dexie 表、完整的 settings UI、marketplace 整合、六个内置插件、十项契约驱动的决策。其后续章节（2026-05）承认还剩一个洞：「31 个没有 Rust 处理器的 `plugin_*` invoke 调用，有意推迟到 ADR 0007」。结果 ADR 0007 转而处理了主题渲染，于是这个缺口一直敞着 —— 而且还在扩大，因为运行时不断新增 `plugin_*` invoke 站点，却没有对应的处理器轨道跟进。

一次全新的三向审计（2026-05-09）得出如下数字：

### A. Tauri 后端缺口比 ADR 0006 估计的**大 2.6 倍**

| 指标                                            | ADR 0006 后续 #5 | 现实（本次审计） | 来源                                   |
| ----------------------------------------------- | --------------------- | -------------------- | -------------------------------------- |
| TS 中不同的 `plugin_*` invoke 命令数            | 31                    | **82**               | grep `lib/plugin hooks/plugins stores` |
| Rust 中的 `plugin_*` `#[tauri::command]` 处理器 | 0                     | **0**                | `src-tauri/src/lib.rs:211-386`         |

验证命令：

```powershell
rtk grep -rEn "invoke[(<][^,]*['\"\`]plugin_[a-zA-Z_]+" lib/plugin hooks/plugins stores
rtk grep -n 'plugin_' src-tauri/src/lib.rs
```

ADR 0006 少算 51 个命令，是抽样不全所致。新发现的命令类别包括文件系统监听器（`plugin_fs_watch/unwatch`）、上下文菜单生命周期（`plugin_context_menu_register/unregister`）、快捷键注册（`plugin_shortcut_*`）、窗口操作（`plugin_window_*`）、媒体处理（`plugin_media_*`）、devtools 开发服务器（`plugin_dev_server_*`），以及 API 桥接通用命令（`plugin_api_invoke`、`plugin_api_batch_invoke`）。

在任何处理器落地之前，桌面模式下每个 `invoke('plugin_*')` 调用都会经 `recordSilentFailure` 被拒，用户对安装、启用、授权、热重载、签名校验等操作只看到一个空操作。

### B. 钩子分发覆盖缺口（108 个里有 38 个）

`lib/plugin/contracts/plugin-points.ts:167-276` 声明了 108 个 `CANONICAL_HOOK_POINTS`。`lib/plugin/messaging/hooks-system.ts` 里的分发器类（`PluginLifecycleHooks` 第 574-1067 行与 `PluginEventHooks` 第 1104-1821 行）**已经实现了每一个分发方法**，包括 `dispatchThemeModeChange`、`dispatchProjectCreate`、`dispatchCanvasContentChange`、`dispatchWorkflowStart`、`dispatchExternalAgent*`、`dispatchMCP*`。缺的是**宿主调用点**：主题 store 从不调用 `dispatchThemeModeChange`，画布 store 从不调用 `dispatchCanvasContentChange`，诸如此类。`lib/plugin/contracts/runtime-proof-audit.ts` 里的证明审计因为绑定元数据存在而把它们标为「已验证」；可运行时实际上是哑的。

如今没有宿主接线的类别：

- 主题（3）：`onThemeModeChange`、`onColorPresetChange`、`onCustomThemeActivate`
- 项目 / 知识库（6）：`onProjectCreate/Update/Delete/Switch`、`onKnowledgeFileAdd/Remove`
- 画布（8）：`onCanvasCreate/Update/Delete/Switch/ContentChange/VersionSave/VersionRestore/Selection`
- 制品（2 个部分接线）：`onArtifactExecute`、`onArtifactExport`
- 导出（3 + 2）：`onExportStart/Complete/Transform`、`onProjectExportStart/Complete`
- RAG / 向量（3）：`onDocumentsIndexed`、`onVectorSearch`、`onRAGContextRetrieved`（部分 —— 仅 RAG 路径在 `lib/plugin/bridge/workflow-integration.ts:145-159` 中接线）
- 工作流（4）：`onWorkflowStart/StepComplete/Complete/Error`
- UI 交互（5）：`onSidebarToggle`、`onPanelOpen/Close`、`onShortcut`、`onContextMenuShow`
- 外部 Agent（7 个部分接线）：`onExternalAgent*` —— 在 `hooks/agent/use-external-agent.ts` 中部分接线
- 代码执行（3）：`onCodeExecutionStart/Complete/Error`
- MCP（4）：`onMCPServerConnect/Disconnect`、`onMCPToolCall/Result`

其中一部分会被降级（见决策 §3），因为宿主事件源确实尚不存在。

### C. 静默 catch 泄漏（8 处）

ADR 0006 后续 #2 把 12 个 `catch { /* ignore */ }` 站点迁移到了 `recordSilentFailure`，但后来对 `lib/plugin/core/context.ts` 的新增又重新引入了裸 catch 或只记日志的 catch。经 Read 验证的站点：

| 文件:行                                     | 模式                                             | 站点名                            |
| ------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `lib/plugin/core/context.ts:357-367`        | `plugin_show_notification` 周围的裸 try/catch    | `ui.showNotification`             |
| `lib/plugin/core/context.ts:592-617`        | `plugin_python_import` 处的隐式 catch            | `python.import`                   |
| `lib/plugin/core/context.ts:869-889`        | `.catch(loggers.manager.error)` × 2              | `fs.watch`、`fs.unwatch`          |
| `lib/plugin/core/context.ts:1024-1048`      | `.catch(loggers.sandbox.error)` × 2              | `shell.spawn`、`process.kill`     |
| `lib/plugin/core/context.ts:1124-1136`      | `.catch(...)` × 2                                | `shortcut.register/unregister`    |
| `lib/plugin/core/context.ts:1165-1180`      | `.catch(...)` × 2                                | `contextMenu.register/unregister` |
| `lib/plugin/api/media-api.ts:969-986`       | `.catch(error => …)` 记录 MediaAIError           | `media.imageAI`                   |
| `lib/plugin/devtools/hot-reload.ts:372-376` | `.catch(() => {})`                               | `hotReload.restoreState`          |

这些站点会无形地吞掉 Tauri 模式下的失败，于是 Plugins → Audit 面板 —— ADR 0006 设计为实时诊断界面 —— 低报了桌面模式的故障。

### 不在范围内（有意不处理）

有两个审计维度结果是干净的，无需任何工作：

- **i18n**：36 个 `plugins.*` + 12 个 `settings.plugins.*` 键，在 `i18n/messages/en.json` 与 `i18n/messages/zh-CN.json` 之间完全同步。全部 28 个 `useTranslations()` 调用点在两种语言下都能解析。没有漂移，没有死键（两个「容器」键 `plugins.tabs` 与 `plugins.signature` 是通过动态迭代访问的，并非陈旧键）。
- **API 表面**：全部 14 个 `lib/plugin/api/*-api.ts` 模块都经由 `lib/plugin/core/context.ts:146-211` 接入 `FullPluginContext`。`PluginContext`（基础，19 个字段）与 `FullPluginContext`（基础 + 14 个扩展 API）和 `types/plugin/plugin.ts` 中的类型声明对齐。

## 决策

### 1. 把工作分层为 5 个可排序的批次（T0–T4）

| 层级   | 范围                                                                                                   | 涉及文件                                                | 风险                    |
| ------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------- |
| **T0** | 本 ADR + 修正 `extension-point-consumers.md` 中的 activation-pattern 计数                               | 2 篇文档                                                  | 无                    |
| **T1** | 静默 catch 迁移（8 处）+ 2 处布局修复（batch-actions-bar 溢出、permission-review 表格） | TS + RTL 测试 + Playwright                             | 低                     |
| **T2** | 接线 38 个钩子宿主调用点；对没有宿主事件源的予以降级                                      | `stores/<domain>/*` 中的宿主 store + `plugin-points.ts` | 中                  |
| **T3** | 分批 3a/3g/3b/3c/3d 实现 Rust 处理器（约 64 个命令，推迟 Python 与 Media）            | `src-tauri/src/plugin_api/**` + `lib.rs`                | 高（逐批审查） |
| **T4** | 文档收尾 + CI 门禁以保持 `expected: !isTauri()` 标志诚实                            | 文档 + `scripts/check-silent-failure-flags.ts`          | 低                     |

排序规则：T1.1（静默 catch 迁移）先于任何 T3 批次落地。迁移是纯增量的 —— 每个原本就吞错的 catch 站点继续吞，我们只是现在把它*记录*下来。一旦 T1.1 落地，Audit 面板就成了数据驱动的队列，用于决定 T3 的批次顺序。

### 2. 推迟 Python（批次 3e，13 个命令）和 Media（批次 3f，5 个命令）

- **Python**：`src-tauri/Cargo.toml` 中没有 PyO3（已验证全部 156 行）。引入它需要为 Windows/macOS/Linux 的 CI 提供 Python 头文件、决定 GIL 语义，以及一套沙盒策略。推迟到 **ADR 0017（插件 Python 运行时）**。在 0017 之前，TS 侧的 `python.call/eval/import` 在桌面端仍是空操作，且即使 Tauri 在场也走 `recordSilentFailure({ expected: true })`。
- **Media**：需要 ffmpeg sidecar 二进制。推迟到 **ADR 0018（插件媒体管线）**。现有的 `lib/plugin/api/media-api.ts:969-986` 已经干净地抛出 `MediaAIError`，所以推迟不会让当前测试回归。

### 3. 对没有宿主事件源的钩子予以降级（不要静默丢弃）

对于宿主事件源确实尚不存在的钩子类别（例如 `onAgentPlanCreate` / `onAgentPlanStepComplete` 已在 `extension-point-consumers.md:115-116` 记为「未来 planner 钩子」），契约条目从 `CANONICAL_HOOK_POINTS` 移到一个新的 `DEPRECATED_HOOK_POINTS` 常量。当某插件注册一个已降级的钩子时，`validatePluginManifest` 会发出一次性警告。

这是一步「诚实化」：`runtime-proof-audit.test.ts` 里的证明审计应当通过，是*因为*该钩子不再是 canonical，而不是因为审计被放松了。

完整的降级点表会随 T2 落地逐步填充；当前预计会降级的类别已在方案中内联记录，但在每个宿主 store 都被搜过是否有事件源之前不算最终定稿。

### 4. `expected: !isTauri()` 标志是把 T1 与 T3 绑在一起的契约

`recordSilentFailure`（`lib/plugin/contracts/diagnostics-store.ts:79-98`）接受 `expected: boolean`。约定：

- `expected: !isTauri()` —— 在 web 模式下失败是结构性预期；只记 debug 日志。Audit 面板在「expected」下展示它。
- `expected: false` —— 桌面运行时失败；记 warn 日志 + 以 code `"plugin.silent-failure"` 写入 `PluginPointDiagnostic`。Audit 面板在「warning」下展示它。

每个 T1.1 站点都从 `expected: !isTauri()` 起步。随着每个 T3 批次交付其对应的 Rust 处理器，相应的 TS 站点翻转为 `expected: false`。一道 CI 门禁（T4，`scripts/check-silent-failure-flags.ts`）会在某个 TS 文件以 `expected: !isTauri()` 提及 `plugin_X`、而 `lib.rs` 已在 `generate_handler!` 中列出 `plugin_X` 时使构建失败 —— 防止该标志卡住不翻。

### 5. 防重复正典（已成文以防重建）

| 关注点                  | 正典路径                                                                       | 规则                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 清单校验器       | `lib/plugin/core/validation.ts:validatePluginManifest`                         | 永远调用；绝不重新实现                                                            |
| 插件管理器单例 | `lib/plugin/core/manager.ts:getPluginManager`                                  | grep `new PluginManager(` 应返回 0 条结果                                      |
| IPC 字节大小              | `lib/plugin/messaging/ipc.ts`                                                  | 用 `new TextEncoder().encode(x).byteLength`，而非 `.length`                                    |
| 钩子分发器          | `lib/plugin/messaging/hooks-system.ts`                                         | 一个 `HookDispatcher`；两个分发器类（`PluginLifecycleHooks` + `PluginEventHooks`） |
| 权限门           | `lib/plugin/security/permission-guard.ts` + `lib/plugin/api/permission-api.ts` | 每次检查都经 `requestPluginPermission` 路由                                        |
| 主题桥             | `lib/plugin/api/theme-api.ts:createThemeAPI`                                   | 启用时自动发现 manifest.themes                                              |
| 连接器桥           | `lib/plugin/bridge/connectors-bridge.ts:registerPluginAdapters`                | 每次插件启用调用一次；禁用时清理                                            |
| 斜杠命令通道    | `lib/slash-commands/registry.ts`，带 `source: "plugin"`                       | 按 `pluginId` 打标，使禁用时可批量移除 |
| 诊断 store        | `lib/plugin/contracts/diagnostics-store.ts:recordSilentFailure`                | Rust 处理器落地前为 `expected: !isTauri()`，之后翻为 `false`                      |

### 6. Rust 模块约定：`src-tauri/src/plugin_api/` 镜像 `companion_api/`

第 3 层落在 `src-tauri/src/plugin_api/`，采用与 `src-tauri/src/companion_api/` 和 `scheduler/` 相同的布局：

```
src-tauri/src/plugin_api/
├── mod.rs              // 模块声明 + PluginRuntimeState 结构体
├── error.rs            // PluginError + Result 别名（thiserror）
├── commands.rs         // 给 generate_handler! 宏的 re-export
├── lifecycle.rs        // 3a — plugin_load/enable/disable/unload/install/uninstall/get_all/runtime_snapshot/set_state/get_state
├── permissions.rs      // 3a — plugin_permission_grant/list/revoke
├── api_bridge.rs       // 3g — plugin_api_invoke/batch_invoke
├── fs_watcher.rs       // 3b — plugin_fs_watch/unwatch
├── window_ops.rs       // 3b — plugin_window_*
├── shortcut_ops.rs     // 3b — plugin_shortcut_register/unregister
├── context_menu.rs     // 3b — plugin_context_menu_register/unregister
├── notification.rs     // 3b — plugin_show_notification
├── process_ops.rs      // 3b — plugin_process_kill
├── backup.rs           // 3c — plugin_backup_create/restore/delete
├── signature.rs        // 3c — plugin_verify_signature/create_signature/generate_keypair
├── marketplace.rs      // 3c — plugin_marketplace_versions/get_directory/download_version/invalidate_cache
└── devtools.rs         // 3d — plugin_dev_server_*/watch_*/reload/list_dev_plugins
```

状态在 `lib.rs` 中、于 `.invoke_handler(generate_handler!...)` 调用之前通过 `.manage(PluginRuntimeState::new(...))` 恰好注册一次。共享可变状态使用 `Arc<RwLock<...>>`（parking_lot），插件键控的 map 使用 `Arc<DashMap<...>>`。`PluginError` 派生 `thiserror::Error`，并序列化为其 display 字符串供 `invoke()` 拒绝使用。

## 后果

- **T1 解除诊断黑屏**：每个静默 catch 站点都在 Audit 面板中可见，为 T3 批次排序提供数据驱动队列。
- **T2 弥合契约/运行时错配**：`runtime-proof-audit.test.ts` 可以重新作为覆盖门禁被信任。
- **T3 让桌面模式可用**：安装 / 启用 / 授权 / 热重载 / 签名校验全部生效。在 T3a 落地之前，每个桌面模式的插件操作都是静默空操作。
- **T4 防止回归**：CI 门禁确保交付一个 Rust 处理器时总会翻转对应的 TS `expected:` 标志，使诊断面板保持诚实。
- **降级钩子**：注册了某个此后被降级的钩子的插件仍会继续加载（无破坏性变更），但清单校验器会发出一次性警告。今天 `plugins/` 中（内置注册表已验证）没有任何插件注册任何候选降级钩子。

## 降级钩子点（随 T2 落地填充）

| 钩子                    | 降级原因                                                                                                                                                                                                                                                                 | 已搜索的宿主文件                                                                               | Grep 关键词                                                | 替代 / 下一步                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `onThemeModeChange`     | T2 范围只允许编辑 `stores/theme/`；实际的 `setTheme` action 位于 `stores/settings/settings-store.ts`，不在范围内。`stores/theme/` 只含 `custom-theme-store.ts`（HTML 导出的主题 token，与应用主题模式无关）。 | `stores/theme/`、`stores/theme/custom-theme-store.ts`                                            | `setMode`、`setTheme`、`colorPreset`                      | 当未来某 ADR 把 T2 范围重定为包含 `stores/settings/`，或把主题 action 迁入 `stores/theme/` 时，恢复为 canonical。 |
| `onColorPresetChange`   | 与 `onThemeModeChange` 同样的降级路径 —— `setColorTheme` 位于 `stores/settings/settings-store.ts`，不在 T2 范围内。                                                                                                                                      | `stores/theme/`、`stores/theme/custom-theme-store.ts`                                            | `setColorTheme`、`colorPreset`                            | 当 `setColorTheme` 可从 T2 允许集内的某个宿主文件调用时，恢复为 canonical。                               |
| `onCustomThemeActivate` | `stores/theme/custom-theme-store.ts` 的 `upsert`/`remove`/`clone` action 针对的是 HTML 导出主题目录，而非应用的活动自定义主题。实际的 `setActiveCustomTheme` action 位于 `stores/settings/settings-store.ts`，不在 T2 范围内。    | `stores/theme/custom-theme-store.ts`、`stores/settings/settings-store.ts`（只读检视） | `activate`、`setActiveCustomTheme`、`activeCustomThemeId` | 当 active-custom-theme action 从 T2 允许集内的某个宿主文件暴露出来时，恢复为 canonical。                 |

T2 期间新增的每一行都必须引用所搜索的宿主文件、搜索关键词，以及若宿主事件源日后出现时用于恢复 canonical 状态的预期 ADR。

## 验证

每一层之后：

```powershell
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test --coverage              # 按 CLAUDE.md ≥90%
rtk pnpm build                        # Next.js 导出仍可工作
```

T2 之后：

```powershell
rtk pnpm test lib/plugin/contracts/runtime-proof-audit.test.ts
```

每个 T3 批次之后：

```powershell
rtk cargo test --lib --package app_lib --manifest-path src-tauri/Cargo.toml
rtk cargo test --tests --package app_lib --manifest-path src-tauri/Cargo.toml
rtk cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
rtk pnpm tauri build --debug
```

UI 改动（T1.2/T1.3）：

```powershell
rtk pnpm playwright test tests/e2e/plugins
# 外加经 mcp__playwright 的 375 / 768 / 1440 视觉快照
```

## 后续事项

- **ADR 0017** —— 插件 Python 运行时（PyO3、沙盒、CI 矩阵）。
- **ADR 0018** —— 插件媒体管线（ffmpeg sidecar、视频特效、转场）。
- **ADR 0006 §后续 #6** —— 回链到本 ADR，附已交付批次的日期。

## 参考

- ADR 0006（`docs/content/docs/adr/0006-plugin-system.md`）—— 原始插件系统设计。
- `lib/plugin/contracts/plugin-points.ts` —— 正典契约注册表。
- `lib/plugin/contracts/extension-point-consumers.md` —— 契约到宿主的映射（T2/T4 的求真目标）。
- `lib/plugin/contracts/runtime-proof-audit.ts` —— `auditPluginPointContracts()` 产出 Audit 子 Tab 渲染的「已验证 / 缺证明」报告。
- 方案文件：`~/.claude/plans/agile-puzzling-cerf.md`。
