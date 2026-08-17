---
title: ADR-0033 — 集成终端 Phase 3 — 桌面体验（分屏、命令导航、重载恢复、跳编辑器、定位对话）
description: Phase 3 把集成终端提升为主力开发终端。(1) VS Code 式的扁平 tab 内分屏，以附加层叠加在既有 tab/session store 之上。(2) 把失效的提示符装饰 stub 重做为真正的 OSC 633 命令 marker + 退出码着色 + 跳上/下条命令。(3) 仅 webview 重载的会话恢复：Rust 进程（及其 PTY）在重载后存活，故用 `SeqEvent` 信封 + 可换 Channel 槽 + `terminal_reattach` 重连并回放保留缓冲——复用 `WsTerminalRegistry` 的 consumer-swap 机制。(4) 终端里可点击的 `path:line:col` 链接按 session cwd 解析后在只读 Monaco 查看器中打开。(5) agent spawn 的终端 tab 可跳回触发它的 chat 会话。WebRTC/移动/服务端阶段维持 scoped out。
---

# ADR-0033 — 集成终端 Phase 3

**状态**：Accepted（2026-05-23）
**作者**：Max Qian + Claude Opus 4.7
**关系**：扩展 ADR-0031（不替代）
**影响**：`stores/terminal/`、`components/terminal/`、`lib/terminal/`、`components/providers/initializers/terminal-bridge-initializer.tsx`、`src-tauri/src/terminal/{session,commands,mod}.rs`、`src-tauri/src/companion_api/ws_terminal.rs`、`src-tauri/src/lib.rs`、`i18n/messages/{en,zh-CN}.json`

## 背景

ADR-0031 已交付完整的集成终端（xterm.js dock、`portable-pty` 后端、OSC 633、移动 WS 传输含 `seq` replay buffer、agent MCP 工具、设置、i18n）。Phase 3 面向"桌面本地开发"场景，把终端从"能用"提升到"主力开发终端"。全程硬约束：**最大化复用、不重复实现**——每个新文件落地前都先对照既有基础设施做复用审计。

## 决策

### D1 — 扁平、附加式的 tab 内分屏

VS Code 的*终端*分屏是扁平的行/列 pane，而非编辑器那种任意嵌套。按扁平 group 建模可让改动保持附加式、不动既有 tab/session store。

`stores/terminal/terminal-store.ts` 新增三个以 group **anchor**（tab 的 session id）为键的 map：`splitPanes`（anchor 旁的有序额外 pane）、`focusedPaneByAnchor`、`splitDirection`。一个 session 渲染成 tab，除非它是某 group 的非 anchor 成员。新增 mutation：`addPaneToGroup` / `setFocusedPane` / `groupAnchorOf` / `panesForGroup` / `tabsForProject`。`removeSession` 在 anchor 关闭时把下一个 pane 提升为新 anchor，使 group（及其 tab）存活，active 指针随之跟进。pane **尺寸**由既有 `hooks/ui/use-resizable-layout`（按 anchor 键）持久化——不在 store 里重复实现。

