---
title: "0135 — 诊断服务接线完成"
description: "把自建诊断服务接进产品：分诊控制台、桌面与移动端的知情同意提交，以及与 CLI 共享的同一套上传状态机。"
---

# ADR 0135 — 诊断服务接线完成

**状态：** 已接受
**日期：** 2026-08-20

## 背景

ADR-0102 规定了一个自建诊断服务，`services/diagnostic-server` 实现了其中的大部分：
租户范围的 grant、可续传上传、服务端脱敏、符号化、指纹分组、保留策略、告警、
带 crypto-shredding 的信封加密，以及不可变审计记录。它带着 44 个测试、一份 Helm
chart 和一套 compose 栈上线。

但这些几乎都无法触达。

- 唯一的客户端是 `cognia crash submit`，而它要求一个 CLI 根本无从获取的 `--grant`。
- `incident_groups` 由分组流水线写入却从未被读回，因此 `status` 永远停在 `open`，
  `assigned_to` 永远是 NULL。
- `tenants.raw_minidump_access_enabled` 与 `audit_events.actor_id` 没有任何代码路径
  读或写。
- `GrantRole::Viewer` 与 `Triager` 排了序，却没有任何路由要求它们。
- ADR 承诺的「OIDC 保护的服务控制台」根本不存在。
- `/logs` 的 Incidents 频道里，两个同意勾选是没人读取的本地 state，描述框是非受控且
  从不被读取的，而且**没有提交按钮**——旁边的文案却写着「在你审阅脱敏报告并显式提交
  之前，不会上传任何内容」。
- 桌面事件的状态被硬编码为 `detected`，而同一个频道提供了永远无法命中的生命周期筛选
  （`queued`/`uploading`/`accepted`）。`recordMobileCrashReceipt` 存在但生产代码零调用。

即使在管道打通的地方，也有两个缺陷让数据不可用。CLI 把整个 `.cognia-diagnostic`
压缩包当作单个 `attachment` 分片上传；服务按 `x-artifact-kind` 分派处理，因此压缩包
产不出任何栈帧，每一次提交都只能按 module 与 exception 分组。另外，事件创建按 artifact
hash 幂等，而 `DO UPDATE` 不会更新 `deletion_credential_hash`，于是重试会拿到一个
新签发、却永远无法与已存哈希校验通过的删除凭证。

## 决策

**控制台落在应用内，而不是服务端。** 它是 `/logs` 的第四个频道，沿用 `/servers`
的做法（ADR-0059）：设计系统、i18n 接线与规避 CSP 的传输在应用里都已具备，而运维者
本身就是 Cognia 用户。做成频道而非 Incidents 的筛选，是因为二者回答的问题不同——
Incidents 是**本机**捕获到的崩溃，Service 是服务从所有人那里接收到的崩溃。

**按角色塑形，而不是按报错塑形。** Viewer 读分组与详情；Triager 额外获得状态、指派与
原始产物读取；Admin 获得租户策略。运维者用不了的东西不会被渲染出来。低于 Viewer 的
凭据会被明确告知，因为空的分组列表读起来像「没有崩溃」，而那是另一回事。

**Grant 交换不属于 intake。** `DIAGNOSTIC_INGEST_ENABLED=false` 连 grant 路由也返回
503，而 grant 只有 15 分钟寿命——于是开关翻转一刻钟之后，文档声称「保持可用」的每一条
路由都变得无法触达，而那恰恰是删除请求必须可被服务的时刻。在 intake 关闭时签发的
grant 依然无法上传，因为真正接收数据的路由本身就是关闭的。

**一套上传状态机，两种传输。** 时序、载荷形状、续传规则与安装证明都放在
`cognia_observability::diagnostic_submit`，由桌面壳与 CLI 共享。传输是**阻塞式**
trait，因为两个调用方确实无法共用同一种——CLI 有意不把 tokio 编进二进制，而桌面端
本来就带着异步 reqwest——但线之上的一切都不重复。

**桌面端保持原生打包。** 包体可达 1 GB，WebView 读不到崩溃目录，而且桌面 CSP 无论如何
都会拦截渲染端对用户自配主机的请求。移动端没有原生打包器，改为把插件的脱敏报告作为
`events` 分片上传。

**每次提交都是一个包内条目一个分片**，并声明服务用于分派的 artifact kind，这样
minidump 才会被符号化、事件流才会被扫描出分组所需的栈帧。

**面向终端用户的路径是安装身份，而不是粘贴令牌。** 同一把 Ed25519 密钥既签名包体也
签名安装证明。在移动端这需要 WebCrypto 的 Ed25519，而 Capacitor 的 WebView 直到近期
才具备，因此该能力是**实际生成密钥探测**出来的，而不是假定的——一个会说谎的能力位
最终表现为「服务拒绝了你的崩溃报告」。

**身份会话只存在系统钥匙串**，连接的其余部分存在按账户的本地状态里，与 `/servers`
的拆分一致，从而保证数据库导出永远不会带走运维者的会话。

## 影响

- `POST /v1/incidents` 现在返回 `created`，并且只有在真正创建了行时才返回
  `deletionCredential`。无条件读取该字段的旧客户端在续传提交时会拿到 `undefined`，
  这是诚实的答案。
- kill switch 的 compose E2E 断言换了形状：现在检查 `POST /v1/incidents` 为 503，
  **并且** grant 交换与分诊路由不是。
- 迁移 `0006_triage_console.sql` 只做扩展：为此前无人执行、因而没有索引的四类查询
  补上索引。
- Viewer 及以上的凭据可以读取本租户的任意事件；Uploader 仍被限制在自己的安装范围内，
  这正是防止一个用户的应用在共享租户上枚举他人崩溃的机制。
- `lib/network/platform-fetch.ts` 现在由 `server-ops` 与 `diagnostic-service` 共享；
  这次抽取还顺带修掉了 ops 客户端从未触发过的潜在缺陷：二进制请求体会被 Capacitor
  桥接层字符串化。
- 支持报告的通道注册表现在会通知订阅者，因此从 effect 中注册的通道——以及将来由插件
  注册的通道——无需重新挂载即可出现。

## 备选方案

**由服务自己提供控制台。** 否决：它需要自带一套设计系统、自带 i18n、并在本仓库所有
门禁之外手写原生 JS，只为服务一群本来就装着应用的人。

**在服务端实现完整的 OIDC 授权码流程。** 暂时否决。服务按配置的 issuer/audience 校验
RS256 会话，并把令牌获取委托给运维方的 IdP——这正是它原本的契约。做一个 OIDC
**客户端**（discovery、JWKS 轮换、回调端点、会话 cookie）本身就是一个子系统，而本仓库
其他地方都不需要。

**异步传输 trait。** 否决：那会把异步运行时强行塞进有意不带运行时的 CLI。
