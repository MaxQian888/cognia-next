---
title: "0020 — Computer Use 补齐"
description: "填补了M5支架留下的空白：5个存根操作、同意UI、sidecar头部、角色选择加入、MCP曝光、macOS/Linux最低要求。"
---

# ADR 0020 — Computer Use 补齐

**状态：** 已接受 **日期：** 2026-05-14 **分支：** `feat/computer-use-completeness`

## 背景

计算机使用支架（M5）自带了一个工作Rust自动化子系统（`src-tauri/src/automation/`）、一个工作流节点接口、一个设置UI壳、一个审计表，以及一个注册三个原生Anthropic工具（`computer_20251124`、`bash_20250124`、`text_editor_20250728`）`plugins/computer-use/`的插件。有四个部分被删减或缺失：

1. **10个`computer_20251124`操作中的5个**返回`"not yet implemented"` — `MouseMove` / `Drag`被模拟为点击声，`MouseButtonDown` / `MouseButtonUp` / `Scroll` / `HoldKey`字面上出现错误。
2. **PerCall同意UI从未被交付。**`Decision::RequireConsent`返回了硬性`"Consent required for this action"`错误，而不是提示用户，使得最严格的权限层级无法使用。
3. **sidecar从未看到注册的原生工具。**`lib/claude/build-options.ts`没有读取`native-anthropic-tool-registry`，所以Anthropic Agent SDK启动时没有`anthropic-beta: computer-use-2025-11-24`头。
4. **设置→白名单+检查员标签页是占位卡**，带有“M2中的船只”副本。

此外：没有`Character`字段门槛可见性（每次聊天都会显示这些工具），外部桥接MCP不会暴露`computer_use`，macOS/Linux后端只是`StubBackend`占位符。

用户要求非重新设计的完成通行证——保留现有架构，填补所有空白，**在`uiautomation` crate增值方面更加努力。

## 决策

七个具体调整。

### 1. AutomationBackend特征扩展为5种新方法

`src-tauri/src/automation/backend.rs` 在特征中添加了 `mouse_move`、`drag`、`scroll`、`hold_key` 和 `mouse_button`。`StubBackend` 对每个特征返回`UnsupportedPlatform`。Windows `UiaBackend`通过`windows::SendInput`（移动/滚动/按钮）和`uiautomation::inputs::Keyboard::{begin_hold_keys, end_hold_keys}` API（hold_key）提供真实实现。`automation/types.rs`中出现了新的模式`Point`、`DragOpts`、`ScrollTarget`、`ScrollOpts`和`ButtonTransition`。

### 2. UIA 模式优先点击策略

`ClickOpts.useNative`默认为`true`。点击`Element`目标时，后端按顺序尝试`InvokePattern` → `TogglePattern` → `SelectionItemPattern`;未击中时，会退回到元素的原生`click()`辅助程序，最后回到边界矩形中心的坐标点击。调度器位于`automation/platform/uia/pattern.rs`，并且被`desktop_invoke_pattern`（之前被存管的Tauri 命令）重复使用。`desktop_window_op`通过同一模块的`dispatch_window_op`接线，并使用`UIWindowPattern` / `UITransformPattern`进行可视化状态/调整大小/移动操作。

### 3. PerCall通过Tauri活动经纪人获得同意UI

`automation/consent.rs`引入了`ConsentBroker`。当门禁返回`Decision::RequireConsent`时，经纪人：

1. 检查`session_grants`是否有已有的“始终允许此场次”的授权，由`(surface, command, plugin_id, process_name)`激活。点击→允许。
2. Else 生成UUID，注册`oneshot::Sender`，发出`automation:consent-request`，并以30秒超时等待接收器。
3. 渲染端`<ConsentOverlay />`（`components/automation/consent-overlay.tsx`）监听事件，并在右下角渲染一张浮动卡片，显示`Allow once / Always allow this session / Reject`。
4. 点击时，覆盖层调用`automation_consent_respond({ id, allow, persist, prompt })`，解析通道——并在持久化时将资助存储在会话映射中。

启动杀机开关会清除所有会话赠予。

### 4. sidecar `anthropic-beta` header passthrough

`sidecar/dispatch/anthropic.mjs`已经理解了拟人Agent技能通行的`ANTHROPIC_DEFAULT_HEADERS`。同一条路径现在合并了`sendOptions.appendHeaders`——由`computeAnthropicBetaHeaders([...])`的`resolveSendOptions`填充——因此API请求随`anthropic-beta: computer-use-2025-11-24`令牌一起发出。

本ADR中**不包含对渲染器`desktop.*` API的全 canUseTool-side 调度;每个注册工具的`executeIpc.invoke`字段指向一个真实Tauri 命令，因此工作流节点和MCP调用者可以直接驱动动作，但基于聊天驱动的SDK路径后续需要渲染器端桥接。

### 5. 软装订`Character.enableComputerUse`

与现有的`Character.twinId`和`Character.a2uiEnabled`惯例相符：

