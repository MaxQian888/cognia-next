---
title: ADR-0031 — 集成终端 Phase 2 —— Dock↔Agent 统一、断线重连/replay、插件 + 工作流接入
description: 在已有终端 dock 之上的 Wave 1-4 增强。(1) Agent 的 MCP 终端工具通过现有 `plugin_tool_exec` IPC 直接驱动用户可见的 PTY —— 同一个 shell、同一个 cwd、同一份历史。(2) sidecar 新增 node-pty REPL 内建工具，为 agent 提供私有交互式 shell（与 dock 中继正交）。(3) Rust 端 5 分钟带 `seq` 的回放缓冲存活 WS 断线；WS handler 实现 resume 协议；前端按指数退避重连。(4) `BaseTerminalSession` 抽象类去重三种传输（Tauri / WS / 将来的 WebRTC）共享的 listener/exit-state 模板。(5) 插件 manifest 早已带 `terminal:spawn|write|kill`；本波新增 workflow `action.system.terminal` 节点 + 借助 github-delivery 的 pre-flight 测试路径 dogfood。(6) 收尾：fish + nushell shell-integration、OSC 8 超链接、dock 拖拽调高、可配置 run-in-dock 超时、移动端 search+history 覆盖层对齐。
---

# ADR-0031 — 集成终端 Phase 2

**状态**：Proposed (2026-05-22)
**作者**：Max Qian + Claude Opus 4.7
**影响范围**：`lib/terminal/`、`lib/plugin/bridge/sidecar-tools-bridge.ts`、`lib/plugin/security/permission-guard.ts`、`lib/claude/plugin-tool-ipc.ts`、`lib/claude/build-options.ts`、`lib/workflow/nodes/`、`types/workflow/visual.ts`、`components/terminal/`、`components/mobile/mobile-terminal-screen.tsx`、`components/settings/terminal/`、`components/workflow/editor/inspector/`、`sidecar/builtin-tools/`、`src-tauri/src/terminal/`、`src-tauri/src/companion_api/ws_terminal.rs`、`src-tauri/resources/terminal/`、`plugins/github-delivery/plugin.json`

## 背景

Phase 1 在 `master` 上以未提交形式落地了约 80 个文件，覆盖完整 xterm.js dock、Rust `portable-pty` 后端、OSC 633 解析器、移动 WebSocket 传输、设置 UI、聊天交接、sidecar MCP 工具、插件 VSCode shim、agent-trust 同意闸。一次横切审计列出 23 个具体缺口。用户决定一次性交付，按四个主题：Agent dock 统一、移动/WAN 韧性、插件 + 工作流接入、Shell 平台均等。

本 ADR 记录决策及其相互依赖。

## 决策

### D1 — Dock↔Agent 统一沿用已有 `plugin_tool_exec` IPC

之前：`sidecar/builtin-tools/terminal-dock-tool.mjs` 文件头部明确写到 agent 的 `child_process` 会话**不是**用户在 dock 看到的 PTY 进程（"Run in dock" 名不副实）。

之后：渲染端通过已有的 `pluginTools` 通道向 sidecar 上报 4 个合成的 `terminal_dock_*` 工具（`lib/plugin/bridge/sidecar-tools-bridge.ts:buildTerminalDockManifestEntries`）。sidecar 现有的 `plugin-tools.mjs` 代理用与第三方插件工具完全一致的 `plugin_tool_exec` → `plugin_tool_response` 来回桥接。渲染端 `lib/claude/plugin-tool-ipc.ts:handlePluginToolExec` 识别 `terminal_dock_` 前缀并派发到 `lib/terminal/dock-tool-handler.ts:runTerminalDockAction`，该 helper 经过 `requestAgentTrust` 和 `runInDockTab`，与聊天侧的 "Run in dock" 保持一致的同意 + tab 闸。

通过复用 `pluginTools` 协议，方案净减 2 个新文件（`terminal-dock-bridge.mjs`、`terminal-dock-ipc.ts`）。每次调用都过三道闸：

