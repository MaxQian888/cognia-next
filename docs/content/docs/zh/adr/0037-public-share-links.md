---
title: ADR 0037 — 公开分享链接（零知识）
description: 通过自部署的 Cloudflare worker（R2 + KV）把对话导出、工作流图片、A2UI 应用与备份包变成公开短链。内容在客户端端到端加密，密钥放在 URL #fragment，永不到达服务器。
---

# ADR 0037 — 公开分享链接（零知识）

> **状态**：2026-05-26 接受。Phase 0–3 已交付：加密内核 + Dexie 镜像、Cloudflare
> worker（`share-server/worker/`）、独立 viewer SPA，以及四类产物的创建侧 UI。
>
> **Phase 4（2026-05-29）** 取代了独立 Vite viewer：应用自身的 `/share/view`
> 路由成为所有类型的唯一查看端，A2UI 应用实现浏览器内真渲染（只读），worker
> 退化为纯 `/v1` API。见
> [Phase 4 增补](#phase-4--统一查看端--a2ui-真渲染2026-05-29)。

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
- **Worker**（`share-server/worker/`）——独立 TS 项目（自带 `package.json` +
  lockfile，`--ignore-workspace` 安装，类似 `sidecar/`）。R2 存信封体，KV 存生命
  周期计数并以 TTL 兜底、懒回收孤儿对象。用 `@cloudflare/vitest-pool-workers`
  （miniflare）测试。
- **Viewer**（`share-server/viewer/`）——作为 worker 静态资源托管的 Vite React
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

独立 Vite viewer（`share-server/viewer/`）**已移除**。它无法渲染 A2UI 应用，因为
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
  Cloudflare Pages 项目（托管 `out/`）。部署指南见 `share-server/pages/README.md`。

**新后果：** 由于 `out/` 是整体导出，部署到 Pages 会把整个（无密钥的）应用壳公开
在分享 host 上。可接受——导出中不含任何凭据——但只想暴露查看端的运营者可加一条
Pages `_redirects` 规则，把非 `/share/view` 路径指向 `/share/view`。
