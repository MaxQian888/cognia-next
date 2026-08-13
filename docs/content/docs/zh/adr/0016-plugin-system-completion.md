---
title: "0016 — 插件系统补完"
description: "弥补了ADR 0006 留下的桌面运行时空白。审计接口 82个plugin_*调用命令但没有Rust 处理器（而非ADR 0006估计的31个），38个已编写的hook调度员缺少的主机呼叫站点，以及8个绕过诊断存储的静默捕获。"
---

# ADR 0016 — 插件系统补完

**状态：** 提议 **日期：** 2026-05-09 **超复后续：** ADR 0006 §“Tauri后端间隙”

## 当前状态修订（2026-08-13）

Plugin Media TypeScript 接口现已具备 concatenate、effect、transition 与 export 的已注册原生处理器。实现复用 `cognia-media` 现有 ffmpeg 参数校验、timeout、临时路径与错误模型，没有新增第二套 JavaScript media API。已降级的 hook family 继续延期。

---

## 背景

ADR 0006发布了插件运行时——75个源文件`lib/plugin/`，5个Dexie表，完整设置UI，市场整合，6个内置插件，10个基于合同的决策。后续部分（2026-05年）承认了一个空白：“31个`plugin_*`调用呼叫且未Rust 处理器，故意推迟给ADR 0007。”ADR 0007实际上是针对主题渲染，因此空白保持悬浮——而且差距扩大，因为运行时不断增加`plugin_*`唤起站点，却没有相应的处理器轨道。

一次新的三向量审计（2026-05-09）得出了以下数据：

### 答：Tauri后端间隙比ADR 0006估计的**2.6×**

| 度规 | ADR 0006 后续 #5 | 现实（本次审计） | 资料来源 |
| ----------------------------------------------- | --------------------- | -------------------- | -------------------------------------- |
| 不同的`plugin_*`在TS中命令 | 31 | **82** | 格雷普·`lib/plugin hooks/plugins stores` |
| `plugin_*` `#[tauri::command]` 处理器 Rust | 0 | **0** | `src-tauri/src/lib.rs:211-386` |

验证命令：

```powershell
rtk grep -rEn "invoke[(<][^,]*['\"\`]plugin_[a-zA-Z_]+" lib/plugin hooks/plugins stores
rtk grep -n 'plugin_' src-tauri/src/lib.rs
```

ADR 0006 中 51-命令 的漏计是部分抽样的结果。新发现命令的类别包括文件系统watcher（`plugin_fs_watch/unwatch`）、上下文菜单生命周期（`plugin_context_menu_register/unregister`）、快捷键注册（`plugin_shortcut_*`）、窗口操作（`plugin_window_*`）、媒体处理（`plugin_media_*`）、DevTools 开发服务器（`plugin_dev_server_*`）以及 API 桥的泛型（`plugin_api_invoke`、`plugin_api_batch_invoke`）。

在任何处理器发布之前，所有桌面模式`invoke('plugin_*')`调用都会通过`recordSilentFailure`拒绝，用户会看到安装、启用、权限授权、热加载、签名验证等的无操作选项。

### B. hook调度覆盖缺口（108投38中）

`lib/plugin/contracts/plugin-points.ts:167-276`声明108 `CANONICAL_HOOK_POINTS`。调度器类在`lib/plugin/messaging/hooks-system.ts`（`PluginLifecycleHooks`行574-1067和`PluginEventHooks`行1104-1821）**已经实现了所有调度方法**，包括`dispatchThemeModeChange`、`dispatchProjectCreate`、`dispatchCanvasContentChange`、`dispatchWorkflowStart`、`dispatchExternalAgent*`、`dispatchMCP*`。缺少的是**主机调用站点**：主题存储从不调用`dispatchThemeModeChange`，画布存储从不调用`dispatchCanvasContentChange`，依此类推。`lib/plugin/contracts/runtime-proof-audit.ts`的校样审计将这些标记为“已验证”，因为绑定元数据存在;但运行时在实际中是沉默的。

目前无主机布线的类别：

