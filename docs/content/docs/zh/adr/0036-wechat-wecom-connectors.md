---
title: 0036 — 微信 / 企业微信 连接器
description: 以原生平台连接器形式接入企业微信（WeCom）智能机器人长连接（流式回复、主动推送、模板卡片交互）与个人微信（iLink 网关：扫码登录、仅回复的 HTTP 长轮询、AES-128-ECB 媒体）；复用通用 WS 桥，并新增加性的 onPartial / streamReply 契约。
---

## 状态

已接受（2026-05-26）。2026-08-12 已对照 adapter registry、企业微信与个人微信 adapters、共享 capability map 及其 contract tests 再次确认实现。

## 背景

平台连接器子系统（ADR-0009 / 0025）已交付 Telegram / Discord / Slack / Lark /
OneBot——全部为「原生 TS 适配器 + Rust 传输桥」，统一接入同一条
`ConnectorBus` → outbound-runner → A2UI ⇄ IM 桥 → 审计 / 健康检查管线。预留但未实现
的两个平台类型为 `wecom` 和 `wechat-oa`。

本 ADR 实现**企业微信（WeCom）**——官方支持、无需公网的路径——作为第一期，并以
iLink 半官方网关（扫码登录 + Bearer token + HTTP 长轮询）实现**个人微信（个人版微信）**
作为第二期。

## 决策

### 传输——智能机器人长连接，复用通用 WS 桥

企业微信智能机器人长连接（`wss://openws.work.weixin.qq.com`，文档 `path/101463`）
是**纯 JSON 文本帧**——无 protobuf、无消息级加解密、无 IP 白名单。鉴权仅需一条
`aibot_subscribe { bot_id, secret }` 帧。这比 Lark 的二进制 protobuf 长连接简单得多，
因此 WeCom 适配器**复用通用 `connectors_ws_*` 桥**（`connectorsWsOpen` → Rust 持有
套接字，与 OneBot forward-WS 同款），而非像 `lark_ws.rs` 那样写专用 Rust handler。
**无新增 Rust 代码。** 媒体解密（AES-256-CBC，IV = 每条消息 `aeskey` 的前 16 字节）
在渲染层用 Web Crypto 完成。

适配器位于 `lib/connectors/adapters/wecom/`：

| 文件 | 职责 |
| --- | --- |
| `protocol.ts` | 帧类型 + 纯构造器（`aibot_subscribe` / `_msg_callback` / `_event_callback` / `_respond_msg` / `_respond_welcome_msg` / `_respond_update_msg` / `aibot_send_msg` / `ping` / 媒体上传）+ `classifyInboundFrame`。 |
| `parse.ts` | `aibot_msg_callback` → `NormalizedInboundEvent`（text/markdown/image/voice/file/video/mixed；单聊 + 群聊；群聊 ⇒ `selfMentioned`）。持有 `WeComConversationRef`（chatId / chatType / userId / **reqId** / sourceMsgId）。 |
| `serialize.ts` | 把出站 segment 拆为 markdown 正文 + 交互式 A2UI surface + 媒体（纯函数）。 |
| `a2ui-mapper.ts` | A2UI surface → `template_card`（button_interaction），记录回调绑定；`template_card_event` → `ConnectorCallbackEvent`。 |
| `media.ts` | AES-256-CBC 解密 + 三段式 `aibot_upload_media_*` 上传。 |
| `welcome.ts` | 运营者配置的 `enter_chat` 欢迎语（不硬编码字符串）。 |
| `index.ts` | 工厂：WS 生命周期、30 秒 `ping`、退避重连、req_id↔ack RPC、回复 / 主动分流、流式。 |

### 流式回复——加性的 `onPartial` / `streamReply`

智能机器人通过反复更新同一条消息来流式回复：
`aibot_respond_msg { msgtype: "stream", stream: { id, content, finish } }`。为驱动它，
新增两处**加性、向后兼容**的接缝：

- `RunAndCaptureOptions.onPartial?(accumulatedText)`（`lib/claude/run-and-capture.ts`）
  ——助手文本增长时触发。默认 `undefined` ⇒ 对聊天及其他连接器零行为变化。经
  `safe-send-prompt.ts` 透传。
- `PlatformAdapter.streamReply?(req)`（`types/connectors/adapter.ts`）——可选；仅
  WeCom 实现。

