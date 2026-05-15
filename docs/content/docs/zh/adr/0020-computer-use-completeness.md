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
