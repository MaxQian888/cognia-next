# IM Bot 自动化测试支持横向调研

> 日期：2026-08-27  
> 范围：Slack、Discord、Telegram、钉钉、企业微信、微信公众号、个人微信、QQ 官方机器人、OneBot、Matrix；飞书仅作为比较基线。  
> 证据口径：仅使用各平台官方文档、官方 SDK/规范仓库和本仓库实现。OneBot 按协议生态而非官方平台处理。

## 结论

如果目标是验证 Cognia 的完整链路——“真实平台消息 → transport → parser/gate/bus → AI → 平台回复”——各平台并不在同一自动化等级：

1. **Matrix 最适合作为持续集成基准平台**：可在每个 CI job 内启动隔离 homeserver，用两个普通 Matrix client 真实走 `/sync` 与 room send；官方 Complement 已证明这种黑盒测试模型可行。
2. **Telegram、Slack、Discord、飞书适合受控 live CI/nightly**：都有无需模拟用户协议的 driver-bot 路径；Telegram 还有独立 Test DC，Slack 有正式 Developer Sandbox，Discord 用专用 test guild，飞书用测试企业。
3. **QQ 官方机器人隔离能力强，但无人值守入站能力弱一档**：官方有独立沙箱 API 和沙箱成员/频道/群，然而官方发布流程仍要求在测试频道提交人工自测报告；未发现代表普通 QQ 用户发送入站消息的官方自动化 API。
4. **钉钉、企业微信、微信公众号的 transport 很容易做本地协议测试，但真实用户入站仍主要依赖测试账号或客户端操作**。它们没有发现等价于 Telegram Bot-to-Bot、Slack 第二 App 或 Matrix 第二 Client 的明确官方 driver 契约。
5. **OneBot 的“协议 E2E”很好测，“真实 QQ E2E”不是一回事**：Cognia 已能用反向 WebSocket stub 完成全链路自动 smoke，但这只证明 OneBot 协议和 Cognia wiring，不证明 NapCat/Lagrange 后面的真实 QQ 客户端状态。
6. **个人微信不应进入常规 CI**：Cognia 的 iLink 路径不是公开的官方个人号 Bot API，需要二维码登录，依赖真实个人账号且有封号风险；只适合隔离备用号的人工/低频 canary。

没有一个中心化平台提供“任意历史事件按 ID 重放为一次新的真实平台投递”的通用能力。正确的测试体系必须把**本地 fixture/transport E2E**与**真实平台 live ingress**分层，不能把前者称为平台 E2E。

## 总览

### 自动化等级

| 平台             | 官方隔离环境                                 | 本地 transport                                | 无人值守真实入站 driver                            | 主动 replay                    | CI 建议                            | 综合等级            |
| ---------------- | -------------------------------------------- | --------------------------------------------- | -------------------------------------------------- | ------------------------------ | ---------------------------------- | ------------------- |
| **Matrix**       | 自建一次性 homeserver；官方 Complement       | `/sync` / Client API / AppService             | 第二 Matrix user/bot 直接发 room event             | 无历史 replay；可重建容器/事件 | 每 PR 可跑                         | **A**               |
| **Telegram**     | 独立 Test DC + 独立 Bot API `/test/`         | long polling / webhook / Local Bot API server | 当前官方 Bot-to-Bot Communication Mode             | 无                             | nightly；少量 PR smoke             | **A-**              |
| **Slack**        | 正式 Developer Sandbox                       | Socket Mode / Events API HTTP                 | 第二 Slack App `chat.postMessage` 驱动 `message.*` | 无                             | nightly；Socket Mode 优先          | **A-**              |
| **飞书（基线）** | 测试企业 + 测试应用                          | 长连接 / webhook                              | 第二 bot + include-bot 权限                        | 无                             | nightly，双 transport              | **A-**              |
| **Discord**      | 专用 test guild；不是独立 DC                 | Gateway / Interactions HTTP                   | 第二 bot Create Message → `MESSAGE_CREATE`         | 无                             | nightly；消息 lane 自动化          | **B+**              |
| **QQ 官方**      | 官方沙箱频道/群/私聊成员 + 独立 API endpoint | Gateway / webhook                             | 未发现普通用户身份注入 API                         | 无                             | 沙箱 nightly + 人工发布前验收      | **B**               |
| **钉钉**         | 测试组织内的企业内部应用；无专用沙箱证据     | Stream Mode WSS；旧式 callback/webhook        | 第二 bot 是否能稳定触发目标 bot 未被官方明确保证   | 无                             | transport CI + 测试组织 UAT        | **B-**              |
| **企业微信**     | 独立测试企业/机器人；无可重置沙箱证据        | 智能机器人长连接，可切自定义 `wsUrl`          | 未发现 bot-to-bot 或用户消息注入 API               | 无                             | mock-WS CI + 测试企业 UAT          | **B-**              |
| **微信公众号**   | 官方接口测试号                               | webhook XML + 签名/加密                       | 仍需真实微信用户给测试号发消息                     | 无                             | signed-fixture CI + 低频真号 smoke | **C+**              |
| **OneBot**       | 协议本身无租户；可自建 stub                  | forward/reverse WebSocket                     | 协议事件可直接注入；真实 QQ 仍需实现端/账号        | 可本地重放 JSON                | 协议 smoke 每 PR；真实 QQ nightly  | **协议 A / 平台 C** |
| **个人微信**     | 无官方 Bot 沙箱                              | iLink HTTP long polling                       | 无；需真实个人号/联系人                            | 无                             | 仅人工 canary                      | **D**               |

