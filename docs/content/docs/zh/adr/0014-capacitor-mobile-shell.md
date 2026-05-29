---
title: ADR-0014 — Capacitor 移动端外壳
description: 移动端客户端 v1 把既有的、与 Tauri 共享的 Next.js 静态导出包裹进一个 Capacitor 7 外壳。同一份 JS 包跑在三个平台上，三路 Transport 选择，设备 JWT 存于操作系统密钥库。
---

# Capacitor 移动端外壳

| 状态     | 已接受                                                                     |
| -------- | ------------------------------------------------------------------------- |
| 日期     | 2026-05-08                                                                |
| 影响     | mobile/, lib/tauri/, app/(mobile-onboard), app/, src-tauri/companion_api/ |
| Issue    | #41 (M3.1) · #42 (M3.2) · #43 (M3.3) · #44 (M3.4)                         |
| 跟踪     | #56                                                                       |

## 背景

cognia-next 在桌面端以 Tauri 2 应用形式运行（Rust 外壳 + WebView）。
移动端客户端 v1 计划（issue #56）新增一个手机客户端，通过 LAN 与桌面端
通信。当时摆在桌面上的有三个原生外壳方案：

1. **Tauri 2 Mobile** —— 能让我们复用同一套 Rust crate。否决：移动端缺少
   sidecar 支持（Tauri issues #11454 / #9774），而我们的 Claude Agent SDK
   sidecar 是桌面端运行时的基石。
2. **React Native** —— 能让我们共享 Zustand store 与 lib/ 辅助函数。否决：
   把全部 57 个 shadcn/ui 组件用 RN 原语重写需要数周，却没有任何功能收益。
   桌面端 UI 本来就是移动端用户想要的东西。
3. **Capacitor 7** —— 把既有的 Next.js 静态导出包进原生 WebView。选用。

把该选择与一个基于 HTTP 的 companion 服务器（M2）配对意味着：手机调用
桌面端的方式与外部脚本一样，都走 `/api/v1/*`。#56 中记录的服务器-客户端
架构使移动端客户端与未来无头的 `cognia-server` 成为同一套 API 的对称
客户端。

## 决策

### 工作区布局

一个新的 pnpm 工作区 `mobile/` 加入既有的 `docs/`：

```
pnpm-workspace.yaml
├── docs        # Fumadocs site (full Next server, port 3001)
└── mobile      # Capacitor shell (no Next server — feeds off ../out)
```

Capacitor 的 `webDir: "../out"` 指向 Tauri 加载的同一个目录
（`src-tauri/tauri.conf.json` 的 `frontendDist: "../out"`）。一次
`pnpm build` 产出一份静态导出，两个原生外壳消费它。

### 锁定的版本

| 包                                                                 | 范围      | 原因                                                                                          |
| ------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------- |
| `@capacitor/core`, `@capacitor/cli`                                | `^7.0.0`  | Capacitor 7 是 Node 20 的下限。                                                              |
| `@capacitor/android`                                               | `^7.6.3`  | 锁定以与 `^7` core 对齐。                                                                    |
| `@capacitor/{app,keyboard,network,preferences,push-notifications}` | `^7.0.x`  | 官方插件。                                                                                   |
| `capacitor-secure-storage-plugin`                                  | `^0.13.0` | 活跃的社区插件；桥接 Keychain / Keystore。                                                   |
| `@capacitor-mlkit/barcode-scanning`                                | `^7.5.0`  | 当前在维护的 QR 扫描器。较老的 `@capacitor/barcode-scanner` 已无人维护。                     |

`bundledWebRuntime` **未设置**——该字段在 Capacitor 5+ 中被移除。issue
#41 的原始措辞早于此变更。

### 传输层选择

三个具体的 `Transport` 实现，在 `lib/tauri/transport-instance.ts` 模块
加载时一次性选定：

```
window.__TAURI_INTERNALS__ exists                  → TauriTransport
window.Capacitor?.isNativePlatform() === true      → CompanionTransport
otherwise                                          → WebStubTransport
```

`CompanionTransport`（M2.7，`lib/tauri/transport-companion.ts`）通过
`POST /api/v1/_rpc/<command>` 与 `GET /ws/v1/events` 与桌面端通信。在
手机上，它的 base URL 指向桌面端的 LAN IP。在 web 构建中，它将瞄准
未来的 `cognia-server` 部署——同一条代码路径服务两者。

### 设备 JWT 的存储

`lib/tauri/companion-storage.ts` 加入一个与后端无关的
`CompanionConfigStorage` 接口，含两个实现：

- **`LocalStorageCompanionStorage`** —— 封装 `window.localStorage`。用于
  web 构建以及 jsdom 单元测试。
- **`SecureStorageCompanionStorage`** —— 动态导入
  `capacitor-secure-storage-plugin`（这样 web 包永远不会解析它）。把
  JSON 序列化的 `CompanionConfig` 存在 iOS Keychain / Android Keystore 中
  的 `cognia.companion.config.v1` 键下。

选择通过 `pickCompanionStorage()` 进行，镜像传输层的选择。一个模块级
缓存挡在两个后端之前，使热路径（`transport.call()` 读取 JWT）保持同步；
缓存在应用启动时由 `hydrateCompanionConfig()` 预热，或由任何一次成功的
`saveCompanionConfig()` 预热。

### 移动端引导（stub）

`app/(mobile-onboard)/pair/page.tsx` + `components/mobile/
pair-onboarding-client.tsx` 交付 M3.4 stub：

1. 用于 `baseUrl` + `pair JWT` 的手动文本框（真正的 QR 扫描在 M4.5 / #49
   发布）。