```ts
interface Character {
  enableComputerUse?: boolean
  computerUseSettings?: {
    allowedToolIds?: string[] // subset of registered tool ids
    requireConsent?: boolean
  }
}
```

`lib/claude/build-options.ts`通过`lib/claude/computer-use-tools.ts:applyComputerUseTools`读取注册表，只有当角色有`enableComputerUse === true`时才填充`opts.anthropicTools`+`opts.appendHeaders["anthropic-beta"]`。角色设置编辑器除了现有的brief/debug/bare开关外，还会有一个`Enable Computer Use`开关。模式会跳升到v32（不迁移——字段是可选的）。

### 6. 外部桥上的`computer_use` MCP工具

`lib/external-bridge/handlers/computer-use.ts` 注册一个带有 union 动作模式的 `computer_use` 工具（`screenshot` / `click` / `type` / `keys` / `mouse_move` / `drag` / `scroll` / `hold_key` / `mouse_button`）。节点 sidecar 条目通告该工具;新的`mcp:computer-use`示波器（默认OFF）门禁通过`checkToolCall`的每次通话。设置→外部桥会渲染新的示波器切换。

当以独立Cognia运行（未连接桌面应用）时，处理器返回结构化`not-yet-bridged`错误，以便外部代理看到明确原因;渲染桥接调度会留在应用内路径中，直到sidecar→渲染器→Tauri IPC桥接落地。

### 7. macOS / Linux 最小可行后端

`platform/ax/mod.rs`（macOS）和`platform/atspi/mod.rs`（Linux）用`enigo`-backed实现替代`StubBackend`占位符，包括`capabilities`、`screenshot`（通过跨平台`platform::shared::screenshot::capture_primary`）、`click(Point)`、`type_text`、`send_keys`、`mouse_move`、`drag`、`scroll`和`mouse_button`实现。

`AXUIElement` / AT-SPI树导航在范围内**不**——`find` / `read_tree` / `invoke_pattern` / `window_op` / 元素目标点击在这些平台上返回`UnsupportedPlatform`。`Capabilities.hasUia` 在 macOS 和 Linux 上是假的，因此渲染器隐藏了UIA-only功能（检查器标签、工作流节点中的按树定位器对话框）。

## 能力矩阵

| 行动 | 窗户 | macOS | Linux |
| -------------------------- | ------- | -------- | -------- |
| `screenshot` | 是的 | 是的 | 是的 |
| `click(Point)` | 是的 | 是的 | 是的 |
| `click(Element)` | 是的 | 不 | 不 |
| `type_text` | 是的 | 是的 | 是的 |
| `send_keys`（和弦） | 是的 | 部分 | 部分 |
| `mouse_move` | 是的 | 是的 | 是的 |
| `drag` | 是的 | 是的 | 是的 |
| `scroll` | 是的 | 是的 | 是的 |
| `mouse_button` | 是的 | 是的 | 是的 |
| `hold_key` | 是的 | 不 | 不 |
| `read_tree` / `find` | 是的 | 不 | 不 |
| `invoke_pattern` | 是的 | 不 | 不 |
| `window_op` | 是的 | 不 | 不 |
| UIA / 无障碍活动 | 不（M2） | 不 | 不 |

¹ macOS 和 Linux 接受单符号和弦（`Enter`、`Tab`、`Escape`、`Backspace`、`Delete`、`Space`）;修饰和弦（`ctrl+shift+t`）返回清晰的`BackendError`。Windows 后端解析`uiautomation::inputs::Keyboard::send_keys`接受的每个和弦。

## 设定UX

- **自动化→权限设置→**——每个接口有三级（关闭/白名单/每次通话）（工作流程/电脑使用/MCP/插件）。默认关闭。
- **设置→自动化→白名单**——进程名和窗口标题-glob编辑器，带有“捕获聚焦窗口”辅助工具。
- **设置→自动化→检查器** — 树管理器 + 每元素细节 + 定位器 / 元素-参考复制按钮 + UIA-pattern 测试按钮。在 macOS / Linux （`Capabilities.hasUia === false`） 上禁用。
- **字符→设置→编辑** — 在简短/调试/裸模式切换下启用电脑使用开关。
- **外部桥接→设置** — `mcp:computer-use`瞄准镜切换。

## Non-Goals

- macOS / Linux UIA-equivalent树行走（AXUIElement.children，AT-SPI内省）。第6.b阶段后续。
- 插件注册的自定义桌面动作/UIA模式。插件仍然通过`registerNativeAnthropicTool`贡献完整的原生工具。
- 元素选择器覆盖层（检查员需要→“选”按钮所需的 `desktop_pick_start`/`_cancel` Rust 命令）。UI占位符显示为禁用，配有“M5b 中的舰船”提示。
- 为聊天驱动路径提供全canUseTool sidecar调度（工作流节点和MCP调用者已能通过现有`desktop_*` Tauri 命令驱动计算机使用）。

## 文件

