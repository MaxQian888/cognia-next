# 非飞书 IM 实现审计 — 2026-10-01

本轮检查现有 10 个非飞书适配器及共享投递、回调和运行过程展示链路。初始审计确认 10 个问题：3 个 P1、7 个 P2。随后修复这些问题、补齐 OneBot v12 已知账号的 `self` 路由，并将 QQ 官方 Webhook 成功 ACK 对齐腾讯 SDK。

检查基于当前共享工作树，而非仅检查已提交版本。以下问题描述保留修复前的证据和当时行号；当前状态见修复表。自动化回归不代表真实平台验收。

## 修复结果

| 问题                | 当前行为与回归覆盖                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OneBot 失败被记成功 | 发送、转发、撤回、表情统一校验 `status` / `retcode`；异步、异常或缺失回执进入不可自动重试的 `delivery_unknown`，保留部分成功信息。明确拒绝保留上游诊断，不猜测通用限流码。 |
| Matrix 连续编辑     | 更新始终返回原始消息 ID，后续 replacement 持续指向原消息。                                                                                                                 |
| DingTalk 拒收/限流  | 检查无效和受限成员名单，区分永久拒绝与明确限流，防止部分发送后整批重放。                                                                                                   |
| OneBot 停止竞态     | 正反向 WS 均使用连接代次，释放迟到监听器/连接，拒绝未完成 RPC，支持停止后重启。                                                                                            |
| Discord ID 碰撞     | 复用共享稳定摘要，覆盖按钮、选择器与弹窗的超长 ID。                                                                                                                        |
| Slack 选择值丢失    | 保留 0/1/多值数组、清空状态及用户/频道/会话选择器，覆盖普通回调与弹窗。                                                                                                    |
| Telegram 富消息为空 | 按官方富消息块递归解析文本、附件、引用、列表、表格、地图等；复用原有媒体链路并保留未知块提示。                                                                             |
| WeCom 加密附件      | 图片、文件、视频及带 URL 的语音复用解密链路；文件接入已有本地提取，失败不暴露不可用密文 URL 为可用资源。单附件明文上限 5 MiB，超限保留元数据。                             |
| 个人微信数字回调    | 解析不提前消费；暂时失败保留游标和原 action；终态持久化回执后确认消费，重投及 adapter 重建不会触发普通聊天，也不会误删新菜单。                                             |
| 公众号不明确回执    | HTTP 200 下不可解析或缺失业务结果归为 `delivery_unknown`，禁止自动重发。                                                                                                   |

WeCom 文件文本复用本地解析流程，后续模型调用仍经过共享 PII gate；本轮未增加新的模型调用路径。

## 修复后验证

- 全部适配器（包含飞书）、共享回调授权/总线、运行时、出站投递及运行过程展示：**187 套测试、3,459 项通过**。Jest 输出 open-handles 提示后正常退出，退出码 0。
- QQ Webhook 定向 Rust 回归：**6 项通过**；`cargo fmt -p cognia-connectors -- --check` 和 `cargo clippy -p cognia-connectors --lib -- -D warnings` 通过。
- 本轮修改的 TypeScript 文件 ESLint、Prettier 和 `git diff --check` 均通过。
- 全仓 TypeScript 检查仍有 15 条本轮范围外诊断：Lark workbench 测试缺少 `legs`、CLI 测试缺少 `NODE_ENV`、Kimi/外部 Agent 测试类型、workflow 调用参数和 wallpaper E2E 缺少 `sharp`。本轮修改文件没有剩余诊断；不能宣称全仓 typecheck 通过。
- 回归包含修复前失败的断言，以及重复投递、部分发送、停止竞态、连续编辑、回调字段和解密边界。
- 未连接真实 IM 账号；未执行覆盖率、全仓构建或 Rust 全量测试。凭据、扫码及外部消息验收仍需按下表执行。

## 初始审计验证