- 主题（3）：`onThemeModeChange`，`onColorPresetChange`，`onCustomThemeActivate`
- 项目/知识（6）：`onProjectCreate/Update/Delete/Switch`，`onKnowledgeFileAdd/Remove`
- 画布（8张）：`onCanvasCreate/Update/Delete/Switch/ContentChange/VersionSave/VersionRestore/Selection`
- 产物（2 部分）：`onArtifactExecute`，`onArtifactExport`
- 出口（3+2）：`onExportStart/Complete/Transform`，`onProjectExportStart/Complete`
- RAG / 向量（3）：`onDocumentsIndexed`、`onVectorSearch`、`onRAGContextRetrieved`（部分路径——仅RAG路径接入`lib/plugin/bridge/workflow-integration.ts:145-159`）
- 工作流程（4）：`onWorkflowStart/StepComplete/Complete/Error`
- UI互动（5）：`onSidebarToggle`，`onPanelOpen/Close`，`onShortcut`，`onContextMenuShow`
- 外部Agent（7 部分）：`onExternalAgent*` — 部分接线在`hooks/agent/use-external-agent.ts`
- 代码执行（3次）：`onCodeExecutionStart/Complete/Error`
- MCP （4）：`onMCPServerConnect/Disconnect`，`onMCPToolCall/Result`

由于宿主事件源实际上尚未存在，子集将被降级（见决策§3）。

### C. 无声捕捉泄漏（8个站点）

ADR 0006后续#2迁移了12个`catch { /* ignore */ }`站点到`recordSilentFailure`，但后来新增的`lib/plugin/core/context.ts`重新引入了裸或仅日志捕获。由Read验证的站点：

| 文件：行 | 模式 | 遗址名称 |
| ------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `lib/plugin/core/context.ts:357-367` | 裸try/catch `plugin_show_notification` | `ui.showNotification` |
| `lib/plugin/core/context.ts:592-617` | 隐含捕捉`plugin_python_import` | `python.import` |
| `lib/plugin/core/context.ts:869-889` | `.catch(loggers.manager.error)` × 2 | `fs.watch`，`fs.unwatch` |
| `lib/plugin/core/context.ts:1024-1048` | `.catch(loggers.sandbox.error)` × 2 | `shell.spawn`，`process.kill` |
| `lib/plugin/core/context.ts:1124-1136` | `.catch(...)` × 2 | `shortcut.register/unregister` |
| `lib/plugin/core/context.ts:1165-1180` | `.catch(...)` × 2 | `contextMenu.register/unregister` |
| `lib/plugin/api/media-api.ts:969-986` | `.catch(error => …)`日志MediaAIError | `media.imageAI` |
| `lib/plugin/devtools/hot-reload.ts:372-376` | `.catch(() => {})` | `hotReload.restoreState` |

这些网站会无形地吸收Tauri模式的故障，因此插件→审计面板——ADR 0006设计为实时诊断接口——低估了桌面模式的故障。

### 超出范围（故意未处理）

两个审计维度结果是干净的，无需工作：

- **i18n**：36 `plugins.*` + 12 `settings.plugins.*`键，在 `i18n/messages/en.json` 和 `i18n/messages/zh-CN.json` 之间完全同步。所有 28 个`useTranslations()`呼叫站点在两个区域都能解析。没有漂移，没有死键（两个“容器”键`plugins.tabs`和 `plugins.signature` 通过动态迭代访问，而非过时）。
- **API 接口**：所有14个`lib/plugin/api/*-api.ts`模块都通过`lib/plugin/core/context.ts:146-211`接入`FullPluginContext`。`PluginContext`（基底，19个字段）和`FullPluginContext`（基数+14个扩展APIs）与类型声明对齐于`types/plugin/plugin.ts`。

## 决策

### 1. 将工作分成5个可排序批次（T0–T4）

| 分级 | 范围 | 触及的文件 | 风险 |
| ------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------- |
| ** | ADR + 激活模式计数修复 `extension-point-consumers.md` | 2 文档 | 没有 |
| **T1** | 静默捕捉迁移（8个站点）+ 2个布局修复（批处理-动作-栏溢出，权限-审查表） | TS + RTL测试 + Playwright | 低 |
| **T2** | Wire 38 hook主机呼叫站点;降级那些没有主机事件源的部分 | `stores/<domain>/*` + `plugin-points.ts` | 媒介 |
| **T3** | 将Rust 处理器分批次实现为3a/3g/3b/3c/3d（~64 命令，推迟Python和Media） | `src-tauri/src/plugin_api/**` + `lib.rs` | 高（批次评测） |
| **T4** | 文档关闭 + CI 门禁以保持旗`expected: !isTauri()`真实 | 文档+`scripts/check-silent-failure-flags.ts` | 低 |

