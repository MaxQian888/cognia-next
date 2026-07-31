---
title: "Discord 机器人配置"
description: "创建 Discord 应用，获取机器人令牌与公钥，邀请机器人，并将其接入 cognia-next。"
---

# Discord 机器人配置指南

本指南将引导你创建 Discord 应用、获取机器人令牌与公钥、将机器人邀请到服务器，并配置 cognia-next 以使用它。

---

## 1. 创建 Discord 应用

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications) 并登录。
2. 点击右上角的 **New Application**。
3. 为你的应用输入一个名称（例如 "Cognia Bot"），然后点击 **Create**。

---

## 2. 添加机器人用户

1. 在你的应用中，从左侧边栏选择 **Bot**。
2. 点击 **Add Bot**，然后通过 **Yes, do it!** 确认。
3. 在 **Token** 下，点击 **Reset Token** 并复制该令牌。**请妥善保管 —— 你将无法再次查看它。**

> 机器人令牌是 cognia-next 用于向 Discord 进行身份验证的凭据。切勿公开分享。

---

## 3. 记下公钥（Public Key）

1. 在你的应用中，前往 **General Information**。
2. 复制 **Public Key**（64 个字符的十六进制字符串）。

公钥用于 Interactions webhook 调用的 Ed25519 签名验证。仅当你在第 6 步选择 **Interactions webhook** 传输时才需要它；默认的 **Gateway** 传输不需要公钥。

---

## 4. 配置 Gateway Intents

1. 在你的应用中，从左侧边栏选择 **Bot**。
2. 向下滚动至 **Privileged Gateway Intents**。
3. 启用以下选项：
   - **Server Members Intent** —— 允许机器人查看服务器（guild）成员。
   - **Message Content Intent** —— 机器人读取服务器频道中消息内容所 **必需**。

> 若没有 **Message Content Intent**，服务器消息的 `content` 字段将为空。私信（Direct Messages）本身不需要此 intent，但机器人仍需订阅 `DIRECT_MESSAGES`（已包含在下面的默认值中）。

cognia-next 默认使用 intent 位掩码 **46593**：

| Intent                   | 值        |
| ------------------------ | --------- |
| GUILDS                   | 1         |
| GUILD_MESSAGES           | 512       |
| GUILD_MESSAGE_REACTIONS  | 1024      |
| DIRECT_MESSAGES          | 4096      |
| DIRECT_MESSAGE_REACTIONS | 8192      |
| MESSAGE_CONTENT          | 32768     |
| **合计**                 | **46593** |

你可以在适配器 **交付与传输** 区域的 **Gateway intents** 字段覆盖该位掩码（留空则使用默认值）。无论位掩码如何，`MESSAGE_CONTENT` 都是特权 intent，必须在 Developer Portal 中开启，否则 Discord 会以关闭码 4014 断开连接。

---

## 5. 将机器人邀请到你的服务器

1. 在你的应用中，从左侧边栏选择 **OAuth2 → URL Generator**。
2. 在 **Scopes** 下，勾选 `bot`。
3. 在 **Bot Permissions** 下，至少勾选：
   - **Send Messages**
   - **Read Message History**
   - **View Channels**
   - **Embed Links**（用于图片附件）
4. 复制生成的 URL 并在浏览器中打开。
5. 选择你想要添加机器人的服务器，然后点击 **Authorise**。

---

## 6. 配置 cognia-next

1. 打开 cognia-next 并导航到 **设置 → 平台连接**。
2. 点击 **添加连接器** 并选择 **Discord**。
3. 在 **Discord Configuration** 对话框中：
   - 为该机器人输入一个 **显示名称**（例如 "My Server Bot"）。
   - 粘贴你在第 2 步复制的 **Bot Token**。
   - 在 **交付与传输** 下，选择一种 **传输方式**：
     - **Gateway (WebSocket)** —— 推荐。通过持久连接同时接收消息与交互，无需公网 URL。
     - **Interactions webhook (HTTP)** —— **仅接收交互**（slash 命令、按钮、modal 提交），此模式下 **不会** 收到消息事件。需要 Cloudflared Tunnel（移动端伴侣设置）与 **Public Key**；把生成的 **Interactions Endpoint URL** 粘贴到 Developer Portal → General Information → Interactions Endpoint URL。
   - 点击 **Test** 验证该令牌能否成功连接到 Discord。
4. 点击 **Create**。

在 Gateway 模式下，cognia-next 通过 WebSocket 连接 Discord Gateway，无需公网 URL。

---

## 7. 验证连接

创建适配器后，检查 **平台连接** 概览。随着 Gateway WebSocket 握手完成（HELLO → IDENTIFY → READY），该适配器应在几秒内显示状态为 **运行中**。

如果适配器显示 **已停止** 或 **降级**：

- 验证 bot 令牌是否正确（如有需要可重置）。
- 确认已在 Developer Portal 中启用 **Message Content Intent**。
- 在 设置 → 平台连接 的 **Audit Log** 标签页中查看错误详情。

---

## 注意事项

- **速率限制**：Discord 对机器人按每个频道每秒 50 条消息进行速率限制。cognia-next 的出站执行器会遵循可重试的错误（HTTP 429）。
- **大型服务器**：对于加入 100 个以上服务器的机器人，你必须通过 Developer Portal 申请 **Gateway Privileged Intents**。
- **分片（Sharding）**：不支持，仅支持单分片运行。
- **交互组件（A2UI）**：按钮、下拉选择和 modal 在 Gateway 模式下可用 —— 机器人会在 Discord 的 3 秒窗口内确认每次交互，并作为普通频道消息回复。**Modal**（TextField / TextArea / Dialog 界面）仅在 Gateway 模式可用；在 webhook 模式下，modal 触发按钮会退化为普通回调。
- **媒体**：图片、文件、视频和语音消息以真正的 multipart 附件上传（而非 URL 内嵌）。语音消息携带 `IS_VOICE_MESSAGE` 标志以及时长和波形元数据。
- **Webhook 传输仅限交互**：Discord 的 Interactions Endpoint 永远不会投递消息事件，只投递交互。任何需要读取聊天消息或私信的机器人都请使用 Gateway 模式。
