---
title: "Slack 机器人配置"
description: "创建 Slack 应用，收集 bot/app 令牌与签名密钥，并将其连接到 cognia-next。"
---

# Slack 机器人配置指南

本指南将引导你创建 Slack 应用、获取所需的令牌与密钥，并配置 cognia-next 以连接到你的工作区。

---

## 1. 创建 Slack 应用

1. 打开 [https://api.slack.com/apps](https://api.slack.com/apps) 并使用你的 Slack 账号登录。
2. 点击 **Create New App**，然后选择 **From scratch**。
3. 输入一个 **App Name**（例如 "Cognia Bot"），并选择你想要安装它的 **workspace**。
4. 点击 **Create App**。

---

## 2. 添加 OAuth 权限范围

1. 在应用设置中，从左侧边栏选择 **OAuth & Permissions**。
2. 向下滚动至 **Bot Token Scopes**，添加以下权限范围：

   | 权限范围            | 用途                                       |
   | ------------------- | ----------------------------------------- |
   | `chat:write`        | 向频道和私信发送消息                       |
   | `channels:history`  | 读取公开频道中的消息                       |
   | `im:history`        | 读取私信（DM）中的消息                      |
   | `app_mentions:read` | 在机器人被 @mention 时接收事件             |
   | `users:read`        | 查询用户信息                               |
   | `users:read.email`  | （可选）访问用户的电子邮件地址             |

3. 点击 **Save Changes**。

---

## 3. 启用 Socket Mode

cognia-next 默认使用 **Socket Mode**，即通过一个持久的 WebSocket 连接，无需公网 URL。

1. 在应用设置中，从左侧边栏选择 **Socket Mode**。
2. 将 **Enable Socket Mode** 切换为开启。
3. 系统会提示你 **Generate an App-Level Token**：
   - 输入一个令牌名称（例如 "cognia-socket-token"）。
   - 添加权限范围 `connections:write`。
   - 点击 **Generate**。
4. 复制该令牌 —— 它以 `xapp-` 开头。**请妥善保管。**

---

## 4. 将应用安装到你的工作区

1. 在应用设置中，从左侧边栏选择 **OAuth & Permissions**。
2. 点击 **Install to Workspace**（若已安装则点击 **Reinstall**）。
3. 检查权限并点击 **Allow**。
4. 复制 **Bot User OAuth Token** —— 它以 `xoxb-` 开头。**请妥善保管。**

---

## 5. 复制签名密钥（Signing Secret）

1. 在应用设置中，从左侧边栏选择 **Basic Information**。
2. 向下滚动至 **App Credentials**。
3. 复制 **Signing Secret**。它用于验证 webhook 负载确实来自 Slack。

---

## 6. 配置 cognia-next

1. 打开 cognia-next 并导航到 **设置 → 平台连接**。
2. 点击 **添加连接器** 并选择 **Slack**。
3. 在 **Slack Configuration** 对话框中：
   - 为该机器人输入一个 **显示名称**（例如 "My Workspace Bot"）。
   - 粘贴你在第 4 步复制的 **Bot Token**（`xoxb-...`）。
   - 点击 **Test** 验证该令牌能否成功连接到 Slack。对话框会显示你的机器人用户名和工作区名称。
   - 粘贴你在第 5 步复制的 **签名密钥（Signing Secret）**。
   - 选择 **Socket Mode** 作为传输方式（默认）。
   - 粘贴你在第 3 步复制的 **App Token**（`xapp-...`）。
4. 点击 **Create**。

cognia-next 将通过 Socket Mode 连接到 Slack，无需公网 URL。

---

## 7. 验证连接

1. 在 Slack 中向你的机器人发送一条 **私信**，或在已邀请它的频道中对它 `@mention`。
2. 该消息应在一两秒内出现在 cognia-next 中。
3. 检查 **平台连接** 概览 —— 该适配器的状态应显示为 **运行中**。

如果适配器显示 **已停止** 或 **降级**：

- 验证 bot 令牌是否正确（`xoxb-...`）。
- 验证 app 令牌是否正确（`xapp-...`）且具备 `connections:write` 权限范围。
- 确认已在 Slack Developer Portal 中启用 Socket Mode。
- 在 设置 → 平台连接 的 **Audit Log** 标签页中查看错误详情。

---

## 注意事项

- **速率限制**：Slack 对每个频道强制实施约每秒 1 条消息的突发限制。cognia-next 的出站执行器会遵循可重试的错误（HTTP 429）。
- **Events API Webhook**：对于部署在公网 URL 之后的生产环境，你可以在配置对话框中将传输方式切换为 **Events API Webhook**。这需要一个公网可访问的 HTTPS URL，且不在第 1 阶段（Phase 1）的范围内。
- **正在输入指示器**：Slack 的 `assistant.threads.setStatus` 仅限于 Slack Assistant 应用使用。标准机器人适配器在第 1 阶段不支持正在输入指示器。
- **文件上传**：第 1 阶段通过 `chat.postMessage` 以超链接形式发送文件。通过 `files.upload` 进行的原生文件上传计划在第 2 阶段（Phase 2）实现。
