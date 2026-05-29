---
title: "OneBot (QQ) 配置"
description: "通过 OneBot 协议，使用 NapCat、Lagrange 或 LLOneBot 以 reverse-WebSocket 方式接入 QQ。"
---

# OneBot (QQ) 配置指南

cognia-next 通过 **OneBot** 协议，使用 **reverse-WebSocket** 连接接入 QQ。
NapCat、Lagrange 或 LLOneBot 与 QQ 客户端一同运行，并连接到 cognia-next。

支持的客户端：

- [NapCat](https://github.com/NapNeko/NapCatQQ) —— 适用于 Windows/Linux 的 QQ，更新频率最快
- [Lagrange](https://github.com/LagrangeDev/Lagrange.Core) —— 跨平台 NTQQ
- [LLOneBot](https://github.com/LLOneBot/LLOneBot) —— 适用于 QQNT 的 LiteLoader 插件

---

## 前置条件

- cognia-next 以 **桌面模式** 运行（`pnpm tauri dev` 或已安装的应用）
- 通过 NapCat / Lagrange / LLOneBot 登录的 QQ 账号
- QQ 客户端所在机器（通常是同一台机器）可访问 `8080` 端口（或你配置的任意连接器端口）

---

## 第 1 步 —— 在 cognia-next 中添加适配器

1. 打开 **平台连接**。
2. 点击 **添加连接器** → **OneBot (QQ)**。
3. 填写：
   - **Bot UIN（QQ 号）** —— 机器人账号的 QQ 号（例如 `123456789`）。
   - **Bearer Token（可选）** —— 除非你在 NapCat 中配置了 `accessToken`（见第 3 步），否则留空。
   - **预期客户端** —— 选择 NapCat、Lagrange 或 LLOneBot（仅作显示用途）。
4. 点击 **创建**。对话框会显示 **reverse-WS 端点 URL**，例如：

   ```
   ws://127.0.0.1:8080/ws/onebot/<adapterId>
   ```

   复制此 URL —— 接下来你会把它粘贴到 NapCat 配置中。

---

## 第 2 步 —— 配置 NapCat reverse-WS

编辑你的 NapCat `napcat.json`（或使用 NapCat WebUI），添加 reverse-WS URL：

```json
{
  "wsReverse": [
    {
      "enable": true,
      "url": "ws://127.0.0.1:8080/ws/onebot/<adapterId>",
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
      "Port": 8080,
      "Suffix": "/ws/onebot/<adapterId>",
      "ReconnectInterval": 3000
    }
  ]
}
```

### LLOneBot

在 LLOneBot 插件设置中，添加一条 **Reverse WebSocket** 条目，URL 为：

```
ws://127.0.0.1:8080/ws/onebot/<adapterId>
```

---

## 第 3 步 —— 可选：配置 bearer token

如果你想保护该端点（在共享机器上推荐这样做）：

1. 在 NapCat `napcat.json` 中设置：

   ```json
   {
     "accessToken": "my-secret-token"
   }
   ```

2. 在 cognia-next 适配器对话框中，将 `my-secret-token` 粘贴到 **Bearer Token（可选）** 字段。

cognia-next 会拒绝发送了错误或缺失令牌的连接。

---

## 第 4 步 —— 重启并验证

1. 重启 NapCat（或重新加载 LLOneBot 插件 / 重启 Lagrange）。
2. NapCat 会在几秒内向 cognia-next 发起 WebSocket 连接。
3. 在 cognia-next 适配器对话框中，点击 **验证连接** —— 它会最多等待 10 秒以完成握手。
4. 连接成功后，**平台连接** 中的适配器状态会显示 **running**（绿色）。

---

## 第 5 步 —— 测试机器人

- **私聊消息**：向机器人的 UIN 发送一条 QQ 私聊消息。
- **群内 @提及**：在群聊中发送 `@<bot-UIN> hello` —— 如果群触发策略匹配，机器人会响应。

---

## 故障排查

常见问题请参阅 [QQ via OneBot FAQ](./qq-via-onebot-faq.md)。