```
src-tauri/src/automation/
  backend.rs        — trait extended; StubBackend grew 5 methods
  commands.rs       — 6 new Tauri commands + consent broker wiring
  consent.rs        — ConsentBroker (new)
  permission.rs     — Call::kind() recognises new driving commands
  types.rs          — Point / DragOpts / ScrollTarget / ScrollOpts / ButtonTransition
  worker.rs         — 5 new Request variants + AutomationHandle methods
  platform/
    shared/
      mod.rs        — re-exports
      screenshot.rs — xcap-based capture (moved from uia/)
    uia/
      mod.rs        — UIA Pattern-first click + 5 new methods
      input.rs      — windows::SendInput-based mouse / scroll / button
      pattern.rs    — UIA pattern dispatch (new)
    ax/mod.rs       — minimum-viable macOS backend (enigo)
    atspi/mod.rs    — minimum-viable Linux backend (enigo)

plugins/computer-use/rust/src/
  commands.rs       — 5 stubs replaced with real handle.* calls
  translator.rs     — Anthropic action shape → automation types

lib/automation/
  client.ts         — 6 new methods + consent-respond
  types.ts          — mirror Rust types

lib/workflow/nodes/
  desktop.ts        — windowFocus / Close / Resize via desktop.windowOp

lib/claude/
  build-options.ts  — call applyComputerUseTools
  computer-use-tools.ts — registry → SendOptions mapping (new)
  types.ts          — SendOptions.anthropicTools + appendHeaders;
                      Character.enableComputerUse + computerUseSettings

lib/external-bridge/
  handlers/computer-use.ts — MCP tool handler (new)
  mcp-server/server.ts     — registerComputerUseTool
  types.ts                 — TOOL_TO_SCOPE.computer_use

types/wiki/index.ts — BridgeScope adds "mcp:computer-use"

components/automation/consent-overlay.tsx — new
components/settings/automation/
  whitelist-tab.tsx        — new
  inspector-tab.tsx        — new
  automation-section.tsx   — replaces 2 PlaceholderTabs
components/settings/characters-section.tsx — Computer Use toggle
components/settings/external-bridge/external-bridge-section.tsx — scope desc

app/layout.tsx — mount <ConsentOverlay />

sidecar/dispatch/anthropic.mjs — appendHeaders → ANTHROPIC_DEFAULT_HEADERS merge

lib/db/schema.ts — v32 marker (no migration)
```

## 补充 2026-05-15 — 完整性表2

后续的完工处理封闭了M5脚手架留下的11个空白。其中两个原始Non-Goals（聊天驱动`canUseTool` sidecar调度、sidecar→渲染器MCP自动化代理IPC）需要结构性新架构，而非“完成”工作，且仍Non-Goals在专门的后续跟踪ADR中进行跟踪。

**闭合缝隙**

1. `text_editor` `undo_edit`动作——`TextEditorAction::UndoEdit { path }`在`plugins/computer-use/rust/src/types.rs`中进行，在每次变异动作（`Create` / `StrReplace` / `Insert`）前由`UNDO_STORE: Lazy<Mutex<HashMap<PathBuf, UndoEntry>>>`快照。撤销用于恢复之前的内容，或在快照“缺失”时删除文件。
2. `bash.restart: true`被尊为经审计的无操作者。Cognia没有持续的壳可重启，因此调用返回一个合成`BashResult`，其`stdout`解释了分歧。审计归属`command: "bash:restart"`。
3. `plugins/computer-use/plugin.json` `runtimeCompatibility`密钥被重命名为 `desktop` → `tauri`（`types/plugin/plugin.ts:99` 的规范密钥）。新的`lib/plugin/core/builtin-manifest-shape.test.ts`会遍历每个内置清单，并拒绝非规范的 接口 密钥。同一遍还规范化了另外六个插件。
4. 激活时间`ctx.agent?.registerNativeAnthropicTool?.(...)`呼叫已从`plugins/computer-use/src/index.ts`中取消。清单驱动注册（`manifest.nativeAnthropicTools`）是规范的。
5. TypeScript SDK在能力合同宣传的路径上搭建的支架：`packages/plugin-sdk/src/api/native-anthropic-tool.ts`和`packages/plugin-sdk/src/context/index.ts`。
6. `runtime-proof-audit.test.ts`锁`native-anthropic-tool`证明状态=`verified`。
7. 设置→自动化同意覆盖层+全部五个标签页（总览、权限、白名单、审计、检查器）以及“角色电脑使用”开关和外部桥接`mcp:computer-use`范围描述，均通过新`automation.*`和现有`settings.*`命名空间下的`useTranslations()`完全连接i18n。插件`/cu`斜语命令通过`lib/i18n/plugin-i18n-registry`注册i18n捆绑。
8. `i18n/messages/en.json` + `zh-CN.json` 对等性恢复。`scripts/i18n-baseline.json` 重新基底——JSX硬编码字符串数量从811降至698（~113字符串闭合）。
9. 能力合同`hostBindings`更新以进行运行时无效审计。

**仍然推迟（Non-Goals，单独记录）**

