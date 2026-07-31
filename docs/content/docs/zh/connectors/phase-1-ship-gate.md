---
title: "Phase 1 发布门禁"
description: "平台连接器 Phase 1 发布的人工验证清单。在将 feat/platform-connectors-phase1 合并到 master 之前，所有条目都必须勾选完成。"
---

# 平台连接器 —— Phase 1 发布门禁

**分支：** `feat/platform-connectors-phase1`  
**ADR：** [0009 —— 平台连接器](/docs/adr/0009-platform-connectors)  
**日期：** 2026-05-05

---

## 自动化门禁（CI 必须通过）

在进行人工检查之前，请确认所有自动化门禁均为绿色：

- [ ] `pnpm typecheck` —— 零 TS 错误
- [ ] `pnpm lint` —— 零 ESLint 错误（警告可接受）
- [ ] `pnpm test` —— 所有 Jest 套件通过（987 个套件，12 772+ 个测试）
- [ ] `pnpm build` —— Next.js 静态导出无错误完成（退出码 0）
- [ ] `pnpm tauri build --debug` —— Rust 编译通过，生成 `.msi` 和 `.exe` 安装包

---

## §1 —— Telegram 适配器冒烟测试

> 前置条件：通过 @BotFather 创建一个机器人，设置 `TELEGRAM_BOT_TOKEN`。  
> 以 dev 模式启动桌面应用：`pnpm tauri dev`。

- [ ] 打开 设置 → 平台连接 → 适配器 选项卡。
- [ ] 点击 **+ 添加连接器** → 选择 **Telegram**。
- [ ] 输入机器人 token；保存。确认列表中出现一行，状态为 `idle`。
- [ ] 点击 **启用**。状态转为 `polling`。
- [ ] 从 Telegram 客户端向机器人发送 “hello”。
- [ ] 确认消息出现在收件箱中（访问 `/inbox` 或 `?section=connections` → 收件箱选项卡）。
- [ ] 在 **手动** 模式下，在编辑器中输入回复并点击发送。
- [ ] 确认回复出现在 Telegram 聊天中。
- [ ] 禁用该适配器。状态转回 `idle`。不再轮询。

---

## §2 —— Discord 适配器冒烟测试

> 前置条件：具备 `bot` + `applications.commands` 权限范围的 Discord 机器人 token，
> 并在开发者门户中至少启用 `Guilds` 和 `Message Content` intent。

- [ ] 在 设置 → 平台连接 → 适配器 中添加一个 Discord 适配器。
- [ ] 输入机器人 token；保存并启用。状态转为 `connected`（Gateway WS）。
- [ ] 在机器人可见的频道中发送一条消息。
- [ ] 消息在 5 秒内出现在收件箱中。
- [ ] 在手动模式下回复；回复在 10 秒内出现在 Discord 中。

---

## §3 —— Slack 适配器冒烟测试

> 前置条件：具备 `app_mentions:read`、`chat:write`、`channels:history` 权限范围的 Slack 应用。  
> 斜杠命令 / 事件 URL 必须是公网可路由的（使用 `ngrok` 或
> 在任务 94/95 中接好的 Tauri HTTP 代理）。

- [ ] 添加一个 Slack 适配器。输入 Bot User OAuth Token 和 Signing Secret。
- [ ] 从 Slack 触发一个事件（在频道中提及机器人）。
- [ ] 事件出现在收件箱中。
- [ ] 在手动模式下回复；回复在 10 秒内出现在 Slack 中。

---

## §4 —— Lark / 飞书适配器冒烟测试

> 前置条件：具备 Encrypt Key 和 Verification Token 的 Lark 自定义机器人。

- [ ] 添加一个 Lark 适配器。输入 App ID、App Secret、Encrypt Key 和 Verification Token。
- [ ] 从 Lark 向机器人发送一条消息。
- [ ] 消息出现在收件箱中。
- [ ] 在手动模式下回复；回复在 10 秒内出现在 Lark 中。

---

## §5 —— OneBot v11（NapCat / LLOneBot）冒烟测试

> 前置条件：本地运行 NapCat 或 LLOneBot，并配置好反向 WS 传输。

- [ ] 添加一个 OneBot 适配器。输入访问 token（如已配置），并确认
      反向 WS URL（`ws://127.0.0.1:<port>/api/onebot`）与 NapCat 配置一致。
- [ ] NapCat 连接成功。适配器状态转为 `connected`。
- [ ] 向机器人发送一条 QQ 消息。
- [ ] 消息出现在收件箱中。
- [ ] 在手动模式下回复；回复在 10 秒内出现在 QQ 中。