- 适配器回归：124 套测试、2,000 项通过。
- 共享能力、注册表、运行时、队列和总线：7 套测试、374 项通过。
- 合计：131 套测试、2,374 项通过；适配器批次曾出现 Jest open-handles 提示，最终退出码为 0。
- 对 OneBot 失败响应与连接停止竞态、DingTalk 拒收响应、Discord ID 碰撞、Slack 选择值、Telegram 富消息、个人微信数字回调、公众号异常响应做了无网络合成检查。
- 合成检查使用实际源码。需要隔离外部依赖时，替换了 HTTP、WebSocket、组件遍历输入或绑定持久化等依赖；不等同于真实平台验收。
- 未登录任何 IM、未扫描二维码、未读取真实凭据、未向外部会话发送消息；未重新执行 Rust 全量测试或整包构建。

## 确认问题

### 1. P1 — OneBot/NapCat 操作失败仍返回成功

位置：`lib/connectors/adapters/onebot/index.ts:489`，另见撤回 520、转发 565、表情 608/619 行。

两个 WebSocket transport 会正常返回协议层的失败响应。适配器只在 `status === "ok"` 时读取消息 ID，却在循环结束后无条件返回 `ok: true`。因此权限拒绝、风控等错误可能被持久化队列标为已送达。

实际源码合成输入 `{status:"failed",retcode:1400,data:null}` 的结果：发送、转发均返回 `{ok:true}`，撤回正常 resolve。

修复方向：统一检查动作响应的 `status` / `retcode`，区分永久失败、限流、结果不明确；多动作请求还需保留部分投递状态。补充失败响应回归，而不只模拟 Promise rejection。