- `computer` / `bash` / `text_editor` 的聊天驱动`canUseTool` sidecar调度。`@anthropic-ai/claude-agent-sdk`是MCP-only的——它没有字段可以注入API-level本地工具。要解决这个问题，要么教`sidecar/dispatch/ai-sdk.mjs`通过 Vercel AI SDK 接入提供商定义的工具，要么添加一个全新的 Anthropic 直接调度器。无论哪条路径都是结构性新调度器，而非完成任务。
- MCP独立`computer_use` IPC。节点MCP sidecar使用拥有stdin/stdout的SDK的`StdioServerTransport`。布线`automation_proxy`包线需要在节点端定制传输封装器，并进行 `src-tauri/src/mcp_server/sidecar.rs` 的标准泵送重构。单独跟踪。
- macOS / Linux UIA-equivalent树步（6.b阶段）。
- 插件注册的自定义桌面动作/UIA模式。

## 补充 2026-05-18 — 聊天发送 + 3 个动作 + cursor_position

后续的完工通行通过与原ADR不同的架构方法，弥补了两个结构延迟的调度空白，同时运送了原M5未接口的三个小动作。

### 架构枢轴——通过插件MCP的聊天路径，而不是新调度器

2026-05-15的补充说明将聊天驱动`canUseTool`调度描述为“要么教`ai-sdk.mjs`通过Vercel AI SDK接入提供商定义的工具，要么新增一个全新的Anthropic直销调度员”。这两条路由都会绕过`@anthropic-ai/claude-agent-sdk`，放弃所有仅存在于该SDK中的所有Claude Code功能（内置Bash/Read/Edit、子代理`agents`、设置源、resume/fork会话连续性、`effort`、`maxThinkingTokens`、部分消息流、Anthropic Skills直通）。

枢轴：**通过现有的 `cognia-plugin-tools` 桥将 `computer_use` / `bash` / `text_editor` 暴露为插件MCP工具**，而不是尝试注入API-level原生工具。模型将它们视为`mcp__cognia-plugin-tools__{computer_use,bash,text_editor}`，而非API-level `type: "computer_20251124"`形状。功能接口相同（相同的动作工会，相同的后端调度）。代价是 Anthropic API 的 _native_ 计算机预训练提升功能不如以往——该模型依然非常强大，但没有原生工具类型触发的特殊紧急处理。

用户明确已接受权衡：所有Claude Code SDK功能都被保留;聊天路径通过`dispatchAnthropic`保持不变。

### 闭合间隙

1. **聊天驱动的计算机使用** — `plugins/computer-use/src/index.ts` `activate()`现在通过`ctx.agent.registerTool()`注册了三个插件工具。`plugin.json`增加了`"tools"`功能。现有的sidecar桥接`sidecar/builtin-tools/plugin-tools.mjs` 接口它们作为MCP工具连接到SDK，无需更改调度器。`requiresApproval: true`调用了聊天端`canUseTool`模态;Rust许可门禁在每次出勤`desktop.*`中独立开火。

2. **外部MCP `mcp_computer_use`** — `src-tauri/src/mcp_server/automation_proxy.rs`（新）为每个`SidecarProcess`创建一个专用的Unix域套接字/Windows命名管道。路径通过`COGNIA_AUTOMATION_PROXY` env var传递给节点MCP sidecar。`lib/external-bridge/handlers/computer-use.ts`在第一次调用时打开该套接字，发送一个换行符的信封JSON信封`{ id, command, args, ctx }`，等待匹配响应。MCP stdin/stdout 传输严格的顺序互斥体保持不变——自动化请求运行在完全独立的通道上。

3. **Inspector Pick** — `src-tauri/src/automation/platform/uia/pick.rs`（新，Windows）在专用线程注册一个低级`WH_MOUSE_LL` hook，打开一个透明且始终在顶部的网页视图，标记为`automation-pick-overlay`（覆盖层纯属装饰——点击通过`pointer-events: none`传递到底层应用），并通过UIA的`ElementFromPoint(x, y)`在第一`WM_LBUTTONDOWN`解决`ElementInfo`。新Tauri 命令 `desktop_pick_start` / `desktop_pick_cancel`。macOS / Linux 返回`UnsupportedPlatform`。检查器标签页在`caps.hasUia === true`时启用“选择”按钮。

4. **`triple_click` / `wait` / `cursor_position`** — `ClickOpts.count`添加（1/2/3）;UIA后端以OS双击节奏重复点击（`GetDoubleClickTime`）。`Wait`已在动作枚举中，在Anthropic-action-mapper层处理（TS睡眠，无需Rust往返）。`cursor_position`作为新的只读Tauri 命令添加（Windows上`GetCursorPos`，macOS / Linux上`Enigo::location()`）。

### 更名为Non-Goals

2026年5月15日附录中被归类为结构性延期Non-Goals的两项现已关闭：

- ~~聊天驱动的`canUseTool` sidecar派遣~~ — 通过插件MCP发布。
- ~~MCP独立`computer_use` IPC~~ ——通过`COGNIA_AUTOMATION_PROXY`侧通道发送。

### 仍然延期

