# AstrBot 普通群聊 Bot 参考调研

调研日期：2026-10-20（Asia/Shanghai）。范围：AstrBot 官方文档和源码；未部署 AstrBot、未登录平台、未发送消息，也未验证平台账号实际权限。本文件是 Cognia Bot 可行性调研的外部参考，独立保存以明确外部事实与本仓实现审计的边界。

源码快照：[AstrBot f2404c191716a64daaa422be7f3c567cace50d39](https://github.com/AstrBotDevs/AstrBot/tree/f2404c191716a64daaa422be7f3c567cace50d39)，GitHub API 返回提交时间为 `2026-10-20T06:49:41Z`。以下在线文档均于 2026-10-20 访问；文档页面不总提供更新时间，不能据此认定对应能力在所有旧版本中可用。

## 已核实的架构事实

- **适配器与 AI 分离。** 平台适配器负责连接 SDK、转换原始消息、投递事件及发送消息；可用插件注册新的平台，不要求修改核心。核心提供 `Platform`、`AstrBotMessage`、`MessageMember`、`MessageType` 与消息链。官方示例的接口包括 `send_by_session`、`run`、`meta`。[平台适配器开发](https://docs.astrbot.app/dev/plugin-platform-adapter.html)
- **会话有跨平台身份。** UMO 格式为 `platform_id:message_type:session_id`，使用平台实例 ID，避免两个 Bot 实例或群聊/私聊 ID 相同而串线。`MessageSession.from_str` 按最多两个冒号切分。[message_session.py](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/astrbot/core/platform/message_session.py#L7-L27)
- **收消息不等于一定回复。** 事件先进入异步队列和 Pipeline；群内唤醒包括 @ Bot、引用 Bot 消息、唤醒前缀和插件过滤器；可配置忽略自身消息、忽略 @ 全体成员及私聊是否需要前缀。`WakingCheckStage` 还把已配置管理员 ID 映射为管理身份。[waking_check/stage.py](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/astrbot/core/pipeline/waking_check/stage.py#L20-L153)
- **群共享上下文和按成员隔离是独立策略。** `unique_session` 默认 `False`；EventBus 按所选配置文件处理隔离，随后提交 Pipeline。该快照的隔离构建器支持 `aiocqhttp`、`slack`、`dingtalk`、`qq_official`、`qq_official_webhook`、`lark`、`misskey`、`matrix`；**Telegram、Discord 不在此表，不能把全局开关理解成所有平台均支持隔离**。[默认配置](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/astrbot/core/config/default.py#L90-L110)、[event_bus.py](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/astrbot/core/event_bus.py#L25-L92)
- **配置文件和会话覆盖分层。** 指定 UMO 可以覆盖模型、人格、禁用插件、知识库、LLM/TTS 与消息处理开关；覆盖优先于所属配置文件，对话重建不删除规则。[自定义规则](https://docs.astrbot.app/use/custom-rules.html)
- **群命令要感知上下文共享。** `/new`、`/reset` 默认“跟随对话隔离”：私聊普通用户可用；共享群上下文仅 AstrBot 管理员可用；渠道实际隔离后普通成员可用。管理员是配置 ID，不自动等同平台群管理员。[内置指令](https://docs.astrbot.app/use/command.html)
- **主动消息和多媒体属于通道契约。** 插件可以保存 UMO 并通过 `context.send_message(umo, chains)` 定时发送；`MessageChain` 有文本、@、图片、语音、视频、文件，具体发送能力仍由平台决定。[消息发送](https://docs.astrbot.app/dev/star/guides/send-message.html)
- **限流按会话执行。** `RateLimitStage` 用 UMO 管理时间戳队列和锁，支持等待或丢弃策略；不能据此推断具备平台全局配额、持久队列或跨实例分布式限流。[rate_limit_check/stage.py](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/astrbot/core/pipeline/rate_limit_check/stage.py#L15-L97)
- **长上下文单独治理。** 内置 AI 支持按轮数截断和 LLM 摘要；上下文接近模型窗口上限时处理；第三方 Dify、Coze Runner 的上下文由对应平台管理。[上下文压缩](https://docs.astrbot.app/use/context-compress.html)
- **普通群聊有专门的上下文感知。** 内置 `GroupChatContext` 将带昵称/时间的群消息按 UMO 缓冲，模型请求时把当前消息之前的记录注入额外用户内容；`group_icl_enable` 可独立开启，已识别命令不作为闲聊上下文。主动接话另由开关、群/UMO 白名单和概率决定，并不要求每条群消息调用模型。[group_chat_context.py](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/astrbot/builtin_stars/astrbot/group_chat_context.py#L44-L198)、[main.py](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/astrbot/builtin_stars/astrbot/main.py#L188-L237)

## 平台能力与实际前提

| 平台        | 官方 AstrBot 接入路径与已核实事实                                                                                                                                                                                                                                                                   | 对可行性判断的影响                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| QQ 官方 Bot | 当前 WebSocket 指南标注媒体表基于 v4.19.6，支持文本、图片、语音、视频、文件收发与主动消息；提供扫码创建，当前文档说只能添加到自己为群主的群；群设置可开放全部群消息与主动发言。另有手动申请、沙箱、IP 白名单流程。[指南](https://docs.astrbot.app/platform/qqofficial/websockets.html)              | “QQ 官方只支持被 @ 才响应”不是可靠的当前统一结论；仍须区分扫码创建/手动申请路径和账号真实能力。           |
| OneBot v11  | AstrBot 作为反向 WebSocket 服务端；协议实现端作为客户端连接 `ws(s)://host:6199/ws`；官方文档列 NapCat、OneDisc、Tele-KiraLink 为实现端例子，并优先推荐 QQ 官方 Bot。[指南](https://docs.astrbot.app/platform/aiocqhttp.html)                                                                        | 实现 OneBot 标准适配可复用多个协议端；它不等于完成 QQ 登录、风控、账号运维或验证各实现端能力。            |
| Telegram    | 文档标注 v4.15.0 媒体表，文本、图片、语音、视频、文件收发和主动推送；群聊建议关闭 Privacy mode；群内流式通过发送后编辑消息实现。[指南](https://docs.astrbot.app/platform/telegram.html)                                                                                                             | 配置 Bot token 不代表能看到群内所有消息；需要检查消息可见性与群权限。                                     |
| Discord     | Bot token + Gateway Intents；Message Content Intent 影响内容读取；插件命令可自动注册为 slash command；OAuth 安装时选择消息、文件、历史等权限。[指南](https://docs.astrbot.app/platform/discord.html)                                                                                                | 适配器之外，还需要安装授权和 intent 配置；不宜直接照搬文档所有权限，应按功能选择。                        |
| 飞书/Lark   | 支持长连接或 Webhook、群聊 @ /引用/前缀唤醒、媒体和主动推送；全量群消息需 `im:message.group_msg`；流式卡片需 `cardkit:card:write`；扫码创建文档要求 >= v4.25.0。[固定源码内官方指南](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/docs/zh/platform/lark.md) | 使用应用机器人收发事件，单向群 Webhook 无法替代完整入站 Bot。长连接可降低本机试用时对公网回调入口的依赖。 |

注意：QQ 总览仍写“主要通过 Webhook”，但侧栏及专门的 WebSocket 指南已推荐 WebSocket 并描述新扫码流程。应以具体接入方式页面和实际账号验证为准，不能仅用总览总结当前能力。[QQ 总览](https://docs.astrbot.app/platform/qqofficial.html)

**QQ 证据分层：** 腾讯当前公开的[事件订阅与通知](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)明确同时描述 Webhook 和 WebSocket，并包含网关、鉴权、心跳及恢复；其 `GROUP_AND_C2C_EVENT` 列表仍只列 `GROUP_AT_MESSAGE_CREATE`，未列 `GROUP_MESSAGE_CREATE`。AstrBot 则在[适配器源码](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/astrbot/core/platform/sources/qqofficial/qqofficial_platform_adapter.py#L126-L220)自行补注册 botpy 的 `group_message_create` parser 并实现接收处理，仅 @ 事件设置 `force_group_mention=True`。因此，“AstrBot 文档已描述且源码已实现新路径”证据充分；“任意 Cognia QQ 账号都已具备全量收群消息/主动发言权限”仍未证实，须用对应接入路径的真实账号验证。

## 插件、运行与集成边界

- **插件生态是 Python 扩展。** 插件可以提供命令、AI 工具、消息监听、外部服务和管理页面；市场/Git 仓库/ZIP 均可安装。官方明确指出插件在 AstrBot 的 Python 环境运行，Agent 沙盒不会自动隔离任意插件代码。[插件](https://docs.astrbot.app/use/plugin.html)
- **Bot 是常驻进程。** 官方提供 Docker/Compose，持久化 `data`，WebUI 默认 6185，OneBot 反向 WS 默认 6199；需要独立设置平台凭据与连接。带 Agent 沙盒的 Compose 是额外部署模式。[Docker 部署](https://docs.astrbot.app/deploy/astrbot/docker.html)
- **Webhook 有统一入口。** 支持统一 Webhook 的适配器可共用外部域名、反代和 WebUI 端口，再分配独立回调 URL；这仍需要可达公网入口。[统一 Webhook](https://docs.astrbot.app/use/unified-webhook.html)
- **许可证事实。** 当前 AstrBot 主仓为 AGPLv3，许可证第 13 节规定修改版本通过网络交互时的对应源码提供义务。[LICENSE](https://github.com/AstrBotDevs/AstrBot/blob/f2404c191716a64daaa422be7f3c567cace50d39/LICENSE#L540-L552)

**集成判断（推论）**：参考架构和协议自行实现，与复制、链接或改造 AstrBot 源码，是不同的工程与许可决策。独立运行 AstrBot，再通过清晰 API 调用 Cognia，可减少通道适配开发；但仍需定义会话、鉴权、取消、媒体、上下文归属与工具权限，不能仅接一个模型地址就认定 Cognia Agent 全能力已接入。是否形成衍生作品及具体合规义务取决于交付边界，本次没有作法律结论。

## 给 Cognia 的设计启示（推论，需与本仓审计合并）

1. 优先确定统一入站消息和回复契约：平台实例、Bot 身份、群/私聊、线程、发送者、消息 ID、引用、媒体、可用能力。把传输适配与 Agent 执行解耦。
2. 把“能收到哪些消息”“哪些消息唤醒 Bot”“哪些消息进入上下文”建成三个策略；全量收群消息不能直接等于全量调用模型。
3. 群共享上下文、群内按成员隔离、线程隔离需显式选择；隔离状态还应控制 `/reset` 等管理命令权限。
4. 常驻 runtime 应拥有去重、持久会话、队列/取消、限流、媒体生命周期及回复降级；Web 配置页不应承担全天接收消息的唯一运行时。
5. 群 Bot 的可执行工具、知识库、记忆和外部账号需按群/身份授权；桌面个人 Agent 的权限不能自动继承到群成员。
6. 可选择“Cognia 原生通道”或“AstrBot 通道层 + Cognia Agent API”做验证，两条路线均应验收跨群隔离、重放去重、@/引用、并发、重启恢复和实际消息发送。当前研究没有完成这些运行验证。
