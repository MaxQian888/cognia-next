---
title: 0015 — 移动端 V2 收尾
description: 收尾 ADR-0014 推迟的移动端事项（QR / TLS / mDNS / OAuth），外加 14 个插件的原生扩展，以及三波次子系统移动化路线图。
---

## 状态

已接受 —— 2026-05-08

## 背景

ADR-0014（「Capacitor 移动端外壳」，2026-04-XX）交付了 V1 移动端基础：
Capacitor 7 工作区、最初的 companion 配对与数据面、推送
通知、增量同步、安全存储，以及一个 M3.4 手动文本框配对引导流程。
ADR-0014 显式推迟了：

- **M2.8** —— LAN companion 服务器的 TLS、Cloudflared 隧道启动器、OAuth
  深链回调处理
- **M2.9** —— mDNS 广播 + LAN 发现
- **M4.5** —— 用 QR 扫描替换手动文本框
- 所有非 Inbox 子系统的移动端 UX（Connector / Workflow / Twin / Backup）
- 10+ 个产品会受益但尚未集成的 Capacitor 插件

本 ADR 的第 1 波收尾每一项被推迟的安全 / 连接事项，铺设一套统一的原生
插件封装层，并为第 2/3 波准备好数据形态。

## 决策

三波次交付：

### 第 1 波（本次提交）—— 配对、安全、原生脚手架

1. **`lib/capacitor/<plugin>.ts` —— 16 个原生封装**

   `_shared.ts` 提供 `withPlugin(loader, action)` + `makeDefaultLoader`，
   使每个封装文件遵循同一模板：可辨识联合的结果、动态导入加载器（web 包
   永不解析原生代码）、web/Tauri 回退。覆盖的插件：

   `haptics`、`toast`、`dialog`、`status-bar`、`splash-screen`、`network`、
   `screen-orientation`、`filesystem`、`camera`、`share`、`browser`、
   `deeplink`（基于 `@capacitor/app`）、`local-notifications`、`geolocation`、
   `biometric`（`capacitor-native-biometric`）、`barcode`（`@capacitor-mlkit/
barcode-scanning`）。

2. **TLS 自签名证书 + 公钥固定（pinning）**

   `src-tauri/src/companion_api/tls.rs` 通过 `rcgen` 生成一份 10 年期的
   自签名证书，持久化于 `<app_data>/cognia/companion/tls.{pem,key}`，并
   计算 SHA-256 的 SubjectPublicKeyInfo 指纹。该指纹被嵌入 QR pair 载荷，
   以便移动端客户端在后续调用中固定它。用同一密钥重新签发可使固定值
   保持有效。

3. **Canonical Pair 载荷（`lib/qr/pair-payload.ts`）**

   当前协议是破坏性升级后的 `cgnp3` envelope，携带 `base`、`host`、
   `tenant`、`exp`、`ver`、`fp` 与 `mode`；仅 `owner-invitation` 模式携带
   单次 `invitation`。客户端拒绝所有旧版与裸 JSON 载荷。设备认证使用
   P-256 密钥、5 分钟 DPoP 绑定 access token 与单次 socket ticket。
   `lib/capacitor/barcode.ts` 封装把原始 QR 字符串交给解码器。

4. **mDNS 广播 + 扫描**

   `src-tauri/src/companion_api/mdns.rs` 通告 `_cognia._tcp.local.`，带
   `ver`、`fp`、`path` 的 TXT 记录。`lib/connectivity/
mdns-discovery.ts` 封装 Capacitor mDNS 插件（移动侧），并为桌面 UI 暴露
   Tauri 命令 `companion_mdns_start` / `companion_mdns_stop`。连接策略模块
   拒绝那些通告指纹与固定值不匹配的 mDNS 发现对端。

5. **Cloudflared 隧道启动器**

   `src-tauri/src/companion_api/tunnel.rs` 将 `cloudflared tunnel
--url <local>` 作为被跟踪的子进程派生，并从 stderr 中解析出
   trycloudflare URL。`lib/connectivity/tunnel-resolver.ts` 向 UI 暴露
   start / stop / current。隧道默认关闭——仅可通过设置主动开启。

6. **连接策略（`lib/connectivity/connection-strategy.ts`）**

   构建一个带优先级的候选列表：mDNS 发现的（指纹匹配）→ 隧道 → 缓存。
   `pickReachable` 遍历列表、调用一个探测函数，返回第一个响应者。是传输层
   「连到哪里」决策的唯一真相之源。

