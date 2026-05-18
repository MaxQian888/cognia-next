---
title: "0020 — Computer Use 补齐"
description: "在 M5 脚手架基础上补齐五个 stub 动作、同意 UI、sidecar 头部、角色开关、MCP 暴露和 macOS/Linux 最小后端。"
---

# ADR 0020 — Computer Use 补齐

**状态：** 已通过
**日期：** 2026-05-14
**分支：** `feat/computer-use-completeness`

## Context

Computer Use 脚手架（M5）已经上线了一个可运行的 Rust 自动化子系统
（`src-tauri/src/automation/`）、工作流节点、Settings UI 框架、审计表，以及一个
位于 `plugins/computer-use/` 的插件，该插件注册了三个 Anthropic 原生工具
（`computer_20251124`、`bash_20250124`、`text_editor_20250728`）。但有四块地方
还是缺失或残缺的：

1. **`computer_20251124` 的 10 个动作中有 5 个返回 “not yet implemented”** —
   `MouseMove` / `Drag` 被当成点击处理，`MouseButtonDown` / `MouseButtonUp` /
   `Scroll` / `HoldKey` 直接报错。
2. **PerCall 同意 UI 没有渲染。** `Decision::RequireConsent` 直接返回
   “Consent required for this action” 错误，最严格的权限层级实际上不可用。
3. **Sidecar 看不到注册的原生工具。** `lib/claude/build-options.ts` 没读
   `native-anthropic-tool-registry`，所以 Anthropic Agent SDK 启动时没有带
   `anthropic-beta: computer-use-2025-11-24` 头。
4. **Settings → Whitelist 与 Inspector 两个 tab 是占位卡片**，写着 “Ships in M2”。

此外：没有 `Character` 字段控制工具的可见性（每个对话都会带出工具），外部桥接
MCP 没有暴露 `computer_use`，macOS / Linux 后端是 `StubBackend` 占位。

用户要求做一次 **不重设计的补齐**：保留现有架构，补齐所有缺口，并且
**在合适的地方更深入地调用 `uiautomation` crate**。

## Decision

七项具体改动。

### 1. AutomationBackend trait 新增 5 个方法

`src-tauri/src/automation/backend.rs` 把 `mouse_move`、`drag`、`scroll`、
`hold_key`、`mouse_button` 加进 trait。`StubBackend` 对每个都返回
`UnsupportedPlatform`。Windows 的 `UiaBackend` 用 `windows::SendInput` 实现
（移动 / 滚轮 / 按钮）和 `uiautomation::inputs::Keyboard::{begin_hold_keys,
end_hold_keys}` 实现 hold_key。新类型 `Point`、`DragOpts`、`ScrollTarget`、
`ScrollOpts`、`ButtonTransition` 落在 `automation/types.rs`。

### 2. UIA Pattern 优先点击策略

`ClickOpts.useNative` 默认为 `true`。当点击带 `Element` 目标时，后端依次尝试
`InvokePattern` → `TogglePattern` → `SelectionItemPattern`；都不行则回退到
元素自带的 `click()` helper；最终落到 bounding-rect 中心坐标点击。Pattern
派发代码集中在 `automation/platform/uia/pattern.rs`，同时被
`desktop_invoke_pattern`（之前的 stub Tauri 命令）复用。`desktop_window_op`
也通过同模块的 `dispatch_window_op` 走 `UIWindowPattern` /
`UITransformPattern`。

### 3. 通过 Tauri 事件 broker 实现 PerCall 同意 UI

`automation/consent.rs` 新增 `ConsentBroker`。当 gate 返回
`Decision::RequireConsent`：

1. 在 `session_grants` 中按 `(surface, command, plugin_id, process_name)`
   元组查“本会话总是允许”授权。命中 → 直接允许。
2. 否则生成 UUID，注册 `oneshot::Sender`，发出 `automation:consent-request`
   事件并 await receiver（30 秒超时）。
3. 渲染端 `<ConsentOverlay />`（`components/automation/consent-overlay.tsx`）
   监听事件，在主窗口右下角浮出 `允许一次 / 本会话总是允许 / 拒绝` 三选一卡片。
4. 用户点击后调用 `automation_consent_respond({ id, allow, persist, prompt })`
   解析 channel；若是“总是允许”则写入会话授权表。

启用 kill switch 会清掉所有 session 授权。

### 4. Sidecar `anthropic-beta` 头透传

`sidecar/dispatch/anthropic.mjs` 已经懂得通过 `ANTHROPIC_DEFAULT_HEADERS`
透传 Anthropic Agent Skills。同一条路径现在也合并
`sendOptions.appendHeaders` —— 这部分由 `resolveSendOptions` 用
`computeAnthropicBetaHeaders([...])` 填充 —— API 请求于是带上
`anthropic-beta: computer-use-2025-11-24`。

