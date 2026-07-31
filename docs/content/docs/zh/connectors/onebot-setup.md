---
title: "OneBot (QQ) 配置"
description: "通过 OneBot 协议，使用 NapCat、Lagrange 或 LLOneBot 以反向或正向 WebSocket 方式接入 QQ。"
---

# OneBot (QQ) 配置指南

cognia-next 通过 **OneBot** 协议接入 QQ，支持两种 WebSocket 连接方式：

- **反向 WS**：NapCat、Lagrange 或 LLOneBot 与 QQ 客户端一同运行，并主动连接到
  cognia-next 的连接器服务器。
- **正向 WS**：cognia-next 主动连接到 NapCat 或其他 OneBot 客户端暴露的 WebSocket 服务端。

支持的客户端：

- [NapCat](https://github.com/NapNeko/NapCatQQ) —— 适用于 Windows/Linux 的 QQ，更新频率最快
- [Lagrange](https://github.com/LagrangeDev/Lagrange.Core) —— 跨平台 NTQQ
- [LLOneBot](https://github.com/LLOneBot/LLOneBot) —— 适用于 QQNT 的 LiteLoader 插件

---

## 前置条件

- cognia-next 以 **桌面模式** 运行（`pnpm tauri dev` 或已安装的应用）
- 通过 NapCat / Lagrange / LLOneBot 登录的 QQ 账号
- 反向 WS：QQ 客户端所在机器（通常是同一台机器）可访问 `7842` 端口（或你配置的任意连接器端口）。
- 正向 WS：cognia-next 可访问 OneBot 客户端的 WebSocket 服务端地址，例如 `ws://127.0.0.1:3001`。

---

## 第 1 步 —— 在 cognia-next 中添加适配器

1. 打开 **平台连接**。
2. 点击 **添加连接器** → **OneBot (QQ)**。
3. 填写：
   - **Bot UIN（QQ 号）** —— 机器人账号的 QQ 号（例如 `123456789`）。
   - **Bearer Token** —— 使用带认证的连接时，填写与 OneBot 客户端 `accessToken` 相同的值。
   - **预期客户端** —— 选择 NapCat、Lagrange 或 LLOneBot（仅作显示用途）。
   - **连接方式** —— 客户端连接到 cognia-next 时选择 **反向 WS**；cognia-next 连接到客户端
     WebSocket 服务端时选择 **正向 WS**。
4. 点击 **创建**。

如果选择 **反向 WS**，对话框会显示端点 URL，例如：

   ```
   ws://127.0.0.1:7842/ws/onebot/<adapterId>
   ```

复制此 URL —— 接下来你会把它粘贴到 NapCat / Lagrange / LLOneBot 配置中。

如果选择 **正向 WS**，请在对话框中填写 OneBot 客户端的 WebSocket 服务端地址，例如
`ws://127.0.0.1:3001`。

---

## 第 2 步 —— 选择传输方式

### 方案 A：反向 WS

编辑你的 NapCat `napcat.json`（或使用 NapCat WebUI），添加 cognia-next 显示的 reverse-WS URL：

```json
{
  "wsReverse": [
    {
      "enable": true,
      "url": "ws://127.0.0.1:7842/ws/onebot/<adapterId>",
      "reconnectInterval": 3000
    }
  ]
}
```

将 `<adapterId>` 替换为 cognia-next 对话框中显示的值。

### Lagrange

在 `appsettings.json` 中：

```json
{
  "Implementations": [
    {
      "Type": "ReverseWebSocket",
      "Host": "127.0.0.1",
      "Port": 7842,
      "Suffix": "/ws/onebot/<adapterId>",
      "ReconnectInterval": 3000
    }
  ]
}
```

### LLOneBot

在 LLOneBot 插件设置中，添加一条 **Reverse WebSocket** 条目，URL 为：

```
ws://127.0.0.1:7842/ws/onebot/<adapterId>
```

### 方案 B：正向 WS

启用 OneBot 客户端的 WebSocket 服务端，并把它的 URL 填入 cognia-next 的 **NapCat WebSocket 地址**
字段。NapCat 常见地址为：

```
ws://127.0.0.1:3001
```

如果填写了 **Bearer Token**，cognia-next 会在打开正向 WebSocket 时发送
`Authorization: Bearer <token>`。

---

## 第 3 步 —— 配置 bearer token

对于反向 WS，入站端点默认 fail-closed：如果没有配置 bearer token，cognia-next 会拒绝连接，
除非你在适配器对话框中显式开启 **允许未认证的连接**。

推荐配置：

1. 在 NapCat `napcat.json` 中设置：

   ```json
   {
     "accessToken": "my-secret-token"
   }
   ```

2. 在 cognia-next 适配器对话框中，将 `my-secret-token` 粘贴到 **Bearer Token（可选）** 字段。

cognia-next 会拒绝发送错误或缺失令牌的反向 WS 连接。只有在可信本机客户端确实不使用
access token 时，才开启 **允许未认证的连接**。

---

## 第 4 步 —— 重启并验证

1. 修改 WebSocket 或 token 设置后，重启或重新连接 OneBot 客户端。
2. 反向 WS 下，客户端会在几秒内向 cognia-next 发起 WebSocket 连接；正向 WS 下，
   cognia-next 会连接客户端 WebSocket 服务端。
3. 在 cognia-next 适配器对话框中，点击 **验证连接** 最多等待 10 秒以捕获一次新的反向 WS
   握手，或点击 **当前已连接？** 读取实时反向 WS 注册表。
4. 连接成功后，**平台连接** 中的适配器状态会显示 **running**（绿色）。

---

## 第 5 步 —— 测试机器人

- **私聊消息**：向机器人的 UIN 发送一条 QQ 私聊消息。
- **群内 @提及**：在群聊中发送 `@<bot-UIN> hello` —— 如果群触发策略匹配，机器人会响应。

---

## 机器人身份与富文本消息

客户端连接后，cognia-next 会通过 OneBot `get_login_info` 动作自动探测机器人自身身份，并在适配器的
**机器人身份** 面板显示真实昵称与 UIN —— 与 Telegram、Slack、Lark 显示机器人身份的方式一致。
若已连接机器人的 UIN 与你填写的 **Bot UIN** 不一致，面板会给出不匹配提示，请据此修正。

入站 QQ 消息会被高保真地映射：

- **合并转发** 会通过 `get_forward_msg` 拉取正文，从而呈现真实的转发内容（`昵称: 文本` 逐行），
  而不是一个通用占位符。
- **位置** 段会转为结构化位置数据；**戳一戳**、**骰子**、**猜拳**、**推荐名片** 以及旧版
  **XML / JSON 卡片** 会渲染为可读文本。

出站方面，适配器可通过 NapCat 的 `send_group_forward_msg` / `send_private_forward_msg` 扩展把已有消息
**合并转发** 到其他会话，并在 NapCat 上游通过 `set_msg_emoji_like` 添加 QQ 表情回应。

---

## 故障排查

常见问题请参阅 [QQ via OneBot FAQ](./qq-via-onebot-faq.md)。