- macOS / Linux UIA-equivalent树步（6.b阶段）。
- 插件注册的自定义桌面动作/UIA模式。
- macOS / Linux 全和弦解析器 + `hold_key` 对等性。作为 Phase 6.b non-Windows 后端完成的一部分进行跟踪。

### 结构

模式提升到`v40`（加法——无迁移）。增加了可选的`Character.computerUseSettings.chatConsentMode`（`"always-ask" | "session-grant" | "auto"`，默认为`"always-ask"`）和`ClickOpts.count`（1/2/3）。现有行往返不变。

## 附录 2026-05-29 — 远程执行目标（cua Docker沙箱）

增加了一个远程**执行目标**轴：计算机使用GUI动作可以在隔离的、由认知编排的[`trycua/cua`](https://github.com/trycua/cua)（MIT）Docker桌面（`ghcr.io/trycua/cua-xfce`）中运行，而非本地主机。这与ADR-0028 `sandboxTier`轴*正交*（Bash/Edit/Write隔离——命令执行合同）;GUI目标是一个独立的合同，**不**运行`dispatchSandbox`。Cua 仅作为“手”使用——代理循环保持在`@anthropic-ai/claude-agent-sdk`;Cua 的`ComputerAgent`/LiteLLM循环被**未**采用。

### 架构（R3路由）

- **锚点实体** — `sandboxConnection`（Dexie `v57`，`lib/db/sandbox-connections.ts`）。每个目标选择器都通过`id`引用连接。存储连接ID（绝不为裸标志）保持未来收敛（如下）纯粹的加法。
- **目标轴** — `Character.computerUseTarget`和`ChatSession.computerUseTarget`（`"local" | { connectionId }`），通过`lib/automation/sandbox-target.ts`解析会话字符→→字符，按本地化，每个会话（`lib/claude/computer-use-target-state.ts`）存储在`resolveSendOptions`中，并由计算机插件执行器印刻在`CallContext.sandboxConnectionId`上。工作流程`desktop`节点携带每个节点的`target`参数。
- **路由（R3）**——`src-tauri/src/automation/cua_route.rs`是单一路由层。后端调度接口——`dispatcher::execute_action`（规范渲染器`desktop.*`+聊天Plugin-MCP路径）和细粒`desktop_*` 命令——都将其称为*`run_gated` `do_call`闭包内部，因此门禁 →同意在审计流水线→封装本地和远程路径是相同的。远程`CallContext`（非空`sandboxConnectionId`）向异步`CuaRemoteClient`（`tokio-tungstenite` WS到容器的`computer-server`）发送;否则，现有的同步COM Worker运行。**不变：** 每个driving/reading动作都被路由;没有远程对应的动作（`get_focus` / `find` / `invoke_pattern` / `window_op` / `pick_at_point`）在远程时返回`UnsupportedPlatform`，而不是静默地击中主机。
- **生命周期** — `src-tauri/src/cua_sandbox/`（模块命名以避免现有`src-tauri/src/sandbox/` ADR-0028碰撞）壳体`docker run/stop/ port`并拥有每个连接的`CuaRemoteClient`注册表;`cua_sandbox_*` Tauri 命令 + a 设置→自动化→沙箱标签驱动。容器是隔离边界（与端对端微虚拟机层相同型号）。
- **能力** — `Capabilities.has_a11y_tree`（远程后端暴露跨平台`get_accessibility_tree`本地Enigo后端则不）。

### 第一阶段范围/Non-Goals

在：本地Docker 提供商、GUI动作路由、Character + 工作流节点目标选择器。延迟：cua.ai Cloud + Lume 提供商，`cua-driver`后台主机驱动，以及与 ADR-0028 的**收敛**——未来`sandboxTier: "cua-desktop"`通过读取同一会话→connectionId绑定将Bash/Edit/Write导入*同一*容器的`run_command`/`read_text`/`write_text`。由于绑定本身就是一类实体，这种收敛纯粹是加法的（无迁移）。每场次Composer目标选择器是剩余的UI 接口（会话字段 + 解析已经端到端工作）。

### 模式（远程目标）

Dexie 提升到 `v57`（加法，无升级hook）——新增`sandboxConnections`表。`Character.computerUseTarget` + `ChatSession.computerUseTarget` 为可选;现有行往返不变。

## 附录（2026-06-27）——OCR-assisted点击 + macOS有界元素树

### `find_text` / `click_text`（像素⇄ OCR桥）

两个新的**gated**插件MCP工具（`lib/automation/ocr-click.ts`，由电脑插件显示）允许模型按名称操作屏幕上的文本，而非猜测像素坐标：

- `find_text` — 捕获屏幕（门禁`desktop.screenshot`）→ OCR →返回具有**屏幕空间**坐标的文本块，查询中排名最佳优先。
- `click_text` ——相同，然后`desktop.click`匹配块的中心（occurrence/button/double可选）。坐标通过提供商光栅化调光和Rust截图降频因子（`coordinate-scaler`信号）OCR `bbox` →映射物理 px。两者都依赖现有的gate/consent/audit流水线。需要一个发出边界框的 OCR 提供商（tesseract / windows-ocr）;无几何体 提供商 返回明显错误。`extract_screenshot_ocr`现在还返回了相对于图像的`blocks`。

### macOS有界AX元素树

macOS 上的 `read_tree` / `find` 现在可以通过高层`accessibility` crate走**最前窗口**的AX子树，depth/node-capped通过新的平台无关`automation::platform::shared::tree_shape`助手（matcher + budget + rect-center;在包括 Windows 开发机在内的所有主机上进行了单元测试）。`capabilities.has_a11y_tree`现在macOS `true`，`find`满足名称 / name_contains / control_type（不仅仅是process/title）。原生AX FFI在macOS CI上验证——它不会在Windows开发主机上编译。

**延迟（下一阶段）:** macOS `pick_at_point`坐标命中测试（`AXUIElementCopyElementAtPosition`需要在`accessibility` crate旧核心基础引脚上进行原始`-sys` ref封装）、元素定向动作（可解析元素引用）、元素几何（`AXPosition`/`AXSize`），以及**Linux AT-SPI**等效物（async/zbus——不是从Windows主机盲目尝试）。`tree_shape`是它们将重复使用的共享骨干网。

## 附录（2026-07-06）——macOS 检查员实际可用

后续的两个缺陷使macOS检查员实际上死了，尽管2026-06-27的边界AX树已经发货：

1. **前端被错误的能力限制了。** `InspectorTab`和概览徽章关闭了`caps.hasUia`（Windows UI自动化），所以macOS——报告`hasA11yTree: true`而非`hasUia`——总是跳入“仅限Windows......后续里程碑”警报。TS `Capabilities`类型甚至没有镜像Rust `has_a11y_tree`字段。修复方法：在TS类型中添加`hasA11yTree`;门禁检查员在`hasUia || hasA11yTree`;将UIA-only模式测试功能（Windows上`UnsupportedPlatform`回归）隐藏在一个诚实的仅限a11y的注释后面;接口在概览上`a11yTree`徽章（`platform-capabilities-card.tsx`，提取+单元测试）。

2. **树“只有窗口名”。** 在macOS主机上通过用独立的AX探针对真实应用（Chrome、VS Code）进行诊断——三个根本原因，现已在`ax/mod.rs`+新`ax/raw.rs`中修复：
   - **懒惰的网页a11y。** Chromium / WebKit / Electron 应用（包括Cognia自家WKWebView）在AT客户端设置 `AXManualAccessibility` / `AXEnhancedUserInterface` 后才发布网页内容树。`read_tree`现在会激活它（应用没有窗口时会有短暂的稳定延迟）。
   - **错误的根窗口。** `AXWindows[0]`通常是空的辅助窗口（在 Chrome 上观察到）。根选择现在`AXFocusedWindow` → `AXMainWindow` →应用元素→第一个非空窗口。
   - ** 瘦节点。** 节点现在携带子角色（→ `class_name`）、标识符（→ `automation_id`）、enabled/focused 回退、链名（`AXTitle` → `AXDescription` →字符串`AXValue` → `AXRoleDescription`）和几何体（`AXPosition`/`AXSize` → `bounding_rect`）。**AX信任门禁**现在会`read_tree`大声失败（系统提示），当进程未被授予可访问性时，而不是默默返回空树。

整个依赖图共享一个`core-foundation-sys`（0.8），因此原始AX FFI通过`accessibility-sys` + `core-foundation-sys`干净利落地桥接，避免了之前笔记担心的核心基础0.9与0.10封装冲突——延迟`AXUIElementCopyElementAtPosition`选中测试现在被同一桥接解除阻挡。Inspector的默认`maxDepth`提升为2→4（上限6→
   10) 所以树默认会达到真实内容。