7. **OAuth 应用内浏览器 + 深链**

   `lib/capacitor/browser.ts` 在 `@capacitor/browser` 中打开 authorize
   URL。`lib/capacitor/deeplink.ts` 把 `cognia://` URL 解析为一个类型化的
   `DeeplinkRoute` 联合，并通过 `@capacitor/app` 的 `appUrlOpen` 事件订阅。
   `lib/oauth/mobile-flow.ts` 进行编排：打开 → 带超时等待深链 → 解析出
   `{ code, state }`。对于不允许自定义重定向 URI scheme 的提供方（例如
   Anthropic Claude），支持手动粘贴模式作为回退。

8. **生物识别守卫（`hooks/use-biometric-guard.ts`）**

   把敏感操作（删除配对、导出备份、解密安全数据）置于 `verify()` 之后。
   在未注册生物识别的设备上默认放行，使 UX 优雅降级。「我 → 应用安全」
   开关（第 2 波）会为想要严格门控的用户把放行翻转为 false。

9. **Schema 新增**

   `pairedDevices.serverFingerprint`（可选）—— 配对时设置的固定 TLS
   指纹。`setServerFingerprint` 在密钥轮换时更新它。
   `CompanionConfig.serverFingerprint` 在移动侧镜像它，使传输层可以
   固定而无需在热路径上读 Dexie。

10. **Android Manifest** —— 加入 `cognia://` intent filter、用于分享目标
    的 `ACTION_SEND` intent filter（第 3 波准备），以及新插件所需的权限
    （RECORD_AUDIO、ACCESS_NETWORK_STATE、USE_BIOMETRIC、
    ACCESS_FINE_LOCATION、READ_MEDIA_IMAGES 等）。

11. **iOS 引导文档**（`mobile/IOS_BOOTSTRAP.md`）

    `cap add ios` 仅限 macOS。该文档记录了 `Info.plist` 新增项、URL
    scheme、Bonjour 服务注册、面向 LAN 的 App Transport Security 例外，
    以及发布所需的 Apple Developer / APNs 步骤。

### 第 2 波 —— 移动端外壳 + 双向 Inbox + Connector 审批（已交付）

1. **出站队列（Dexie v25，`mobileOutboundQueue`）**

   `lib/db/mobile-outbound-types.ts` 定义了 11 个命令的面
   （`connector_send`、`connector_approve_draft`、`workflow_trigger_manual`、
   `twin_ingest_source`、`backup_export`……）。`lib/db/mobile-outbound-queue.ts`
   是 Dexie 辅助层（`enqueue`、`claimNext`、`markSent`、
   `recordFailure`、`vacuumSent`、`retryDeadletter`）。
   `lib/queue/retry-policy.ts` 提供指数退避（1 → 60 s，25% 抖动，最多 5 次
   尝试）外加 4xx 类不可重试检测。`lib/queue/outbound-queue.ts` 是 runner ——
   订阅 `@capacitor/network` 变更事件，在 `kick()` 时排空，并遵守
   `nextAttemptAt` 使失败行获得正确的冷却时间。

2. **移动端外壳封装 + 4-Tab 栏**

   `components/mobile/shell/mobile-shell-wrapper.tsx` 在 `app/layout.tsx`
   中无条件挂载，仅当 `usePlatform() === "mobile"` 时渲染 `<MobileTabBar />`。
   `mobile-tab-bar.tsx` 暴露微信风格的 4 个 tab（聊天 / 工作流 / 发现 / 我），
   采用最长前缀优先的路由匹配与触觉选择反馈。在 `/pair` 与 `/oauth/*` 上
   隐藏，使引导流程拥有完整画布。

3. **通用交互原语（`components/mobile/interactions/`）**

   `pull-to-refresh.tsx`（带刷新回调的橡皮筋拖拽）、
   `swipe-row.tsx`（带提交阈值的水平滑动，揭示左 / 右动作面板）、
   `long-press.tsx`（按住 + 容差 + 移动时自动取消）。三者都通过
   `lib/capacitor/haptics.ts` 驱动触觉，使反馈一致。一个
   `test-pointer-polyfill.ts` shim 绕过 jsdom 26 不暴露 `PointerEvent`
   的问题。

4. **发现页 + 我页**

   `app/discover/page.tsx` 是一个 4-tab 的 Tabs 面，通过 Dexie
   `useLiveQuery` 列出 character、team、skill 与 twin 草稿。
   `components/mobile/discover/{character,team,skill,twin-draft}-card.tsx`
   是行原语。
   `app/me/page.tsx` 是设置总览——配对状态卡 + 联动分区（Account / Data /
   Appearance / Advanced），路由进既有的 `/settings?section=...` 路径。