1. **Manifest** — `buildPluginToolsManifest({ exposeDockToAgents })` 在开关关闭时根本不上报合成条目，sidecar 也就不会注册。
2. **渲染端** — `dock-tool-handler.ts` 每次动作都重新读取 `useSettingsStore.getState().settings.terminal.exposeDockToAgents`（防御 manifest 缓存过期）。
3. **同意 broker** — 写入走 `terminal:write` permission，scope 为 `agent:<chatId>:<tabId>`（`lib/terminal/agent-trust.ts`）。

### D2 — 通过 `node-pty` 提供 headless 交互式 REPL（可选依赖）

Dock 中继覆盖渲染端在场的场景。在 headless 场景下（V2 server、不需要用户可见的 agent-only 流），sidecar 暴露 4 个 `terminal_repl_*` 工具，由 `node-pty` 提供真实 PTY：双向字节、环形输出缓冲、空闲 GC、每 agent 会话上限（8）。`import("node-pty")` 懒加载——没有原生模块的宿主退化为结构化错误而非崩溃。

`node-pty` 在 `sidecar/package.json` 中声明为 `optionalDependencies`，无 C++ 工具链的机器也能 `pnpm install`。新增 BuiltinTools 类别 `terminalRepl`（默认关闭）控制此工具入口；与 `exposeDockToAgents` 分开是因为它们服务不同场景。

### D3 — 带单调 `seq` 的断线重连/replay 协议

之前：`src-tauri/src/companion_api/ws_terminal.rs:78` 标注 reconnect "reserved for future"，handler 拒绝任何不是 `spawn=1` 的请求。移动会话在网络抖动时即丢失。

之后：每会话一个 `ReplayBuffer`（`src-tauri/src/terminal/replay.rs`）为每个 `TerminalEvent` 分配单调 `seq: u64`，保留约 512 KiB / 5 分钟（与渲染端重连预算对齐）。`PtySession` 的 reader/waiter 线程在 fan-out 之前先 push 到 buffer。WS 关闭不再 drop 会话——一个进程级 `WsTerminalRegistry` 标记为 detached；后台 reaper 在消费者断线超过 5 分钟后才 drop 会话。

协议增量：

- 出向 JSON 控制帧新增 `seq: u64`。
- Reconnect URL：`wss://…/ws/v1/terminal?token=<jwt>&sessionId=<id>&resumeFrom=<seq>`。服务端从 buffer 中 replay 所有 `seq > resumeFrom` 的事件，然后切回实时。
- 设备级 ownership：`WsTerminalRegistry.lookup_for_device` 校验请求端的 device JWT 与原始创建者一致，方允许重连。

客户端（`lib/terminal/transport-ws.ts`）：

- `RemoteTerminalSession extends BaseTerminalSession`。
- 指数退避调度 [1s, 2s, 5s, 10s, 30s, 60s × 4] ≈ 5 分钟。
- 重连窗口内出向写入排队（上限 256 帧），重新连上后 flush。
- `onTransportState` 监听：`connected | reconnecting | gone`。移动端连接徽章订阅此事件。
- 超出 5 分钟预算 → 发 `gone` → `handleExit(null)`，消费者看到终态退出。

### D4 — `BaseTerminalSession` 抽象类去除传输模板代码

`TerminalSession`（Tauri channel）与 `RemoteTerminalSession`（WS）此前重复约 80 LOC 的 listener-set + exit-state 代码。再为 WebRTC 加第三个子类就会变成 240 LOC 复制粘贴。

`lib/terminal/base-session.ts` 抽出共享面：`dataListeners`、`integrationListeners`、`exitListeners`、`exited`、`exitCode`、`onData/onIntegration/onExit`、`dispatchData/dispatchIntegration/handleExit`、`isExited/lastExitCode/id`。子类只实现 `write/resize/kill`，并把入站帧路由到受保护的 dispatcher。

Tauri 子类从 161 LOC 缩到 100；WS 子类（含新增 reconnect 机制）落在 ~330 LOC——但相比最差情况（三个子类各自复制）节省约 120 LOC 模板。

### D5 — `EventSink` 改为 `(seq, event)` 而非仅 `event`

为了让 Rust reader/waiter 同时把 replay buffer 分配的 seq 与事件向下游暴露，`EventSink` 类型从 `Arc<dyn Fn(TerminalEvent) + Send + Sync>` 改为 `Arc<dyn Fn(u64, TerminalEvent) + Send + Sync>`。Tauri Channel 包装（`spawn_session`）丢弃 seq（桌面 dock 不需要）；WS handler 把它写入每一个出站 JSON 控制帧。