`components/terminal/terminal-pane-group.tsx` 用既有 `components/ui/resizable` 渲染 group，并把聚焦 pane 及其命令式 handle 上报给 dock，使搜索浮层 / 历史栏 / 命令跳转键都作用于聚焦 pane。键位：`Ctrl/Cmd+\`（竖裂）、`Ctrl/Cmd+Shift+\`（横裂）、`Alt+方向`（切换聚焦）。

### D2 — 命令导航 + 退出码装饰（重做失效 stub）

`terminal-instance.tsx` 原有一段失效装饰 effect：在 React effect 里于*当前光标行*打 marker（而非命令发生行）、只标最后一条、不按退出码着色。Phase 3 移除它，改为让 instance 订阅 `session.onIntegration`：`command_start` 时打 xterm marker + gutter 装饰（中性色）；`command_end` 时按退出码重建装饰着色（绿/红）——xterm 装饰无重着色 API，故重建是受支持的路径。`lib/terminal/command-markers.ts` 持有纯函数 `exitMarkerColor` 与 `prevMarkerLine`/`nextMarkerLine`；instance handle 新增 `jumpToPrevCommand`/`jumpToNextCommand`，在 dock 绑 `Ctrl/Cmd+↑/↓`。store 仍经 `spawn-orchestrator` 收到同样的事件供历史栏使用——本监听仅负责终端内 gutter。

### D3 — 仅 webview 重载的会话恢复

Tauri Rust 进程（及每个活的 `PtySession`）在 webview 重载后存活；只有 JS `Channel` 与内存中的 session registry 被销毁。Phase 3 通过**复用 `WsTerminalRegistry` 的 consumer-swap 机制**让桌面会话可恢复，而非另造一套：

- `session.rs` 新增 `SeqEvent { seq, event }` 信封（桌面 Channel 现在携带 seq，渲染端因此知道续传点）与 `PtySession` 上的可换 `ChannelSlot { channel, last_seq }`。sink 通过当前安装的 Channel 发送；`last_seq` 对 replay-vs-live 去重，保证每个事件对某 channel 恰好送达一次；发送失败（重载后旧 channel 已死）不更新 `last_seq`，事件因此会被回放。
- `terminal_reattach(id, on_event, resume_from)`（`commands.rs`，在 `lib.rs` 注册）安装新 Channel 并回放 `replay.since(resume_from)`。**锁序安全**：reader/waiter 线程对 replay 锁与 channel-slot 锁是*顺序*获取（push→释放→sink），从不嵌套，故 `reattach` 可在持 slot 锁时快照 `replay.since()` 而不死锁——使 swap 相对 sink 原子。
- 渲染端（`lib/terminal/session.ts`）跟踪 `lastSeq` 并暴露 `TerminalSession.reattach(id, resumeFrom = 0)`。`resume_from = 0` 回放整个保留缓冲（≤512 KiB / 5 分钟），同时把最近 scrollback 还原进新 xterm。
- `lib/terminal/rehydrate.ts` 在启动时运行（`terminal-bridge-initializer`，仅 Tauri）：`terminal_list_all` → 重建行 → `reattach` → `wireSessionToStore` → 恢复经校验的 UI 布局。app 完全重启后不恢复（进程已没）。

### D4 — 路径/报错链接 → 只读 Monaco 查看器

`lib/terminal/terminal-links.ts` 是 `path:line:col`、tsc 括号式、V8 栈帧的纯匹配器，外加 cwd 解析。`terminal-instance.tsx` 注册 xterm `ILinkProvider`（与处理 URL 的 `WebLinksAddon` 并存）；点击时按 store 维护的 session cwd 解析路径并打开 `stores/terminal/file-viewer-store.ts`。`components/terminal/file-viewer-dialog.tsx` 经既有 `lib/file/file-operations.readTextFile` 读文件，在只读 `@monaco-editor/react` 里渲染并定位目标行。它刻意**不**用 `mountMonacoWorkbench`——临时查看器不应注册为 vscode-shim 的 active text editor 而扰乱 LSP provider。

### D5 — agent 终端定位回对话

agent 驱动的终端 tab 已带 `agentSpawner`（chat session id，由 `dock-tool-handler` 写入）。tab 右键菜单与历史栏新增"在对话中定位"，调 `useChatStore.setActiveSession(agentSpawner)`（沿用 `chat-header` fork 操作验证过的范式）并切到 chat 视图。消息级滚动延后——chat 暂无 scroll-to-message 基础设施。

### D6 — `wireSessionToStore` 抽取

命令捕获 + 集成事件→store + 退出→store+审计 的接线原先内联在 `spawnFromDock`。Phase 3 抽到 `spawn-orchestrator.wireSessionToStore`，使重连的会话与新 spawn 的会话行为一致、无重复。

### D7 — 可安全跨重载恢复的分屏布局

终端持久化 shell 现在携带一份仅用于重载恢复的元数据快照：分屏成员及顺序、方向、聚焦 pane、各项目的 active tab，以及自定义标题。活的 `TerminalSessionRow` 仍只保存在内存中。持久化数据 hydration 后先放入独立的 `pendingReloadLayout`，避免逐个注册存活 PTY 时用不完整的中间状态覆盖完整快照。

`terminal_list_all` 全部处理完后，`rehydrateTerminals` 以单次事务应用快照。store 只接受成功 reattach 的 session，拒绝跨项目 pane 与重复 group 成员，对过期 focus/active id 使用安全回退，随后清空 pending 快照。Rust 成功返回空 session 列表时，会清除 app 完全重启留下的过期元数据；列表调用失败时则保留，因为 IPC 故障可能是暂时的。Web 与 Capacitor 的 PTY 无法跨重载存活，因此在初始化时直接清除快照。pane 尺寸继续复用按 anchor id 键控的 `useResizableLayout` 持久化。

## 测试覆盖

逐文件 co-located 测试（CLAUDE.md 规则 #3）：`terminal-store.test.ts`（分屏 mutation + anchor 提升）、`terminal-pane-group.test.tsx`、`command-markers.test.ts`、扩展 `terminal-instance.test.tsx`（marker、jump、link provider）、`terminal-links.test.ts`、`file-viewer-store.test.ts`、`file-viewer-dialog.test.tsx`、扩展 `terminal-dock.test.tsx`（分屏/聚焦/定位）、扩展 `terminal-tab-context-menu.test.tsx` 与 `terminal-history-panel.test.tsx`（定位）、扩展 `session.test.ts`（`SeqEvent` 信封 + `reattach`）、`rehydrate.test.ts`。Rust：`session.rs` 的 reattach 回放 + 去重测试（`#[cfg(test)]`）。