5. **Connector 草稿审批面板**

   `components/mobile/connector/draft-approval-panel.tsx` 以最新优先列出
   每个待处理的 `ConnectorDraftRow`；每行用 `<SwipeRow>` 左=拒绝 / 右=批准
   外加内联按钮。被接受的草稿既命中
   `lib/db/connector-drafts.approveDraft`，又入队一个
   `connector_approve_draft` 出站任务，使桌面端发起实际的平台发送。
   `<PullToRefresh>` 在下拉时运行 `sweepExpired()`。

6. **Composer 加号菜单（相机 / 相册 / 文件 / 语音）**

   `components/mobile/chat/composer-plus-menu.tsx` 是附件启动器。相机 + 相册
   走 `lib/capacitor/camera.ts`；文件用 `<input type="file">`（在 Capacitor
   与 web 上都可用）；语音惰性使用 `@capacitor-community/voice-recorder`。
   权限拒绝 / 取消 / 不支持都经 `onError` 浮现，而不抛出。

7. **i18n**

   新增 `mobile` 顶级命名空间（en + zh-CN），含子键 `tabs`、`tabBar`、
   `pair`、`discover`、`me`、`companion.{tunnel,mdns,
revoke}`、`twinDraft`、`draftApproval`、`composerPlus`。第 1 波的硬编码
   中文字符串（TunnelCard / MdnsCard / pair 页）被重构为通过
   `next-intl::useTranslations` 使用这些键。

验证：

- `pnpm typecheck` → EXIT=0
- 35 个套件共 288 / 288 个 jest 测试
- `lib/capacitor`、`lib/queue`、`components/mobile/interactions`、
  `components/mobile/shell`、`components/mobile/connector`、
  `components/mobile/chat` 的覆盖率均 ≥ 90% 语句 + 分支

### 第 3 波 —— Workflow / Twin / Backup 移动化 + 离线收尾（已交付）

1. **移动端 Workflow 面**（`components/mobile/workflow/`）

   `workflow-list.tsx` —— 对 `workflows` + `workflowRuns`（运行中）的 Dexie
   liveQuery，使每个列表行在有运行进行中时获得一个 "Active" 标记。
   `trigger-button.tsx` 入队 `workflow_trigger_manual` + 轻触觉 + i18n
   toast。`run-vertical-gantt.tsx` 把运行垂直堆叠，带时间线圆点 + 状态徽章
   + 时长格式化（`<1s` → ms，`<60s` → 小数 s，否则 `Xm Ys`）。
   `run-status-badge.tsx` 用主题感知的颜色覆盖全部 7 个 RunStatus 变体。

2. **Twin 来源 + 草稿面板**（`components/mobile/discover/`）

   `twin-sources-panel.tsx` 以最新优先列出每个 TwinSource，带一个 FAB
   "+"，打开 3 个选择器快捷方式：粘贴（原生 dialog 提示）、相机
   （`lib/capacitor/camera.pickPhoto`）、文件（web 文件输入）。每条路径都
   入队一个 `twin_ingest_source` 出站任务。
   `twin-drafts-panel.tsx` 把每个 `<TwinDraftCard>` 包进 `<SwipeRow>`，
   左=拒绝 / 右=接受；接受会持久化一个真实的 `Character` / `Skill` 行 +
   标记草稿为已接受；拒绝则标记为已拒绝。两者都镜像到出站队列。

3. **移动端 Backup 分区**（`components/mobile/backup/`）

   `mobile-backup-section.tsx` 暴露仅加密导出
   （`buildBackupPackage` → `encryptBackupPackage` → `lib/capacitor/
filesystem.writeFile` 写到 `Documents/cognia/backups/<ts>.cog.bak`）、
   导入（web 文件输入 → `migrateEnvelope` → `applyBackupPackage`，带合并
   策略选择器）、自动备份开关（LocalNotifications 提醒），以及一个历史
   列表（来自 `listBackupHistory` 的前 8 条）。挂载在 `/me` 中 Data 分区
   的顶部。Web 模式的导出回退为 Blob-URL 下载。

4. **分享目标接收器**（`app/share-target/page.tsx`）

   渲染收到的 text/url + 一个会话选择器；点击某个会话会入队一个
   `connector_send` 出站任务。可通过以下方式到达：
   - Android `ACTION_SEND` intent filter（第 1.3 波）
   - iOS Share Extension（需人工介入 —— 见 `mobile/IOS_BOOTSTRAP.md`）
   - Web `?text=...&url=...` 查询参数（Web Share Target API）
     启动 provider 的 `appUrlOpen` 深链路由器会自动把
     `cognia://share?...` 路由到这里。