“无人值守真实入站”只计平台真实产生并投递的事件；直接把 JSON POST 到 Cognia、本地 WebSocket stub 或 parser fixture 都只计协议/接缝测试。

## 各平台

### 1. Slack

#### 官方测试与 transport

Slack 提供正式 **Developer Sandbox**：它是与其他 workspace 数据隔离的 Enterprise org 环境，面向开发和应用测试。加入 Slack Developer Program 后即可申请；没有付费计划时需提供支付方式作身份验证但不会扣费。当前限制包括最多 2 个 active sandbox、默认存活 6 个月、每个 sandbox 最多 5 个 workspace、8 个用户（bot/app 不计）、每 workspace 最多 20 个 integration。[Developer Sandboxes](https://docs.slack.dev/tools/developer-sandboxes/)

事件接入可用公开 HTTPS Events API，或用 Socket Mode 通过 `apps.connections.open` 建立出站 WebSocket；Socket Mode 不需要 Request URL，很适合受控 CI。两者承载同一 Events API/interactive payload，启用 Socket Mode 后不会再经 HTTP Request URL 投递。[Events API](https://docs.slack.dev/apis/events-api/) · [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)

#### 自动触发与 replay

推荐两个 App：driver app 用 `chat.postMessage` 向专用频道写入带 `runId` 的消息，target Cognia app 订阅 `message.channels`/`message.groups`/`message.im`。Slack 的 message event 明确区分 bot message，消息对象可带 `bot_id`/`bot_profile`；因此“第二 App 发送 → target 收到 message event”可作为无人值守 driver。对 `app_mention` 的 bot-origin 行为不要作唯一依赖，P0 应以 `message.*` 为主。[Message event](https://docs.slack.dev/reference/events/message/) · [`bot_message` subtype](https://docs.slack.dev/reference/events/message/bot_message/) · [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage)

未发现官方任意事件注入或历史 event replay API。HTTP receiver 可在本地重放带正确 HMAC 的 fixture；Node SDK 的 `WebClient` 支持替换 `slackApiUrl` 和 `fetch`，Python SDK 官方仓也用 mock Web API server，但这些只验证 SDK/receiver 接缝。[Node WebClient injection](https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/src/WebClient.ts) · [Python SDK test patterns](https://github.com/slackapi/python-slack-sdk)

#### 客户端缺口与限制

Slash command、shortcut、Block Kit 按钮、modal、App Home、安装/OAuth UI 和最终客户端渲染仍需真人或客户端自动化。Events API 要在 3 秒内 2xx；失败会按近即时、1 分钟、5 分钟最多重试 3 次；事件上限为每 workspace/app 每 60 分钟 30,000 次。消息发送通常按每频道约 1 条/秒控制，429 必须遵循 `Retry-After`。[Events API retries](https://docs.slack.dev/apis/events-api/) · [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)

### 2. Discord

#### 官方测试与 transport

Discord 没有独立 sandbox/DC。官方建议 server-installable app 在“不被其他人使用的 test server”开发，并把 user-installable app 同时安装到自己的账号测试 DM。测试 guild 仍运行在正式 Discord 基础设施。[Getting Started：test server](https://docs.discord.com/developers/quick-start/getting-started)

普通消息、成员、reaction 等实时事件走 Gateway WebSocket；Interactions 可由 Gateway 或 HTTP interactions endpoint 接收。配置 HTTP endpoint 时平台会发 `PING` 验证 Ed25519 handler，但 endpoint 不是普通 `MESSAGE_CREATE` 的替代入口。[Gateway](https://docs.discord.com/developers/events/gateway) · [Interactions overview](https://docs.discord.com/developers/interactions/overview) · [Receiving interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)

#### 自动触发与 replay

driver bot 可调用 Create Message 向共同 test guild channel 发消息；官方契约说明创建消息会产生 `MESSAGE_CREATE` Gateway event，而 message author 可以是 bot user，所以 target bot 可无人值守收到。Cognia 的 parser 也只丢弃自身 echo，明确保留其他 bot 的消息。该结论是两条官方契约的组合推导，不是 Discord 专门命名的“bot-to-bot testing”产品。[Create Message](https://docs.discord.com/developers/resources/message#create-message) · [Gateway events](https://docs.discord.com/developers/events/gateway-events) · [Cognia self-echo guard](../../lib/connectors/adapters/discord/parse.ts)

未发现 Gateway dispatch 或 interaction 的官方注入/replay API。官方 `discord-interactions` 只提供类型、签名校验和 HTTP middleware，不是 Discord emulator；本地固定 key/fixture 只覆盖 interaction receiver。[discord-interactions-js](https://github.com/discord/discord-interactions-js) · [Community resources](https://docs.discord.com/developers/developer-tools/community-resources)

#### 客户端缺口与限制

Bot 不能通过官方 API 代表普通用户调用 slash/user/message command、点击 component 或提交 modal；这些仍需真实用户客户端。target 读取普通消息正文需要 `MESSAGE_CONTENT` privileged intent。Gateway 每连接每 60 秒最多 120 个 outbound event；IDENTIFY 有全局日限额和并发控制；REST 使用 route bucket + global limits；interaction 初始响应必须在 3 秒内，token 有效 15 分钟。[Gateway limits](https://docs.discord.com/developers/events/gateway) · [HTTP rate limits](https://docs.discord.com/developers/topics/rate-limits) · [Interaction response timing](https://docs.discord.com/developers/interactions/receiving-and-responding)

### 3. Telegram

#### 官方测试与 transport

Telegram 有真正独立的 **Test DC**。测试环境要新建测试用户和 `@BotFather` bot，并把 Bot API 请求发到 `https://api.telegram.org/bot<TOKEN>/test/METHOD_NAME`；测试环境与生产完全分离。官方也建议为普通开发另建 test bot。Test DC 不会放宽 flood limits，甚至可能更严格。[Testing your bot / Dedicated test environment](https://core.telegram.org/bots/features#testing-your-bot)

Update 通过 `getUpdates` long polling 或 webhook 获取，二者互斥。long polling 不需要公网入口，最适合 CI；官方开源 Local Bot API server 仍连接 Telegram DC，不是离线 fake Telegram。[Bot API updates](https://core.telegram.org/bots/api#getting-updates) · [Bots FAQ](https://core.telegram.org/bots/faq#getting-updates) · [Local Bot API server](https://github.com/tdlib/telegram-bot-api)

#### 自动触发与 replay

当前官方已提供 **Bot-to-Bot Communication Mode**，不能再沿用旧的“bot 永远看不到 bot”结论：

- 群聊中，driver bot 可用 `/command@TargetBot` 或直接回复 target bot；至少一方打开 mode 时 target 可收到；target 打开 mode 且为群管理员或关闭 Group Privacy 后还能收到其他 bot 的普通群消息。
- 私聊中双方打开 mode 后，driver bot 可把 target 的 `@username` 作为 `sendMessage` 目标。

这使“Test DC + 两 bot + long polling”成为非常强的无人值守 ingress lane，但必须对 bot loop 设置深度、sender allowlist 和 runId 去重。[Bot-to-Bot Communication](https://core.telegram.org/bots/features#bot-to-bot-communication) · [Telegram API Bot-to-Bot](https://core.telegram.org/api/bots/bot-to-bot)

未发现任意 update 注入/replay API。`getUpdates` 最多返回 100 个未确认 update，offset 只是确认队列游标，不是历史重放。Telegram 也没有官方语言级 mock bot framework；Cognia 应继续用自身 fixture/HTTP seam 覆盖异常分支。[Bots FAQ：getUpdates](https://core.telegram.org/bots/faq#getting-updates)

#### 客户端缺口与限制

Inline keyboard 点击、Web App、LoginUrl、支付、联系人/位置分享和最终 UI 仍需真实客户端。常用发送约束是单 chat 约 1 条/秒、群 20 条/分钟、免费 bulk 约 30 条/秒；测试环境也必须处理 429 和 retry。Webhook 与 polling 不能同时运行。[Broadcast limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)

### 4. 钉钉

#### 官方测试与 transport

未发现独立、可重置的钉钉 Bot sandbox。官方 Stream SDK 的调试流程是：在自己的组织中创建企业内部应用，添加机器人能力，选择 Stream 模式并发布，再以 Client ID/Secret 启动示例。因此应使用独立测试组织/内部应用，而不是生产应用。[DingTalk Stream SDK Node README](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)

Stream Mode 通过出站 WebSocket 接收事件、机器人消息和卡片回调，不需要公网 callback URL。官方 Node SDK 还明确实现了 handler 背压：默认 event/callback 各最多 100 个 pending handler；event 过载返回 `LATER`，callback 过载不 ACK 以等待服务端重投。[DingTalk Stream SDK Node](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)

#### 自动触发、mock 与 replay

钉钉 OpenAPI 能让企业机器人发送群消息/单聊消息，官方能力中心也列出创建机器人、加群、发送和撤回能力；但未找到官方文档明确保证“机器人 A 发出的消息会作为机器人 B 的 bot-directed Stream inbound”。因此不能在 P0 CI 中无条件采用双 bot driver，应先用测试组织实测并把该能力做成 probe；失败时回退到专用测试用户/真实客户端。[DingTalk Open Platform](https://open.dingtalk.com/) · [Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)

未发现平台事件 replay API。官方 Node SDK 自己的 `lifecycle-mock.mjs`、`reconnect-mock.mjs` 和 `nock` 测试证明本地 fake gateway/HTTP 是受支持的 SDK 测试方式；这适合 Cognia transport protocol lane，不证明真实钉钉投递。[SDK package/test scripts](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/package.json) · [SDK test directory](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/tree/main/test)

#### 客户端缺口

普通用户单聊/群 @、卡片点击、机器人安装/发布、权限与客户端渲染仍需真实钉钉客户端。CI 应串行复用单个测试应用连接，按 SDK ACK/LATER 语义注入背压和重投 fixture；不要把 SDK 默认并发数误当成平台固定吞吐限额。

### 5. 企业微信（WeCom 智能机器人）

#### 官方测试与 transport

未发现面向智能机器人的临时 sandbox/test tenant 产品；实务上只能使用独立测试企业和专用智能机器人。官方 `WecomTeam` Node SDK 证明标准接入是 `wss://openws.work.weixin.qq.com` 长连接，以 BotID + Secret 订阅，提供消息、事件、流式回复、欢迎语、模板卡片、媒体和主动推送。[WeCom AI Bot Node SDK](https://github.com/WecomTeam/aibot-node-sdk)

SDK 允许覆盖 `wsUrl`、logger、heartbeat、request timeout 和重连参数；默认心跳 30 秒、请求 timeout 10 秒、指数退避最高 30 秒。这是很好的本地 fake-WS seam。官方 package 自带 Vitest，但没有提供可代表企业微信服务端业务语义的独立 emulator/test tenant。[SDK README](https://github.com/WecomTeam/aibot-node-sdk) · [SDK package](https://github.com/WecomTeam/aibot-node-sdk/blob/main/package.json)

#### 自动触发与 replay

协议有 `aibot_send_msg` 主动推送，但未找到官方契约说明由另一个机器人主动发出的消息会成为 target 智能机器人的 inbound callback，也未发现普通用户身份消息注入 API。因此双 bot 只能作为待验证 probe，不能作为默认 CI 前提。未发现事件 replay API。

真实 UAT 仍需企业微信用户先与机器人建立会话，触发单聊/群聊消息、`enter_chat`、模板卡片和 feedback。CI 可稳定覆盖鉴权、心跳、ACK、断线重连、流式帧和卡片帧；真实平台 lane 建议 nightly 且保留人工/客户端 driver。

### 6. 微信公众号

#### 官方测试与 transport

微信公众平台提供正式**接口测试号**，可获得测试 AppID/AppSecret、配置 URL/Token，并让测试用户扫码关注；它适合在没有正式认证公众号时调试接口。另有“公众平台接口调试工具”调用 OpenAPI，但它不是入站用户消息生成器。[接口测试号申请](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Requesting_an_API_Test_Account.html) · [测试号登录](https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login) · [接口调试工具](https://mp.weixin.qq.com/debug/cgi-bin/apiinfo)

入站是微信服务器向 URL POST XML；消息接收文档规定服务端需及时响应，否则平台会重试。Cognia 的 safe mode 还必须覆盖 timestamp/nonce/signature、`msg_signature`、AES 解密、XML parse 和重复消息去重。[接收普通消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)

#### 自动触发与 replay

没有官方 bot-to-bot，也没有代表普通微信用户向测试号发消息的 server API；因此真实入站仍需测试微信账号在客户端发送。OpenAPI 调试工具只能调服务端 API，不能替代用户消息。未发现历史 callback replay。

本地可用固定 Token/EncodingAESKey 构造明文与密文 XML，POST 到 Cognia webhook；这是最稳定的 CI seam。客服消息受用户交互窗口约束，常见 48 小时窗口必须在真号 smoke 中验证，不应只断言 API HTTP 200。[客服消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html)

#### 客户端缺口

关注/取消关注、菜单点击、扫码、模板消息展示、用户文本/媒体和 48 小时窗口只能通过真实微信客户端高保真覆盖。推荐接口测试号 + 专用微信测试用户 + 低频客户端自动化/人工验收；不要把个人号自动化协议用于该 lane。

### 7. 个人微信

Cognia 的 Personal WeChat adapter 使用 `https://ilinkai.weixin.qq.com` 的二维码登录与 HTTP long polling，但在本次官方微信开放平台资料中没有找到面向个人微信号的公开 Bot API、测试租户、事件注入、bot-to-bot 或 replay 能力。本仓库 ADR 也明确把它定义为非官方/半官方 gateway、reply-only，并要求展示封号风险。[Cognia ADR-0036](../content/docs/en/adr/0036-wechat-wecom-connectors.md) · [Setup guide](../content/docs/en/connectors/wechat-personal-setup.mdx)

该 adapter 的 auth/protocol/index tests 已能用 injected HTTP 覆盖二维码状态、cursor、`ret -14` session expiry、`context_token` 回复和媒体解密；这应是常规 CI 的全部范围。[Adapter tests](../../lib/connectors/adapters/wechat-personal)

真实测试只能用无支付、无关键联系人、可丢弃的隔离备用号，并由另一个真实微信账号发消息。二维码确认、session 续期、客户端展示和账号风控无法由官方自动化接口验证。建议只做显式 opt-in 的人工 canary，不进 PR gate，也不允许使用生产主号。

### 8. QQ 官方机器人

#### 官方沙箱

QQ 开放平台提供真实沙箱：可配置沙箱频道、群和私聊成员，成员总数不超过 20；沙箱使用独立 endpoint `https://sandbox.api.sgroup.qq.com`，沙箱 API/事件与正式环境隔离。它是本次国内平台中最明确的官方测试环境。[QQ Bot 官方 Wiki](https://bot.q.qq.com/wiki/)

官方发布流程仍要求开发者在测试频道完成自测并提交自测报告，说明沙箱解决了隔离，不等于官方提供无人值守场景编排器。Cognia 可分别验证 Gateway WSS 与 webhook/Ed25519 transport，但发布前仍应保留真实 QQ 客户端验收。[QQ Bot 官方 Wiki](https://bot.q.qq.com/wiki/)

#### 自动触发、replay 与限制

未发现官方 API 能代表普通 QQ 沙箱成员发起 C2C/群/频道入站，也未发现任意事件 replay。若第二个 QQ bot 能否稳定触发 target bot 没有明确官方契约，则不能把它当作默认 driver；优先以真实沙箱账号完成用户消息、@、回复、富媒体和权限场景。

本地可用 Gateway dispatch fixture 或带正确 Ed25519 签名的 webhook fixture 覆盖 READY/RESUME/heartbeat、opcode、intent、签名、重复 event 和 invalid-session；真实沙箱 lane 应按官方返回的 session/start-limit 与 API rate-limit 信息动态退避，不硬编码固定吞吐。

### 9. OneBot

OneBot 是机器人应用接口标准/生态，不是 QQ 官方平台，也没有官方租户或平台级 sandbox。v11/v12 规范定义 event/action/echo 和 HTTP/WebSocket transport；具体 QQ 连接由 NapCat、Lagrange、LLOneBot 等实现承担。[OneBot 11](https://github.com/botuniverse/onebot-11) · [OneBot 12](https://12.onebot.dev/) · [NapCatQQ](https://github.com/NapNeko/NapCatQQ)

它是最容易做**协议级**自动化的平台：测试端直接作为 reverse-WS client 连 Cognia，发送 `post_type=message` JSON，接收 `send_private_msg`/`send_group_msg` action，并以 `echo` 回响应。事件 fixture 可任意重复、乱序、延迟和断线重放；OneBot 标准本身没有全局 rate limit，限制来自具体实现和上游 QQ。

但这个结果只证明：

```text
OneBot JSON/WS → Cognia ingress → AI → OneBot action
```

它不证明：

```text
真实 QQ 客户端 → NapCat/Lagrange 登录态与风控 → OneBot → Cognia → 实现端 → QQ
```

因此应保留两条 lane：每 PR 跑 hermetic protocol smoke；低频在隔离 QQ 账号上跑真实实现端 canary。不要把 OneBot 的成功归类为“QQ 官方支持通过”。

### 10. Matrix

#### 官方测试模型

Matrix 是开放协议，可以为每个 CI job 启动一次性 homeserver，而不依赖供应商 sandbox。官方 **Complement** 是 homeserver 黑盒集成框架：按 Blueprint 启动一个或多个 Docker homeserver，预建 user/room，再通过 Client-Server API 发请求和断言；测试结束销毁 deployment。它提供了本次调研中最接近“可重置真实 IM 环境”的能力。[Complement README](https://github.com/matrix-org/complement) · [Complement onboarding](https://github.com/matrix-org/complement/blob/main/ONBOARDING.md)

Cognia 当前是普通 Matrix client：用 access token 调 `/sync` long poll，而不是 Application Service。driver user 通过 `PUT /rooms/{roomId}/send/{eventType}/{txnId}` 写入带 `runId` 的 `m.room.message`，target Cognia client 真实从 `/sync` 收到；`txnId` 提供发送幂等。两个 bot 只是两个普通 Matrix user，天然支持 bot-to-bot。[`/sync`](https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3sync) · [Send event](https://spec.matrix.org/v1.18/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid)

#### Replay、SDK seam 与限制

Matrix 没有把历史 event 再投递成新 event 的通用 API，但本地 homeserver 可以重建容器或重新发送等价 event。若未来支持 Application Service，homeserver 会以 `PUT /_matrix/app/v1/transactions/{txnId}` 推 transaction，txnId 也用于重试幂等。[Application Service transactions](https://spec.matrix.org/v1.18/application-service-api/#put_matrixappv1transactionstxnid)

官方 Matrix SDK 仓包含 mock server/testing helpers；更高一层直接使用 Complement 即可覆盖真实 homeserver。E2EE 应另用 crypto-capable client 或 Complement Crypto，不能用未加密 room 的成功推断加密 room 正常。[matrix-rust-sdk mock usage](https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk/src/client/builder/mod.rs) · [Complement Crypto](https://github.com/matrix-org/complement-crypto)

自建 homeserver 没有第三方租户级固定速率，具体限流由实现/配置决定；客户端仍必须处理 `M_LIMIT_EXCEEDED`/`retry_after_ms`。UI 渲染、push、SSO、Widget、语音视频需客户端测试；标准未加密消息、thread、reaction、edit/redaction 都可 headless 自动化。

## Cognia 当前测试现状

### 已有基础

每个 adapter 都已有 co-located parse/serialize/contract/transport tests。截至 2026-08-27 的 `*.test.ts` 数量如下：

| adapter         | test files | 代表性 transport 测试                                                                     |
| --------------- | ---------: | ----------------------------------------------------------------------------------------- |
| telegram        |         15 | `transport-longpoll.test.ts`、`transport-webhook.test.ts`、`webhook-registration.test.ts` |
| discord         |         12 | `gateway-client.test.ts`、`transport-webhook.test.ts`                                     |
| slack           |         16 | `transport-socket-mode.test.ts`、`transport-webhook.test.ts`                              |
| qq-official     |         10 | `gateway-client.test.ts`、`transport-webhook.test.ts`                                     |
| onebot          |         15 | reverse/forward WS + v11/v12 + inbound reply/forward                                      |
| wecom           |         14 | `protocol.test.ts`、`live-connection.test.ts`                                             |
| wechat-oa       |          8 | `transport-webhook.test.ts`、auth/parse/contract                                          |
| wechat-personal |         11 | auth/protocol/index/media/parse/contract                                                  |
| dingtalk        |          8 | `stream-client.test.ts`、auth/parse/contract                                              |
| matrix          |         12 | `transport-sync.test.ts`、auth/e2ee/token rotation                                        |
| lark（基线）    |         35 | long connection + webhook + OpenAPI/card/OAuth                                            |

源目录：[built-in adapters](../../lib/connectors/adapters)。这些测试证明 parser、serializer、鉴权、退避、cursor、opcode/ACK 和错误映射，但不会证明真实平台的权限、应用发布状态、测试租户配置和网络投递共同成立。

### 当前 live 覆盖

1. [`telegram-bidirectional.spec.ts`](../../tests/e2e/tauri/telegram-bidirectional.spec.ts) 已有 **mock full-path E2E**：本地 Telegram Bot API mock 提供 `getUpdates`/`sendMessage`，Tauri adapter 轮询 synthetic update → mock AI → outbound runner → mock server 断言回复；[`connector-inbound-trigger.spec.ts`](../../tests/e2e/tauri/connector-inbound-trigger.spec.ts) 还覆盖 inbound → workflow run。它们证明 Cognia 全路径 wiring，但不触达 Telegram Test DC。
2. [`scripts/smoke/compose-smoke.mjs`](../../scripts/smoke/compose-smoke.mjs) 的 `--tier im` 使用 OneBot reverse-WS **协议 stub** 注入 private message，但后半段走真实 headless Brain AI path，并断言返回的 `send_private_msg` 包含 `pong`。当前 [compose CI workflow](../../.github/workflows/compose-e2e.yml) 只运行 `services`/`server`，没有运行 secret-gated 的 `im` tier。
3. [`scripts/lark-live-smoke.mts`](../../scripts/lark-live-smoke.mts) 是真实飞书 OpenAPI **出站 live smoke**，不覆盖长连接/webhook 入站。
4. [`phase-1-ship-gate.mdx`](../content/docs/en/connectors/phase-1-ship-gate.mdx) 对 Telegram、Discord、Slack、Lark、OneBot 的真实入站/回复仍是人工 checklist；WeCom、WeChat、DingTalk、QQ Official、Matrix 尚未进入该清单。
5. [`inbound-a2ui-pipeline.smoke.test.ts`](../../lib/connectors/__smoke__/inbound-a2ui-pipeline.smoke.test.ts) 只验证 mapper dispatch wiring，当前只列 Phase 1 的 Slack/Lark/Discord/Telegram/OneBot；它不是 transport 或平台 E2E。

因此当前最大缺口不是 adapter 单测数量，而是缺少一套共享 runner，把不同平台的真实 driver、readiness、correlation、回复断言、去重和清理统一起来。

## 推荐的跨 IM Harness

### 三层测试

| 层  | 名称                | 目标                                                                                                           | 是否触达真实平台 | 默认频率          |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------- |
| L0  | local deterministic | fixture replay + transport emulator：签名/密文、parser/gate、去重、WS ACK/resume、HTTP retry、long-poll cursor | 否               | 每 PR             |
| L1  | live ingress        | driver identity → 真实平台/自建 homeserver → Cognia → AI → 平台回复                                            | 是               | nightly / 受控 PR |
| L2  | real client         | 按钮、modal、OAuth/安装、扫码、支付、UI、推送、首次建联                                                        | 是               | 发布前 / 低频     |

L0 要故意覆盖重复、乱序、过期、签名错误、断线、429、ACK 超时和重启；L1 只保留少量 P0 happy-path 与平台重试/幂等场景；L2 不承担普通消息主路径回归。

### 统一 driver contract

建议新增共享 runner，而不是为每个平台各写一套临时脚本：

```ts
interface ImLiveDriver {
  platform: ConnectorPlatform
  transport: string
  provision(runId: string): Promise<LiveConversation>
  waitTargetReady(target: AdapterHandle): Promise<void>
  injectMessage(input: {
    runId: string
    conversation: LiveConversation
    text: string
    replyTo?: string
  }): Promise<{ sourceMessageId: string; eventHint?: string }>
  waitForTargetReply(input: {
    runId: string
    conversation: LiveConversation
    timeoutMs: number
  }): Promise<ObservedReply>
  cleanup(runId: string): Promise<void>
}
```

driver 的实现按平台分层：

- `matrix-local`：Complement/Synapse + driver user token；每 job 全新 room/user。
- `telegram-test-dc`：driver bot + target bot + long polling；另设 webhook lane。
- `slack-sandbox`：driver app + target app + 专用 channel + Socket Mode；另设 Events API HTTP lane。
- `discord-test-guild`：driver bot REST Create Message + target Gateway。
- `lark-test-tenant`：driver bot + target bot + 专用群，分别跑 long connection/webhook。
- `qq-sandbox`：官方沙箱与真实测试成员；自动 driver 不成立时标为 `requiresClient`。
- `dingtalk-test-org` / `wecom-test-corp`：先运行 bot-to-bot capability probe；无官方保证时转 `requiresClient`，不能静默假绿。
- `wechat-oa-test-account`：真实测试号 + `requiresClient`；L0 使用 signed/encrypted XML。
- `onebot-stub`：每 PR 协议全链路；`onebot-real` 连接 NapCat/Lagrange 作为低频 canary。
- `wechat-personal`：只允许显式人工 canary，不实现 unattended CI driver。

### L1 标准运行协议

1. 每次生成不可预测的 `runId`，正文固定带 `cognia-e2e:<platform>:<runId>:<caseId>`；平台幂等键/txnId/nonce 也从 runId 派生。
2. 先等待 target transport readiness，再注入消息。Gateway/Socket/Stream/long-connection 同凭据只允许一个 consumer；用 distributed lock 串行化共享测试账号。
3. driver 与 target 必须是不同 identity。target 自己发送后形成的 self echo 不算入站测试。
4. 同时等待两份证据：
   - Cognia audit/trace 中出现唯一的 inbound event、AI turn、outbound delivery；
   - 平台会话中出现 target bot 的回复，且 sender、conversation、thread/reply relation 和 runId 正确。
5. 不只断言 HTTP 200/ACK。平台已接收请求但未显示消息、权限静默丢弃、回错 thread 都应失败。
6. 对同一 event/payload 做一次重复投递，断言只产生一次副作用；真实平台无法主动 replay 时在 L0 做，L1 只观察平台自身 retry。
7. `finally` 清理本次消息/room/channel；失败时保留 runId、platform message/event id、transport session id、时间窗口和 Cognia trace id。
8. 任何需要客户端的 case 显式返回 `requiresClient`/`manualEvidenceRequired`，不能 `skip` 后把整个平台标绿。

### 首批场景矩阵

| 场景                       | L0 本地                | 自动 L1 平台                                        | L2/人工平台                              |
| -------------------------- | ---------------------- | --------------------------------------------------- | ---------------------------------------- |
| 文本消息 → 文本回复        | 全部                   | Matrix、Telegram、Slack、Discord、Lark、OneBot stub | QQ、DingTalk、WeCom、WeChat OA、个人微信 |
| 群 @ / reply-to-bot        | 全部                   | Telegram、Discord、Slack、Lark；DingTalk probe      | QQ/WeCom 客户端                          |
| thread/reply 关系          | 支持的平台             | Matrix、Slack、Discord、Telegram、Lark              | QQ/DingTalk 按能力                       |
| 同一 event 重复只回复一次  | 全部                   | 观察平台 retry                                      | 无 replay 的平台由 L0 主测               |
| 断线重连 / resume / cursor | 全部 transport         | 各 long-lived transport 低频                        | —                                        |
| 图片/文件                  | parser + download mock | Matrix、Telegram、Slack、Discord                    | 国内平台按客户端补齐                     |
| 按钮/card/modal            | callback fixture       | 可由 API 产生的极少数事件                           | 主要走真实客户端                         |
| E2EE                       | Matrix crypto fixture  | Matrix Complement Crypto                            | Element UI 仅做显示验收                  |
| OAuth/安装/扫码/首次建联   | state-machine test     | —                                                   | 全部平台的 real-client lane              |

## 建议实施顺序

1. 把现有 OneBot `--tier im` 抽成通用 `ImLiveDriver` runner，并在无外部 secret 的 CI 中持续运行 `onebot-stub`。
2. 加 `matrix-local`，让它成为每 PR 的第一个真实 homeserver ingress 基准。
3. 加 Telegram Test DC、Slack Sandbox、Discord test guild、Lark test tenant 四个 secret-gated nightly driver。
4. 接 QQ 官方沙箱；先自动化 transport/readiness/outbound，真实入站暂以 `requiresClient` 证据提交。
5. 钉钉和 WeCom 先做两 bot capability probe。只有官方/实测都稳定时才升级为 unattended driver；否则保留测试组织 UAT。
6. 微信公众号只增加测试号 signed-webhook lane 与低频客户端 smoke；个人微信只保留隔离备用号 canary。

这样可以用 Matrix/OneBot 保住确定性，用 Telegram/Slack/Discord/Lark证明外部真实平台链路，再把国内缺少用户注入 API的平台诚实地留在 client/UAT 层，而不是用 fixture 冒充“已支持真实 IM”。