2. 带 pair JWT、设备标签、平台与一个可选公钥，`POST {baseUrl}/api/v1/auth/pair`。
3. 把返回的 `CompanionConfig` 持久化到安全存储路径。
4. 冒烟 RPC：`transport.call("claude_sidecar_status")` —— 该只读命令已在
   服务端的 `src-tauri/src/companion_api/rpc.rs` 中注册。（issue #44 的示例
   用的是 `list_characters`，但 character 存在 Dexie 中、并未在 Rust 侧
   暴露；`claude_sidecar_status` 是当下存在的等价只读冒烟。）
5. 冒烟 WS：`transport.subscribe("claude://session-event", …)` —— 打开
   WebSocket，从 seq 游标回放。

该页面位于路由组 `(mobile-onboard)` 之下，因此 URL 为 `/pair`。静态导出
得以保留（`dynamicParams = false`，由于路由是具体的，无需
`generateStaticParams`）。

### 平台清单

iOS（`mobile/ios/App/App/Info.plist`，M3.2 —— 需在 Mac 上人工介入）：

- `NSCameraUsageDescription` —— QR 配对
- `NSLocalNetworkUsageDescription` —— 在 LAN 上发现桌面端
- `NSAppTransportSecurity / NSAllowsLocalNetworking = true` —— 在 M2.8 的
  TLS 工作被推迟到 M2.9 期间所需。一旦自签名证书落地，策略就收紧为
  trust anchor。
- iOS Deployment Target = 16.0

Android（`mobile/android/`，M3.3 —— 在 Windows 上以 JDK 21 + Android
SDK 35 构建并验证）：

- `INTERNET`、`CAMERA`、`POST_NOTIFICATIONS` 声明于
  `app/src/main/AndroidManifest.xml`。
- 仅调试用的 `usesCleartextTraffic="true"` 放在
  `app/src/debug/AndroidManifest.xml`，这样发布构建继承安全默认值。
- `compileSdk` / `targetSdk` = 35（Capacitor 7 默认），`minSdk` = 24。
- `gradlew assembleDebug` 成功；产出的 `app-debug.apk`（≈22 MB）即冒烟
  证据。

## 后果

### 好处

- 一套 Next.js 代码库，三个外壳。无 UI 重写，无并行的组件库。
- `out/` 的再生成成本付一次，消费两次。
- 将来新增第四个客户端（Electron、Wails……）只需一个新的 `Transport`
  实现，外加一个加载 `out/` 的封装。
- 手机是_客户端_，不是对等节点。Twin embedding、sidecar token 预算、MCP
  服务器、OAuth bearer —— 全都留在桌面侧。手机永不触碰
  `~/.claude/.credentials.json`。

### 可接受的成本

- WebView 约束：没有 `<canvas>` 重渲染路径，没有原生文件系统访问。
  cognia-next 恰好在移动端两者都不需要（暂无侧栏 3D 场景）。
- 配对流程需要一套 UX（QR 或旁路）。M4.5 发布 QR 扫描；M3.4 stub 用
  文本框。
- Capacitor 的 WebView 与系统共享，而非 Chromium 分叉。较老的 Android
  设备（API < 24）的 JS 性能很差——`minSdk = 24` 是我们守住的底线。

### 待定

- **LAN 的 TLS** —— M2.8 把自签名证书 + cloudflared 推迟到 M2.9。在
  M2.9 落地前，M3.4 冒烟跑在纯 HTTP 之上，由上面的
  `NSAllowsLocalNetworking` / `usesCleartextTraffic` 仅调试例外把守。
  M2.9 将收紧两份清单。
- **mDNS 广播** —— 同样推迟到 M2.9。M3.4 stub 用手动 `baseUrl` 输入；
  M4.4 将从 QR 载荷中取它。
- **iOS 冒烟构建** —— #42 需在 Mac 上人工介入。计划级决策已记录；待某位
  负责人运行构建后补上物理验证 + Xcode 日志摘录。

## 验证

端到端（手动，需要运行中的 M2 桌面服务器 + 同一 LAN 上的一部手机或
模拟器）：

1. 桌面：`pnpm tauri dev`，设置 → Companion → 启用 LAN 绑定 + 启动
   服务器，生成一个 5 分钟的 pair JWT。
2. 构建静态导出：`pnpm build`。
3. 同步进平台：`pnpm mobile:sync`（链式执行
   `pnpm build && pnpm -F mobile sync`）。
4. 打开平台：`pnpm mobile:open:android`（或在 Mac 上用 `:ios`）。
5. 在设备应用中，导航到 `/pair`，输入桌面端的 LAN IP + pair JWT，点
   **Pair**。
6. 点 **Smoke RPC** —— 预期得到一个 `claude_sidecar_status` 载荷。
7. 点 **Smoke WS** —— 预期在 5s 内得到 "OK" 或一帧捕获帧。
8. 确认 JWT 在操作系统密钥库中：Android 上 `adb shell run-as
com.cognia.mobile cat shared_prefs/SecureStorage.xml` 显示一个加密值；
   iOS 上 `security find-generic-password -a default
-s "com.cognia.mobile.companion" -w` 返回该 JWT。

自动化：

- `pnpm test --testPathPatterns="(companion-storage|transport-companion|pair-onboarding)"`
  —— 58 个测试覆盖存储后端、传输层重构与引导组件（正常 + 错误路径）。
- `pnpm typecheck` —— 干净。
- `gradlew assembleDebug`（在 `mobile/android/` 中）—— `BUILD SUCCESSFUL`，
  产出 `app/build/outputs/apk/debug/app-debug.apk`。