这是让 replay buffer 成为事件顺序唯一真相的契约变更——消费者要么尊重 seq，要么显式忽略。

### D6 — WebRTC datachannel 传输——设计完成、推后实现

ADR-0021 的 signaling 栈（`src-tauri/src/companion_api/signaling/{mod,client,dispatch,peer}.rs`，加上 dispatch + envelope 合计约 5000 LOC）落地了仅 JSON 的 `cognia.v2` 数据通道供 RPC + 事件面使用。在同一 peer 上承载终端有两条路：

1. 在已有通道里多路复用 PTY 字节（需要 RPC envelope schema 支持二进制 + 会话 id 前缀），或
2. 同一 peer 上再开一个标签为 `cognia.v2.terminal` 的二进制通道（隔离更干净，但需在 `signaling/client.rs` + `dispatch.rs` 里识别新 label）。

`lib/terminal/pick-transport.ts:selectTerminalTransportChain` 今日在 Capacitor 上返回 `["ws"]`。当 Rust 桌面端的 RTC handler（新增 `rtc_terminal.rs`、`peer.rs` 增 label 派发、TS 侧新增 `transport-webrtc.ts` 继承 `BaseTerminalSession`）就绪后，链将扩展为 `["ws", "webrtc"]`，orchestrator 在 WS 连失败时自动 fallback。D4/D5 的 `BaseTerminalSession` + reconnect 协议已经替这块未来工作把底子搭好——剩下的主要是 signaling routing 集成。

### D7 — 工作流节点 `action.system.terminal`

新增 node kind（`types/workflow/visual.ts` union + `WORKFLOW_NODE_KINDS` 数组），executor 在 `lib/workflow/nodes/terminal.ts`。输入：`command`、可选 `args` / `cwd` / `shell` / `projectId` / `tabId` / `timeoutSec` / `onFailure`（`"throw" | "branch"`）。输出：`{ exitCode, output, sessionId }`，并附带 `decision`（exit 0 ⇒ `"success"`，否则 `"failure"`），供 `flow.branch` 路由。

executor 委托给 `runTerminalDockAction`，使同意 + tab + 超时解析与聊天 affordance、agent MCP 路径完全一致。仅渲染端执行——工作流在 Next.js 进程中跑；若 V2 server 侧工作流执行将来落地，需为同意 broker 做 Tauri command 桥（本波不在范围内）。

Inspector 表单（`components/workflow/editor/inspector/forms/index.tsx` 中的 `SystemTerminalConfig`）暴露所有输入；在 `node-config-registry.tsx` 注册。

### D8 — 插件 permission 描述 + 风险分级

`terminal:spawn` / `terminal:write` / `terminal:kill` 早就出现在 `PluginPermission`（`types/plugin/plugin.ts:280-282`）以及 `PERMISSION_DESCRIPTIONS` / `PERMISSION_GROUPS`（`lib/plugin/security/permission-guard.ts:74-121`）。本波新增：

- `terminal:write` 加入 `DANGEROUS_PERMISSIONS`（向既有 shell 写入等价于执行任意命令，与 `terminal:spawn` 和 `shell:execute` 同档）。
- `terminal:kill` 明确**不**列为 dangerous（中风险——杀掉一个你已经握有 handle 的 session 是可恢复的；要求每次确认弊大于利）。

github-delivery 的 manifest 加上 `terminal:spawn` + `terminal:write`，整条链路 dogfood：现在可以组合 `action.system.terminal`（例如 `pnpm test`）→ `flow.branch` → `action.github.mergePr`，让合并按 pre-flight 测试结果门控。

### D9 — Shell 平台均等（fish + nushell）与提示符标记完整性

两个新 shell-integration 脚本沿用 bash / zsh / pwsh 风格：

- `shell-integration.fish` 走 fish 原生的 `fish_prompt` + `fish_preexec` 事件。在提示符渲染时 emit D + P + A，命令提交时 emit C；不发 B（fish 没有 post-prompt 事件；OSC 633 解析器容忍 B 缺失）。
- `shell-integration.nu` 走 `$env.config.hooks.{pre_prompt, pre_execution}`。emit D + P + A + C；不发 B（同上）。`LAST_EXIT_CODE` 取不到时退回 0。

