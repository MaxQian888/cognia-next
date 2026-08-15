---
title: "0127 — 聊天渲染与传输效率，以及消息自定义契约"
description: "所有聊天轨统一一套合并策略、Companion 帧批量化、扩宽消息展示契约，并对每一个休眠的聊天/传输功能给出审计后的处置。"
---

# ADR 0127 — 聊天渲染与传输效率，以及消息自定义契约

**Status:** Accepted
**Date:** 2026-08-16
**Builds on:** ADR-0114（统一消息呈现）、ADR-0090（统一 agent 执行）、ADR-0027（移动同步）、ADR-0021（WebRTC 广域传输）
**范围：** 主应用（浏览器 / Tauri / Capacitor）与公开分享页。**不含** CLI TUI（`cli/src/tui/` 是独立的 Ink 渲染器）。

## 背景

对聊天渲染路径、消息自定义面和四条传输轨（本地 sidecar、Companion WS/WebRTC、外部 agent、独立 CLI）的审计确认了以下事实：

- **渲染已成熟但各轨不对称。** sidecar 轨每帧最多提交一次 React 状态、流式增量经 250 ms 防抖落 Dexie（`hooks/chat/stream-coalescing.ts`）。**外部 agent 轨**两者皆无：`writeAssistant()` 每个 delta 全量 `replaceSessionMessages`，且只在 turn 结束时持久化，中途崩溃丢失部分内容。后台（非当前面板）会话每事件直写 Dexie、无节流。
- **上网前零合并。** sidecar 每 token 一行 JSON；Rust 每行一个 Tauri 事件；Companion `EventBus` 每事件一个带 seq 的帧；WS 与 WebRTC 每事件一帧、不压缩。慢订阅者遇 `broadcast::Lagged` 即被断开（`ws.rs`）或被要求重同步（`signaling/dispatch.rs`）。唯一带宽杠杆是全开/全关的 `streamPartialMessages`。
- **虚拟化只看条数。** `VIRTUALIZE_THRESHOLD = 40`；39 条、每条 200 KB 代码块的会话走普通文档流。
- **呈现契约（ADR-0114）已完整接通**，但渲染器的 9 项能力（`enableMath/Mermaid/Diff`、`showLineNumbers`、代码换行、`mathFontScale/Alignment/ShowCopyButton`、衬线正文）只以硬默认 prop 存在——无设置、无 UI。`messageDisplay` 本身缺席于 `SECTION_OWNED_KEYS` 与 `APPEARANCE_CONFIG_KEYS`，导致"重置本节"、变更审查、外观导出静默跳过它。
- **休眠清单** 共 20 项（见 *处置*）。每项现已接线、删除或明确记为 inert。

## 决策

### 1. 所有到达渲染器的轨共用一套合并策略

`SessionCoalescingRegistry`（rAF 节流的 store 提交 + 250 ms 防抖 `persistStreamingMessages`，turn 结束时同步提交 + 全量 `persistMessages` 封口）是**唯一**的流式写策略。外部 agent 轨原样采用；后台面板分支的直写 Dexie 也采用同一防抖。绕过注册表的轨视为 bug，由"合成 100 tok/s 流下每帧 ≤ 1 次 store 提交"的测试钉住。

### 2. Companion 帧批量化，只在发送环

批帧位于 `companion_api/ws.rs` 与 `companion_api/signaling/dispatch.rs` 的每订阅者发送环，**不**在 `EventBus`（进程内 A2A 消费者保持逐帧语义）。规则：

- 窗口 **33 ms** 固定。空闲订阅者的首帧立即发出（首 token 时延不变），其后帧在窗口内累积。
- 只合并**同一 channel 的连续帧**。channel 变化、控制帧（`stream_ready`、`resync_required`、`ping`）或窗口到期均触发 flush。
- 回放突发同样批量化。
- 封套 — WS：`{ "type": "event_batch", "channel", "seq_from", "seq_to", "frames": [EventFrame…] }`（安全，因真实 channel 名总含 `://`）；RTC：`{ "kind": "event-batch", "event", "seq_from", "seq_to", "frames": [...] }`。
- 客户端（`lib/tauri/transport-companion.ts`、`lib/tauri/transport-rtc.ts`）把批展开进既有的每 channel 单调 seq 游标路径；单帧永远有效（兼容旧服务端）。
- `Lagged` 处理不变。
- `agent://message` 并行规范流**不在范围内**；其退役仍归 ADR-0090 Phase 9，此处仅记为已知传输成本。

### 3. 双阈值虚拟化

`MessageList` 在消息条数 ≥ 40 **或** 所有 part 文本总长 > 256 KB 时虚拟化。两者皆未达的会话保持零 ResizeObserver 的文档流路径。

### 4. 扩宽消息展示契约

`MessageDisplayPreferences.overrides` 新增：

```ts
markdown?: {
  math?: boolean; mermaid?: boolean; diff?: boolean;
  codeLineNumbers?: boolean; codeWrap?: boolean;
  mathFontScale?: 0.8 | 1 | 1.2; mathAlign?: "center" | "left"; mathCopy?: boolean;
};
bodyFont?: "sans" | "serif";
```

