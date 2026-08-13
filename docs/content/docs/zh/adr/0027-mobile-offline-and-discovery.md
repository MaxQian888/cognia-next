---
title: ADR-0027 — 移动端离线容忍与服务器发现 (Wave 4.0)
description: 持久化同步游标、Dexie-first 读取、Capacitor mDNS、Serwist PWA，以及 ConnectionStateBadge 下拉菜单（重连 / 扫描 / 切换）。
---

# ADR-0027 — 移动端离线容忍与服务器发现

**状态**: 已接受 (2026-05-19, Wave 4.0)
**关联**: 扩展 ADR-0014 (Capacitor 外壳)、ADR-0015 (Wave 1.x 移动端补全)、ADR-0021 (WebRTC 通道)
**作者**: Max Qian + Claude Opus 4.7

## 背景

Capacitor 7 移动端外壳已发布 JWT 配对、WebRTC 通道、写入离线队列；但在桌面端不可达时仍有三个明显短板：

1. **缺少读路径缓存**。每个屏幕都直接调用 `transport.call()`。现有同步编排器 `lib/sync/companion-sync.ts` 仅同步 4 张表（sessions/messages/characters/skills），且游标只存在内存里；其余 5 张可同步的表未接入。
2. **断网时无"扫描 / 重连"入口**。`ConnectionStateBadge` 只是展示性徽章；桌面端掉线时用户没有触发发现、重新配对或切换其他已配对桌面的入口，只能手动走到 `/pair`。移动端 mDNS 一直是 `defaultMobileLoader` 的 no-op。
3. **配对流程纸割伤**。QR 扫码在权限被拒时无声失败 —— Apple 不提供权限再请求接口，用户被卡住。

## 决策

### 同步编排器扩展（计划 B 节）

- **持久化游标**：新增 Dexie 表 `syncCursors`（schema.ts v44），`lib/sync/cursor-store.ts` 提供 read-through 缓存；`companion-sync.ts` 在首次 `runSyncDown` 时一次性 hydrate 内存 `stateMap`，每次 handler 完成后 fire-and-forget `saveCursor`。冷启动现在从最后成功游标恢复，不再每次都从 `since: 0` 拉全量。
- **新增 5 个 handler**：`workflows` / `twinProfile` / `plugins` / `adapterInstances` / `settings`。Rust 侧 `sync_registry.rs::default_tables()` 已注册，无需改动后端。
- **两个新触发点**：`installNetworkSync()`（网络恢复）+ `installResumeSync()`（`@capacitor/app:resume`），均挂入 `CompanionBootProvider`。outbound queue 仍独立订阅网络事件；Capacitor 插件监听器允许多个订阅者。
- **`useDexieFirstQuery` hook**（`hooks/data/use-dexie-first-query.ts`）组合 `useClientLiveQuery` + 挂载时一次同步触发 + SWR 指示器。已迁移两个示范路径：`mobile-channel-list.tsx`（characters）+ `workflow-list.tsx`（workflows）。

### 服务器发现（计划 C 节）

- **mDNS 插件**：通过 npm 安装 `capacitor-zeroconf@4.0.0`（`mobile/package.json`）。原计划 vendor 到 `plugins/capacitor-zeroconf/`，推迟到 Android 14+ `NsdManager.resolveService()` 弃用真正阻塞时再做；当前 npm 依赖即可（2025-05-09 上游 commit 明确支持 Capacitor 7、TXT 记录、匹配 `_cognia._tcp`）。
- **iOS 本地网络合规**：`mobile/scripts/patch-ios-info-plist.mjs` 在 `cap add ios` 后写入 `NSBonjourServices = ["_cognia._tcp"]` 和双语 `NSLocalNetworkUsageDescription`。不写入则 iOS 14+ 静默返回空发现结果。
- **Android 组播**：`CHANGE_WIFI_MULTICAST_STATE` 已在 `AndroidManifest.xml`。
- **权限助手**：`lib/connectivity/mdns-permission.ts` 包装 iOS 一次性本地网络弹窗；用户拒绝后返回 `kind: "denied"`，扫描 Sheet 据此渲染 `openAppSettings()` 深链入口（`lib/capacitor/app-settings.ts`）—— Apple 不支持代码再请求权限。

### PWA 层（计划 A 节）

- **Serwist 9**（`@serwist/next`）包裹 `next.config.ts`。`NEXT_PUBLIC_PLATFORM === "mobile"` 时禁用 —— iOS WKWebView 在 `capacitor://localhost` 自定义 scheme 下无法注册 SW，移动端依赖前述 Dexie-first 编排器即可。
- `app/sw.ts` 运行时缓存：`/api/v1/_rpc/sync_pull` 走 `NetworkFirst`（4 秒超时，1 小时上限）；图片走 `StaleWhileRevalidate`；其余走 `defaultCache`。
- `app/manifest.ts` 声明 `cognia` 名称 + standalone + 192/512 SVG 图标。生产 PNG 图标作为后续跟进。

### QR 扫码 UX（计划 D 节）

- 计划中的 "M3.4 stub" 描述已过期 —— `pair-step.tsx` 实际已经接入 `lib/capacitor/barcode.ts`。真正的缺口是权限被拒后的恢复入口与"扫描中..."的临时态。
- `pair-step.tsx` 的 Phase 状态机新增 `scanning`（点击按钮后在原位置渲染 spinner），`error` 变体新增可选 `action`（标签 + `onAction`）。`permission_denied` 时 action 深链到 `openAppSettings()`。