---

## 附录——记录器门禁与紧急停车（2026-08-01，参见[ADR-0106](/docs/en/adr/0106-end-to-end-skill-recorder)）

添加技能记录器——一个安装全局输入hook并比启动通话更久的会话——暴露了本书ADR建立的门禁合同中的三个漏洞。这三个漏洞在这里都被修复，而不是在录音器中绕过。

1. **`run_gated`门控一次性操作，而非会话。** 解决方式：** 转折门禁，而非会话。** “Armed a Recording”实际上是一次性操作，完成时间为毫秒，因此`record_start`正常通过`dispatcher::run_gated`;拆除无需授权，写入自己的配对`audit_session_end`行，因此诊断显示的是匹配的对，而非单侧`record_start`。

2. **`Whitelist`层可以自动允许全局输入hook。** `Call::forces_per_call()`现在对shell类*和*`record_start`返回为true，`record_start`加入`CallKind::Driving`臂。由于`evaluate`现有的顺序是kill switch→禁用→→白名单的层级关闭→同意，且`run_gated_impl`中没有在白名单之前运行，因此“在提示前拒绝”是从现有排序中导出的，而不是新的检查。调用站点通过捕获范围派生的`process_name` / `window_title`;之前绕过的路径对两者都通过了`None`，完全跳过了白名单。

