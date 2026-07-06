---
title: ADR-0005 — 远程控制子系统
description: 用本地 127.0.0.1 axum HTTP 监听器、HMAC 签名的出站投递以及专门的设置区，补完半成品的 webhook + 事件触发能力。
---

# 远程控制子系统

| 状态 | 已接受 · **已于 2026-06-03 激活**                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------- |
| 日期 | 2026-05-03                                                                                                            |
| 取代 | `components/scheduler/task-form.tsx` 中半成品的 webhook 通道 + 自由文本事件触发 UI（本 ADR 之前）。                     |

## 激活更新（2026-06-03）

最初实现留下三条惰性价值链路，现已全部接通，且入站面已从「仅调度器」泛化：

- **入站分发已上线。** `RemoteControlReceiver` 已挂载到 `app/layout.tsx`。新增通用的
  `POST /api/v1/commands/:target` 路由发出 `remote-control://command`；渲染端的
  `lib/remote-control/dispatch.ts` 路由表按 target 分发到各子系统已有的无头运行入口 ——
  **调度器**（`runTaskNow` / `emitSchedulerEvent`）、**目标**（`createGoal` /
  `requestManualContinue`）、**工作流**（`startWorkflowFromRemote` → `runWorkflow`）、
  **Agent 团队**（`agentTeamManager.start`）、**计划中枢**（`runPlan`）。原有的
  `/tasks/:id/run` + `/events` 路由保留。
- **Loopback 加固**（Tailscale LocalAPI 模型）：Host 头白名单 + 拒绝 Origin/Referer（DNS
  rebinding / `0.0.0.0-day`）、`Idempotency-Key` 重放缓存（5 分钟窗口）、读/写令牌能力闸门，
  以及每个响应上的 `Content-Security-Policy: default-src 'none'`。
