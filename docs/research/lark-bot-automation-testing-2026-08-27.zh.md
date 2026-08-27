# 飞书 Bot 自动化测试支持调研

> 日期：2026-08-27  
> 范围：企业自建应用机器人、消息收发、事件订阅、卡片回调，以及 Cognia Lark connector 的自动化验证。  
> 证据口径：仅使用飞书/Lark 官方文档、`larksuite` 官方 SDK 仓库和本仓库实现。

## 结论

飞书已经提供了搭建 Bot 自动化测试所需的大部分**基础积木**，但没有发现官方托管的“Bot 模拟器 + 临时沙箱租户 + 任意事件回放”一体化产品。

最可行的组合是：

1. 在独立测试企业内创建真实测试应用和测试账号；
2. 本地用固定事件样本、SDK normalizer/dispatcher 和 Cognia 现有协议测试覆盖异常分支；
3. 用第二个 driver bot 向专用测试群注入消息（优先的无人值守触发器），或用 `lark-cli` 的用户身份补充更高保真用例，再用消息历史 API 断言 Cognia Bot 的回复；
4. 分别跑 Webhook 和长连接两个真实入站 lane；
5. 卡片点击、客户端 UI、单聊首次建联等行为保留一个真实客户端自动化或人工触发 lane。

这不是纯 mock：核心 E2E 仍连接真实飞书测试企业。官方自己的 Channel SDK E2E 也是这个模式，并把自动发送用例与需要真人触发的入站消息、reaction、卡片点击等用例分开。[Channel SDK Go E2E README](https://github.com/larksuite/channel-sdk-go/blob/main/e2e/README.md)

## 官方能力边界

| 能力                          | 官方支持情况                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 对自动化测试的含义                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试企业 / 测试应用           | 官方教程提供测试企业、测试应用的准备路径；页面标注更新于 2026-05-07。另一份自建应用流程建议在测试阶段另建新企业，并在其中创建应用、配置权限。[测试企业与应用教程](https://open.larkenterprise.com/document/quick-start-of-personnel-and-attendance-management-system/step-1-create-and-configure-an-application) · [企业自建应用开发流程](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)                                                                                                     | 可实现租户、账号、群、应用凭据和数据的生产隔离；它仍是真实企业，不是可自动重置的模拟沙箱。                                                                       |
| 应用快速注册                  | Node SDK 提供设备授权的一键应用注册流程。[Node SDK：App Registration](https://github.com/larksuite/node-sdk#app-registration)                                                                                                                                                                                                                                                                                                                                                                                                                                         | 可减少测试应用初始化工作，但仍要扫码/授权，产物也是真实应用。                                                                                                    |
| API 调试                      | Node SDK 官方 README 指向开放平台 API 调试台；各 OpenAPI 文档可直接在线调试。[Node SDK README](https://github.com/larksuite/node-sdk)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 适合凭据、权限和请求体的人工排障，不等价于持续集成中的场景编排器。                                                                                               |
| 长连接本地调试                | 长连接无需公网 IP、域名或内网穿透，只要本机能访问公网；仅支持企业自建应用。事件处理需在 3 秒内成功完成，否则会重推；单应用最多 50 个连接；集群模式随机投递而非广播。[长连接模式](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode) · [回调订阅模式配置](https://open.larkenterprise.com/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address)                                                                                              | 很适合本地和受控 CI smoke；同一应用的多个消费者不能各自期待收到同一事件，测试时应避免共享凭据并行抢消息。                                                        |
| Webhook challenge、加密和签名 | 保存地址时平台会发送 `challenge`；官方 Node SDK adapter 可自动处理 challenge。Webhook 可配置 Encrypt Key 和 Verification Token。[Node SDK：Events Handling](https://github.com/larksuite/node-sdk#events-handling) · [Webhook 订阅](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server) · [事件加密](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case)       | 可在单测中固定 challenge、timestamp、nonce、密钥和原始 body，真实集成测试则必须经过公网回调入口。                                                                |
| 投递重试与日志                | 未在 3 秒内成功响应会触发重推；开放平台日志可查 Event ID、返回状态、耗时和重试，日志保留 7 日，每次查询跨度不超过 24 小时。[事件订阅 FAQ](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/event-subscriptions/faq) · [日志检索](https://open.feishu.cn/document/tools-and-resources/open-api-log-query)                                                                                                                                                                                                                                | 可验证超时重试和业务去重，但日志是诊断能力，不是历史事件回放 API。                                                                                               |
| 主动事件 Replay               | 在本次官方资料范围内，没有发现按 Event ID 任意重新投递历史事件的 API 或后台 Replay/Resend 操作。Node Channel 暴露了纯 normalizer，可将保存的原始 webhook/历史事件在本地重放。[Node Channel 文档](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md)                                                                                                                                                                                                                                                                                                     | 应把“平台失败自动重推”和“测试主动回放”分开；后者由本地 fixture/replay runner 实现。                                                                              |
| 消息 API 测试驱动             | 可发送、回复、查询指定消息、读取会话历史；发送接口支持 `uuid` 幂等。[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) · [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply) · [获取指定消息](https://open.feishu.cn/document/server-docs/im-v1/message/get) · [获取历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)                                                                                                                                                                       | 可以“注入带 run ID 的消息 → 等待 Bot → 查历史消息断言内容、sender、reply/thread 关系”。                                                                          |
| 用户身份驱动                  | 官方 CLI 支持以用户或机器人身份发消息、回复消息、建群和读取历史；用户身份需要 OAuth 登录和相应 scope。[CLI 发送消息](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md) · [CLI 回复消息](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md) · [CLI 创建群](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-create.md) · [CLI 读取历史](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-messages-list.md) | 专用测试用户的 UAT 最接近真实用户输入，且比 bot-to-bot 少一层消息来源差异。登录令牌应按测试密钥管理。                                                            |
| Bot-to-bot 群聊               | `im.message.receive_v1` 支持用户/机器人 sender；接收其他机器人群消息需 include-bot 类权限，当前机器人自己的消息不会以全群消息事件回流。[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)                                                                                                                                                                                                                                                                                                                                       | “第二个测试 bot → 专用测试群 → include-bot 权限 → 被测 bot”是首选的完全自动入站触发器。它不能用被测 bot 自己发消息形成回环，也不能据此假设 bot-to-bot 单聊成立。 |
| SDK mock / 测试接缝           | Node Client 可注入 `httpInstance`，事件 dispatcher 可直接调用；Channel 支持自定义 HTTP、cache、logger，导出纯 normalizer。Go SDK 的 HTTP client 接口明确可用于 mock，并提供构造明文/加密事件再 POST 到本地 Webhook 的示例。[Node SDK](https://github.com/larksuite/node-sdk) · [Node Channel](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md) · [Go HttpClient](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/core/httpclient.go) · [Go mocksend event 示例](https://github.com/larksuite/oapi-sdk-go/tree/v3_main/sample/mocksendevent)     | 官方提供的是注入点、类型和示例，不是跨语言 fake Feishu server 或内存测试租户。                                                                                   |
| 客户端操作模拟                | 官方 Channel SDK 的 E2E 将卡片点击、入站消息、reaction、评论等列为人工触发项。[Channel SDK Go E2E](https://github.com/larksuite/channel-sdk-go/blob/main/e2e/README.md)                                                                                                                                                                                                                                                                                                                                                                                               | 没有证据表明 OpenAPI 能合成真实用户卡片点击。需要客户端 UI 自动化，或只在 handler 层注入回调 payload。                                                           |

## Cognia 现状

### 已有的自动化基础

- [`parse.test.ts`](../../lib/connectors/adapters/lark/parse.test.ts) 已用 DM、群 @、thread reply、图片等 fixture 覆盖事件归一化。
- [`contract.test.ts`](../../lib/connectors/adapters/lark/contract.test.ts) 已覆盖文本、Markdown、媒体、thread、reaction、卡片、编辑和删除的出站请求契约。
- [`axum_app.rs`](../../crates/cognia-connectors/src/axum_app.rs) 已测试 challenge、普通事件、加密/token 校验、重复事件和过期事件拒绝；[`sigverify/lark.rs`](../../crates/cognia-connectors/src/sigverify/lark.rs) 覆盖 token、时间窗口和 AES 解密。
- [`lark_ws.rs`](../../crates/cognia-connectors/src/lark_ws.rs) 已覆盖 protobuf frame、ACK、分片、gzip、close 和 endpoint response 等长连接协议行为。
- [`lark-live-smoke.mts`](../../scripts/lark-live-smoke.mts) 会用真实 App ID/Secret 驱动真实 adapter 和 OpenAPI，覆盖 token、whoami、群列表/创建、发送/编辑/回复、卡片、reaction、图片、历史消息和删除。
- 中英文 [Lark 配置文档](../content/docs/zh/connectors/lark-setup.md) 已说明长连接、Webhook、`im.message.receive_v1`、challenge、Verification Token/Encrypt Key 和免 @ 探针；[ADR 0091](../content/docs/zh/adr/0091-lark-unified-identity-dual-entry.md) 与 [实现计划](../plans/2026-07-24-lark-im-dual-entry-completion.md) 已要求真实测试租户验证 DM、群、topic、重复投递、重启、CardKit 和多租户隔离。

### 当前关键缺口

现有 live smoke 是**出站 OpenAPI smoke**，并不覆盖真实飞书事件进入 Cognia 的链路。脚本自身明确写着不覆盖长连接 transport 和 Webhook ingress。因此目前不能由它证明以下两个端到端路径成立：

```text
真实飞书事件 → WebSocket protobuf/ACK/重连 → Rust → Tauri event → TS parser/dispatcher → Bot 回复

真实飞书事件 → 公网 Webhook → challenge/原始 body/解密/验签/去重 → TS parser/dispatcher → Bot 回复
```

单元测试分别证明了组件行为，但没有证明真实平台配置、权限、应用版本、凭据、网络入口和运行时 wiring 能共同工作。这是 Cognia 当前最需要补的 E2E 缺口。

另外还缺少：

- 可由 CI 主动触发的用户身份入站消息；
- 长连接与 Webhook 两个 lane 的独立结果标记；
- 统一的 `runId`/`caseId`、超时轮询、消息/thread 断言和清理协议；
- 卡片点击与授权拒绝等客户端交互 lane；
- 真实平台重复投递、进程重启后去重、多实例抢投递的受控验证。

## 推荐的 Cognia E2E Harness

### 四层结构

| 层                   | 运行位置          | 目的                                                                                                 | 是否访问真实飞书 |
| -------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| L0：fixture replay   | 普通 CI           | 将保存的 v2 事件、密文、重复/过期事件送入同一 verification + parse 路径，稳定覆盖边界                | 否               |
| L1：adapter contract | 普通 CI           | 断言 OpenAPI 请求、错误映射、幂等键、thread/card/media 语义                                          | 否               |
| L2：live ingress     | 受控 CI / nightly | 在独立测试企业中，以测试用户或 driver bot 发送真实消息，分别验证长连接与 Webhook，查历史消息断言回复 | 是               |
| L3：real client      | nightly / 发布前  | DM 首次建联、卡片点击、授权拒绝、移动端/桌面端显示、Chat Tab/JSSDK                                   | 是               |

L0/L1 保证快速、确定、可覆盖异常；L2 证明真正的平台入站与回复闭环；L3 只承担 OpenAPI 无法模拟的客户端行为。不要用 L3 替代前两层。

### L2 运行协议

1. 使用独立测试企业、专用测试应用、专用测试用户、专用群；生产凭据和生产群完全不进入测试。
2. 每次生成 `runId`，消息正文带不可冲突的标记，例如 `cognia-e2e:<runId>:group-thread`；API `uuid`/Cognia idempotency key 同样派生自该标记。
3. 先启动 Cognia ingress，并等待 readiness：
   - `long-connection` lane 只启一个同凭据消费者，确认已连接后再发消息；
   - `webhook` lane 确认公开 HTTPS 地址可达、challenge 成功、配置版本已发布。
4. 无人值守 CI 优先使用第二个 driver bot，并显式开通 include-bot 权限；另设少量专用测试用户 UAT 用例，验证与真实用户 sender 完全一致的路径。driver bot 不能与被测 bot 共用身份，也不能依赖它自己的消息回流。
5. 轮询消息历史，按 `runId` 找到 Cognia Bot 回复，断言 sender、文本/卡片内容、`root_id`/`parent_id`、chat/thread 归属；不能只断言 HTTP 200。
6. 同时断言 Cognia 内部 audit/trace，确认同一 `event_id` 只产生一次副作用。
7. 在 `finally` 中清理本次消息；群可复用但必须按 lane 隔离。失败时保留 run ID、Event ID、message ID、平台日志查询窗口和 Cognia trace。

### 首批场景矩阵

| 优先级 | 场景                               | L0/L1            | 长连接 live  | Webhook live | 客户端   |
| ------ | ---------------------------------- | ---------------- | ------------ | ------------ | -------- |
| P0     | 群 @ Bot 文本 → 文本回复           | ✓                | ✓            | ✓            |          |
| P0     | 群免 @（开启全群消息权限）         | ✓                | ✓            | ✓            |          |
| P0     | topic/thread 内回复关系            | ✓                | ✓            | ✓            |          |
| P0     | 同一 `event_id` 重复输入只回复一次 | ✓                | 受控验证     | 受控验证     |          |
| P0     | 3 秒超时/失败重推，处理器幂等      | ✓                | 低频故障演练 | 低频故障演练 |          |
| P1     | DM、图片、文件、富文本             | ✓                | ✓            | ✓            | 首次建联 |
| P1     | 重启后恢复、断线重连               | ✓                | ✓            | ✓            |          |
| P1     | 多租户、两应用凭据隔离             | ✓                | ✓            | ✓            |          |
| P1     | 卡片点击、授权拒绝、重复点击       | callback fixture | 事件接收     | 事件接收     | ✓        |
| P2     | reaction、编辑、撤回               | ✓                | ✓            | ✓            | 按需     |

## 限制与风险控制

- **3 秒约束**：入站应尽快 ACK/返回 200，把耗时推理放到异步工作；业务必须按 `event_id` 幂等。平台自动重推不是测试 replay。[长连接模式](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)
- **随机投递**：相同应用的长连接集群随机收到事件，不广播。CI 不应让多个 job 共享同一 App ID 抢同一断言；按应用或测试群做 lease/串行化。
- **频控**：平台限额会变化，驱动器应限制并发、同群串行，遇到 HTTP 429 按响应头退避，不把当前数字写死。[频控指南](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)
- **权限和版本**：权限、事件订阅、Bot 能力、可用范围的修改通常需要发布应用版本后才生效。测试 readiness 要显式检查，不能把“收不到事件”直接归为代码失败。
- **凭据**：App Secret、Encrypt Key、Verification Token、测试用户 UAT 都进入 CI secret store；日志只打印哈希化的 tenant/app 标识，不输出 token 或原始敏感消息。
- **数据隔离**：专用测试企业和群不放真实业务数据；所有消息含 run ID 并设置保留/清理策略。
- **卡片真实性**：直接构造 callback payload 只能证明 handler 契约，不能证明真实客户端渲染、按钮可见性和用户点击权限。

## 建议实施顺序

1. **P0：扩展 live smoke 为 ingress harness。** 保留现有出站步骤，增加共享的 run context、历史轮询、断言、清理和诊断产物；分别提供 `long-connection`、`webhook` 模式，而不是把两者混成一个结果。
2. **P0：先打通长连接 live lane。** 它无需公网回调地址，搭建成本最低，但必须运行真实 Tauri/Rust host，不能继续使用当前 Node invoker 替代。
3. **P0：补 Webhook live lane。** 在受控公网入口验证真实 challenge、加密/验签、重复投递和 200 ACK；确保测试经过原始 body，而不是绕过 Rust 层直接调用 TS parser。
4. **P1：建立版本化 raw-event corpus。** 每个 fixture 记录来源事件类型、schema 版本、是否脱敏和预期 normalized event；通过 Cognia 的真实 verification/parse 边界重放。
5. **P1：配置双驱动。** 默认由第二个测试 bot 在专用群发送带 run ID 的群/topic 消息；再用专用测试用户 UAT 补充 DM 和真实用户 sender 场景。不要把 bot-to-bot 群聊能力外推为 bot-to-bot DM。
6. **P1：增加真实客户端卡片 lane。** 发布前或 nightly 跑卡片点击、重复点击、非 owner 点击和移动/桌面端显示；无法稳定自动化时保留明确的人工 gate。

验收标准不是“API 调用成功”，而是两种 transport 都能完成：

```text
真实测试账号输入
→ 飞书投递
→ Cognia 验证、归一化、身份与会话解析
→ agent 处理
→ Cognia 发送
→ 飞书历史中出现唯一且 thread 正确的回复
→ Cognia audit 能按 runId/eventId/messageId 追溯
```

达到这一闭环后，才能说 Cognia 的 IM 体系对飞书 Bot 的真实收发链路有持续、可回归的自动化保障。
