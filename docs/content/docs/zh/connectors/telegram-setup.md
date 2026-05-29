---
title: "Telegram 机器人配置"
description: "用 @BotFather 创建机器人、获取 Bot Token，并在 cognia 中通过长轮询或 Webhook 接入。"
---

# Telegram 机器人配置指南

本指南将引导你用 Telegram 官方的 [@BotFather](https://t.me/botfather) 创建机器人、获取 `Bot Token`，并在 cognia 中通过**长轮询**或 **Webhook** 接入你的工作区。

---

## 1. 用 @BotFather 创建机器人

1. 在 Telegram 中打开 [@BotFather](https://t.me/botfather) 并发起对话。
2. 发送 `/newbot`，按提示依次设置：
   - **名称（Name）**：机器人在聊天中显示的名字（例如 "Cognia Bot"）。
   - **用户名（Username）**：必须以 `bot` 结尾且全局唯一（例如 `cognia_workspace_bot`）。
3. 创建成功后，@BotFather 会返回该机器人的 `Bot Token`，形如 `1234567890:ABCDEF...`。**请妥善保管** —— 任何人持有它都能操控你的机器人。

可选的进一步设置（仍在 @BotFather 中操作）：

| 命令            | 用途                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| `/setprivacy`   | 群组隐私模式。**开启时**机器人只能收到 @ 它或回复它的消息；**关闭后**能收到群里的全部消息。 |
| `/setcommands`  | 为机器人注册斜杠命令列表，方便用户在输入框中看到提示。                                       |

> 如果你打算让机器人在群里被动接收所有消息，记得用 `/setprivacy` 关闭隐私模式，否则它只能看到针对它的消息。

---

## 2. 在 cognia 中配置

1. 打开 cognia 并导航到 **设置 → 平台连接**。
2. 切换到 **适配器** 标签，点击 **添加连接器**，选择 **Telegram**。
3. 在 **Telegram 配置** 对话框中填写：

   | 字段          | 说明                                                                                                                                  |
   | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
   | **显示名称**  | 该机器人在 cognia 内部的标识名（例如 "My Workspace Bot"）。                                                                            |
   | **Bot Token** | 第 1 步从 @BotFather 拿到的 `Bot Token`。它会被加密存放在系统钥匙串中，永不写入日志。                                                  |
   | **传输方式**  | **长轮询**（默认）：cognia 直接轮询 Telegram，无需公网地址。 **Webhook**：Telegram 把更新推送到你的公网 URL（见第 3 步）。              |

4. （桌面端）填好 `Bot Token` 后，可点击 **测试** 按钮验证令牌。它会在内部调用 Telegram 的 `getMe` 接口，成功时显示机器人的用户名与 id。

   > **测试** 按钮仅在桌面运行时（Tauri）可用；在浏览器中该按钮处于禁用状态。

5. 点击 **创建** 保存。

---

## 3.（仅 Webhook）配置公网入口

如果你在第 2 步选择了 **Webhook** 传输方式，Telegram 需要一个公网可访问的 **HTTPS** 入口才能把更新推送过来。

1. 先在 **设置 → 移动端伴侣** 中启动 **Cloudflared Tunnel**，为 cognia 暴露一个公网 HTTPS 地址。
2. 回到 Telegram 配置对话框的 **传输方式** 区域。隧道就绪后，表单会自动拼出该机器人的 **Webhook URL**；点击 **复制** 取走它。
3. 保存连接器 —— cognia 会通过 Telegram 的 `setWebhook` 接口自动注册该 URL。
4. 可选填写 **Webhook 密钥**：Telegram 会把它放进每次回调请求的 `X-Telegram-Bot-Api-Secret-Token` 请求头中，cognia 据此校验请求确实来自 Telegram。

   > 隧道未运行时，表单会提示你前往 **移动端伴侣** 先把隧道启动起来；Webhook URL 在隧道就绪前不可用。

---

## 4. 验证连接

1. 在 Telegram 中向你的机器人发送一条**私聊**消息，或在已邀请它的**群组**里 @ 它。
2. 该消息应在一两秒内出现在 cognia 中。
3. 检查 **平台连接** 概览 —— 该适配器的状态应显示为 **运行中**。

如果适配器显示 **已停止** 或 **降级**：

- 确认 `Bot Token` 正确（形如 `1234567890:ABCDEF...`）；可在桌面端用 **测试** 按钮复核。
- 如果用的是 Webhook，确认 Cloudflared Tunnel 正在运行且 Webhook URL 已保存。
- 如果机器人在群里收不到消息，检查是否需要用 `/setprivacy` 关闭群组隐私模式。
- 在 设置 → 平台连接 的 **审计日志** 标签页中查看具体错误。

---

## 注意事项

- **长轮询 vs Webhook 的取舍**：长轮询无需任何公网地址，配置最简单，适合本机或局域网运行，是默认且推荐的方式；Webhook 由 Telegram 主动推送、延迟更低，但要求一个稳定的公网 HTTPS 入口（通过 Cloudflared Tunnel 提供）。多数场景用长轮询即可。
- **群组隐私模式**：默认开启时，机器人在群里只能收到 @ 它或回复它的消息。若需要它接收群内全部消息，必须在 @BotFather 用 `/setprivacy` 关闭隐私模式，并将机器人重新加入群组使设置生效。
- **凭据安全**：`Bot Token` 与 Webhook 密钥都加密存放在系统钥匙串中，永不写入日志。请勿在公开渠道粘贴你的 `Bot Token`。
- **历史消息**：Telegram 的 Bot API 不提供拉取任意聊天历史的接口，因此该适配器只处理实时收到的更新，无法回溯既往消息。
- **速率限制**：当 Telegram 返回 429（请求过于频繁）时，cognia 的出站执行器会读取 Telegram 给出的 `retry_after` 冷却时间并据此退避重试。

参考链接：

- [@BotFather](https://t.me/botfather) —— 创建与管理机器人
- [Telegram Bot API](https://core.telegram.org/bots/api) —— 官方接口文档
