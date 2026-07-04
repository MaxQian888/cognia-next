---
title: "通过 OneBot 接入 QQ —— 常见问题"
description: "关于 OneBot QQ 接入的常见问题：UIN 与 OpenID、多账号配置、NapCat 与 Lagrange，以及已知限制。"
---

# 通过 OneBot 接入 QQ —— 常见问题

## 为什么用 UIN 而不是 OpenID？

cognia-next 的 OneBot 适配器使用机器人的 **UIN**（QQ 号），这正是 NapCat、Lagrange 和 LLOneBot 所暴露的标识。

**QQ 官方机器人**平台使用 **OpenID** —— 这是一套完全不同的 API，走官方 Bot 网关与 REST 接口。如需接入该通道，请使用独立的 [`qq-official` 适配器](./qq-official-setup)。

请**不要**混用两者：NapCat 不认识 OpenID，而 QQ 官方机器人 API 也不使用 OneBot。

---

## 群权限要求

要让机器人接收群消息，机器人账号必须：

- 是该群的成员。
- （为支持 @ 提及回复）该群必须允许任意成员被 @ 提及，或者机器人必须被显式提及。

某些群限制只有管理员才能发言。在这种情况下，只有管理员才能触发机器人；cognia-next 会原样遵循 OneBot 的事件流。

---

## 反向 WS 防火墙 / 连接被拒绝

默认情况下，cognia-next 的连接器服务器绑定到 `127.0.0.1`（仅回环地址）。这意味着：

- NapCat 与 cognia-next **必须运行在同一台机器上**。
- 如果你在另一台主机上运行 NapCat（例如同一局域网内的 Docker 容器），连接将会失败。

**解决方案：**

1. 让 NapCat 与 cognia-next 运行在同一台主机上。
2. 如果确实需要分离部署，使用 `ssh -L 7842:127.0.0.1:7842 user@cognia-host` 转发默认连接器端口。
3. 未来会提供一个设置项，允许绑定到 `0.0.0.0` —— 请关注更新日志。

---

## Token 轮换

如果你更改了 NapCat 或 cognia-next 中的 bearer token：

1. 在 cognia-next **设置 → 平台连接 → （适配器）→ Bearer Token** 中更新 token。
2. 更新 NapCat 配置中的 `accessToken`。
3. 重启或重新连接 NapCat，让它使用新 token 打开新的 WebSocket。

不需要重启 cognia-next。反向 WS 服务器会在每次 WebSocket upgrade 时读取 keyring，
因此下一次连接会使用已保存的 token。正向 WS 下，cognia-next 连接 OneBot 客户端的
WebSocket 服务端时，会把已保存的 token 作为 `Authorization: Bearer <token>` 发送。

---

## 帧大小限制

OneBot 客户端通常将单个 WS 帧上限设为几 MB。如果你发送一个非常大的文件，上传会因 NapCat 返回的帧大小错误而失败。

对于大附件请使用 **file** 段类型：NapCat 会通过 QQ 文件传输 API 上传文件并发送一个引用，而不是内嵌原始字节。

---

## “连接已接受但收不到事件”

如果适配器显示为**运行中**（绿色），但没有任何消息触发机器人：

1. 检查群触发策略是否设置正确 —— 默认情况下，在群里只有 @ 提及和 `/ask` 斜杠命令才会触发机器人。
2. 确认 NapCat 正在接收消息：打开 NapCat 日志，查看是否有进入的 `message` 事件。
3. 确保机器人的 QQ 账号是该群成员且未被禁言。

---

## 多个机器人 / 适配器

你可以在 cognia-next 中添加多个 OneBot 适配器 —— 每个适配器都会获得唯一的 `adapterId`，因此也会得到唯一的端点 URL：

```
ws://127.0.0.1:7842/ws/onebot/adapter-abc-1
ws://127.0.0.1:7842/ws/onebot/adapter-abc-2
```

让每个 NapCat 实例指向各自的 URL。Bearer token 可以按适配器分别设置。

---

## 协议版本差异

| 特性                 | v11（NapCat 默认）                    | v12（Lagrange 选项）           |
| -------------------- | ------------------------------------- | ------------------------------ |
| `message_type` 字段  | 有                                    | 无 —— 改用 `detail_type`       |
| `user_id` 类型       | number                                | string                         |
| @ 提及段             | `at`，带 `qq` 字段                    | `mention`，带 `user_id` 字段   |
| 发送动作             | `send_private_msg` / `send_group_msg` | `send_message`                 |
| 删除动作             | `delete_msg`                          | `delete_message`               |

cognia-next 会从第一个事件中自动检测版本，并按适配器实例缓存。你无需手动配置。