3. **同意从未一次性完成。** `request_with_thumbnail`在`has_session_grant`时短路，每当渲染器传递`persist: true`时`resolve`插入授权——`session_key: None`未阻止。`ConsentPrompt::is_one_shot()` 现在对 `record_start` 返回为真;`has_session_grant` 对其提前返回 false，`resolve`跳过插入。一个“不要再问”，默默重新激活全局输入hook，不是用户可以提前有意义地给予的授权。

**紧急停止包含三个不同的功能。** `automation_kill_switch`（命令.rs）、全局快捷方式（`shortcuts/registry.rs`）和托盘项（`tray/mod.rs`）各自承担不同的子集工作：前者从未发出事件，后者跳过持久性和虚拟显示释放，第三者跳过了授权清除。它们现在共享`automation::kill_switch::engage`，会激活→持久化→清除会话授权→释放虚拟显示→ `recorder.interrupt_blocking(KillSwitch)` →发出一个`automation:kill-switch`。事件*名称*未变，现有TS监听者继续工作;它的载荷从`null`变成`KillSwitchEvent`。`interrupt_blocking`不接受`AppHandle`（它使用存储的`EventSink`），这让`engage`能保持通用而不会感染`ActiveSession` `R: Runtime`。

两个支持性新增：一个非提示`platform/shared/input_monitoring.rs`（`IOHIDCheckAccess`，与`screen_capture.rs`相同的5s缓存），使得印前检查可以报告输入监控状态，而唯一信号不会`HookGuard::install`失效;以及`InputEvent::KeyDown`获得一个布局解码的`text`字段（macOS `CGEventKeyboardGetUnicodeString`，Windows `ToUnicodeEx`），因为`keys_to_hint`只输出大写ASCII。

## 附录——远程桌面能力修正（2026-08-24）

Docker/computer-server 连接现在只被视为**远程 GUI** 提供方。它不能证明
shell 或文件操作发生在容器内，因此 `workspaceRead` 与 `workspaceExec`
默认均为 `false`；读取旧连接行时也会将这两项收窄为 `false`。远程 GUI
调用仍携带 connection id，但现在由不可变的 `SandboxRuntimeRef` 连同已解析
的 confinement ceiling 一起提供。

为兼容存量数据，`cua-desktop` shell tier 仍保留在序列化类型中，但现有层级
选择器会禁用它并显示原因，发送预检也会直接拒绝。它不会回退到宿主机自动化
或 `sandbox_exec`。Docker 的 start/stop/health/delete 现统一经过既有
`SandboxProviderAdapter` 与 `runSandboxOperation`；未实现的 provider 会持久化
类型化错误，不再停留在 `starting`。

## 附录（2026-08-30）：app-session 工具面，以及始终没接上的那一半

`28ca2c722` 用 revision-bound 的 **app session** 取代了 Anthropic 形状的
`computer_20251124` 工具面。`get_app_state` 返回某个应用的一个编号 revision
（可访问性树投影、与上一版的 diff、一帧画面、一个一次性 `turnToken`），
`perform_action` 花掉这个 token，作用于元素句柄或像素目标。Rust 侧这次替换
做得很好，TypeScript 侧只完成了一半。本附录同时记录缺口与修复，因为上文
的 ADR 正文描述的仍是那个已被删除的工具面。

**模型看不见屏幕。** `get_app_state` 返回的是普通对象，`plugin-tools.mjs`
落到 `toolText`，`safety.mjs` 再用 `JSON.stringify` 序列化整个 revision。
于是画面以 base64 **文本**抵达模型：视觉模型读不了，而一张 1280x800 的 PNG
大约要花掉十万量级的 token，偏偏这个工具的描述要求每次动作前后都调用它。
投影现在只有一份，位于 `lib/automation/model-frame.ts`，产出一个 MCP `image`
块加一个剥掉 bytes、保留尺寸的 JSON 块（像素目标要靠这些尺寸校验）。
两个面向模型的表面都用它：应用内的插件工具，以及 External Bridge 的
`computer_use`，后者通过 `runWithGate` 统一的文本信封犯了同样的错。

**五个工具里有四个发布的是空 schema。** `perform_action` 把整个动作词汇表
声明成 `{"request": {"type": "object"}}`，模型因此从不知道元素句柄、像素目标
和 `strategy` 的存在，而 `jsonSchemaToZodShape` 会把这个参数降级为
`z.unknown()`，连校验也一并失去。契约现在只写一次，以 zod 形式落在
`lib/automation/action-schemas.ts`，再用 `z.toJSONSchema` 渲染成 JSON Schema。
Rust 仍是真相源，因此有一个 parity 测试从 `session.rs` 里读出 `UiAction` /
`ActionTarget` / `ActionStrategy` 的枚举，zod 联合一旦漂移就失败。这项工作
还牵出一个前置条件：`jsonSchemaPropToZod` 没有 `oneOf` / `anyOf` 分支，而模型
看到的 schema 是从**转换后**的 zod 形状生成的，不是从 manifest，所以不修的话
每个可辨联合都会原样退回 `z.unknown()`。

