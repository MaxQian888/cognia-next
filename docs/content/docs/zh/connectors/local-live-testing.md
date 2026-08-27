---
title: "本地真实平台测试"
description: "用真实的 Telegram / Slack / Discord / 飞书 / Matrix 会话驱动你已配置的 Cognia Bot，模型端换成确定性 Fixture。"
---

# 本地真实平台测试

仓库里其它连接器测试至少有一端是假的：mock E2E 假的是平台；`scripts/lark-live-smoke.mts`
打的是真飞书 API，但只覆盖出站，且用 Node 替换了 Tauri。它们都没证明你真正在意的那件事：
一条真实消息，由真实平台推送，经过真实传输层（飞书长连接和所有 Webhook 签名都在 Rust 侧），
过完真实的准入门禁与 PII Gate，再作为一条真实回复发回来。

这套工具补的就是这个闭环。唯一被替换的是模型：用确定性 Fixture 顶替 Anthropic，
断言因此稳定，跑多少次都不花钱。

```text
测试身份 → 真实 IM 平台 → 你已配置的 Cognia Bot → Connector 入站
→ 准入 + PII Gate → 确定性模型 Fixture → Connector 出站
→ 真实 IM 平台 → 测试身份观察到回复
```

## 需要准备什么

每个平台两个身份——负责发消息的**驱动方**，和你已经在 Cognia 里跑着的**目标 Bot**——
外加一个只有这两者在场的专用会话。驱动方不复用 Cognia 自己的 Adapter 代码，
而是直接调平台 API：否则同一个缺陷会在两侧同时出现，互相抵消成一次假绿。

目标 Bot 必须已经配置好、已启用，并在该会话里处于自动回复模式。
这套工具**从不写入**你的数据库、Keyring 或 Connector 配置。

## 命令

```bash
pnpm im:test:target
```

终端 1。先起一个只监听回环的模型 Fixture，再以 `ANTHROPIC_BASE_URL` 指向它的方式
启动 `pnpm tauri dev`。保持它运行。它会写出 `test-results/im-live/target.json`（权限 `0600`），
Runner 靠这个文件找到 Fixture 并通过其控制面鉴权。

```bash
pnpm im:test:doctor -- --platform telegram
```

终端 2。只做预检，不发任何消息：校验驱动方身份确实不同于目标、凭据形态正确、
会话可达、Fixture 在线。

```bash
pnpm im:test:live -- --platform telegram
```

P0 场景。`--platform all` 跑全部平台（五个平台没配齐时会直接拒绝启动；
加 `--allow-unconfigured` 则跑已配置的，其余记为 `NOT_CONFIGURED`）。

另外两条命令不需要凭据，也不需要应用在跑：

```bash
pnpm im:test:unit
```

```bash
pnpm im:test:contract
```

`im:test:unit` 覆盖工具自身。`im:test:contract` 聚合既有的连接器传输、契约、去重与限流套件。
有一处它**没有**覆盖到，需要知道：`slack/transport-socket-mode.test.ts` 没有断线重连用例，
而 Discord 和 Matrix 都有——contract 全绿并不等于协议全覆盖。Rust 那一半
（`crates/cognia-connectors/src/sigverify/` 的签名校验与 `replay_guard.rs` 的防重放）
由 `cargo test` 覆盖，不在这两条脚本里。

## P0 场景做了什么

1. 取一把每会话的锁，避免两个 Runner 互相污染。
2. 跑 `doctor`。失败就到此为止，一条消息都不会发出去。
3. 清空 Fixture 的请求日志。
4. **第一轮**——用不可预测的标记 `cognia-e2e:<platform>:<runId>:turn-1` @ 目标 Bot。
5. **并发**等待两件事：Fixture 捕获到该标记，以及 Bot 的回复出现在会话里。
6. **第二轮**——回复 Bot 自己那条消息。两轮不是同一个测试：
   `lib/connectors/conversation-admission.ts` 对群消息的准入条件是
   `selfMentioned` **或** `isReplyToSelf`，两轮各打中一条路径。