依据：[OneBot 11 WebSocket 响应](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)、[OneBot 12 动作响应](https://12.onebot.dev/connect/data-protocol/action-response/)。

### 2. P1 — Matrix 连续更新会尝试编辑一条编辑事件

位置：`lib/connectors/adapters/matrix/index.ts:664`；调用链为 `lib/connectors/run-presentation/runner.ts:465` 和 525 行。

`edit()` 返回新创建的 `m.replace` 事件 ID。运行过程展示保存这个返回值，并将其作为下一次更新的目标。Matrix 要求 replacement 指向原始消息，不能再编辑 replacement；因此同一运行的第二次更新可能不再显示。

证据为当前生产调用链和官方契约，未连接真实 homeserver。修复方向：编辑成功继续返回原始消息的规范 ID；如需审计 replacement ID，应单独存储。

依据：[Matrix replacement 有效性规则](https://spec.matrix.org/latest/client-server-api/#validity-of-replacement-events)。

### 3. P1 — DingTalk 单聊批量接口忽略拒收/限流名单

位置：`lib/connectors/adapters/dingtalk/index.ts:403` 至 440 行。

OTO 接口返回 HTTP 200 时，代码只读取 `processQueryKey`，没有检查 `invalidStaffIdList` / `flowControlledStaffIdList`。即使唯一目标用户在名单中，仍返回成功，队列随即标记已发送。

实际源码合成检查：两种名单分别包含唯一收件人时，均返回 `{ok:true,platformMessageId:"mock-message-id"}`。

修复方向：无效收件人返回永久失败；明确限流返回可重试失败；保留请求查询信息用于后续排查。

依据：[阿里云官方 DingTalk SDK 响应结构](https://github.com/alibabacloud-go/dingtalk/blob/v2.0.83/robot_1_0/client.go)。

### 4. P2 — OneBot 连接尚未完成时停止，旧连接仍会建立

位置：`lib/connectors/adapters/onebot/transport-forward-ws.ts:118` 至 130、187 至 199 行。

`start()` 等待 `connectorsWsOpen()` 后没有检查停止状态。若此时已经调用 `stop()`，后续仍安装监听器并执行 `onOpen()`，可能把已禁用的连接重新标成 running。

无网络合成顺序 `start → stop → 延迟连接成功` 得到 `openedAfterStop:1`、`closed:[]`，并留下两个新监听器。

修复方向：使用连接代次或停止标记，在每个异步建立步骤后核验；迟到的 handle 必须关闭，迟到的监听器必须释放。

### 5. P2 — Discord 超长交互 ID 截断后发生碰撞

位置：`lib/connectors/adapters/discord/a2ui-mapper.ts:200`，同类分支 233、313 行。

超过长度限制的 `custom_id` 仅保留末尾 90 个字符，可能丢失 surface/component 身份。两张卡片使用相同长组件 ID 时可生成同一个 wire ID，覆盖共享绑定表中的旧记录，导致旧卡片点击解析到后一个绑定。

实际 mapper 合成检查：两个不同 surface 产生相同 ID，绑定表最终只保留第二个 surface。修复应使用包含完整身份的稳定摘要，并验证按钮、选择器、弹窗路径及同消息内唯一性。

依据：[Discord custom_id 约束](https://docs.discord.com/developers/components/reference#anatomy-of-a-component)。

### 6. P2 — Slack 多选与弹窗提交丢失选择值

位置：`lib/connectors/adapters/slack/parse.ts:548`、593 行。

普通回调只有在 `selected_options.length > 1` 时保存数组，选中一个值或清空选项时均丢失状态；弹窗提交没有读取 `selected_options`。用户/频道选择器的专用字段也未完整处理。

实际 parser 合成检查：一个选项得到 `value:""` 且没有 values；弹窗字段得到 `{a:""}`。

修复方向：按组件类型保留原始值结构，包括空数组；同时覆盖 block actions 和 view submissions。

依据：[Slack MultiStaticSelectAction](https://docs.slack.dev/tools/bolt-js/reference/interfaces/MultiStaticSelectAction/)、[ViewStateValue](https://docs.slack.dev/tools/bolt-js/reference/interfaces/ViewStateValue/)。

### 7. P2 — Telegram 新的 rich_message 被解析为空内容

位置：`lib/connectors/adapters/telegram/parse.ts:408` 至 415 行。

当前官方 Bot API 已提供 `Message.rich_message`，本地解析器仍只处理原有媒体、text、caption。实际 parser 输入包含一段可读 paragraph 的 rich_message 后，输出为 `segments:[]`、`plainText:""`。

修复方向：按官方富消息块结构提取文本、媒体和相关实体；无法映射的块保留明确的可读降级，避免静默丢失。

依据：[Telegram Message](https://core.telegram.org/bots/api#message)、[RichMessage](https://core.telegram.org/bots/api#richmessage)、[RichBlockParagraph](https://core.telegram.org/bots/api#richblockparagraph)。

### 8. P2 — WeCom 文件/视频缺少加密媒体解密链路

位置：`lib/connectors/adapters/wecom/index.ts:339`、429 行；`parse.ts:104`。

入站处理只解密图片。文件/视频的 URL 被直接保留为消息段，而对应 AES key 留在 raw 中；后续共享处理没有补齐这些媒体的解密。对于官方的加密 CDN URL，普通下载不能得到可用原文件。

证据为源码调用链和官方 SDK 契约，未进行真实企业微信附件下载。修复方向：扩展解密附件缓存，保留可用文件资源，再接入已有文件提取流程；视频应至少保留可访问的解密资源。

依据：[WeCom 官方机器人 SDK 消息类型](https://github.com/WecomTeam/aibot-node-sdk#-消息类型)。

### 9. P2 — 个人微信数字回调提前消费，重投可能变成普通聊天

位置：`lib/connectors/adapters/wechat-personal/parse.ts:195`，`index.ts:205`、215、218 行；共享总线 `lib/connectors/bus.ts:2451`。

数字绑定在解析阶段就被删除，尚未等待回调结果。总线遇到暂时性绑定查询错误时会保留可重试语义，但数字绑定已经不存在；同一批次重投时，这条数字消息还可能走普通文本路径，触发额外 Agent turn。

直接调用当前 parser 的合成结果：`{first:"audit-action",redelivery:null,normalMessage:"1"}`。修复方向：区分查找、占用、确认消费，使用消息身份对重投去重；回调结果需要能反馈给入站游标推进逻辑。

### 10. P2 — 公众号异常 HTTP 200 响应被当成可安全重试

位置：`lib/connectors/adapters/wechat-oa/index.ts:212` 至 216 行；共享队列 `lib/connectors/outbound-runner.ts:1308`。

HTTP 200 的不可解析响应或缺失成功字段，被分类为 `platform_4xx` 且 `retryable:true`。队列对该通道的结果不明确保护仅匹配 network / platform_5xx 等错误，因此会重发。如果第一次消息已被平台接收、只是回执损坏，就可能重复发送。

实际源码合成检查：响应体 `not json` 和 `{}` 都得到 `ok:false`、`code:"platform_4xx"`、`retryable:true`。既有测试 `index.test.ts:188` 还明确要求此行为，说明需要调整断言。

修复方向：未取得明确平台业务结果的成功 HTTP 响应应进入 `delivery_unknown`，不能假定消息没有发送。

## 条件性兼容与待确认项

- **OneBot v12 多机器人连接**：已为删除、上传、读取文件和身份动作补齐已知 `self`。全新多账号连接若尚未收到身份事件，无法推断 platform，仍可能收到 `10101 Who Am I`；用户当前选择的 NapCat v11 不受此项影响。[官方动作请求规范](https://12.onebot.dev/connect/data-protocol/action-request/)
- **QQ 官方 Webhook ACK**：成功 ACK 已从 `{"op":12}` 对齐为腾讯 SDK 的 `{"op":12,"d":0}`，并增加精确响应断言。未取得平台实测证明旧格式被拒绝，因此这是契约对齐，不宣称复现了线上拒绝。[官方 SDK](https://github.com/tencent-connect/botgo/blob/master/interaction/webhook/webhook.go)
- **能力扩展机会**：iLink 官方接口提供 getconfig/sendtyping，本地尚未接入输入状态；公众号接口提供可选的 `aimsgcontext.is_ai_msg` 标记，本地消息结构未提供配置入口。这两项属于功能扩展，不是本轮确认的投递故障。[iLink 官方协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)、[公众号发送客服消息](https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html)

## 实测所需条件

凭据只填本机配置，不发送到聊天。

| 平台        | 所需条件                                                                      | 优先验收                                                           |
| ----------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| QQ / NapCat | 当前 Mac 的 QQ/NapCat 版本、登录用测试 QQ、私聊对端、测试群、回环地址 WS 服务 | 被拒绝的发送不能记成功；禁用连接无残留；文字/图片/@/引用/撤回/重连 |
| QQ 官方     | 自建机器人 App、Webhook 验证配置、可用测试群/C2C 范围                         | 事件 ACK、被动回复和媒体                                           |
| Telegram    | Bot token、私聊和群/话题测试会话                                              | rich_message、编辑、回调、附件                                     |
| Discord     | 测试服务器、Bot/Application 配置、所需 intents 和权限                         | 超长 ID 的多卡片交互、表单、附件                                   |
| Slack       | 测试 workspace、App token/scopes、Socket Mode 或签名回调                      | 多选 0/1/多值、弹窗、频道/用户选择                                 |
| Matrix      | homeserver、Bot access token、未加密测试房间                                  | 同一消息连续更新至少三次；重试幂等                                 |
| DingTalk    | 企业自建机器人、测试成员/群、Stream 或回调配置                                | 有效/无效收件人、限流名单、群/单聊                                 |
| WeCom       | 测试企业智能机器人、长连接配置、测试成员/群                                   | 加密图片/文件/视频的下载及使用                                     |
| 个人微信    | 可扫码的测试账号、iLink 连接、测试对端                                        | 数字回调重投/暂时失败、媒体、会话恢复                              |
| 微信公众号  | 可用客服接口权限、测试 openid、回调配置、有效交互窗口                         | 明确失败与回执不明确分开处理；媒体                                 |

当前 Mac 的 NapCat 建议同机正向 WebSocket：NapCat 开启 WebSocket 服务端并绑定 `127.0.0.1`，Cognia 填相同端口、access token 和机器人 UIN。官方 macOS 安装涉及 QQ 文件补丁，安装前应确认版本与安装方式并备份；本轮没有安装或修改 QQ。音视频还需独立验收，不能从文字/图片通过推断转码可用。

依据：[NapCat macOS 安装](https://doc.napneko.icu/guide/boot/Shell)、[连接配置](https://doc.napneko.icu/config/basic)、[音视频限制](https://doc.napneko.icu/config/advanced)。

## 后续顺序

代码修复后，优先用当前 Mac 的 QQ/NapCat 完成真实 IM 验收：拒绝发送、禁用连接、重连、普通消息及媒体、回调和撤回。其余平台按上表补齐测试账号与权限后逐一验收。iLink 输入状态和公众号 AI 标记属于独立能力扩展，本轮未实现。
