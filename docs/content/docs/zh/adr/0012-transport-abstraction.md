---
title: "0012 — 面向多客户端未来的传输层抽象"
description: "lib/tauri.ts 获得统一的 Transport 接口，使同一套 wrapper 代码路径既能在桌面端走 Tauri IPC、在 Capacitor 移动端经 HTTP+WS 连到远程桌面，也能在纯 web 下走 no-op 桩——为即将到来的服务器-客户端架构提供单一接缝。"
---

# ADR 0012 — 面向多客户端未来的传输层抽象

**状态：** 已接受
**日期：** 2026-05-08
**分支：** `feat/mobile-m1-foundation`
**相关 issue：** #26 #27 #28 #29 #30 #31 #32（M1 基础链）· [Tracker #56](https://github.com/MaxQian888/cognia-next/issues/56)

---

## 背景

cognia-next 正从单客户端（Tauri 桌面）应用迈向服务器-客户端
系统，由同一个后端同时服务桌面 UI 与未来的移动
客户端（M3+）。一次 2026 年现状的代码库审计确认了两个钉死设计的事实：

1. **五个子系统永远无法在 iOS/Android 上运行**——Claude Agent SDK Node
   sidecar、MCP server sidecar、`sqlite-vec` 原生向量扩展、
   Rust `keyring` crate（它不覆盖 iOS Keychain / Android
   Keystore），以及连接器 webhook server（NAT 后的手机无法托管
   公网 URL）。这是平台事实，而非框架事实。
2. **`lib/tauri.ts` 本_应_是唯一的 `invoke()` 收口处**——但
   有五个非 `lib/tauri/` 模块（`lib/claude/ipc.ts`、
   `lib/external-bridge/tauri-control.ts`、`lib/connectors/tauri/commands.ts`、
   `lib/native/system-scheduler.ts`、
   `lib/anthropic-subscription/credential-store.ts`）直接调用 `invoke`，
   外加散落在 `lib/plugin/*`、`lib/ai/*` 等处的 30 多个漏网者。

二者合起来意味着：我们需要一个抽象，把_要运行哪个命令_与_如何派发它_解耦。
桌面端继续为了速度使用 Tauri IPC；未来的移动 shell（Capacitor——其选型见
对应 ADR）经同一组具名导出面与桌面的 axum HTTP/WS 服务器通信。

## 决策

引入一个 `Transport` 接口，并把 `@/lib/tauri` 中每个具名导出及其高频
下游 wrapper 都路由经一个模块作用域的 `transport` const。

```ts
// lib/tauri/transport-types.ts
export interface Transport {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>
  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void
}
```

M1 交付三个实现：

| 实现                     | 何时                               | `call`                                                          | `subscribe`                                                             |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `TauriTransport`         | `isTauri()`                        | 委托给 `@tauri-apps/api/core` 的 `invoke`                       | 把异步 `listen` 桥接成同步取消订阅，带 cancel-before-resolve            |
| `WebStubTransport`       | 纯 web（无 Tauri、无 Capacitor）   | 以 `tauri-only command from web mode: <name>` 拒绝             | no-op                                                                   |
| `CompanionTransportStub` | Capacitor 移动端                   | 以 `companion transport not implemented yet — see M2` 拒绝     | no-op                                                                   |

选型在 `lib/tauri/transport-instance.ts` 中于模块加载时一次性发生
（与 `lib/tauri.ts` 分离，以避开
`lib/tauri.ts → lib/tauri/index.ts → lib/tauri/<wrapper>.ts → lib/tauri.ts`
的循环导入链）。解析出的 `transport` const 从 `@/lib/tauri` 重新导出供
消费方使用。

`isCapacitor()` 与 `isTauri()` 一道成为公开的检测 helper，供需要区分这三种
运行时上下文的 UI 门控使用。

## 迁移范围与延期

M1 仅为承重的调用点交付迁移——目标是这个抽象，而非穷尽式迁移：

**已迁移（M1.1 → M1.6）：**

- 三个 transport 类全部 + 选择器
- `lib/tauri.ts:greet`（M1.2 试点）
- `lib/tauri/canvas.ts` 与现已退役的 `lib/tauri/remote-control.ts`（历史 M1.3——插件 wrapper
  中仅有的直接调 `invoke` 的调用方）
- `lib/claude/ipc.ts`、`lib/external-bridge/tauri-control.ts`、
  `lib/native/system-scheduler.ts`、
  `lib/anthropic-subscription/credential-store.ts`（M1.4）
- `lib/tauri/events.ts:onTauriEvent` 与 `lib/claude/ipc.ts:onClaudeMessage`
  （M1.5——标准的事件监听 helper）

**明确延期到后续 PR：**