每个预设提供默认值；解析仍在 `resolveMessageDisplayOptions`（ADR-0114 优先级：会话覆盖 → 全局 → 预设）。**两条**渲染分支（Streamdown 流式、react-markdown 定稿）与代码块渲染器读取解析值；块内工具栏开关仍是解析默认值之上的临时覆盖。控件出现在 `MessageDisplayControls`（桌面外观页、会话设置抽屉、移动端设置面板）。分享页只读全局。Shiki 主题保持硬编码（`lib/chat/code-theme.ts`）——两渲染器必须一致，选择器不值这份耦合。

`globals.css` 声明 `@theme --font-serif`；`bodyFont: "serif"` 应用到消息正文，`typographyExt.serifFamily` 首次有了消费者。

每面密度（`density.chat / .table / .sidebar`）落地：消息列表容器 `densitySurfaceProps("chat")`，会话列表 `("sidebar")`，`Table` 根 `("table")` 且单元格读 `--density-row-padding`。

### 5. 可度量验收

| 场景 | 标准 |
| --- | --- |
| 2000 条会话、40 图、12 mermaid | TTI < 800 ms；longTask 总计 < 1.5 s |
| 单条 200 KB 代码块 | 定稿后无 > 100 ms 主线程阻塞 |
| 100 tok/s 持续 60 s | 每帧 ≤ 1 次 store 提交、≤ 1 次 React 提交；无 > 50 ms longTask |
| Companion 100 tok/s | 过网帧数 − ≥ 80 %；首 token 时延 + ≤ 50 ms |

确定性计数断言（每帧提交数、批数、Dexie 写次数）在 Jest 中运行并作为 CI 门禁。耗时类指标放在 `@perf` 标记的 Playwright 套件（`tests/e2e/mobile/chat-render-perf.spec.ts`），保持可选。

### 6. 休眠清单处置

| 项 | 处置 |
| --- | --- |
| 朗读按钮在 `focused`/`balanced` 下不可达（只在 `actions: "all"` 分支渲染） | **已修复** — core/hover 分支同样渲染 |
| 桌面 `MessageList` 漏传 `directCharacter` | **已修复** |
| `MessageRenderer` memo 比较器漏 `onRewindFiles` | **已修复** |
| `messageDisplay` 及 6 个兄弟键不在 `SECTION_OWNED_KEYS` / `DEFAULTS` | **已修复** — 归属 Appearance/Conversation；完整性守卫覆盖 |
| `APPEARANCE_CONFIG_KEYS` 导出 `agentFlowMode` 却不含 `messageDisplay` | **已修复** |
| `DEFAULT_APPEARANCE_SLICE` 零消费者 | **已接线** 进 `getSettings()` 作为单一默认源 |
| `AgentFlowDisplayToggle` + `chat.header.flowDisplay.*` | **已删除** — 被 `MessageDisplayControls` 取代 |
| 测试专用导出（`parseShortcut`、`KeyboardShortcut`、`DetailsGroup`、`computeTimelineGeometry`） | **已删除 / 内部化** |
| `ChatHeaderPresetPill`（系统提示词预设切换） | **已接线** 到聊天头部中央 chip 区 |
| `density.chat/.table/.sidebar` 死旋钮 | **已接线**（§4） |
| `typographyExt.serifFamily` 死旋钮 | **已接线**（§4） |
| 隐藏的 markdown/数学/代码渲染 prop | **已升格**为设置（§4） |
| 插件工具结果渲染器注册表（生产 0 注册） | **已填充** — `web-tools`、`screenshot`、`clipboard-history` 注册卡片 |
| `command_ack`（发出、无人消费） | **已消费** — 重复命令 ⇒ 不重插用户消息、不重进流式态 |
| `session_closed`（AI-SDK 轨，渲染端丢弃） | **已消费** — status → idle，释放合并注册表 |
| `companion://device-paired`（有监听、无发射） | **已发射** — 设备注册处，仿 `device-seen` |
| `browser://console`、`browser://network`、`browser://snapshot`（声明未发） | **已发射** — overlay sentinel 通道 push-on-append（保留 drain 命令），由 DevTools 抽屉（console/network）与 agent-engine 快照缓存（按 generation）消费；Companion 转发默认**关** |
| `gateway://decide` 渲染端往返（默认 flag 关） | **inert，不变** — ADR-0090 Phase 9 |
| `agent://message` 并行规范流 | **不变** — ADR-0090 Phase 9 |
| `http` / `websocket` / `custom` / `sse` 外部 agent 协议（仅类型层） | **inert，不变** |
| `TauriTransport` 无 `Transport.readBinary` | **设计上 inert**（桌面读 Dexie blob） |

## 后果

- 所有到达渲染器的轨写入节奏一致；外部 agent 轨中途崩溃不再丢失部分内容。
- Companion 消费者收到更少、更大的帧；不识别 `event_batch` 的旧客户端须先于发出它的服务端升级——WS/RTC 契约版本随之提升。
- 新呈现选项必须先加入 `resolveMessageDisplayOptions` **和**两条渲染分支才对用户可见；测试强制 Streamdown/react-markdown 一致。
- 启用每面密度与衬线正文让此前 inert 的 UI 生效；曾设置过它们的用户升级后会看到变化。
- 浏览器 push 通道新增的 Rust → 渲染端事件量只在嵌入浏览器打开期间、且仅本地存在。