`integration.rs:ShellKind` 新增 `Fish` 与 `Nu`。`build_fish` 用 `--init-command "source <script>"`（fish 在 init command 之前先加载 conf.d，因此用户函数已就绪）。`build_nu` 写一个临时配置，先 `try { source '<user>' } catch {}` re-source 用户原配置，再 `source` 我们的 hook 脚本，然后用 `--config <path>` 启动。两者都注入 `COGNIA_TERM_NONCE` env，OSC 633 解析器 nonce-gate 入站序列。

`shell-integration.ps1` 的 PSReadLine 补全（Wave 3C 在 Windows 上的 `C` 事件）在本波之前已交付。

### D10 — 收尾：OSC 8 超链接、dock 拖拽调高、可配置超时、移动 overlay 对齐

- **OSC 8 超链接**（`terminal-instance.tsx`）：xterm.js 5.x 的 `linkHandler`。Tauri 优先用 `@tauri-apps/plugin-opener`（直接走系统 OS、无 webview 中转），浏览器/Capacitor 回退 `window.open`。允许 scheme：http / https / mailto / file。
- **Dock 拖拽调高**（`terminal-dock.tsx`）：dock 顶端钉一根 4px 把手。Pointer 拖拽时把 `pointermove` 挂到 `window`（鼠标可离开把手不丢拽）；deltaY → 视口百分比 → `useTerminalStore.setPanelHeight`（受 `TERMINAL_LAYOUT_BOUNDS` 限制）。键盘可达：分隔条聚焦后方向键 ±2%。aria-label 完整。
- **可配置 run-in-dock 超时**（`run-in-dock.ts`、`terminal-card.tsx`）：新增设置 `terminal.runInDockTimeoutSec`（默认 60，范围 5–600）。在调用时读取，设置一改下次调用立刻生效。每次调用的 `input.timeoutMs` 仍然优先；此设置作为缺省。
- **移动端 overlay 对齐**（`mobile-terminal-screen.tsx`）：挂载已有的 `TerminalSearchOverlay`（右上角悬浮）与 `TerminalHistoryPanel`（底部 `Sheet`）。原组件本身对触摸友好，本次只做组合。

### D11 — 设置 + i18n 对齐

新增 / 更新的 i18n 键 同时落到 `i18n/messages/en.json` 与 `i18n/messages/zh-CN.json`：

- `terminal.dock.resize`（把手 aria-label）
- `mobile.terminal.search`、`history`、`historyTitle`、`historySubtitle`
- `settings.terminal.exposeDockToAgents.helper`（按新的 dock-relay 语义重写）
- `settings.terminal.runInDockTimeout.{label, helper}`
- `settings.builtinTools.terminalRepl{, Desc}` + 每工具描述
- `workflows.forms.systemTerminal.*`（command / cwd / shell / tabId / timeoutSec / onFailure 含选项）

`pnpm lint:i18n` 确认平衡。

## 测试覆盖

每文件配套测试（CLAUDE.md 第 #3 条规则，新代码 ≥90% 行/分支/函数）：

- `lib/plugin/bridge/terminal-dock-schemas.test.ts`（10 用例）
- `lib/plugin/bridge/sidecar-tools-bridge.test.ts`（13 用例 —— 扩展）
- `lib/terminal/dock-tool-handler.test.ts`（17 用例，覆盖 4 个 action + 闸门 + 同意 + 超时）
- `lib/claude/plugin-tool-ipc.test.ts`（扩展，新增 terminal-dock fallback 用例）
- `components/providers/initializers/terminal-bridge-initializer.test.tsx`（4 用例）
- `lib/terminal/base-session.test.ts`（10 用例）
- `lib/terminal/transport-ws.test.ts`（重写 —— 20 用例，含 7 个 Wave 2 重连场景）
- `lib/terminal/pick-transport.test.ts`（扩展 chain）
- `components/mobile/mobile-terminal-screen.test.tsx`（11 用例，含 3 个 overlay 对齐）
- `lib/workflow/nodes/terminal.test.ts`（10 用例）
- `sidecar/builtin-tools/__tests__/terminal-repl-tool.test.mjs`（15 个 Node-test 用例 —— node-pty stub）
- `lib/plugin/security/permission-guard.test.ts`（扩展 `terminal:write` dangerous 分级）
- `plugins/first-party-manifests.test.ts`（覆盖 github-delivery manifest 扩展）
- Rust：`src-tauri/src/terminal/replay.rs`（8 个 `#[cfg(test)]` 用例）；`src-tauri/src/terminal/integration.rs`（fish/nu 4 个新用例）；`src-tauri/src/companion_api/ws_terminal.rs`（扩展 resume 参数 + registry）。

