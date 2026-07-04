---
title: "钉钉（DingTalk）配置"
description: "创建钉钉开放平台机器人应用，并通过 Stream 模式接入 cognia-next。"
---

# 钉钉（DingTalk）配置指南

本指南将引导你在钉钉开放平台创建机器人应用、获取应用凭据，并配置 cognia-next
通过钉钉 Stream 模式接收机器人消息。Stream 连接由桌面端连接器运行时维护，因此
不需要公网 webhook URL，也不需要 IP 白名单。

---

## 1. 创建钉钉机器人应用

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com/)。
2. 创建企业内部应用，并为该应用启用机器人能力。
3. 在应用凭据页面记录两项凭据：
   - **App Key** - 作为 Stream 模式的 `clientId`。
   - **App Secret** - 作为 Stream 模式的 `clientSecret`，也用于换取应用 access token。

请妥善保存 App Secret。cognia-next 会把 App Key 与 App Secret 加密存放在操作系统钥匙串中。

---

## 2. 启用 Stream 模式事件

在钉钉开发者后台，为该应用配置机器人消息的 Stream 模式接收：

1. 打开应用的事件或 Stream 模式配置页面。
2. 为机器人启用 Stream 模式。
3. 订阅机器人消息主题：
   - `/v1.0/im/bot/messages/get`
4. 如果后台要求发布新版本，请发布或上线最新应用版本。

cognia-next 会通过以下接口注册 Stream 连接：

```text
POST https://api.dingtalk.com/v1.0/gateway/connections/open
```

运行时随后使用返回的一次性 ticket 打开 WebSocket，并 ACK 每个回调帧。该适配器
不使用 webhook URL。

---

## 3. 在 cognia-next 中配置

1. 打开 cognia-next，进入 **设置 -> 平台连接 -> 适配器**。
2. 点击 **添加连接器**，选择 **钉钉**。
3. 在 **身份** 分区填写：
   - **显示名称** - 便于识别的连接器名称。
   - **App Key** - 来自钉钉开放平台的 App Key。
   - **App Secret** - 来自钉钉开放平台的 App Secret。
4. 点击 **测试** 校验凭据。测试会通过 `POST /v1.0/oauth2/accessToken`
   换取应用 access token。
5. 点击 **创建**。

适配器持久化时使用内部的 `longpoll` 传输枚举，但界面会显示为 **Stream Mode WSS**，
因为钉钉实际使用长生命周期 WebSocket 网关。

---

## 4. 验证连接

1. 将机器人加入钉钉单聊或群聊。
2. 给机器人发送一条消息。群聊中，钉钉通常只投递明确指向机器人的消息，例如 @ 机器人。
3. 查看 **平台连接**。Stream 注册成功后，适配器状态应进入运行中。

如果没有收到消息，请确认机器人已安装到对应会话，并且钉钉后台已订阅
`/v1.0/im/bot/messages/get`。

---

## 出站行为

- **单聊主动发送** 使用 `POST /v1.0/robot/oToMessages/batchSend`，需要来自入站消息的
  `userId`。
- **群聊主动发送** 使用 `POST /v1.0/robot/groupMessages/send`，需要来自入站消息的
  `openConversationId`。
- 适配器会把普通文本发送为 `sampleText`，把 markdown 与 A2UI 投射结果发送为
  `sampleMarkdown`。
- 提及会渲染为可见的 `@name` 文本。当前适配器不保证这类渲染能触发钉钉原生通知。

定时工作流与手动测试发送应使用已经从入站事件学习到的会话引用，例如单聊
`single:<staffId>`，或群聊 `group:<conversationId>`。

---

## 注意事项

- **入站范围**：钉钉 Stream 模式投递指向机器人的消息。单聊消息天然指向机器人，群聊消息
  通常需要 @ 机器人。
- **入站媒体**：图片、音频、视频和文件会投射为文本标记。音频在钉钉提供识别文本时使用
  识别结果。
- **A2UI 投射**：A2UI 界面会降级为钉钉 markdown。链接保持为链接；只有回调的按钮、选择框、
  单选项和输入框会列为可用操作，提示用户用文本回复。
- **不支持的能力**：钉钉适配器不提供通用消息编辑、消息撤回、正在输入、历史拉取、表情反应、
  线程，或保证触达的原生 @ 通知。
- **凭据轮换**：编辑 App Key 或 App Secret 会触发凭据轮换事件。下一次 Stream 重连和出站 API
  调用会读取钥匙串中的最新值。

---

## 故障排查

| 现象 | 可能原因 |
| ---- | -------- |
| 测试时报 access token 错误 | App Key 或 App Secret 不正确，或应用无权换取应用 access token。 |
| 适配器一直降级 | Stream 注册失败，或 WebSocket 网关无法打开。检查应用凭据和 Stream 模式订阅。 |
| 收不到群聊消息 | 机器人不在群里、没有 @ 机器人，或未订阅 `/v1.0/im/bot/messages/get`。 |
| 单聊主动发送失败 | 会话引用缺少 `userId`；先向机器人发送一条消息，让 cognia-next 学到该字段。 |
| 群聊主动发送失败 | 会话引用缺少 `openConversationId`；请使用已经产生过入站事件的群聊。 |
| A2UI 控件显示为文本 | 当前钉钉 markdown 适配没有这些控件的回调通道，因此 cognia-next 会把操作列为文本。 |
