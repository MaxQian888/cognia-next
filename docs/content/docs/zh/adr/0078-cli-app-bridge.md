---
title: ADR-0078 — CLI ↔ App 桥接
description: 为两个本地 CLI 保留专用的经认证回环 bridge，只对 WebView-owned state 使用 renderer round-trip，并通过显式投影与 transcript handoff 保持 forked store。
---

# ADR-0078 — CLI ↔ App 桥接

**状态**：已接受（2026-07-16）

## 当前状态修订（2026-08-13）

本地 CLI bridge listener、endpoint writer 与 initializer 已在编译期限制为非移动 desktop target，Tauri setup hook 也无法在 Android 或 iOS 上启动它们。Mobile 继续使用 Companion transport，且绝不写入 `cli-endpoint.json`。

## 背景

Cognia 有两个职责不同的本地命令行产品：TypeScript `cognia-agent` 聊天 TUI 与 Rust
`cognia` 插件作者 CLI。两者都需要运行中桌面端的部分能力，而 Agent CLI 还必须保持独立可用。
桌面 Companion API 服务于另一种受众与 threat model：已配对设备经 HTTPS、WebSocket、WebRTC
访问，并使用 device JWT。

部分桌面权威数据位于 WebView 而不是 Rust。Agent team 使用 renderer store；twin context 横跨
Dexie 与 vector-backed runtime state。独立进程与 browser renderer 的配置和对话 store 也不同。

## 决策

1. 在 `127.0.0.1:0` 运行专用 Axum `cli_bridge` listener。在
   `<config_dir>/cognia/cli-endpoint.json` 发布 base URL 与每次启动随机生成的 token；所有路由
   都要求 loopback origin 与 `X-Cognia-Dev-Token`。当前 catalog 有 18 条路由，包含插件 Dev
   Session 事件与可验证 reload。
2. 显式划分路由归属。`cognia` 负责插件生命周期与 ACP brokerage；`cognia-agent` 负责 session
   handoff、twin context 与 team 操作。Health 由两者共享。
3. 权威状态位于 WebView 时使用 Tauri renderer request/response。插件开发中，Rust 负责鉴权、
   路径校验、安装、manifest 一致性和已安装 artifact 的 SHA-256；renderer 负责 WebView runtime
   的 quiesce、激活及 lifecycle generation 验证。只有两端都成功才算 reload 成功。
4. CLI bridge 与 `companion_api` 保持分离；同一用户本地工具不复用 device pairing、LAN 暴露、TLS
   配置或 device-JWT 路由 catalog。
5. 保持 forked store 与共享实现。GUI 保留 browser IndexedDB 与 keyring state；CLI 通过 fake
   IndexedDB、JSON 文件和自己的 JSONL transcript store 复用共享 schema 与 Agent 代码。
6. 跨 shell state movement 必须显式。Desktop-to-CLI config/credential/history/MCP sync 是直接文件
   投影。两个 transcript handoff 方向都创建 continuation 副本，不转移活跃 sidecar 或 SDK session id。

## 后果

- 任一 CLI 都能在没有固定端口或 network-visible service 的前提下发现运行中的桌面端。
- 两个产品不会只因共享 endpoint file 就误用彼此的路由。
- Twin/team 操作需要活跃 WebView，并受有界 client/server timeout 保护。
- 插件 bundle 已安装或已发现不能证明 runtime 已变化。reload 仅在获得新的 active lifecycle
  generation 与 Rust 实际安装 artifact 的 revision 后返回成功。
- Endpoint-file confidentiality 是同一用户本地控制，无法防御已作为该用户运行的恶意进程。
- Store divergence 是预期行为。新的同步表面必须是明确 projection 或 import，而不是临时共享文件写入。
- 当前 Tauri startup path 在 `cli_bridge::init` 周围没有显式的移动端编译排除；renderer listener
  与同步控制受 desktop gate 保护。未来若要建立平台不变量，必须先由代码强制，再由文档声明原生
  listener 仅桌面可用。

## 考虑过的替代方案

- **把路由合并到 Companion API**：拒绝，因为本地 CLI 与已配对设备的发现、暴露和认证要求不同。
- **让 GUI 与 CLI 共用一个数据库**：拒绝，因为 browser IndexedDB/keyring 与独立 Node process
  的持久化和生命周期边界不同。
- **让每个 Agent 动作都代理到桌面端**：拒绝，因为 `cognia-agent` 必须在桌面关闭时运行。
- **在 Rust 复制 renderer-owned state**：拒绝，因为 team 与 twin context 会偏离权威 WebView store。
