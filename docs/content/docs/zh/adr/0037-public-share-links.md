---
title: ADR 0037 — 公开分享链接（零知识）
description: 通过自部署的 Cloudflare worker（R2 + KV）把对话导出、工作流图片、A2UI 应用与备份包变成公开短链。内容在客户端端到端加密，密钥放在 URL #fragment，永不到达服务器。
---

# ADR 0037 — 公开分享链接（零知识）

> **状态**：2026-05-26 接受。Phase 0–3 已交付：加密内核 + Dexie 镜像、Cloudflare
> worker（`services/share-server/worker/`）、独立 viewer SPA，以及四类产物的创建侧 UI。
>
> **Phase 4（2026-05-29）** 取代了独立 Vite viewer：应用自身的 `/share/view`
> 路由成为所有类型的唯一查看端，A2UI 应用实现浏览器内真渲染（只读），worker
> 退化为纯 `/v1` API。见
> [Phase 4 增补](#phase-4--统一查看端--a2ui-真渲染2026-05-29)。
>
> **匿名访客（2026-09-25）**：阅读分享不需要本地账户。没有已解锁账户时，各道门禁以访客外壳渲染
> `/share/view`，而不是首次运行表单。见[增补](#匿名访客2026-09-25)。

## 背景

Cognia 原有约 16 个「分享 / 导出」入口，但几乎都只产出本地文件、需手动转交。
唯一的链接机制——A2UI 的 `/share/app?code=`——把整个应用 base64 塞进 URL，大应用
会失效，且收件人必须已运行 Cognia。**没有任何方式生成一个任意人都能用浏览器
打开查看的 URL。**

仓库已为 WebRTC signaling 自部署了一个 Cloudflare worker（workers-rs + Durable
Objects，ADR-0021），具备 `wrangler deploy`、自定义域名，以及**单租户「自部署
worker」**模型。新增对象存储（R2）+ 键值元数据（KV）+ HTTP worker 是对运营者
已在运行的基础设施的自然延伸。

## 决策

新增**「生成分享链接」**能力：把产物发布到由**全新独立 TypeScript Cloudflare
worker** 托管的公开短链。内容**零知识端到端加密**：随机 256-bit 密钥在浏览器内
生成、放进 URL `#fragment`、**永不上传**；worker 只存不透明密文，**解密发生在
viewer 页面的客户端**（`#fragment` 不会传给任何服务器）。读取通过短码公开；
**创建与撤销需要只有运营者持有的 bearer 密钥**——与 signaling 服务器的单租户姿态
一致。

创建侧支持四类产物：对话导出（HTML / 动画 / Markdown / JSON / 文本）、工作流图片
（PNG）、A2UI 应用、备份包。

## 架构

```
应用（Tauri / Capacitor / 浏览器）           share.<域名>（TS worker）
  createShareLink()                           POST   /v1/share        （bearer；密文 → R2，元数据 → KV）
   ├─ 渲染产物 → SharePayload                  GET    /v1/share/:code  （公开；TTL / 次数 / 阅后即焚）
   ├─ encryptSharePayload(payload, 随机密钥)   GET    /v1/share/:code/stats（bearer）
   ├─ PUT 信封 → worker → R2                   DELETE /v1/share/:code  （bearer；撤销）
   └─ url = https://…/v/<code>#k=<密钥>        /*  →  viewer SPA（静态资源）

收件人浏览器 → viewer → 取信封 → 用 #fragment 密钥解密 → 按 kind 渲染
```

- **加密**（`lib/share/`）——`encryptSharePayload` / `decryptShareEnvelope` 用
  AES-GCM；基础情形用裸随机密钥，设了额外口令时密钥由 `rawKey ‖ 口令` 经 PBKDF2
  派生（URL 密钥与口令单独都解不开）。`kind` 与 `mime` 在密文**内部**，服务器对
  内容类型无感。该模块是干净叶子（自带 `lib/share/hash.ts` 的 sha256，不依赖
  `lib/data/crypto`），以便独立 viewer 引入时不拖入应用全局类型。
- **Worker**（`services/share-server/worker/`）——独立 TS 项目（自带 `package.json` +
  lockfile，`--ignore-workspace` 安装，类似 `sidecar/`）。R2 存信封体，KV 存生命
  周期计数并以 TTL 兜底、懒回收孤儿对象。用 `@cloudflare/vitest-pool-workers`
  （miniflare）测试。
- **Viewer**（`services/share-server/viewer/`）——作为 worker 静态资源托管的 Vite React
  SPA，经 `@` → 仓库根别名引入真实 `lib/share/crypto`，按 kind 渲染：对话
  HTML/动画用**沙箱 iframe**，Markdown/JSON/文本用预格式文本，工作流 PNG 用
  `<img>`，备份 / A2UI 用下载卡。
- **应用胶水**——一个可复用 `<ShareLinkDialog>`（生命周期控制 + 链接 + 二维码 +
  复制 + 撤销）、一个 `<MySharesPanel>`（对 Dexie `sharedLinks` 镜像用响应式
  `useLiveQuery`，schema v54），一个 `<ShareSettingsCard>`（worker 地址 →
  AppSettings，上传密钥 → 操作系统钥匙串）。接入对话导出对话框、工作流编辑器溢出
  菜单、A2UI 工作区工具栏、备份导出卡。

## 生命周期控制

每条链接：**有效期**（TTL，由 worker + KV TTL 强制）、**查看次数上限 / 阅后即焚**
（达 N 次后自毁）、**手动撤销**，以及可选**额外口令**。由于零知识，服务器端没有
搜索或预览。

## 后果

- worker **被设计为不可信**；丢链接即丢内容。
- **A2UI 真渲染暂缓。** A2UI 目录静态导入 64 个组件，外加 `next/image`、
  `next/link`、recharts/three/d3/tone/framer-motion 及全套 Radix——独立 Vite
  viewer 无法干净引入。故 A2UI 分享呈现为「下载后导入 Cognia」卡片。若日后要真渲染，
  正确架构是把**应用自身的静态导出 `/share/view` 路由部署到 Cloudflare Pages**
  （它本就带渲染器、Tailwind 与 Next 运行时），而非独立 viewer。
- 配置与 signaling 一致：`NEXT_PUBLIC_SHARE_URL` 构建默认值、`AppSettings.shareUrl`
  按安装覆盖、上传密钥存钥匙串。
- 不在范围：实时协作分享（Durable Objects）、可浏览注册表 / 市场、服务器端搜索。

运营者部署指南见 `companion/share-links-setup`。

## Phase 4 — 统一查看端 + A2UI 真渲染（2026-05-29）

独立 Vite viewer（`services/share-server/viewer/`）**已移除**。它无法渲染 A2UI 应用，因为
A2UI catalog 静态 import 了 61 个组件外加 `next/image`、recharts/three/d3/tone/
framer-motion 与整个 Radix/HeroUI——所以 A2UI 分享当时只能下载。「后果」里暂缓的
真渲染，正是用它当初预言的架构来落地的。

**变化：**

- **唯一查看端，落在应用内。** 应用自身的 `app/share/view/page.tsx`（`"use client"`）
  是所有类型的唯一查看端。它随普通静态导出（`out/`）一起产出，因此既能在公网
  **Cloudflare Pages** 上渲染，也能在 **Tauri 桌面壳**内渲染——owner 可在 app 内打开
  自己的分享。按类型渲染在 `components/share/payload-view.tsx`（chat HTML/动画的沙箱
  iframe 等级原样保留）；加载/解密编排在 `lib/share/load.ts`。
- **A2UI 真渲染，只读。** `PayloadView` 把解密后的导出 JSON 通过 `createA2UISurface`
  （与 `importApp` 同一路径）载入 A2UI store，再挂载真实的 `<A2UISurface readOnly>`。
  `A2UIProvider`/`A2UISurface` 新增的 `readOnly` 让 `emitAction` / `setDataValue`
  失效，公开查看端无法被驱动去修改或跳转。
- **统一 URL。** 链接现在对**所有**类型铸造 `${base}/share/view?c=<code>#k=<key>`
  （原为 `/v/<code>#k=`）。`code` 是公开查找 id（query 参数）；密钥仍只在
  `#fragment`。查看端必须经正常导航或直接打开抵达——绝不能用 HTTP 重定向，否则
  fragment 会丢失。
- **worker 退为纯 API。** 不再托管静态资源；非 `/v1` 路径返回 404。`wrangler.toml`
  去掉 `[assets]`，把 worker 路由限定在 `share.cognia.cn/v1/*`，host 其余部分交给
  Cloudflare Pages 项目（托管 `out/`）。部署指南见 `services/share-server/pages/README.md`。

**新后果：** 由于 `out/` 是整体导出，部署到 Pages 会把整个（无密钥的）应用壳公开
在分享 host 上。可接受——导出中不含任何凭据——但只想暴露查看端的运营者可加一条
Pages `_redirects` 规则，把非 `/share/view` 路径指向 `/share/view`。

## 第 5 阶段——自托管 Rust 服务（脱离 Cloudflare 的选项）

Worker 把分享 API 绑死在 Cloudflare R2 + KV 上。已经在跑信令服务器自托管 Rust 二进制
（ADR-0021）、或者干脆不想用 Cloudflare 的运营者，现在对分享也有了对等选项：位于
`services/share-server/` 的独立 axum 服务，提供**完全相同的 `/v1` 契约**。

**是什么：** `services/share-server/` 现在是一个 Cargo workspace（`Cargo.toml`、`src/`、
`core/`、`tests/`、`Dockerfile`、`fly.toml`），与既有的 TypeScript `worker/` 和
`pages/` 并列。它是 `services/signaling-server/` 的分享服务孪生体：单个静态二进制、相同的
`docker` / `fly` 部署方式、相同的安全与可观测姿态。无需改动应用——运营者只要把
`AppSettings.shareUrl`（以及 keyring 里的上传密钥）指向它即可，与指向托管 Worker
完全一样。

**存储。** 与信令（无状态、内存态）不同，分享需要持久化，因此服务保存一个单文件
**SQLite** 数据库（WAL）：不透明信封与其生命周期元数据存在**同一行**。读取在单个
`BEGIN IMMEDIATE` 事务内完成——既自增浏览计数，又在用尽/过期时删除该行——从而消除
Worker 拆分 R2（信封体）+ KV（元数据）设计中的跨存储原子性缺口（它依赖懒回收孤儿，
无法严格串行化并发的 max-views 读取）。后台 reaper 加读取时懒删除替代 KV 的 TTL
自动过期。

**安全对等 + 增强。** Bearer 鉴权采用长度无关的常数时间比较（未设密钥则拒绝一切写入）；
请求体大小上限（`413`）；所有被门控的读取一律返回 `404`，不泄露存在性。相对依赖
Cloudflare 边缘的 Worker，新增了**每 IP 令牌桶限流**（`429`）以遏制 code 枚举，以及
可选的 `Origin` 白名单。客户端 IP 取自 `Fly-Client-IP` / `X-Forwarded-For` 的首跳。
TLS 与信令一样由平台终结。

**共享逻辑。** `services/share-server/core/` crate 收纳无副作用的部分——信封校验、读取生命周期
决策、code 生成、常数时间比较、限流令牌桶——独立单测，与 `services/signaling-server/core/`
一致。（此拆分仅为结构对齐：分享 Worker 是 TypeScript，因此共享的是 HTTP 契约而非代码。）

**可观测性。** `GET /healthz`（JSON）与 `GET /metrics`（Prometheus：
`share_created_total`、`share_read_total`、`share_deleted_total`、
`share_rejected_total{reason=…}`、`share_active`、`share_uptime_seconds`）。

配置由环境变量驱动（`SHARE_DB_PATH`、`SHARE_UPLOAD_SECRET`、`SHARE_MAX_BODY_BYTES`、
`SHARE_ALLOWED_ORIGINS`、`SHARE_RATE_PER_SEC` / `SHARE_RATE_BURST`、
`SHARE_REAPER_INTERVAL_SECS`、`PORT` / `BIND_ADDR`）。构建/运行/部署指南见
`services/share-server/README.md`。

## 匿名访客（2026-09-25）

**问题。** Phase 4 把查看端放进了应用的静态导出，让同一个 `/share/view` 路由同时服务
应用内的所有者和分享主机上的匿名访客。后者在正式构建中从未生效。该路由位于
`app/layout.tsx` 的完整鉴权运行时之下，所以 `AccountGate` 给全新浏览器展示的是
"创建本地账户"表单，而不是分享内容。创建账户后又交给 `OnboardingGate`，它把路由替换为
`/onboarding`，`?c=…#k=…` 随之丢失。已在生产导出（`NODE_ENV=production`，未设置
`NEXT_PUBLIC_E2E`）上用全新浏览器上下文复现：链接没有发出任何 envelope 请求，页面显示
首次运行表单；创建账户后页面停在 `/onboarding`，链接已丢失，访客浏览器里多出九个
IndexedDB 数据库。有两件事掩盖了它：E2E 用例的 `prepareViewer` 会先写入一个账户，
而开发服务器会给每个全新配置自动开一个一次性账户。

**权衡过的方案。**

1. _把 `/share/view` 加入 `LIGHTWEIGHT_ROUTE_PREFIXES`。_ 否决。该列表按路由判定，
   静态 HTML 与水合因此一致，但它是全有或全无：所有者的应用内副本会失去导入操作
   （`template-definition`、`chat-template`）所需的账户，也会失去应用外壳。
2. _按来源（origin）判定轻量分支_（从分享主机提供即走轻量）。否决，理由有三：静态 HTML
   无从知道来源，终归要在水合之后再切换；分享来源本身是账户级配置
   （`AppSettings.shareUrl`），账户解锁前读不到；该分支也无法在 `localhost` 上验证。
3. _在门禁处放行，依据已落定的账户状态。_ 采纳。

**决策。** 阅读分享不需要本地账户。

- `isShareViewerRoute(pathname)`（`lib/share/viewer-context.ts`）按静态主机可能提供的
  每种写法识别该路由（`/share/view`、`/share/view/`、`/share/view.html`），只匹配这一个
  路由，不含其下级或相邻路径。
- `AccountGate` 新增 `guestView`，根布局把它填为套在 `ShareGuestShell` 中的页面。在分享
  路由上、账户注册表落定之后（`loaded && !loading`），门禁渲染：

  | 账户状态                         | 渲染                                                   |
  | -------------------------------- | ------------------------------------------------------ |
  | 有已解锁账户                     | 完整运行时，保持不变：应用外壳、库、导入               |
  | 此来源上没有任何账户             | 直接渲染访客视图，不再显示首次运行表单                 |
  | 有账户但均未解锁                 | 照旧显示解锁界面，并附"不解锁，直接阅读"，点击后切到访客视图 |
  | 原生移动端、一次性恢复密钥、宠物浮窗 | 保持不变，且优先判定                               |

  静态 HTML 与客户端首次渲染都是启动界面（两者时账户存储都尚未加载），因此一致。
  之后门禁才在应用与访客视图之间做选择。

- **为什么等待 `loaded`，为什么有账户时先解锁。** 每次读取分享都会计一次查看
  （`maxViews`、阅后即焚）。选择必须在页面挂载之前定下。若门禁事后切换外壳，页面会重新
  挂载并再次拉取 envelope。`loaded` 置位时，所有自动解锁（桌面工作区、记住的档案、标签页
  会话恢复）都已跑完，所以所有者不会先看到访客视图。出于同一原因，已锁定的所有者会在页面
  挂载 _之前_ 被请求解锁；反过来在访客视图里放一个解锁按钮，那时已经花掉了一次读取。
- `CloudSignInGate` 与 `OnboardingGate` 放行该路由，与它们放行 `/lark/workbench` 的方式
  相同。网页登录要经身份提供方往返一次，首次运行重定向会离开页面，两者都会丢掉 `#k=`
  密钥。从查看端进入应用时，这两道门禁依旧生效。
- `ShareGuestShell` 只包含查看端实际读取的 provider。next-intl 与主题来自门禁上方；外壳
  只加 `TooltipProvider` 与 `Toaster`，其余一概不含：没有 `SettingsHydrator`、没有插件
  运行时、没有 Dexie。在它之下，查看端从 `defaultShareBaseUrl()`（构建期
  `NEXT_PUBLIC_SHARE_URL`）读取，而不是 `resolveShareEndpoint()`；它不提供导入，也不调用
  `resolveShareViewerRunsInApp()`。这一点很重要：未选中账户时 `getDb()` 会回落到旧版
  数据库，读取设置行或钥匙串会在陌生人的浏览器里创建应用数据库。

**后果。**

- 公开部署构建时必须让 `NEXT_PUBLIC_SHARE_URL` 指向自身主机（Pages README 已有说明）。
  访客没有 `shareUrl` 设置可以覆盖它。
- 访客看到的是默认语言：设置从不加载，`LocaleGate` 回落到默认值。在公开主机上按浏览器
  语言协商，是待办的后续工作。
- 在 `/share/view` 上，访客视图会取代门禁在无账户时显示的所有界面，包括桌面端"工作区无法启动"的错误（该错误会让注册表为空）。这个错误在其他所有路由上照常显示，而阅读分享本就不需要工作区。
- 锁定（空闲自动锁定）会像以往一样卸载页面。之后无论解锁还是以访客身份再次阅读，都会重新拉取 envelope，因而再计一次查看。这是读者自己的选择，而不是门禁自行切换外壳。
- 页眉与页脚指向 `/` 的链接仍会启动完整应用，访客在那里创建账户（"用 Cognia 创建你自己的"）。
- 测试：`tests/e2e/share/public-share-view.spec.ts` 新增"匿名访客"一组。它不写入任何
  数据，把链接作为浏览器的第一次导航打开，断言负载可见、URL 未被改动、只有一次 envelope
  读取、没有账户数据库或旧版数据库，以及 `chat-template` 不提供导入。仅针对访客的断言
  在静态导出上运行（CI 即如此），因为开发服务器会给每个全新配置自动开一个账户。单元测试
  固定了每道门禁的放行与页面的访客模式。