### 重连 / 扫描 / 切换入口（计划 E 节）

- `ConnectionStateBadge`（顶栏常驻徽章）升级为下拉触发器。菜单：**立即重连**（重做 WebRTC 握手 + 触发同步）/ **扫描局域网**（打开 `MobileServerScanSheet`）/ **切换已配对服务器**（打开 `MobilePairedServersSheet`）/ **配对新设备**（跳转到 `/pair`）。"上次同步" 子段调用 `snapshotSyncStates()`，让用户一眼看出哪些表可能已陈旧。
- `MobileServerScanSheet` 驱动 `scanLan()` + `requestMdnsPermission()`，按 `mdns`/`probe`/`history` 分组展示发现结果。iOS 本地网络被拒时通过共享 `EmptyState` 显示 `openAppSettings()` 入口。
- `MobilePairedServersSheet` 列出 Dexie `pairedDevices` 中未撤销的所有设备；点击跳转 `/pair?switchTo=<deviceId>`，由配对页执行 device-JWT 验证。

### 工作流列表手势（计划 I 节）

- `workflow-list.tsx` 现在每行包裹 `<SwipeRow>`（Run / Favorite 快捷操作），列表整体包裹 `<PullToRefresh>`。长按打开 `WorkflowRowActionsSheet` —— 六个操作：Run / Pause / Pin / Graph / Delete。`WorkflowDeleteConfirm` 仅本地 Dexie 删除；服务端镜像 RPC 作为 Wave 5（需扩展 `MOBILE_OUTBOUND_COMMANDS` 与 Rust dispatcher）。

## 非目标（Wave 4.0）

- **vendor mDNS 插件源码**：Android 14+ 弃用在生产中显现时再做。
- **Inbox 移动变体**（计划 F 节）—— 推迟到 Wave 4.1；目前桌面 `/inbox` 响应式回流可用，分段移动版（Drafts / Messages / All）+ 滑动审批拆出。
- **Backup 完整流程**（计划 G 节）—— `mobile-backup-section.tsx` 已支持口令导出和历史列表；分享面板、计划 CRUD、导入预览推迟到 Wave 4.1。
- **Twin Source 编辑器**（计划 H 节）—— 只读移动面板保留；长按编辑、redact 预览、相机 OCR 添加路径推迟到 Wave 4.1。
- **Capacitor scheme 迁移**到 `https://localhost`（以便 iOS 启用 SW）—— 爆炸半径太大（CapacitorHttp 钉证、认证、WebRTC），相比 Dexie-first 已覆盖移动 PWA 价值，不划算。

## 影响

- 移动端冷启动 UX：以前首次启动每次都阻塞拉全量；现在立即从 Dexie 渲染并后台刷新。
- 服务器掉线 UX：聊天 / 工作流 / 发现等屏幕在桌面不可达时仍能渲染真实数据；`ConnectionStateBadge` 下拉菜单暴露了之前必须走 `/pair` 才能找到的恢复入口（重连 / 扫描 / 切换）。
- iOS 本地网络摩擦：首次提示出现在第一次点击 `Scan LAN`（不是启动时）。被拒后可通过设置深链恢复，但不能代码再请求。
- Schema 升级：Dexie v44 —— 纯追加，无 upgrade hook。v44 之前的安装从空游标表开始，编排器回退到 `since: 0`（幂等）。
- Bundle 大小：web/Tauri 增加约 30 KB（Serwist SW 源）；移动端不变（已禁用）。

## 验证

- `pnpm lint:i18n` — en + zh-CN 键奇偶校验。
- `pnpm typecheck` — Serwist + cursor-store 类型可解析。
- `pnpm test:coverage` — 编排器 + 新 handler + cursor-store + 权限助手 + app-settings ≥90%。
- `pnpm build` — 确认 web 产物中存在 `out/sw.js` + `out/manifest.webmanifest`。
- `cross-env NEXT_PUBLIC_PLATFORM=mobile pnpm build` — 确认移动构建中 SW **未** 生成。
- `pnpm mobile:sync` — `capacitor-zeroconf` 注册到 cap 插件列表；`mobile/scripts/patch-ios-info-plist.mjs` 已挂入 `mobile/package.json` 的 `add:ios`。

## 后续跟进

1. `app/manifest.ts` 的 PNG 图标（当前为 SVG 占位）。
2. Inbox / Backup / Twin Source 编辑器 —— 计划 F / G / H 节。
3. `workflow_delete` 与 `workflow_schedule_pause` 的 RPC 镜像（需扩展 `MOBILE_OUTBOUND_COMMANDS` 与 Rust dispatcher），让移动端工作流 CRUD 能回到桌面端。
4. Tauri SW 注册的 macOS / Win / Linux 验证 —— `tauri://localhost` scheme 未在文档中明确支持 SW，若注册失败则桌面端降级为无 PWA，无用户可见影响。

## 当前状态修订（2026-08-13）

PNG manifest、mobile Inbox、backup/import/reminder、Twin long-press/redaction/camera 流程，以及 workflow delete/pause RPC mirrors 均已存在。剩余开放项是真实 Tauri service worker 在 macOS、Windows、Linux 上的 smoke 证据；历史功能清单不应再被当作当前缺口。
