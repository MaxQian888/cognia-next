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

如果你在第 2 步选择了 **Webhook** 传输方式，Telegram 需要一个公网可访问的 **HTTPS** 入口，并且 cognia 需要能把这个地址告诉 Telegram。

1. 打开 **设置 → 平台连接 → 隧道**，在该标签页启动 **Cloudflared Tunnel**。

   > 请从 **隧道** 标签页启动，而不是 **移动端伴侣**。同一时刻只会运行一条隧道，而「隧道」标签页会把它指向连接器服务——真正对外提供 `/webhook/telegram/<适配器 ID>` 的那个进程。为伴侣端启动的隧道指向的是另一个端口，Telegram 的推送会 404。

2. 重新打开已保存的 Telegram 适配器。隧道就绪后，**传输方式** 区域会显示该机器人的 **Webhook URL**。
3. 填写 **Webhook 密钥**。这是**必填项**，不是可选项：Telegram 会在每次推送的 `X-Telegram-Bot-Api-Secret-Token` 请求头中回传该密钥，而 cognia 会拒绝所有不带密钥的推送——没有密钥的 Webhook 收不到任何消息。
4. 保存适配器。

此后注册工作由 cognia 接管：适配器启动时会自行调用 Telegram 的 `setWebhook`，带上回调地址、密钥，以及与长轮询完全相同的 `allowed_updates` 列表——因此 Webhook 机器人与长轮询机器人收到的更新类型始终一致。公网地址变化时（Cloudflared 快速隧道每次重启都会换域名）它会自动重新注册；适配器停止时会调用 `deleteWebhook` 撤销注册——正是这一步让你可以把机器人切回长轮询，而不会让 Telegram 对每次 `getUpdates` 都返回 409。

新建但尚未保存的 Webhook 适配器无法显示最终 URL，因为适配器 ID 此时还不存在。

### 手动注册

只有当你的公网入口不走隧道时才需要这样做——例如在连接器服务前面自建了反向代理。从表单复制 **Webhook URL**，自己调用 `setWebhook`，并传入与 cognia 相同的 `allowed_updates` 列表；一旦显式指定了该列表就等于放弃了 Telegram 的默认集合，凡是没列出的更新类型都会被静默丢弃：

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<你的域名>/webhook/telegram/<适配器 ID>",
    "secret_token": "<你的 Webhook 密钥>",
    "allowed_updates": ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query", "message_reaction", "my_chat_member"]
  }'
```

升级版本时请同步更新这个列表——cognia 会随功能演进往里添加新的更新类型，而手动注册的 Webhook 只会保留你当初传入的那份。

如果适配器记录本身带有明确的公网地址（在部署无头实例或导入连接器时写入，而非通过本对话框填写），cognia 会注册**该**地址而不是隧道地址，并同样负责后续维护。

---

## 4. 验证连接

1. 在 Telegram 中向你的机器人发送一条**私聊**消息，或在已邀请它的**群组**里 @ 它。
2. 该消息应在一两秒内出现在 cognia 中。
3. 检查 **平台连接** 概览 —— 该适配器的状态应显示为 **运行中**。

如果适配器显示 **已停止** 或 **降级**：

- 确认 `Bot Token` 正确（形如 `1234567890:ABCDEF...`）；可在桌面端用 **测试** 按钮复核。
- 如果用的是 Webhook，适配器的健康原因会直接指出问题：没有可用的公网 HTTPS 地址（隧道未运行）、未配置 Webhook 密钥、`setWebhook` 被拒绝，或者 Telegram 自己报告推送失败——出现 `Wrong response from the webhook: 404 Not Found` 说明隧道指向了错误的本地端口。
- 如果机器人在群里收不到消息，检查是否需要用 `/setprivacy` 关闭群组隐私模式。
- 在 设置 → 平台连接 的 **审计日志** 标签页中查看具体错误。

---

## 注意事项

- **长轮询 vs Webhook 的取舍**：长轮询无需任何公网地址，配置最简单，适合本机或局域网运行，是默认且推荐的方式；Webhook 由 Telegram 主动推送、延迟更低，但要求一个公网 HTTPS 入口（通过 Cloudflared Tunnel 提供）和一个 Webhook 密钥。多数场景用长轮询即可。
- **群组隐私模式**：默认开启时，机器人在群里只能收到 @ 它或回复它的消息。若需要它接收群内全部消息，必须在 @BotFather 用 `/setprivacy` 关闭隐私模式，并将机器人重新加入群组使设置生效。
- **凭据安全**：`Bot Token` 与 Webhook 密钥都加密存放在系统钥匙串中，永不写入日志。请勿在公开渠道粘贴你的 `Bot Token`。
- **历史消息**：Telegram 的 Bot API 不提供拉取任意聊天历史的接口，因此该适配器只处理实时收到的更新，无法回溯既往消息。
- **速率限制**：当 Telegram 返回 429（请求过于频繁）时，cognia 的出站执行器会读取 Telegram 给出的 `retry_after` 冷却时间并据此退避重试。

参考链接：

- [@BotFather](https://t.me/botfather) —— 创建与管理机器人
- [Telegram Bot API](https://core.telegram.org/bots/api) —— 官方接口文档