- `lib/connectors/tauri/commands.ts` 与 10 个连接器适配器模块
  （slack/discord/telegram/lark/onebot 传输）。它们的测试经
  `mockInvoke.mock.calls.filter(...)` 断言，迁移它们是一项专门的工作。
- 9 个插件 SDK wrapper（`autostart.ts`、`cli.ts`、`clipboard.ts`、
  `deep-link.ts`、`notification.ts`、`opener.ts`、`os.ts`、`store.ts`、
  `webview-zoom.ts`）——它们包装的 Tauri 插件 SDK 内部使用
  `invoke`，channel 名形如 `plugin:foo|bar`。迁移需要
  为每个插件函数定义并行的 Rust 命令来包装（属 M2 服务器
  API 面工作）。
- 约 30 个其他生产模块（`lib/plugin/*`、`lib/ai/providers/*`、
  `lib/ccswitch/*`、`lib/files/*`、`lib/scheduler/*` 等）直接 import
  `invoke`。它们随各自对应的 `/api/v1/*` 路由处理器在 M2 落地而
  按领域逐一迁移。
- 禁止在 `lib/tauri/transport-tauri.ts` 之外引入 `@tauri-apps/api/core` 的
  `no-restricted-imports` ESLint 规则。待生产代码迁移完成后落地（否则会
  迫使 30 多个模块逐文件加 `eslint-disable` 注释）。

## 后果

**收益：**

- 单一接缝（`transport`）拦截 IPC 边界。
  `jest.spyOn(transport, "call")` 成为新的通用 mock 模式。
- `isCapacitor()` 已就位，供 M4 的 `usePlatform()` hook 使用。
- M2 的 `CompanionTransport`（真正的 HTTP/WS 实现）只需在
  `transport-instance.ts` 中做单文件替换——下游每个消费方保持不变。
- web 模式的错误消息现在一致（`tauri-only command from web
mode: <name>`），不再是各 wrapper 特有的字符串。

**代价：**

- `transport` 的模块加载即时求值不得不移到
  单独文件，以免破坏 `jest.requireActual("@/lib/tauri")`
  模式（`lib/db/twin-runtime-settings.test.ts` 中的一个测试）。
- 此前经 `mockedInvoke.mock.calls` 断言的测试不得不
  改用 `jest.spyOn(transport, "call")`。约 6 个测试文件已更新；约 10
  个连同其 wrapper 一起延期。
- 已迁移 wrapper 中本地的 `isTauri()` / `ensureTauri()` 守卫被
  移除，改为让 WebStubTransport 产出拒绝。
  错误消息字符串有所变化，但语义等价，且
  Capacitor 路径现在可达。

## 验证

- `pnpm test`——9314 通过，24 跳过，0 失败。
- `pnpm test:coverage`——每个新文件（`transport-types.ts`、
  `transport-tauri.ts`、`transport-web.ts`、`transport-companion-stub.ts`、
  `transport-instance.ts`）行覆盖率均超 90%。
  `transport-types.ts` 被排除在闸门外（纯接口，V8
  报告 0 条语句），与 `jest.config.ts` 中已豁免的另外九个仅类型
  模块遵循同一模式。
- `pnpm typecheck` 与 `pnpm lint`——M1 的六个 commit 无回归。
- 手动冒烟 `pnpm tauri dev`——聊天 / 设置 / twin admin 都
  走过已迁移路径，无可观察的行为变化。

## 下一步

M2 在此接缝之上构建：定义镜像 Tauri 命令列表的 `/api/v1/*` axum 路由
（依 ADR 0013——命令清单）、JWT 配对 / 鉴权
（`pairedDevices` Dexie schema v21）、真正的 `CompanionTransport`，以及
mDNS/cloudflared 的 LAN+隧道暴露。移动 shell（M3 起）把
既有的 Next.js 导出包进 Capacitor 7，并经本次交付的同一 `transport`
接缝把手机连到桌面的 axum 服务器。

## 参考

- M1 issue 链：[#26](https://github.com/MaxQian888/cognia-next/issues/26)
  → [#27](https://github.com/MaxQian888/cognia-next/issues/27)
  → ([#28](https://github.com/MaxQian888/cognia-next/issues/28)
  ‖ [#29](https://github.com/MaxQian888/cognia-next/issues/29)
  ‖ [#30](https://github.com/MaxQian888/cognia-next/issues/30)
  ‖ [#31](https://github.com/MaxQian888/cognia-next/issues/31))
  → [#32](https://github.com/MaxQian888/cognia-next/issues/32)
- 移动客户端 tracker：[#56](https://github.com/MaxQian888/cognia-next/issues/56)
- 计划文件（私有）：`~/.claude/plans/react-tauri-react-native-snug-hennessy.md`
- Tauri Mobile sidecar 讨论：[tauri-apps/tauri#11454](https://github.com/tauri-apps/tauri/discussions/11454)（选 Capacitor 而非 Tauri Mobile 的动因）