净增 / 扩展用例 **121 + 15 + 8 = 144 个，全部通过**。

## 文件清单

**新增（10）**：

- `lib/terminal/base-session.ts`
- `lib/terminal/dock-tool-handler.ts`
- `lib/plugin/bridge/terminal-dock-schemas.ts`
- `lib/workflow/nodes/terminal.ts`
- `sidecar/builtin-tools/terminal-repl-tool.mjs`（替换被删的 `terminal-dock-tool.mjs`）
- `src-tauri/src/terminal/replay.rs`
- `src-tauri/resources/terminal/shell-integration.fish`
- `src-tauri/resources/terminal/shell-integration.nu`
- 本 ADR（en）+ 中文镜像

**扩展（约 22 个）**：`lib/plugin/bridge/sidecar-tools-bridge.ts`、`lib/claude/build-options.ts`、`lib/claude/plugin-tool-ipc.ts`、`lib/claude/types.ts`、`lib/plugin/security/permission-guard.ts`、`lib/settings/builtin-tools-data.json`、`sidecar/builtin-tools/index.mjs`、`sidecar/package.json`（可选 node-pty）、`components/providers/initializers/terminal-bridge-initializer.tsx`、`lib/terminal/session.ts`、`lib/terminal/transport-ws.ts`、`lib/terminal/pick-transport.ts`、`lib/terminal/run-in-dock.ts`、`src-tauri/src/terminal/{mod,session,integration}.rs`、`src-tauri/src/companion_api/ws_terminal.rs`、`src-tauri/resources/terminal/shell-integration.ps1`（已有 PSReadLine）、`components/mobile/mobile-terminal-screen.tsx`、`components/terminal/terminal-instance.tsx`、`components/terminal/terminal-dock.tsx`、`components/settings/terminal/terminal-card.tsx`、`components/workflow/editor/inspector/forms/index.tsx` + `node-config-registry.tsx`、`types/workflow/visual.ts`、`lib/workflow/nodes/built-ins.ts`、`plugins/github-delivery/plugin.json`、两份 i18n message 文件、`stores/terminal/terminal-store.ts`（注释刷新）、`lib/terminal/spawn-orchestrator.ts`（注释刷新）。

**删除（2）**：`sidecar/builtin-tools/terminal-dock-tool.mjs` 及其测试 —— 死代码（`terminalDock` BuiltinToolsConfig 字段从未存在，sidecar 根本没注册过这些工具）。由 `terminal-repl-tool.mjs` 的 REPL 入口替代。

## 明确推后的工作

1. **WebRTC 终端传输** —— `pick-transport.ts` 现在只返回 `["ws"]`；Rust 侧就绪后将扩为 `["ws", "webrtc"]`。TS 侧 `transport-webrtc.ts` 会继承 `BaseTerminalSession`；Rust 侧需要新增 `rtc_terminal.rs` 模块 + 在 `signaling/peer.rs` 中识别 `cognia.v2.terminal` 数据通道标签。估算：Rust + TS 合计约 400 LOC。
2. **远端 shell-integration 脚本下发** —— 移动 WS 会话当前刻意关闭 OSC 633（脚本是本地路径，远端无法解析）。未来小版本可在 WS 握手时把脚本字节传过去，让移动端也拿到提示符标记 + 命令跟踪。
3. **服务器侧工作流执行 + 同意 broker 桥** —— `action.system.terminal` 仅渲染端可用。若 headless V2 server 工作流要驱动 dock，要么走 Tauri command 桥同意 broker，要么限制走 headless `terminal_repl_*` 路径。
4. **更多 shell** —— elvish / tcsh / xonsh 各自需要一个 `shell-integration.<x>` + `ShellKind` 变体。模板已就绪，剩下是逐 shell 实现。