**Windows 与 Linux 在静默点错位置。** 默认实现的
`AutomationBackend::screenshot_application` 截的是整屏，汇报的却是前台**窗口**
的逻辑矩形，而 `pixel_to_global_point` 假设画面正好覆盖 `logical_bounds`。
于是整屏像素被映射进一个窗口矩形，全程不报错。默认实现现在汇报实际捕获的
**显示器**矩形，也就是这些像素真正所属的那一个。

**缺三个原语。** `zoom` 裁剪 revision 那一帧的一个区域，这是高分辨率屏幕上
已知性价比最高的 grounding 补救手段。它裁的是**存量帧**而非重新捕获，因为
重新捕获会与 UI 竞态，交回一个与模型正在推理的 revision 不匹配的区域。
`wait` 让一个回合可以等 UI 稳定，而不是去读一张画到一半的帧。
`PermissionGate::check_rate` 把驱动类调用限制在每分钟 150 次，并拒绝连续
20 次同签名的调用。读永不限流，因为饿死 `get_app_state` 恰好会拿走 agent
发现自己卡住所需的那份反馈。kill switch 会重置这个窗口，新一轮运行不会被
上一轮的预算拒掉。

**截图降采样现在作用于模型真正看的那条路。** 设置 → 自动化 → 行为下的这一项，
过去只被 `desktop_screenshot`、同意缩略图和录制器读取，`desktop_get_app_state`
完全不读。现在采集会分成两帧：交给调用方的那份按操作者的预算缩放，
`UiSurface::pixel_width` / `pixel_height` 描述的就是**这一帧**，从而让穿过
session 的每个像素坐标都说同一种语言；原生分辨率的那份则作为
`SessionRecord::zoom_source` 留下。降采样因此不丢细节，因为 `zoom` 裁的是
原生帧：基础帧保持便宜，细节仍然可以一区一区拿回来。`ZoomedRegion` 用
「所展示帧」的坐标空间汇报 `region`，并以 `scale` 表示每个 region 像素对应
多少裁剪像素，于是一个点按 `region.origin + crop_point / scale` 映射回去。
只有当降采样确实缩小了尺寸时才会保留第二份拷贝。

**凭据窗口遮蔽作用在了错误的那份拷贝上。** ADR-0020 W1 的遮蔽跑在命令边界，
改的只是即将返回的那个 revision，而 session 存下的是原始帧。当 `zoom` 开始
裁剪存量帧之后，一个处于前台的密码框会在 `get_app_state` 里被涂黑，却能在
一次 `zoom` 之后被完整取回。遮蔽已移入采集过程
（`worker::redact_captured_frame`），于是 session **存下**的那一帧本身就是
遮蔽后的，所有读它的人都继承同一个决定。这次移动顺带补上一个既有缺口：
`cognia-mcp-server` 的 `automation_proxy` 是进入同一个 worker 的第二个入口，
它经过 `run_gated_enf` 有门禁，却从不做遮蔽，因此 MCP 客户端能拿到桌面路径
已经涂黑的凭据像素。

**一个跨语言的线格式缺陷。** `ElementRef` 与 `KeyChord` 在 Rust 侧是 newtype
struct，serde 会透明渲染成裸 JSON 字符串，TypeScript 却把它们建模成一元组。
`desktop.keys()`、`holdKey()`、`Locator.from` 以及事件触发器的 scope 过滤
一直在发送后端会拒绝的形状，而 `elementRefValue()` 读一个真实引用只会拿到
**第一个字符**。`lib/automation/types.test.ts` 里有两条断言钉的正是错误格式。
Rust 侧现在有一个测试断言元组形状**不能**反序列化。

**六处休眠接线接回。** `startAutomationAuditMirror` 零调用点，于是保留策略
任务在勤奋清理一张自动化从不写入的表。`classify-risk.ts` 仍以已删除的工具名
为键，ADR-0070 的 risk-to-ceremony 升级对 Computer Use 从未触发过。它的回归
测试现在直接遍历共享常量，改名不会再让某个工具静默掉出等级。画中画视图在
现行工具路径上没有生产者。`ComputerUseCard` 映射到已删除的工具名，解析的还是
旧的 `{action, coordinate}` 形状，因此每次调用在聊天里都渲染成一坨原始 JSON。
`find_text` / `click_text` 基于既有的 `ocr-click.ts` 重新注册为工具，覆盖元素
句柄的盲区（Canvas、游戏、远程桌面、自绘控件），并在表面指引里注明它们捕获
的是主显示器而非应用窗口。以及新建了
`app/recorder-controller/page.tsx`，因为 `recorder_window` 打开的是一条不存在
的路由，每次录制期间都是一条空白置顶条。

本轮不做、仍然开放的部分：Windows 的 app-session 后端（那四个
`AutomationBackend` 方法没有 UIA 覆写，所以 app session 目前只有 macOS）、
权限授予入口、macOS 的 `window_op`，以及 macOS/Linux 上的 `DragOpts` 与
`ScrollTarget::Element`。