完整的 canUseTool 端 → 渲染端 `desktop.*` API 派发 **不**包含在本 ADR 中；每个
注册工具的 `executeIpc.invoke` 字段都指向真实的 Tauri 命令，所以工作流节点和
MCP 调用方可以直接驱动 Computer Use，但 SDK 主导的聊天路径还需要在后续提交中
做渲染端桥接。

### 5. 软绑定 `Character.enableComputerUse`

对齐已有的 `Character.twinId` 与 `Character.a2uiEnabled` 范式：

```ts
interface Character {
  enableComputerUse?: boolean
  computerUseSettings?: {
    allowedToolIds?: string[] // 已注册工具 id 的子集
    requireConsent?: boolean
  }
}
```

`lib/claude/build-options.ts` 通过 `lib/claude/computer-use-tools.ts:applyComputerUseTools`
读注册表；仅当 `enableComputerUse === true` 时才填充 `opts.anthropicTools`
和 `opts.appendHeaders["anthropic-beta"]`。Character 编辑器在
brief / debug / bare 三个开关旁加一个 `Enable Computer Use` 开关。Schema
升到 v32（不需要迁移，字段都是可选的）。

### 6. 外部桥接的 `computer_use` MCP 工具

`lib/external-bridge/handlers/computer-use.ts` 注册一个 `computer_use` MCP
工具，输入是动作联合体（`screenshot` / `click` / `type` / `keys` /
`mouse_move` / `drag` / `scroll` / `hold_key` / `mouse_button`）。Node sidecar
入口暴露这个工具；新 scope `mcp:computer-use`（默认关）通过 `checkToolCall`
门控每一次调用。Settings → External Bridge 渲染对应开关。

在独立模式（cognia 桌面应用未连接）下，handler 返回结构化的 `not-yet-bridged`
错误以便外部 agent 看清原因；渲染桥接的派发暂时只走应用内路径，直到 sidecar
→ Rust → 渲染端的 IPC 桥落地。

### 7. macOS / Linux 最小可用后端

`platform/ax/mod.rs`（macOS）和 `platform/atspi/mod.rs`（Linux）把
`StubBackend` 占位替换成 `enigo` 驱动的实现：`capabilities`、`screenshot`
（走跨平台 `platform::shared::screenshot::capture_primary`）、`click(Point)`、
`type_text`、`send_keys`、`mouse_move`、`drag`、`scroll`、`mouse_button`。

`AXUIElement` / AT-SPI 树遍历 **不** 在范围内 —— `find` / `read_tree` /
`invoke_pattern` / `window_op` / Element 目标点击在这两个平台都返回
`UnsupportedPlatform`。`Capabilities.hasUia` 在 macOS / Linux 为 false，
渲染端会隐藏 UIA 专属功能（Inspector tab、工作流节点的按树定位对话框）。

## 能力矩阵

| 动作                  | Windows  | macOS | Linux |
| --------------------- | -------- | ----- | ----- |
| `screenshot`          | yes      | yes   | yes   |
| `click(Point)`        | yes      | yes   | yes   |
| `click(Element)`      | yes      | no    | no    |
| `type_text`           | yes      | yes   | yes   |
| `send_keys`（组合键） | yes      | 部分¹ | 部分¹ |
| `mouse_move`          | yes      | yes   | yes   |
| `drag`                | yes      | yes   | yes   |
| `scroll`              | yes      | yes   | yes   |
| `mouse_button`        | yes      | yes   | yes   |
| `hold_key`            | yes      | no    | no    |
| `read_tree` / `find`  | yes      | no    | no    |
| `invoke_pattern`      | yes      | no    | no    |
| `window_op`           | yes      | no    | no    |
| UIA 事件订阅          | no（M2） | no    | no    |

¹ macOS / Linux 支持单键组合（`Enter`、`Tab`、`Escape`、`Backspace`、
`Delete`、`Space`）；带修饰键的组合（如 `ctrl+shift+t`）会返回 `BackendError`。
Windows 后端解析 `uiautomation::inputs::Keyboard::send_keys` 能接受的所有
组合。

## Settings 体验

- **Settings → Automation → Permissions** —— 每个 surface（Workflow /
  Computer Use / MCP / Plugin）三个 tier（Off / Whitelist / Per-call），默认 Off。
- **Settings → Automation → Whitelist** —— 进程名 + 窗口标题 glob 编辑器 +
  “Capture focused window” 助手按钮。
- **Settings → Automation → Inspector** —— 树管理器 + 元素详情 +
  locator/element-ref 复制按钮 + UIA pattern 测试按钮。macOS / Linux 上由
  `Capabilities.hasUia === false` 禁用。
