---
title: "ADR-0049 — 外部智能体进程管理加固（Windows 启动 · 事件驱动 I/O · 关机清理 · Codex 存活检测）"
description: "加强本地外部代理进程层及其TypeScript生命周期以实现正确的全链 loading/startup：解决命令对 Windows PATH × PATHEXT 。cmd/.bat shims（NPX、OpenCode、Cursor-Agent）实际上启动，完成向事件驱动stdout/stderr/exit转发的迁移，终止代理进程并在应用退出时ACP终端，阻止释放终端子节点泄露，并为Codex应用-服务器适配器提供主动健康探针。"
---

# ADR-0049 — 外部智能体进程管理加固（Windows 启动 · 事件驱动 I/O · 关机清理 · Codex 存活检测）

**状态**：已接受（2026-06-20）**作者**钱马克斯 + Claude Opus 4.8 **基于**：ADR-0048（Codex支持扩展;ACP执行精度）、外部代理子系统（`lib/ai/agent/external/`、`src-tauri/src/external_agent/`）以及文档中的五级主干（规范化→连接会话→→执行→翻译）。

## 背景

外部代理子系统（ACP / OpenCode / Codex 应用-服务器适配器、管理器主干、预设、准备梯、环境构建器）已经成熟：TS端拥有所有协议解析，Rust端则是一个薄的 stdio 桥。对**进程管理、加载和启动**进行全链审查——本地流程层在从50毫秒轮询排水环路到事件驱动汇的重构中——揭示了五个具体缺陷。协议逻辑中没有;这些都属于启动/生命周期管道。

## 决策

### 1 ·在生成前解决命令针对PATH × PATHEXT（标题修正）

Windows上的`tokio::process::Command::new("npx")`只会自动添加`.exe`;它**不**咨询`PATHEXT`。每个可执行预设都会启动一个裸 命令，在 Windows 上作为 `.cmd` shim 存在（`npx -y @zed-industries/codex-acp`、`opencode serve`、`cursor-agent`），因此生成失败，显示“找不到程序”——而 `check_command_exists` *确实检查过 `.cmd`，报告了预设 `executable`。准备度和生成率在整个链条上存在分歧。

新`src-tauri/src/external_agent/command_resolver.rs`将裸路命令解析为具体路径（PATH × `PATHEXT`，默认路径`.COM;.EXE;.BAT;.CMD;.PS1`）。`process.rs`和`terminal.rs`在`Command::new`之前达成决心;Rust ≥ 1.77.2 则正确执行已解析的`.cmd`/`.bat`（BatBadBut硬化）。在Unix上，原始名称未更改（无`PATHEXT`;`Command`已经PATH-searches了），如果什么都没找到（生成点接口自己的错误）。`check_command_exists`是在**同一个**解析器之上重新实现的，所以预设报告的`executable`现在变成了真正会生成的。

### 2 ·事件驱动stdout/stderr/exit（完成迁移）

50毫秒轮询循环（`receive_external_agent_stderr` + 每次访问一次管理器锁）被移除。每个进程会获得stdout/stderr个读取任务，将行推送到`ExternalAgentEventSink`，以及一个监督任务，等待子节点（或`oneshot`杀请求），并推送退出事件——退出真实的唯一来源。Tauri 命令层的`TauriEventSink`会发出`external-agent://{stdout,stderr,exit,state-change}`。管理器状态会丢弃其外部的 `Mutex`（管理器内部已经同步），因此 spawn/send/kill/status 之间不再串行化。

### 3 ·关闭代理进程并ACP应用退出时的终端

`RunEvent::Exit`/`ExitRequested` 处理器清理了CLI桥和CUA沙盒，但没有清理外部代理，导致自动生成的`opencode serve`/`npx`子及其ACP终端成为孤儿。处理器现在`block_on`s `ExternalAgentState::kill_all()`，新`AcpTerminalManager::kill_all()`。

### 4 ·`kill_on_drop` ACP终端

`process.rs` `kill_on_drop(true)`;`terminal.rs`没有这样做，所以释放一个仍在运行的终端泄露了子节点（及其读取任务）。`terminal.rs`现在也设置了——释放或丢弃终端会获得子程序，子节点关闭stdout/stderr并让读取任务结束。

### 5 ·Codex应用-服务器适配器的主动活化探针

`CodexAppServerAdapter`继承了基础`healthCheck()`（返回缓存连接标志），因此一个楔入但未退出的服务器会永远`connected`，管理器的健康定时器也不会重新连接它——这与ACP（`ping`）和OpenCode（`config.get()`）不同，后者是往返的。Codex现在覆盖`healthCheck()`，实现廉价且无副作用的往返`model/list`：任何回复——包括JSON-RPC*错误*响应——都证明服务器正在处理消息（健康）;只有请求超时或拆除传输才是不健康的。

## 超出范围

- 用同一个解析器硬化`claude/sidecar.rs`和`mcp_server/*` `node`刷新点。如今他们`node.exe`稳定地解决;折叠它们是一个独立且更广泛的变化，具有自身的爆炸半径。
- PATH项目本地CLIs的增援（`node_modules/.bin`）。预设目标PATH-installed工具;本地安装仍由用户负责。

## 后果

- Windows 用户可以启动所有可执行文件ACP/Codex预设;准备不再是谎言。通过`cargo test --lib external_agent`验证（包括Windows门控`.cmd`-resolution测试）和Codex `healthCheck` jest suite。
- 没有任何进程或ACP终端能在应用退出后存活下来。
- Rust进程层没有轮询环路，也没有热路径管理器锁。