---

## §6 —— 出站队列与熔断器

- [ ] 启用任意适配器并将其设为 **手动** 模式。
- [ ] 断开互联网连接 / 吊销机器人 token，以强制造成投递失败。
- [ ] 通过编辑器发送一条消息。设置中的“出站”选项卡应显示该
      任务处于 `pending` → `retrying` 状态，且 `attempts` 不断增加。
- [ ] 在 5 次失败尝试后，该行转为 `deadlettered`。
- [ ] 恢复连接 / 修复 token。任务不会从死信中自动重试
      （Phase 1 行为 —— 需从“出站”选项卡手动重新入队）。

---

## §7 —— 免打扰时段

- [ ] 打开 设置 → 平台连接 → 适配器 → 编辑某个适配器。
- [ ] 将免打扰时段设为 `00:00` 至 `23:59`（今天的日期）并保存。
- [ ] 触发一次回复；“出站”选项卡显示该任务被延后（状态 `pending`，
      `nextAttemptAt` 设为免打扰窗口结束时间）。
- [ ] 移除免打扰时段；任务立即处理。

---

## §8 —— 草稿模式

> 当前说明：auto 模式和 scheduled digest 现在都会通过 `runConnectorDigestTurn`
> 走共享 AI 回合路径。草稿模式仍会先产生一行草稿 —— 请端到端验证批准/拒绝流程。

- [ ] 通过 ConversationHeader 的切换器将某个适配器会话设为 **draft** 模式。
- [ ] 发送一条入站消息。
- [ ] 打开 收件箱 → 会话详情。确认 DraftBanner 出现，并带有
      占位草稿文本。
- [ ] 点击 **批准**。确认草稿在“出站”选项卡中转为一个出站任务。
- [ ] 点击 **拒绝**。确认草稿被移除。

---

## §9 —— Web 模式降级

- [ ] 在浏览器（非 Tauri）中打开 cognia-next：`pnpm dev` → `http://localhost:3000`。
- [ ] 导航到 设置 → 平台连接。确认 web 模式横幅可见，其
      role 为 `status`，aria-label 为 `"Web mode banner"`。
- [ ] 打开 `/inbox` → 导航到任意绑定了平台的会话。
- [ ] 确认 ConversationHeader 的模式切换器被包裹在一个禁用的 span 中
      （`pointer-events-none`、`aria-disabled="true"`）。
- [ ] 打开任意带有 `platformBinding` 的聊天会话。确认编辑器的发送
      按钮被禁用。

---

## §10 —— 插件连接器扩展 API

- [ ] 构建或获取一个插件，其声明了带有有效 `PluginConnectorDef` 的
      `manifest.connectors[]`（参见 [用插件扩展](/docs/connectors/extending-with-plugins)）。
- [ ] 通过 设置 → 插件 安装该插件。
- [ ] 确认插件适配器出现在适配器列表中。
- [ ] 禁用该插件。确认适配器从列表中被移除。

---

## §11 —— 审计日志

- [ ] 在不同适配器上执行若干入站/出站流程。
- [ ] 打开 设置 → 平台连接 → 审计 选项卡。
- [ ] 确认每个事件都有时间戳、`adapterId`、`kind`（`inbound.received`、
      `outbound.enqueued`、`outbound.delivered`、`outbound.failed`）以及消息。
- [ ] 确认该表上限为 5 000 行（添加一个脚本插入 5 001 行，
      并确认下一次写入时最旧的一行被剪除）。

---

## §12 —— 通过调度器进行定时出站

- [ ] 打开调度器 UI。创建一个类型为 `connection:outbound:send`
      的任务，载荷为：
  ```json
  {
    "adapterId": "<your_adapter_id>",
    "conversationKey": "<conversation_key>",
    "segments": [{ "type": "text", "text": "Scheduled greeting" }]
  }
  ```
- [ ] 触发该任务（立即运行）。
- [ ] 确认消息在 30 秒内投递到平台。
- [ ] 确认写入了一条 `outbound.enqueued` 审计条目。

---

## 已推迟（仅限 Phase 1+）

以下条目已被明确推迟，**不得**阻塞本次发布：

| 推迟的条目                                                          | 跟踪                                            |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| 完整 Playwright E2E（`pnpx playwright test`）                       | 需要 `pnpm add -D @playwright/test express`     |

---

## 签核

| 角色        | 姓名 | 日期 | 状态   |
| ----------- | ---- | ---- | ------ |
| 实现者      |      |      |        |
| 评审者      |      |      |        |
| QA          |      |      |        |