- **出站签名已接入** [Standard Webhooks](https://www.standardwebhooks.com/) 方案
  （`{id}.{timestamp}.{body}` HMAC，`webhook-id` / `webhook-timestamp` / `webhook-signature`
  请求头），由独立的出站端点注册表（`lib/remote-control/outbound/`）驱动，任意子系统都可向其推送。
  旧的 `X-Cognia-Signature` 十六进制辅助函数已退役。
- **持久审计**：Dexie `remoteControlAudit` 表（schema v72）记录每次入站分发与出站投递；
  新增 `"remote"` `TaskExecutionTriggerSource` 标记远程运行。

接通后的细节见[远程控制子系统文档](../subsystems/remote-control)。

## 自定义更新（2026-07-03）

设置面板新增了更细粒度、端到端接线的控制项，遵循最小权限 ACL 与主流 webhook 后台的惯例：

- **按目标的权限 ACL（入站）。** `RemoteControlInboundConfig.disabledTargets` 是一个拒绝列表，
  在 Rust 服务端（`run_command` 在发出命令事件前返回 `403 target_disabled`）强制执行，并在
  `dispatchRemoteCommand` 中加一道渲染端防线作为纵深防御。入站页签把命令目标按子系统渲染为开关
  （含批量启用/禁用）。与端口/白名单/能力一样，在下次启动监听器时生效。
- **按端点的事件订阅（出站）。** `WebhookEgressEndpoint.eventTypes` 把某个出站端点过滤为指定的
  生命周期事件类型（为空即全部），由 `publishOutboundEvent` 中的 `endpointSubscribesTo` 执行。
  端点还新增了按端点的自定义请求头编辑与实时 URL 校验。
- **可调的投递限制（出站）。** `RemoteControlOutboundConfig.delivery`（`maxRetries` /
  `timeoutMs` / `baseDelayMs`，由 `normalizeWebhookDelivery` 夹取范围）取代了 `deliverWebhook`
  中原先写死的常量；对单任务 URL 与出站端点均生效。
- **入站快速上手** cURL 片段，以及概览页的流量快照（近期调用窗口内的成功/错误/成功率）。

## 背景

自 scheduler 落地以来，cognia-next 已交付两个相邻的半成品特性：

1. **出站 webhook 投递** —— `lib/scheduler/notification-integration.ts:176`
   已经会带重试/超时/抖动地向配置的 URL 发 POST，且
   `NotificationChannel = "desktop" | "toast" | "webhook" | "none"` 加上
   `TaskNotificationConfig.webhookUrl?` 已端到端类型化。但任务表单只渲染了
   `["desktop", "toast"]` 通道按钮——根本没有办法通过 UI 实际设置 webhook URL。
   也没有签名或自定义 header 的能力，因此接收方无从验证某次投递是否真的来自这个
   cognia 安装。
2. **事件触发任务** —— `lib/scheduler/event-integration.ts` 暴露了
   `emitSchedulerEvent(eventType, data, eventSource)`，且
   `lib/scheduler/task-scheduler.ts:1260` 已经**同时**按 `eventType` 与
   `eventSource` 过滤监听中的任务。但表单只是一个自由文本输入框，完全没有暴露
   `eventSource`。渲染进程之外的任何东西都无法触发一个事件。

这就留下了一个没有入站表面（外部系统无法触发任务或触发事件）、出站表面也只完成
一部分（无认证、无 URL 字段、无自定义 header）的「远程控制」能力。2026-05-03 时
面向用户的动机是：自动化套件和个人脚本想要驱动它们自己的 cognia 安装——从 CI
作业启动一个定时对话、在外部同步结束时触发 `backup:needed` 事件等等——而无需
编写插件或学习 MCP 工具链。

## 决策

### 1. 入站传输：本地 127.0.0.1 axum HTTP 服务器

新增的 Rust 模块 `src-tauri/src/remote_control/` 启动一个绑定到
`127.0.0.1:<port>`（默认 `47821`）的 axum 0.7 HTTP 服务器。三个端点：

- `GET  /api/v1/health` —— `{ ok: true, version }`。需要认证，以避免向未认证的
  探测者泄露版本信息。
- `POST /api/v1/tasks/:id/run` —— 触发 `remote-control://run-task` Tauri 事件；
  渲染进程中的 `RemoteControlReceiver` provider 将其分派给
  `useSchedulerStore.getState().runTaskNow(taskId)`。返回 `202`。
- `POST /api/v1/events` —— 触发 `remote-control://emit-event`；接收方转发给
  `emitSchedulerEvent`。返回 `202`。

我们选择 127.0.0.1 而非 `0.0.0.0`，因为本次迭代不涉及 LAN 暴露——未来的 ADR 可以
增加一个 Cloudflare Tunnel sidecar，而完全不改动 axum 应用。

中间件栈（由外到内）：体积上限（8 KiB）→
bearer 认证（经 `subtle::ConstantTimeEq` 做常量时间比较）→
IPv4 CIDR allowlist → 固定窗口限流（默认 60 req/min）。令牌错误 → 401，
不在 allowlist → 403，体积超限 → 413，超过限流 → 429。优雅关闭依托
`tokio::sync::watch` 通道。

监听器是**选择加入**的。Inbound 标签页的启用 Switch 在用户显式点击「Generate
token」之前一直禁用，而 `lib.rs:setup` 中的自动启动路径仅当 `inbound.enabled`
持久化为真**且**操作系统钥匙串中仍有令牌时才运行监听器。缺失令牌会干净地返回
`TokenMissing`，于是渲染进程提示用户重新生成。

### 2. 出站 HMAC 签名 + 自定义 header

`sendWebhookNotification` 增加了一个可选 `opts` 参数
`{ signingSecret?, headers? }`。当设置了 `signingSecret` 时，对体做 HMAC-SHA256
签名，并在同一次投递的每次重试上带上 `X-Cognia-Signature: sha256=<hex>` header。
签名辅助函数位于 `lib/scheduler/webhook-signature.ts`（Web Crypto，约 30 行），
以便生产发送路径和测试使用同一向量。

`opts.headers` 在规范的 `Content-Type: application/json` **之前**合并——调用方提供的
`Content-Type` 会被故意丢弃，从而让接收方始终看到 JSON。两个 opts 都通过
`lib/scheduler/webhook-outbound-config.ts` 中的 `getWebhookOutboundConfig()` 一次性
计算，它从 Zustand 的 `useRemoteControlStore` 读取 header，并（仅在桌面上）从操作
系统钥匙串读取签名密钥。该密钥永不进入 Zustand 或 Dexie。

### 3. 密钥存放于操作系统钥匙串（`com.cognia.remote-control`）

入站 bearer 令牌和出站签名密钥都通过 TTS 子系统已在使用的同一个 `keyring = "3"`
crate 存放（`src-tauri/src/tts/keyring.rs`）。服务 `"com.cognia.remote-control"`，
账户 `"inbound-token"` 与 `"outbound-signing-secret"`。渲染进程按需通过
`remoteControlGetToken` / `remoteControlGetSigningSecret` Tauri 命令获取它们；
两个值都不属于任何持久化的 Zustand 状态。

### 4. 新增 `remote-control` 设置区

`components/settings/remote-control/remote-control-section.tsx` 1:1 镜像
`data/data-section.tsx` —— `useSyncExternalStore` + `?remoteControlTab=`
URL 水合，四个标签页（`Overview` / `Inbound` / `Outbound` / `Events`）。
Inbound 标签页被 `isTauri()` 闸住；另外三个在两种运行时中都渲染。该区位于
`system` 设置分组中，介于 `Scheduled Tasks` 与 `Desktop` 之间。

### 5. 就地扩展 `domain-list-input` 以支持 IP allowlist

我们没有从搜索侧的 `domain-list-input.tsx` 分叉，而是增加两个可选 prop——
`validate?: (raw: string) => string | null` 与
`errorRender?: (key: string) => ReactNode`。既有调用方（搜索的允许/屏蔽列表）
保留其原始行为，因为默认校验器返回 `null`。远程控制的 allowlist 传入
`validateCidrOrIp`（定义于 `types/remote-control/index.ts`）和一个翻译所返回 i18n
键的 `errorRender`。

### 6. 为 `TaskExecutionTriggerSource` 增加 `"remote"`

运行时 `runTaskNow` 路径会用其发起来源标记执行。远程触发的运行理应有自己的变体，
这样执行历史可以显示「remote」徽章，而不是误分类为「run-now」。

## 威胁模型

单一 bearer 令牌 + 127.0.0.1 绑定足以抵御：

- 同主机上**不**具备读取操作系统钥匙串权限的同驻用户态进程（防御：bearer 认证）
- 非环回的网络攻击者（防御：127.0.0.1 绑定 + 默认为 `127.0.0.1/32` 的
  IPv4 CIDR allowlist）
- 把窃取到的体重放到 webhook 接收方（防御：出站投递的 HMAC 签名、入站认证上的
  `subtle::ConstantTimeEq`）

它**不足以**抵御：

- 能读取操作系统钥匙串的同驻攻击者（无防御——同样的威胁适用于任何 cognia API key）
- 运行在 cognia webview 中的恶意浏览器扩展（适用 Tauri 的默认 CSP）
- 出站 webhook 投递上的中间人（防御：接收方应当 pin TLS + 验证签名）

## 复用映射

| 关注点                  | 复用来源                                                  | 为何没有分叉                                                                  |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Webhook 重试/超时       | `lib/scheduler/notification-integration.ts:176`            | 既有的 3 次重试指数退避循环是正确的；我们就地扩展 opts。                       |
| Webhook 测试设施        | `lib/scheduler/notification-integration.ts:231`            | `testNotificationChannel("webhook", url)` 已支持显式 URL。                    |
| 标签式设置外壳          | `components/settings/data/data-section.tsx`                | `useSyncExternalStore` + `?…Tab=` URL 水合是规范模式。                        |
| 设置原语                | `components/settings/common/settings-section.tsx`          | `SettingsCard`/`Toggle`/`Row` 覆盖一切布局需求。                              |
| 列表输入                | `components/settings/search/_shared/domain-list-input.tsx` | 增加一个 `validate?` prop 即可避免再造一个平行控件。                          |
| Tauri 命令绑定          | `lib/tauri/canvas.ts`                                      | 每个命令一个 `invoke` 调用点 + `isTauri()` 护栏。                            |
| 操作系统钥匙串          | `src-tauri/src/tts/keyring.rs`                             | 同一个 `keyring = "3"` crate，同样的 `NoEntry → None` 映射。                 |
| 长生命周期服务          | `src-tauri/src/scheduler/service.rs`                       | 由 Tauri 管理、持有 `tokio::sync::Mutex<Option<JoinHandle>>` 的状态。        |
| 前端 Tauri 监听器       | `components/providers/a2ui-dispatch-provider.tsx`          | 顶层 provider，在整个应用生命周期内持有 Tauri 监听器。                        |
| 偏好持久化              | `lib/tauri/store.ts` + Zustand `persist` 中间件            | 同样的混合方案（web 上用 localStorage，桌面上用 tauri-plugin-store）。       |

## 未来工作

- **Cloudflare Tunnel sidecar** —— 让用户无需端口转发即可把入站监听器暴露到公网。
  axum 应用原地不动；只新增一个 sidecar 进程。
- **MCP 工具集** —— 把同样的路由包进一个 MCP 服务器，让外部 Claude Desktop /
  Cursor 会话能够通过它们自己的协议驱动监听器。
- **按任务覆盖签名密钥** —— 目前是单个全局密钥对每次出站 webhook 签名。
- **带 scope 的多个 bearer 令牌** —— 今天只有单个令牌；按令牌限流已就位，但每个
  令牌拥有相同的权限。
- **WebSocket / SSE 推送** —— 今天只支持请求/响应。