- **Settings → Characters → Edit** —— 在 brief / debug / bare 开关下面加一个
  Enable Computer Use 开关。
- **Settings → External Bridge** —— `mcp:computer-use` scope 开关。

## 不在范围内

- macOS / Linux 的 UIA 等价树遍历（AXUIElement.children、AT-SPI 介质）。
  Phase 6.b 跟进。
- 插件注册自定义桌面动作 / UIA pattern。插件依然通过
  `registerNativeAnthropicTool` 贡献整个原生工具。
- 元素拾取器叠层（Inspector → “Pick” 按钮需要的
  `desktop_pick_start` / `_cancel` Rust 命令）。UI 渲染为禁用状态并附 “M5b
  落地” 提示。
- 聊天路径完整的 canUseTool sidecar 派发（工作流节点和 MCP 调用已经能通过
  现有 `desktop_*` Tauri 命令驱动 Computer Use）。

详细文件列表见英文版 ADR。

## 附录 2026-05-15 — 完整性 Slate 2

在 M5 脚手架之上的补齐 PR 关闭了 11 个遗留缺口。其中两个原始 Non-Goal（聊天驱动 canUseTool 侧车派发、Sidecar→Renderer 的 MCP automation-proxy IPC）经研究确认需要结构性新架构而非「补齐」工作，转入独立 ADR 跟进。

**已关闭缺口**

1. `text_editor` 新增 `undo_edit` 动作。`TextEditorAction::UndoEdit { path }` 在 `plugins/computer-use/rust/src/types.rs` 声明；`UNDO_STORE` 在每次 `Create` / `StrReplace` / `Insert` 之前快照旧内容；undo 恢复旧内容，若旧状态是「文件不存在」则删除当前文件。
2. `bash.restart: true` 作为审计内空操作处理。Cognia 没有可重启的常驻 shell，命令返回合成 `BashResult` 在 `stdout` 说明差异，审计命令名为 `bash:restart`。
3. `plugins/computer-use/plugin.json` 的 `runtimeCompatibility` 键由 `desktop` 改为规范的 `tauri`（与 `types/plugin/plugin.ts:99` 一致）。新增 `lib/plugin/core/builtin-manifest-shape.test.ts` 遍历所有内置插件 manifest，拒绝非规范键。其余 6 个插件同步修正。
4. 删除 `plugins/computer-use/src/index.ts` 中 `activate()` 里的运行时 `registerNativeAnthropicTool` 调用；manifest 驱动注册为规范路径。
5. TypeScript SDK 文件按能力契约路径补齐：`plugin-sdk/typescript/src/api/native-anthropic-tool.ts` 与 `plugin-sdk/typescript/src/context/extended.ts`。
6. `runtime-proof-audit.test.ts` 锁定 `native-anthropic-tool` 的 `proofStatus` = `verified`。
7. 设置 → 自动化 的授权浮层 + 全部五个标签（概览 / 权限 / 白名单 / 审计 / 检查器），以及 角色 → Computer Use 开关、外部网桥 `mcp:computer-use` 作用域描述均通过 `useTranslations()` 接入 i18n；新增 `automation.*` 命名空间，扩展现有 `settings.*`。`/cu` 斜杠命令通过 `lib/i18n/plugin-i18n-registry` 注册插件侧 i18n bundle。
8. `i18n/messages/en.json` 与 `zh-CN.json` 键对齐恢复。`scripts/i18n-baseline.json` 重置 — JSX 硬编码字符串数量从 811 降至 698（关闭 ~113 处）。
9. 能力契约 `hostBindings` 与运行时证明审计同步更新。

**仍延迟（Non-Goal，独立跟进）**

- 聊天驱动的 `canUseTool` 侧车派发（`computer` / `bash` / `text_editor`）。`@anthropic-ai/claude-agent-sdk` 是纯 MCP 架构，没有可以传入 API 级原生工具的字段。关闭这个缺口需要：要么让 `sidecar/dispatch/ai-sdk.mjs` 借助 Vercel AI SDK 通过 `provider-defined` 工具承载，要么新增直调 Anthropic SDK 的派发器。任一路径都是结构性新派发器，超出「补齐」范畴。
- MCP 单机 `computer_use` IPC。Node MCP sidecar 使用 SDK 的 `StdioServerTransport`，独占 stdin/stdout。`automation_proxy` 信封需要 Node 侧自定义 Transport 包装 + Rust 侧 `mcp_server/sidecar.rs` 的 stdout 抽取重构，独立跟进。
- macOS / Linux 等效 UIA 树遍历（Phase 6.b）。
- 插件注册的自定义桌面动作 / UIA 模式。

## Addendum 2026-05-18 — 聊天派发 + 三个动作 + cursor_position