顺序规则：T1.1（静默捕获迁移）在任何T3批次之前发货。迁移纯粹是累加的——每个已经吞下错误的捕获点继续吞并它;我们现在就_record_它。一旦T1.1落地，审计面板就成为T3批次排序的数据驱动队列。

### 2. Defer Python （第3e批，13 命令）和 Media（第3批f，第5 命令）

- **Python**：`src-tauri/Cargo.toml`中缺少PyO3（已验证全部156行）。添加它需要在CI中添加Python头，用于Windows/macOS/Linux、GIL语义决策和沙箱策略。请参考**ADR 0017（插件Python 运行时）**。直到0017，TS-side `python.call/eval/import`在桌面上保持不可操作状态，即使有 Tauri 也`recordSilentFailure({ expected: true })`。
- **Media**：需要ffmpeg sidecar二进制。请参考**ADR 0018（插件媒体管道）**。现有`lib/plugin/api/media-api.ts:969-986`已经能干净地抛出`MediaAIError`，因此延迟不会回归当前测试结果。

### 3. 降级hook没有主事件源（不要无声地丢弃）

对于hook类别，当主事件源确实不存在（例如`extension-point-consumers.md:115-116`中已文档为“未来规划器hook”）的`onAgentPlanCreate` / `onAgentPlanStepComplete`），合同条目会从`CANONICAL_HOOK_POINTS`转移到新的`DEPRECATED_HOOK_POINTS`常数。当插件注册弃用hook时，`validatePluginManifest`会发出一次性警告。

这是一个“诚实”步骤：`runtime-proof-audit.test.ts`的证明审计应该通过_because_ hook不再是规范的，而不是因为审计被放宽了。

完整的降级积分表将随着T2地区填充;目前预计降级的类别已在计划中记录，但直到每个主办商店搜索事件来源后才最终确定。

### 4. `expected: !isTauri()`旗是将T1与T3绑定的合同

`recordSilentFailure`（`lib/plugin/contracts/diagnostics-store.ts:79-98`）接受`expected: boolean`。约定：

- `expected: !isTauri()` — 在网页模式下，故障是结构上预期的;仅限调试日志。审计面板显示在“预期”下。
- `expected: false` — 桌面运行时故障;警告日志 + 写入`PluginPointDiagnostic`代码`"plugin.silent-failure"`。审计面板显示在“警告”栏目。

每个 T1.1 站点以 `expected: !isTauri()` 开头。每当 T3 批次发布匹配的 Rust 处理器，相应的 TS 站点会切换为 `expected: false`。如果 CI 门禁（T4， `scripts/check-silent-failure-flags.ts`）在 TS 文件中提及 `plugin_X` 与 `expected: !isTauri()` 一起，而 `lib.rs` 已在 `generate_handler!` 中列出 `plugin_X`，则该构建失败，防止旗标卡住。

### 5. 防重复加农炮（规范以防止重建）

| 关注点 | 正规路径 | 统治 |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 清单验证器 | `lib/plugin/core/validation.ts:validatePluginManifest` | 始终调用;绝不重新实现 |
| 插件管理器单例 | `lib/plugin/core/manager.ts:getPluginManager` | `new PluginManager(`的grep应该会返回0个结果 |
| IPC字节大小 | `lib/plugin/messaging/ipc.ts` | `new TextEncoder().encode(x).byteLength`，不是`.length` |
| hook调度员 | `lib/plugin/messaging/hooks-system.ts` | 一`HookDispatcher`;两类调度器（`PluginLifecycleHooks` + `PluginEventHooks`） |
| 请允许门禁 | `lib/plugin/security/permission-guard.ts` + `lib/plugin/api/permission-api.ts` | 每次检查都经过`requestPluginPermission` |
| 主题桥 | `lib/plugin/api/theme-api.ts:createThemeAPI` | manifest.themes 在启用时自动发现 |
| 连接桥 | `lib/plugin/bridge/connectors-bridge.ts:registerPluginAdapters` | 每个插件启用一次调用;在“禁用”时进行清理 |
| 斜线命令通道 | `lib/slash-commands/registry.ts` 和`source: "plugin"` | `pluginId`标记在禁用时启用批量移除 |
| 诊断存储 | `lib/plugin/contracts/diagnostics-store.ts:recordSilentFailure` | `expected: !isTauri()` Rust 处理器船，然后切换到`false` |

