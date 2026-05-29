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

它用于在 Discord 将交互负载发送到 webhook 端点时进行 Ed25519 签名验证。第 1 阶段（Phase 1）使用 Gateway（WebSocket）模式，因此目前它是 **可选** 的 —— 但为将来迁移到 webhook 而保存它是一个良好的做法。

---

## 4. 配置 Gateway Intents

1. 在你的应用中，从左侧边栏选择 **Bot**。
2. 向下滚动至 **Privileged Gateway Intents**。
3. 启用以下选项：
   - **Server Members Intent** —— 允许机器人查看服务器（guild）成员。
   - **Message Content Intent** —— 机器人读取服务器频道中消息内容所 **必需**。

> 若没有 **Message Content Intent**，服务器消息的 `content` 字段将为空。私信（Direct Messages）不需要此 intent。

cognia-next 默认使用 intent 位掩码 **33281**：

| Intent          | 值        |
| --------------- | --------- |
| GUILDS          | 1         |
| GUILD_MESSAGES  | 512       |
| MESSAGE_CONTENT | 32768     |
| DIRECT_MESSAGES | 4096      |
| **合计**        | **33281** |

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
   - 可选地粘贴第 3 步中的 **Public Key**。
   - 点击 **Test** 验证该令牌能否成功连接到 Discord。
4. 点击 **Create**。

cognia-next 将使用 WebSocket 模式连接到 Discord Gateway，无需公网 URL。

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
- **分片（Sharding）**：第 1 阶段不支持，仅支持单分片运行。
- **语音消息**：第 1 阶段不支持，计划在第 2 阶段（Phase 2）实现。