**305 个前端终端测试通过；`pnpm build` / `pnpm typecheck` / `pnpm lint:i18n` 绿；`cargo check` 干净。** Rust 单测已写但无法在 Windows 开发机执行（Tauri 测试二进制以 `STATUS_ENTRYPOINT_NOT_FOUND` 启动失败——WebView2/运行时 DLL 限制，非代码缺陷；CI 中运行）。真实 app 二进制可正常启动。

## 文件清单

**新增**：`components/terminal/terminal-pane-group.tsx`（+test）、`components/terminal/file-viewer-dialog.tsx`（+test）、`lib/terminal/command-markers.ts`（+test）、`lib/terminal/terminal-links.ts`（+test）、`lib/terminal/rehydrate.ts`（+test）、`stores/terminal/file-viewer-store.ts`（+test）、本 ADR（en + zh）。

**扩展**：`stores/terminal/terminal-store.ts`（分屏层）、`components/terminal/{terminal-dock,terminal-instance,terminal-history-panel,terminal-tab-context-menu}.tsx`、`lib/terminal/{session,spawn-orchestrator}.ts`、`components/providers/initializers/terminal-bridge-initializer.tsx`、`src-tauri/src/terminal/{session,commands,mod}.rs`、`src-tauri/src/companion_api/ws_terminal.rs`、`src-tauri/src/lib.rs`、两份 i18n 文件。

**协议变更**：桌面终端 Channel 现在携带 `{ seq, event }`（`SeqEvent`）而非裸 `TerminalEvent`。

## 明确 scoped out 的后续

1. ~~**WebRTC WAN 终端传输**~~ — **已上线**，见 ADR-0031 follow-up #1。
2. **移动端 OSC 633 下发** — ADR-0031 follow-up #2，仍延后。
3. **服务端工作流执行 + consent 桥** — ADR-0031 follow-up #3。
4. ~~**dock 内 AI 命令辅助**~~ — 已由 ADR-0039（终端自动补全）取代并上线。
5. ~~**消息级定位回对话**~~ — **已上线**：会话行携带 `agentSpawnerMessageId`，dock 走 `messagePermalinkQuery`（scroll-to-message 锚点由 ADR-0094 提供）。
6. ~~**会话分享**~~ — **已上线**，见 ADR-0133：已配对设备直接接入宿主会话并共用其控制权租约；宿主广播参与者名单，dock 新增「分享」对话框。同一改动删除了从未接线的 `lib/terminal/collaboration/share-manager` 邀请/令牌模型。

## Phase 4 — dock 可用性（本次改动）

叠加在本 ADR 之后才落地的「独立进程 durable host」之上。

- **`PathInjection` 归 host 所有。** 应用的 managed-CLI 注册表是进程内 static
  （`cli_bridge::detect`），独立的 host 进程无从推导。现改为经 `Hello` 帧传入并存于
  host —— 不是按连接存：远程 spawn（Companion WS、WebRTC）走的连接永远不会发送它，
  而会话本就归 host 所有。**仅本地身份**可写。应用内下载 CLI 注册新目录后会重新推送；
  已在运行的 shell 保持旧 PATH（PTY 环境在 `execve` 时固化）。
- **新增 frame kind 21–23** —— `FlowControl` / `HistoryQuery` / `HistorySnapshot`。
  此前从未被构造的 `TransportState`(18) 现在承载流控状态变化。**兼容性铁律：host 绝不
  主动发送 client 未索取的 frame kind**，因为客户端遇到未知判别值会直接抛错。将来若要新增
  *推送型* kind，必须先经 `Hello` ack 的 `protocolFeatures` 协商。
- **能力协商。** bridge 会复用已在运行的 host —— 那可能是以登录服务安装的旧二进制，
  因此新命令都以 host 广播的能力列表把关，并以明确错误降级。
- **端到端流控。** `FlowGate`（std `Mutex` + `Condvar`）挂起 PTY reader 线程，未读字节
  留在内核缓冲区、子进程在写入时阻塞。暂停在各 attachment 间引用计数（最慢消费者优先），
  并由五条独立路径释放 —— detach、断连、attachment 溢出、kill，以及针对「暂停后停止运行的
  客户端」的 30 秒兜底回收。在此之前，洪流会撑爆 host 的有界每客户端队列并**丢弃整个
  attachment**：标签页是直接死掉，而不是变慢。

### 已知的下一步

`Channel<HostSeqEvent>` 把 `bytes: Vec<u8>` 序列化成 JSON 十进制数组 —— 约 4 倍膨胀，
外加每块一次 JSON parse，是洪流路径上最大的常数因子。流控让系统**正确**，但没有让它**快**。
迁移到二进制 channel body 是后续项。