### 6. Rust模约定：`src-tauri/src/plugin_api/`镜像`companion_api/`

三级地图`src-tauri/src/plugin_api/`采用`src-tauri/src/companion_api/`和`scheduler/`建立的相同布局：

```
src-tauri/src/plugin_api/
├── mod.rs              // module declarations + PluginRuntimeState struct
├── error.rs            // PluginError + Result alias (thiserror)
├── commands.rs         // re-exports for the generate_handler! macro
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
├── devtools.rs         // 3d — plugin_dev_server_*/watch_*/reload/list_dev_plugins
└── tray_items.rs       // 3b (addendum, ADR 0016 P2-A, 2026-05-17) — plugin_tray_item_register/unregister/list/unregister_by_plugin
```

状态在`.invoke_handler(generate_handler!...)`调用前通过`lib.rs`的 `.manage(PluginRuntimeState::new(...))` 注册一次。共享可变状态使用插件键控映射的 `Arc<RwLock<...>>`（parking_lot）和 `Arc<DashMap<...>>`。`PluginError` 从`thiserror::Error`导出并序列化到其显示字符串以`invoke()`拒绝。

> **附录（2026-05-17，P2-A）:** `tray_items.rs`与第3批次b的其他部分一同发布，但未出现在上述原始模块表中。它暴露了四个`#[tauri::command]` 处理器（`plugin_tray_item_register`、`plugin_tray_item_unregister`、`plugin_tray_item_list`、`plugin_tray_item_unregister_by_plugin`），这些通过`manifest.trayItems`贡献了托盘物品槽插件。注册于`src-tauri/src/lib.rs:297-300`，排在其他`plugin_api::*`之前，以匹配其在托盘子系统中的位置。分类：3b批次（Window/Shortcut/Context-menu/Notification家族）。

## 后果

- **T1解除诊断黑屏**：每个静默捕获点在审计面板中可见，提供基于数据的数据的队列以支持T3批次订购。
- **T2 弥补了contracts/runtime不匹配**：`runtime-proof-audit.test.ts` 再次值得信赖，作为覆盖门禁。
- **T3让桌面模式功能正常**：安装/启用/权限授予/热重载/签名，验证所有工作。在T3a上线之前，所有桌面模式插件操作都是无声的“无操作”。
- **T4防止回归**：CI 门禁确保发货时Rust 处理器总是触发匹配的TS `expected:`标志，使诊断面板保持诚信。
- **降级hook**：注册了降级后的hook插件继续加载（无破坏性变更），但清单验证器发出一次性警告。目前没有插件在`plugins/`（内置注册表已验证）注册任何候选降级hook。

## 降级hook点（在T2着陆时补足）