7. 再观察 10 秒。同一轮出现第二条回答就是重复消费失败。
8. 删除测试消息（`IM_LIVE_KEEP=1` 可保留现场）。
9. 把脱敏证据写到 `test-results/im-live/<runId>/<platform>.json`——
   消息 ID、各阶段耗时、标记事实、Fixture 命中情况，**不含消息正文**。

## 配置

写进 `.env.im-live.local`（`.gitignore` 已覆盖），或直接用环境变量传入。
每个字段都显式指定自己的变量名，因此任何平台都不可能拿到另一个平台的凭据。

```bash
# Telegram
IM_LIVE_TELEGRAM_DRIVER_BOT_TOKEN=
IM_LIVE_TELEGRAM_TARGET_CHAT_ID=
IM_LIVE_TELEGRAM_TARGET_BOT_USERNAME=
# IM_LIVE_TELEGRAM_API_BASE=https://api.telegram.org   # 例如 Test DC

# Slack —— 必须是用户 Token（xoxp-），不能是 Bot Token，原因见下。
IM_LIVE_SLACK_DRIVER_USER_TOKEN=
IM_LIVE_SLACK_TARGET_CHANNEL_ID=
IM_LIVE_SLACK_TARGET_BOT_USER_ID=

# Discord
IM_LIVE_DISCORD_DRIVER_BOT_TOKEN=
IM_LIVE_DISCORD_TARGET_CHANNEL_ID=
IM_LIVE_DISCORD_TARGET_BOT_USER_ID=

# 飞书 / Lark
IM_LIVE_LARK_DRIVER_APP_ID=
IM_LIVE_LARK_DRIVER_APP_SECRET=
IM_LIVE_LARK_TARGET_CHAT_ID=
IM_LIVE_LARK_TARGET_BOT_OPEN_ID=

# Matrix
IM_LIVE_MATRIX_HOMESERVER=
IM_LIVE_MATRIX_DRIVER_ACCESS_TOKEN=
IM_LIVE_MATRIX_TARGET_ROOM_ID=
IM_LIVE_MATRIX_TARGET_USER_ID=

# 可选
# IM_LIVE_TURN_TIMEOUT_MS=120000
# IM_LIVE_DUPLICATE_WINDOW_MS=10000
# IM_LIVE_KEEP=1
```

这些值不会被打印，也不会落盘：Secret 会注册进脱敏器，常见 Token 形态即使出现在
平台自己的报错文本里也会被拦下。

## 会咬人的前置条件

下面这些失败看起来像产品坏了，其实不是。`doctor` 能看到的都会拦；
剩下的列在这里，因为 Runner 是另一个进程，读不到你应用内的配置。

### 所有平台通用

- **同平台只保留一个启用中的 adapter**，或者确保所有同平台实例都已完成身份探测。
  当同平台存在第二个「身份未确认」的启用中 adapter 时，兄弟 Bot 反环门
  （`lib/connectors/bus.ts` step 9.6）会 **fail-closed**：驱动方消息只记入历史，
  AI 轮次根本不会跑。表现和传输层挂掉一模一样。
- **群里必须 @ 目标 Bot**（第一轮）或回复它（第二轮）。
  确认该会话的触发策略不是「只在别的 scope 生效」。
- **把当前 Provider 的自定义 Base URL 置空**，或指向 Fixture。
  金库里配置的 Base URL 会覆盖 `pnpm im:test:target` 注入的那个
  （`src-tauri/src/claude/host.rs` 的 `inject_provider_env`），这一轮就会走真模型。
  这种情况会被报成 `MODEL_NOT_INTERCEPTED`，绝不会算通过。

### Telegram