`lib/connectors/runtime.ts` 负责编织：当目标适配器实现 `streamReply` 时，向
`runAndCapture` 传入 `onPartial`，经 `bus.getAdapter(...)` 实时流式发送部分文本
（`finish:false`）。**权威**的最终消息仍走持久化的 `enqueueOutbound` 队列，并以同一
stream id（由 `conversationRef.reqId` 派生）`finish:true` 结束同一条流——无重复消息。
部分帧为尽力而为；`streamReply` 失败绝不会中断该轮对话。

### 回复 vs 主动推送

回复必须复用触发回调的 `req_id`（有效约 10 分钟）。`send()` 检查
`conversationRef.reqId`：仍有效 ⇒ 回复（`aibot_respond_msg`，流式），否则 ⇒ 主动
`aibot_send_msg`（目标 `chatid`，`chat_type` 1 单聊 / 2 群聊）。覆盖定时 / 工作流 /
勿扰时段的外发。**约束：** 企业微信仅在用户此前给机器人发过消息的会话中投递主动推送
——已在设置表单中明示。

### 交互、欢迎语、媒体

`template_card_event` 在 5 秒窗口内经 `aibot_respond_update_msg` 确认，再经
`ConnectorBus.dispatchConnectorCallback` 路由（Slack 模式：`triggerId = actionId`，
surface 经绑定表恢复）。`enter_chat` 经 `aibot_respond_welcome_msg` 发送运营者配置的
欢迎语。入站图片尽力解密并以 base64 内联，使模型能收到；出站媒体先上传得到
`media_id`。

### 接线 + 能力

`adapter-registry.ts`（`case "wecom"` + `buildWeComAdapter`，从密钥串读取 `botId` /
`secret`）、`platform-meta.tsx`、新增 `wecom-config.tsx` 表单、适配器页的新增菜单、
config-detail 分发器、通用 Send-Test 与 whoami 面板（探测按钮隐藏——WeCom 无
getMe），以及两个 locale 的 i18n。`WECOM_A2UI_CAPABILITY` 将 Button 与展示型基础组件
标为 native，其余降级为 `plainTextMirror`。

### 第二期 —— 个人微信（`wechat-personal`）经 iLink

无官方 API，故借道 iLink（智联）半官方网关（`ilinkai.weixin.qq.com`，即 OpenClaw
「微信 ClawBot」功能）。它是 HTTP 长轮询而非 WebSocket，故
`lib/connectors/adapters/wechat-personal/` 沿用 WeCom 的拆分，但以 HTTP 循环替代套接字：

- `protocol.ts` —— 端点（`/ilink/bot/{get_bot_qrcode,get_qrcode_status,getupdates,sendmessage}`）、
  `X-WECHAT-UIN` 防重放头 + `Authorization: Bearer <bot_token>`、getupdates/sendmessage
  请求体构造器、item 类型（1=文本…5=视频）、`ret -14`。
- `auth.ts` —— 扫码登录流程（`requestLoginQr` → `pollLoginStatus`），供设置向导在适配器
  行存在之前调用；HTTP 可注入以便测试。
- `index.ts` —— `start()` 经 `ctx.tauri.httpRequest` 跑长轮询循环，推进 `get_updates_buf`
  游标；`ret -14` ⇒ degraded + 重新扫码。
- `parse.ts`/`serialize.ts` —— 归一化入站；出站 v1 **仅文本**。
- `media.ts` —— 自带一份 AES-128 逆向密码（经 FIPS-197 校验），因为加密是
  **AES-128-ECB**，而浏览器 Web Crypto 不支持 ECB（仅 CBC/CTR/GCM）。入站图片尽力解密并内联。

**仅回复**：每次 `sendmessage` 必须回显入站的 `context_token`，没有主动发送路径，故
`send()` 在无有效 token 时拒绝，且不实现 `streamReply`（iLink 无流式）。登录向导
（`wechat-personal-config.tsx`）显著提示**封号风险**与会话过期重扫码——这是非官方接入。

## 影响

- 企业微信无需公网入口、无需消息加解密、无需 IP 白名单——最稳健的官方路径——并复用
  整条既有 bus 管线（审计、健康、勿扰、策略、A2UI）。
- 共享 AI loop 获得一个流式接缝，可供未来支持流式的平台复用，对非流式平台零成本。
- `edit` / `delete` / `typing` / `history.fetch` 不支持（协议无对应帧）；主动推送受
  企业微信「用户须先发消息」规则约束。
- 个人微信为仅回复，且封号风险已显著提示；出站媒体（需 ECB *加密* + CDN 上传握手）v1
  暂不支持，但入站媒体——含图片解密——已处理。
