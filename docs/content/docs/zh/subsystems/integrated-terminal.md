---
title: 集成终端
description: 应用内的真实 PTY —— 桌面 / 移动 / 远程主机的传输选择、带 nonce 校验的 OSC 633 Shell 集成、SSH 会话、面向 Agent 的 headless exec，以及 Agent 在敲进你的 Shell 之前必须通过的信任门禁。
---

# 集成终端

<Status variant="stable">Stable · ADR-0031 → 0033</Status>

<TLDR>
  这是一个真实的 PTY，而不是套在命令执行器外面的模拟器。由哪条管道承载，由
  `selectTerminalTransport()`（`lib/terminal/pick-transport.ts:31`）决定：Tauri 桌面走进程内的
  `tauri-channel`，Capacitor 移动端走 LAN/mDNS 上的 `ws`，而驱动远程 Cognia 主机的桌面端会重定向到
  该主机的 `/ws/v1/terminal`。提示符边界、退出码与 cwd 变更来自 **OSC 633** Shell 集成序列，
  由 Rust 侧解析（`crates/cognia-terminal/src/osc633.rs`），并校验每次 spawn 的 nonce ——
  因此终端内的恶意进程无法伪造提示符装饰。Agent 走的是另一扇门 ——
  `headless-exec` 加上按标签页的信任门禁（`lib/terminal/agent-trust.ts`）。
</TLDR>

<StatGrid>
  <Stat label="核心模块" value="30" hint="lib/terminal —— 非测试 .ts" />
  <Stat label="UI 组件" value="17" hint="components/terminal" />
  <Stat label="Rust 模块" value="11" hint="crates/cognia-terminal/src" />
  <Stat label="Tauri 命令" value="9" hint="crates/cognia-terminal/src/commands.rs" />
  <Stat label="传输方式" value="3 + 1" hint="tauri-channel · ws · webrtc（规划中）· unsupported" />
</StatGrid>

设计动机见 [ADR-0031](../adr/0031-integrated-terminal) 与
[ADR-0033](../adr/0033-integrated-terminal-phase-3)。本页描述**当前实现**。

## 传输选择

```ts
type TerminalTransportKind = "tauri-channel" | "ws" | "webrtc" | "unsupported"
```

两个入口，刻意分开。`selectTerminalTransport()` 返回优先级最高的**单个**传输，
供不想处理回退逻辑的调用方使用 —— 比如桌面端 dock 的「+ 新建」按钮。
`selectTerminalTransportChain()` 返回一个有序列表，由 spawn 编排器逐个尝试：
上一个返回 `null` 或抛错时，就走下一个。

| 运行形态 | 传输 | 说明 |
| --- | --- | --- |
| Tauri 桌面 | `tauri-channel` | 进程内 PTY，不存在远程歧义 |
| 桌面 → 远程主机 | `ws` | 指向主机的 `/ws/v1/terminal`（[ADR-0082](../adr/0082-remote-development-remote-host)）；未激活远程主机时完全休眠，普通桌面零影响 |
| Capacitor 移动端 | `ws` | LAN / mDNS |
| 浏览器 | `unsupported` | 链返回 `[]`，dock 不挂载 |

`webrtc` 已在联合类型中声明，但属于**规划中、尚未接通**：待 Rust 桌面 peer 与 TS 客户端通过
rendezvous 打通后，该链会扩展为 `["ws", "webrtc"]`。组件用
`terminalAvailable()`（`lib/terminal/pick-transport.ts:66`）决定是否挂载 dock。

## Shell 集成带 nonce 校验

VS Code 的 `ESC ] 633 ; <C> ; <args> BEL` 序列族，是把一串哑字节流变成结构化会话的关键：
提示符边界、命令执行前后、以及 cwd 变更。PTY 输出流经 `Osc633Parser::feed`，它把原始字节
**原样**返回 —— 终端的回滚缓冲仍需要它们来还原字体与颜色 ——
同时在识别出完整序列时单独抛出类型化的 `IntegrationEvent`。

安全性来自打进 `$COGNIA_TERM_NONCE` 的每次 spawn 独立 nonce。解析器会校验它，
因此运行在终端**内部**的恶意进程无法自行发出 OSC 633 序列来伪造提示符装饰。
无法识别的序列会被丢弃，而不是猜测处理。

## 代码位置

```
lib/terminal/
  pick-transport.ts       # 传输选择 + 回退链
  spawn-orchestrator.ts   # 遍历链，负责重试
  session.ts              # 前台会话；base-session.ts 是共享内核
  session-registry.ts     # 活跃会话；headless-session-registry.ts 用于 Agent 运行
  transport-ws.ts         # ws 客户端
  command-markers.ts      # TS 侧的 OSC 633 消费
  command-output.ts       # 按命令捕获输出（供 quick-fix 与 Agent 读取）
  headless-exec.ts        # 面向 Agent 的非交互执行面
  agent-trust.ts          # Agent 敲键前的按标签页信任门禁
  ssh-session.ts · ssh-connect.ts · ssh-profiles.ts · ssh-credentials.ts
  shell-detect.ts · profiles.ts · color-schemes.ts
  completion/ · quick-fix/    # 幽灵文本、补全弹层、报错快速修复
  sticky-scroll.ts · terminal-links.ts · stack-trace.ts
  backpressure.ts         # 进程高速写出时的流控
  rehydrate.ts            # 跨刷新恢复标签页

crates/cognia-terminal/src/
  osc633.rs      # 序列解析器 + nonce 校验
  session.rs · exec.rs · headless.rs · replay.rs
  ssh.rs · complete.rs · path_scan.rs · integration.rs
  commands.rs    # 9 个 Tauri 命令

components/terminal/    # dock · 标签条 · 实例 · 搜索 · quick-fix · 补全 · 文件查看器
stores/terminal/        # terminal-store · file-viewer-store
```

## Agent 拿不到「白给的 Shell」

Agent 触达终端要过两道门。`headless-exec.ts` 是独立的非交互接口面，拥有自己的注册表
（`headless-session-registry.ts`），因此一次 Agent 运行绝不会悄悄继承某个交互标签页。
若要驱动**交互式**标签页，它必须先通过
`requestAgentTrust()`（`lib/terminal/agent-trust.ts:50`）——
该门禁同时按聊天会话**与**标签页取键（`agentTrustPluginId(chatSessionId, tabId)`），
因此在一个标签页授予的信任不会外溢到另一个。`isAgentTrusted()` 是这道门的读取侧。

## 相关文档

<Cards>
  <Card title="ADR-0031" href="../adr/0031-integrated-terminal" description="终端最初的决策记录" />
  <Card title="ADR-0033" href="../adr/0033-integrated-terminal-phase-3" description="第三阶段 —— 补全、quick-fix、粘性滚动" />
  <Card title="CLI ↔ App 桥" href="./cli-app-bridge" description="Shell 与应用相遇的另一处" />
  <Card title="Companion API" href="./companion-api" description="移动端与远程路径所走的 ws 传输" />
</Cards>