5. **离线收尾**

   `hooks/use-network-status.ts` 是 `lib/capacitor/network.subscribe` 之上
   的 React 适配器。`components/mobile/offline-banner.tsx` 通过
   `MobileShellWrapper` 固定在每个移动路由的顶部，显示两种状态：
   - **离线**（红）—— "Offline — sends will queue and retry."
   - **队列待处理**（琥珀）—— "{count} queued"，带一个旋转加载器。
     每 15 s 轮询 `getQueueSummary()`。在桌面 / web 上，以及在初始网络读取
     加载期间隐藏。

6. **i18n**

   新增子命名空间：`mobile.{workflow,twinSources,twinDraftActions,
backup,shareTarget,offline}`（en + zh-CN）。通过
   `scripts/add-wave3-i18n.mjs` 幂等注入。

第 3 波验证：

- `pnpm typecheck` → EXIT=0
- 39 个套件共 304 / 304 个 jest 测试
- 覆盖率里程碑：第 1 波 → 161 个测试，第 2 波 → +127，第 3 波 → +16

## 后果

### 正面

- 生产级配对（QR 扫描 + TLS + 指纹固定）
- 媲美成熟 IM / 生产力应用的原生 UX（触觉、分享单、应用内浏览器、生物
  识别、系统状态栏主题化）
- 所有原生操作的单一分派面 —— 功能代码中不再有散落的动态导入调用
- 连接层感知 mDNS / 隧道 / 缓存，使 LAN 变动时传输层不会盲目重试错误的
  端点
- 双向子系统解锁了真正的「把手机当远程」工作流（第 2/3 波）

### 负面 / 风险

- iOS 平台引导需在 macOS 上人工介入 —— 第 1 波提交无法包含生成的 Xcode
  工程；引导文档记录了所有必须在 macOS 上发生的事项
- Apple Developer 账号 + APNs key + Provisioning Profile 是带外要求
- Cloudflared 依赖用户安装该二进制；我们不附带它
- TLS 自签名 + 公钥固定可能让期望链式校验的企业代理感到意外；文档浮现了
  一个回退到带真实 TLS 的 Cloudflared 的方案
- 14 个新原生插件折算为 .apk / .ipa 中约 3-4 MB 的额外原生代码；对生产力
  应用可以接受

### 中性

- 桌面专属流程无公开 API 变更
- Web 包未受触碰（动态导入把原生代码挡在外面）

## 验证

第 1 波验收：

```powershell
# TS
rtk pnpm install
rtk pnpm typecheck
rtk pnpm test --coverage         # ≥90% on lib/capacitor/*, lib/connectivity/*,
                                 # lib/qr/pair-payload, lib/oauth/mobile-flow,
                                 # hooks/use-biometric-guard
rtk pnpm lint

# Rust
rtk cargo --manifest-path src-tauri/Cargo.toml test --lib companion_api::tls
rtk cargo --manifest-path src-tauri/Cargo.toml test --lib companion_api::mdns
rtk cargo --manifest-path src-tauri/Cargo.toml test --lib companion_api::tunnel
rtk cargo --manifest-path src-tauri/Cargo.toml build

# Android
rtk pnpm build
rtk pnpm --filter mobile sync
rtk pnpm --filter mobile open:android   # Build + install on emulator/device

# iOS (macOS only — see mobile/IOS_BOOTSTRAP.md)
# pnpm --filter mobile add:ios
# pnpm --filter mobile sync
# pnpm --filter mobile open:ios
```

手动冒烟（先 Android）：

1. 在桌面 设置 → Connections → 「配对新设备」生成 QR
2. 从移动端 pair 页扫描 → 2s 内完成配对，指纹已存
3. 探测 `_rpc/claude_sidecar_status` → 成功
4. 在设置中开启 Cloudflared → 隧道 URL 出现 → 重新配对 → 在移动数据网络
   上（脱离 LAN）仍可用
5. 从 Tab 4 触发 Claude OAuth → 应用内浏览器打开 → 捕获回调（手动粘贴
   路径）
6. 设置 → 我 → 应用安全 → 「启用生物识别」；重启应用 → Face ID 提示；
   跳过 → 应用保持锁定
7. 运行 `pnpm test` 并确认新目录上 ≥90% 覆盖率

## 参考

- ADR-0014 — Capacitor 移动端外壳（V1 基线）
- 计划文件 —— `~/.claude/plans/capacitorjs-spicy-cook.md`
- Issue 跟踪 —— M2.8 / M2.9 / M4.5（现已关闭）