| hook | 降职原因 | 已搜索的主机文件 | Grep项 | 更换/下一步 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `onThemeModeChange` | T2 范围只允许对`stores/theme/`进行编辑;实际的`setTheme`动作存在于 `stores/settings/settings-store.ts`，而  是超出范围。`stores/theme/` 只包含 `custom-theme-store.ts`（HTML-export 主题标记，与应用主题模式无关）。 | `stores/theme/`，`stores/theme/custom-theme-store.ts` | `setMode`，`setTheme`，`colorPreset` | 当未来的ADR重新调整T2范围以包含`stores/settings/`或将主题动作迁移到`stores/theme/`时，恢复为正规。 |
| `onColorPresetChange` | 降级路径和`onThemeModeChange`一样——`setColorTheme`住在`stores/settings/settings-store.ts`，超出范围 2型糖尿病。 | `stores/theme/`，`stores/theme/custom-theme-store.ts` | `setColorTheme`，`colorPreset` | 当 T2 允许集内的主机文件调用`setColorTheme`时恢复为规范。 |
| `onCustomThemeActivate` | `stores/theme/custom-theme-store.ts` `upsert`/`remove`/`clone`动作是针对HTML-export主题目录的，不是应用的活跃自定义主题。实际的`setActiveCustomTheme`动作存在`stores/settings/settings-store.ts`，超出范围 T2。 | `stores/theme/custom-theme-store.ts`，`stores/settings/settings-store.ts`（只读检查） | `activate`，`setActiveCustomTheme`，`activeCustomThemeId` | 当 T2 允许集合内的主机文件暴露 active-custom-theme 动作时，恢复为规范。 |
| `onAgentPlanCreate`（P1-5,2026-05-17） | 没有主办事件源。`extension-point-consumers.md:115`在降级前已经标记为“未来规划hook（目前未使用）”——呼叫该调度员的代理规划器从未实现。 | `lib hooks stores app components`工作区范围 | `dispatchOnAgentPlanCreate`，`agentPlan`，`planCreate` | 当一个解雇该调度员的代理策划器出货时，恢复为正规;通过指向代理运行时的未来ADR进行追踪。 |
| `onAgentPlanStepComplete`（P1-5,2026-05-17） | 没有主机事件源。和 `onAgentPlanCreate` 一样的根本原因。 | `lib hooks stores app components`工作区范围 | `dispatchOnAgentPlanStepComplete`，`planStep`，`stepComplete` | 当特工规划者降落时，与`onAgentPlanCreate`并存。 |
| `onArtifactExecute`（P1-5,2026-05-17） | 没有主事件源。`extension-point-consumers.md:205`声称有“运行产物运行者”作为消费者;代码库中不存在此类运行程序。`dispatchArtifactExecute` `hooks-system.ts:1649` 是调度器，呼叫者为零。 | `lib hooks stores app components`工作区范围 | `dispatchArtifactExecute`，`artifactRunner`，`artifact.execute` | 当产物运行子系统发货并开始激活调度员时恢复。 |
| `onArtifactExport`（P1-5,2026-05-17） | 没有主办事件源。`extension-point-consumers.md:206`声称消费者有一个“出口管道”;现有的出口管道（通过`lib/plugin/api/export-api.ts` `dispatchExportStart/Complete/Transform`）是产物无关的。 | `lib hooks stores app components`工作区范围 | `dispatchArtifactExport`，`exportArtifact`，`artifact.export` | 当产物专用出口管道发货时，恢复该调度器（与现有项目-出口管道分开）。 |

在T2期间添加的每一行都必须引用被搜索的主机文件、搜索词，以及如果主机事件源后来出现时恢复规范状态的预期ADR。

## 验证

每个等级结束后：

```powershell
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test --coverage              # ≥90% per CLAUDE.md
rtk pnpm build                        # Next.js export still works
```

T2之后：

```powershell
rtk pnpm test lib/plugin/contracts/runtime-proof-audit.test.ts
```

每次T3批次后：

```powershell
rtk cargo test --lib --package app_lib --manifest-path src-tauri/Cargo.toml
rtk cargo test --tests --package app_lib --manifest-path src-tauri/Cargo.toml
rtk cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
rtk pnpm tauri build --debug
```

UI变化（T1.2/T1.3）：

```powershell
rtk pnpm playwright test tests/e2e/plugins
# Plus 375 / 768 / 1440 visual snapshots via mcp__playwright
```

## 后续

- **ADR 0017** — 插件 Python 运行时（PyO3、沙箱、CI矩阵）。
- **ADR 0018** — 插件媒体管道（ffmpeg sidecar、视频特效、转场）。
- **ADR 0006 §后续 #6** — 本ADR的反向链接，附有发货日期。

## 参考文献

- ADR 0006（`docs/content/docs/adr/0006-plugin-system.md`）——原始插件系统设计。
- `lib/plugin/contracts/plugin-points.ts` — 规范合同登记处。
- `lib/plugin/contracts/extension-point-consumers.md` — 合同到主机映射（T2/T4的真实目标）。
- `lib/plugin/contracts/runtime-proof-audit.ts` — `auditPluginPointContracts()` 生成由审计子标签页呈现的已验证/缺失证据报告。
- 计划文件：`~/.claude/plans/agile-puzzling-cerf.md`。