通过架构上的转向关闭了 2026-05-15 addendum 标记为结构性 Non-Goal 的两个派发缺口，并补齐 M5 原始范围之外的三个小动作。

### 架构转向 —— 经由 Plugin MCP 实现聊天，而不是新派发器

2026-05-15 addendum 把聊天驱动的 `canUseTool` 派发框定为「要么让 `ai-sdk.mjs`
透传 provider-defined tools，要么新建 Anthropic 直连派发器」。两条路都会绕过
`@anthropic-ai/claude-agent-sdk`，丧失只在该 SDK 内才存在的 Claude Code 能力
（built-in Bash/Read/Edit、subagent `agents`、settings sources、resume/fork、
`effort`、`maxThinkingTokens`、partial-message 流、Anthropic Skills 透传）。

转向方案：**把 `computer_use` / `bash` / `text_editor` 通过现有
`cognia-plugin-tools` 桥包装成 Plugin MCP 工具**，而不是注入 API 级原生工具。
模型看到的是 `mcp__cognia-plugin-tools__{computer_use,bash,text_editor}` 而不是
API 级 `type: "computer_20251124"`。功能等价，但 Anthropic API 端原生
computer-use 的预训练加成不会触发 —— 模型仍然可用，只是少了原生工具类型带来的
prompt 处理优惠。

用户明确接受这个权衡：Claude Code SDK 的全部能力得以保留；聊天路径继续走
`dispatchAnthropic`，无任何改动。

### 已关闭的缺口

1. **聊天驱动 Computer Use** — `plugins/computer-use/src/index.ts` 的
   `activate()` 通过 `ctx.agent.registerTool()` 注册三个插件工具。`plugin.json`
   增加 `"tools"` capability。现有 `sidecar/builtin-tools/plugin-tools.mjs` 桥
   会自动把它们暴露为 MCP 工具给 SDK，**无需任何派发器改动**。
   `requiresApproval: true` 触发聊天侧 `canUseTool` 模态；Rust 权限门在每次
   `desktop.*` 调用时独立启用。

2. **外部 MCP `mcp_computer_use`** — `src-tauri/src/mcp_server/automation_proxy.rs`
   （新）为每个 `SidecarProcess` 创建专属 Unix Socket / Windows Named Pipe，
   通过 `COGNIA_AUTOMATION_PROXY` 环境变量传给 Node MCP sidecar。
   `lib/external-bridge/handlers/computer-use.ts` 在首次调用时打开该套接字，
   发送 `{ id, command, args, ctx }` 信封并等待对应响应。MCP stdin/stdout
   传输的串行 mutex 不受影响 —— 自动化请求走完全独立的通道。

3. **Inspector Pick** — `src-tauri/src/automation/platform/uia/pick.rs`（新，
   Windows）在专用线程注册低级 `WH_MOUSE_LL` 钩子，打开一个透明置顶 webview
   `automation-pick-overlay`（覆盖窗仅作视觉提示 —— `pointer-events: none` 让
   点击穿透到底层应用），首次捕获 `WM_LBUTTONDOWN` 后通过 UIA
   `ElementFromPoint(x, y)` 解析 `ElementInfo`。新 Tauri 命令
   `desktop_pick_start` / `desktop_pick_cancel`。macOS / Linux 返回
   `UnsupportedPlatform`。

4. **`triple_click` / `wait` / `cursor_position`** — `ClickOpts.count` 字段
   （1/2/3）；UIA 后端按 OS `GetDoubleClickTime` 节奏重复点击。`Wait` 已在
   ComputerAction 枚举里，Anthropic action mapper 层在 TS 端直接 sleep，无
   Rust 往返。`cursor_position` 作为只读 Tauri 命令新增（Windows
   `GetCursorPos`，macOS / Linux 走 `Enigo::location()`）。

### 重新分类的 Non-Goal

2026-05-15 addendum 中归为结构性 Non-Goal 的两项现在已关闭：

- ~~聊天驱动 `canUseTool` 侧车派发~~ —— 通过 Plugin MCP 实现。
- ~~MCP 单机 `computer_use` IPC~~ —— 通过 `COGNIA_AUTOMATION_PROXY` 侧通道实现。

### 仍延迟

- macOS / Linux 等效 UIA 树遍历（Phase 6.b）。
- 插件注册的自定义桌面动作 / UIA 模式。
- macOS / Linux 完整 chord 解析器 + `hold_key` 等价支持。归入 Phase 6.b 非
  Windows 后端补齐。

### Schema

Schema 升级到 `v40`（仅新增，无迁移）。增加可选字段
`Character.computerUseSettings.chatConsentMode`
（`"always-ask" | "session-grant" | "auto"`，默认 `"always-ask"`）和
`ClickOpts.count`（1/2/3）。既有行原样可读。