- 为驱动方开启 **Bot-to-Bot**。
- **关掉驱动方 Bot 的隐私模式**（@BotFather → `/setprivacy` → Disable，
  然后把它移出群再加回去）。隐私模式开着时，驱动方能发消息，但永远**看不到**目标的回复。
  `doctor` 会检查这一项。
- 驱动方 Token 不能同时被别的消费者占用——`getUpdates` 与已注册的 Webhook 互斥，
  第二个轮询者会抢走更新。`doctor` 会检查是否注册了 Webhook。

### Slack

- 驱动方**必须**是用户 OAuth Token。`lib/connectors/adapters/slack/parse.ts`
  会无条件丢弃一切带 `bot_id` 的事件，所以第二个 Slack App 永远打不到目标。
  `doctor` 会直接拒绝 Bot Token。
- 驱动方用户必须已加入该频道。

### Discord

- 目标 Bot 需要 **`MESSAGE_CONTENT`** 特权 Intent，否则它收到的消息正文是空的。
- 驱动方 Bot 在该服务器需要 View Channel + Send Messages 权限。

### 飞书 / Lark

- 目标应用需要 **include-bot 类权限**，才能收到其它 Bot 的群消息。
- **权限、事件订阅、机器人能力的变更都需要发布新应用版本**才生效。
  改完配置后收不到事件，通常是版本没发布，而不是代码问题。
- 单应用最多 50 条长连接，且集群模式下是**随机投递给其中一条而非广播**——
  绝不要对同一个 App ID 并发跑两个 Runner。

### Matrix

- 使用**未加密房间**。本工具发送明文事件；`doctor` 会直接拒绝加密房间，
  而不是让这次运行白白超时。
- 驱动方账号必须已加入该房间。

## 运行失败之后

Runner 只能看到两件事：Prompt 有没有到达 Fixture，以及 Bot 往会话里发了什么。
它读不到你应用内的 audit 行。所以它不猜单一原因，而是把这两个观测映射成一个结论 + 一份候选清单：

| Fixture 命中 | Bot 回复 | 结论 | 含义 |
| --- | --- | --- | --- |
| 否 | 否 | `TIMEOUT` | 消息在 AI 轮次之前就被丢弃了。候选：传输未连接；兄弟 Bot 反环门 fail-closed；群里没 @ 到；chat 白/黑名单；静默时段；PII Gate（`reason: "pii_blocked"`）。 |
| **否** | **是** | **`MODEL_NOT_INTERCEPTED`** | 闭环是通的，但回答来自**真实模型**，并且真的计费了。原因是金库里的 Provider 覆盖了 Base URL、这一轮带了冻结执行规格（`sidecar/dispatch/subprocess-env.mjs` 会按白名单重建子进程环境），或者应用是用普通的 `pnpm tauri dev` 启动的。 |
| 是 | 否 | `FAIL` | 模型跑过了，出站失败。检查出站队列死信、Bot 的发言权限、以及熔断器。 |
| 是 | 标记不对 | `FAIL` | 这条回复属于别的轮次——通常是有第二个 Runner，或有人在同一个会话里说话。 |
| 是 | 两条带标记的回复 | `FAIL` | 入站事件被消费了两次，或者两个 Bot 在互相回答。 |

每条候选都会连同实现该规则的文件一起打印，你可以直接去读真正的门禁，而不是只信这份清单。
证据文件保留了平台消息 ID，失败之后仍然可以去会话里把消息找出来。

## 覆盖范围

已覆盖：各平台主传输上的文本闭环（Telegram 长轮询、Slack Socket Mode、Discord Gateway、
飞书长连接、Matrix `/sync`）。

未覆盖：次要传输（Webhook 与 Discord Interaction HTTP 留在契约测试里）、
媒体与附件、按钮 / 卡片 / Modal、安装与 OAuth 流程、Matrix E2EE、真实模型的回答质量、
以及公网 Webhook 隧道。事件重放、断线与 Resume 无法从平台侧主动制造，
因此留在 `pnpm im:test:contract`，而不是在这里假造。
