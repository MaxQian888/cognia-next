# 群聊 Bot 技术方案对抗评审记录

起草：2026-10-20；完整稿复审与修订：2026-10-21（Asia/Shanghai）。对象：[普通群聊与常驻聊天 Bot 方案](../plans/2026-10-20-community-and-resident-group-bot.md)。

当前实施规范以主方案为准，本页 §10 联合复核与 §11 打断补充是当前裁定；前轮记录保留历史（例如 observed→queued 的旧提议已被替换），不能当成并行生效的设计。

这是设计评审记录，不是已实现代码的安全认证或线上验收。仅新增方案/研究 Markdown，没有修改业务代码、授权真实群、调用真实模型或部署。

## 1. 方法与契约

遵循 [doubt-driven](../../.agents/skills/doubt-driven/SKILL.md)：先提取 artifact 与约束，再交给 fresh-context reviewer 寻找错误；主会话回查 owning source，逐条分类和修订，最多三轮。Reviewer 不接收作者结论作为要求，不修改代码。另有独立的源码审计和上游研究，分别检查成员/记忆/工具边界，以及 MaiBot/AstrBot 的常驻参与机制。

本次要证伪的核心假设：复用现有 Connector/Agent 运行路径，只增加公共群准入与观察/发言策略，就能同时保证访客不继承 owner 权限、旁听不逐条调用模型、撤权及时生效、陈旧消息不被发送。

共同契约：静态导出不变；不建第二 Agent 引擎或队列服务；平台真实 actor 不被伪造成 owner；所有模型/embedding/tool/data/出站路径受 PII 与授权双门；显式请求保持独立 FIFO；无远端幂等时不承诺 exactly-once；不承诺撤回已跨网络发送的内容；未知能力必须拒绝而非 fallback。

用户于 2026-10-21 明确选择“跳过，完成当前方案”，因此未运行 Gemini/Codex CLI 跨模型审查。以下均是同模型、独立上下文的对抗检查；不将独立上下文描述成跨模型多样性。

## 2. 第一轮：方向稿暴露 8 类旁路

| ID  | Reviewer 反例与源码                                                                                                                                                      | 主会话判定     | 纳入方案                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------- |
| D1  | [bus](../../lib/connectors/bus.ts) 在主体准入前调用 passive observers 并持久完整 event；[inbound jobs](../../lib/db/connector-inbound-jobs.ts) 终态仍保留正文            | 有效、需修设计 | §4–5 前置准入、安全投影、拒绝事件无正文 receipt；content-aware observers                      |
| D2  | [Lark Adapter](../../lib/connectors/adapters/lark/index.ts) 在 emit 前下载媒体，bus 提前 OCR                                                                             | 有效、需修设计 | §3/§5 Adapter preflight；observe-only 不下载、不提取、不做云调用                              |
| D3  | [callback authorization](../../lib/connectors/callback-authorization.ts) 有 off/audit；[principal resolver](../../lib/connectors/principal/resolve.ts) 非 Lark 为 legacy | 有效、需修设计 | §4.3 community 强 guard，不受 legacy flag 降级                                                |
| D4  | [IM ceiling](../../lib/connectors/im-permission-ceiling.ts) 是部分 denylist，不是访客默认无工具                                                                          | 有效、需修设计 | §6 run-bound data/recipient/tool scope；nested、Workflow node、plugin/MCP/native 各 sink 验证 |
| D5  | [build-options](../../lib/claude/build-options.ts) 有 project history、Twin/KB、旧 SDK session；关 memory 不能清除这些                                                   | 有效、需修设计 | §5.3/§6 新 lineage、短期 SDK context、独立数据门、禁 owner continuity                         |
| D6  | [runtime](../../lib/connectors/runtime.ts) 的 onPartial 直接调用 Adapter.streamReply                                                                                     | 有效、需修设计 | §8 首版关闭 partial/activity/审批实时面，后续每 mutation 统一 guard                           |
| D7  | [outbound runner](../../lib/connectors/outbound-runner.ts) 可 sibling balancing/failover                                                                                 | 有效、需修设计 | §8 默认禁止跨 adapter/recipient，运行范围不能被 reroute 扩大                                  |
| D8  | ack 丢失有不确定窗口；发送失败转 draft 可复活旧内容                                                                                                                      | 有效、需修设计 | §8 episode/source/epoch/expiry 随投递/草稿/审批/恢复；无远端幂等进入 reconciliation           |

这些大多是现有私人助手的预期能力或现有恢复取舍；评审没有将它们笼统认定为现有产品的安全漏洞。问题是新公共群用途不能直接继承这些默认。

## 3. 源码审计独立确认了记忆默认与权限传播事实

- [room settings](../../lib/chat/room/settings.ts) 的 `resolveRoomSettings` 显示 IM 默认关闭记忆，`initialRoomMemoryFields` 没有生产调用；[createPlatformSession](../../lib/connectors/session-bindings.ts) 没写 memory flags，而 [build-options](../../lib/claude/build-options.ts) 将原始 session 传给 [memory policy](../../packages/memory/src/control-plane/policy.ts)。因此“UI 默认 off”不是实际 recall 已关闭的证据。方案把 fresh/legacy group 和 DM 区分列入前置修复。
- 现有 [permission cascade](../../lib/ai/agent/external/policy/permission-cascade.ts) 已有 allow 交集/deny 并集及下游传播；可复用。但它不提供群数据、凭据身份和收件范围。
- [memory caller](../../lib/memory/api/caller.ts)、[KB session reader](../../lib/knowledge-base/runtime/session-reader.ts) 可复用；[workflow knowledge access](../../lib/workflow/knowledge/access.ts) 的 trusted-local 入口不能直接用作公共群授权。
- 现有广播、邀请、Lark 用户身份 CLI、Workflow send/forward 等是需要收窄的 sink；不能只收窄 prompt 中显示的工具列表。
- [room participants](../../lib/chat/room/participants.ts) 是 observed projection；共享聊天的 membership mirror 与 IM 平台成员不是同一事实来源。

## 4. 第二轮：完整稿安全反证与修订

| ID  | 问题                                                                                                                                  | 分类 / 修订                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | 关闭 profile 可能让新消息重新进 legacy owner 路径                                                                                     | 有效；§4.1/§9 持久 quarantined binding、先于 legacy 的 kill guard，回 legacy 要独立迁移                                                                            |
| S2  | rootless workspace 会经 [effective-cwd](../../lib/workspace/effective-cwd.ts) 回 owner 默认目录，build-options 自动读取 AGENTS/CLAUDE | 有效；§6.1 禁 owner cwd fallback、磁盘 instruction/import/subagent 自动发现；只用明确空隔离 root，缺失拒绝                                                         |
| S3  | 正确静态 token 不证明不可伪造的 actor，不能提升管理员或审批权                                                                         | 有效；§4.2 区分 bridge_authenticated/actor_integrity_verified，复用 [forge-resistant 判定](../../lib/connectors/principal/self-bind.ts)，增加 transport capability |
| S4  | 长期事实合并后只有单一 source 字段，无法完整撤销依赖                                                                                  | 有效；§6.1 多源反向 lineage/source epoch/grant，先 reader 隔离再清理；批准的长期事实有独立 retentionBasis                                                          |
| S5  | tombstone 清除后旧 create/edit 可续 TTL 或复活                                                                                        | 有效，与 R3 重合；§5.2 无正文 replay receipt/horizon、固定首次 expiry、版本次序与超窗拒绝                                                                          |
| S6  | namespace helper 对缺 projectId 的 workspace row 不够严格                                                                             | 有效；§6.1 community 强制 scope=workspace 且 projectId 精确等于绑定 workspace；缺值拒绝                                                                            |

S4 采用明确取舍：经批准的长期事实可在观察原文普通 TTL 到期后继续按批准期限保留；显式 source 删除和 grant 撤销仍隔离派生事实。不能同时承诺“24h 原文删除会自动删除所有已批准事实”和“长期记忆长期存在”。

## 5. 第二轮：运行时反证与修订

| ID  | 问题与源码                                                                                                           | 分类 / 修订                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | bus overflow 把请求 history_only、steer 可并入旧 run，恢复按平台时间                                                 | 有效；§7.1 community 固定 queue、按 localSequence durable drain，持久满明确拒收，不丢已接受 job                                             |
| R2  | promoted anchor 重进普通 pipeline 会被 dedup 或 mention/trigger 拒绝                                                 | 有效的契约缺口；§7.2 提取 startRouteHandlerTurn 受控接缝，不重 capture/ensure/trigger/commands/fan-out                                      |
| R3  | job/短期 tombstone 清理后迟到源复活                                                                                  | 有效；§5.2 复用 inboundLedger 保存无正文 receipt，community 不忽略重复返回，窗口内不被原 cap prune 淘汰                                     |
| R4  | semaphore 外检查后等待，期间 source/权限改变仍发送                                                                   | 有效；§8 校验移入 sendSemaphore callback，和 invalidation/停说共用短临界区，明确发送登记线性化点                                            |
| R5  | selector 选 A，最新 B 作 anchor 会误归请求者/回复目标                                                                | 有效；§7.2 冻结 selectedSource/context/replyTarget/consumed refs，anchor 仅作生命周期；自主 initiator 独立                                  |
| R6  | [cost budget gate](../../lib/usage/cost-budget-gate.ts) 读已花费且 fail-open，不是原子 reservation；无调用 deadline  | 有效；§7.2/7.3 扩展同 usage owner 持久 reservation/settlement，次数按调用尝试，取消/崩溃保守记账、deadline、公平轮转；列入 P1 前 WP3        |
| R7  | 桌面 [bootstrap lease](../../lib/connectors/bootstrap/install-connector-runtime.ts) fail-open，旧 owner 缺真实 fence | 有效；§8 community 强制 verified fail-closed lease，runtime fencing 与 binding epoch 分离，native IO 边界验 fence；陈旧本机投影不产生副作用 |

R7 不假装 TS Dexie 与 Rust lease 有一个分布式事务。允许旧 owner 留下待清理 bookkeeping 的明确条件是：新 token 下不能消费它，所有产生外部副作用的 owning port 必须拒绝旧 token。这是隔离效果和本机投影一致性的区分。

## 6. 第三轮：针对修订契约做有界复核

完整稿安全 reviewer 与 runtime reviewer 被要求只复核上述设计修订、报告残留实质矛盾，不要求已经实现的运行证据，不继续无限增开审查。

安全 reviewer 返回：前 5 项发现与 namespace 细节均在设计中闭合，未发现剩余实质阻断项。运行时 reviewer 返回：原 7 项均已闭合，硬预算和 fencing 已成为 addressed 试点前置条件。

运行时复核额外指出一个小边界：receipt 硬容量满时，“所有 delete 都持久 tombstone”无法无条件成立。主会话接受并补充 §5.2：必要 tombstone 失败就持久 captureBlocked，停止可能复活内容的 capture/episode/出站；若连阻断也无法写入，停 Adapter 并撤销执行许可。存储修复必须重新核验 replay 水位、新建 authority epoch、作废旧依赖，不能因容量恢复自动放行。A21 覆盖满容量 delete-before-create。

依技能的有界停止规则，第三轮仅剩上述小边界并已补充，不开启第四轮。复核只证明原反例已在方案文字中处理；未完成真实平台验证不属于“静态设计已通过”可代替的事项，实现时仍必须运行方案 A01–A21。

## 7. 验证记录与不能宣称的结论

2026-10-20 主会话重新运行了 12 个聚焦 suites：`11 passed, 1 failed`；tests `337 passed, 1 failed, 338 total`；16.96 秒。完整命令见方案 §11.3。失败为 `runtime.test.ts:3313` mixed card/A2UI：`Expected: "card" / Received: "a2ui"`。未修改代码/测试以消除此 baseline 失败，也未确认其根因。

初稿包含 7 个目标、21 条行为/对抗验收和 8 个工作包；2026-10-21 追加权限复核后扩为 30 条验收；同日短平快场景修订扩为 37 条；联合复核后扩为 45 条，目标和工作包数量不变。它们是设计与未来实施标准，不是本次新增功能已通过的测试。

本次不声称：真实中文熟人群自然度、平台消息完整可见、长期在线 SLA、跨平台 exactly-once、未知 membership 即时撤权、外部模型/平台内容彻底擦除、旧 Host 任意降级安全、插件/外部 Agent 自动受沙盒隔离。

Sources：本页相邻链接均指 owning source；上游机制与论文的固定版本证据见[常驻研究](./2026-10-20-resident-group-social-bot-reference.md)，不将上游宣传视作 Cognia 运行证明。

## 8. 2026-10-21 用户追加：授权来源与处分权复核

用户要求“再考虑一下权限问题”。这是在原运行路径审查之外，对“谁可授予哪些权限”的新决策做独立复核，不将先前的三轮审查当成完整 IAM 正确性证明，也不启动已被用户跳过的跨模型 CLI。

待证伪判断：只要 runtime ceiling 足够严格，operator 配置群管理员、KB allowlist 和常驻开关便能提供有效授权。此判断不充分：运行约束不能补足签发者缺失的资源、群治理、处理方和受众处分权。

### 8.1 第一轮发现及处理

| ID  | 反例                                                              | 判定与修订                                                                                          |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P1  | operator 配置能力被误作群治理与资源处分权                         | 有效；§4.4 分 operator、群治理者、资源处分者、普通成员及自主安装主体；签发/消费均核验对应 authority |
| P2  | A 有 read ACL，Bot 就能把知识答案发给 B/C                         | 有效；§4.5/§6/§8 将 read/process 与 audience publish 分开；共享 prompt 不读取成员私人资源           |
| P3  | 相同 conversation ID 被误作稳定受众                               | 有效；动态当前/未来成员须资源方明示；固定主体材料不进入首版群运行，未知 roster 不猜授权             |
| P4  | 旁听开关同时隐含允许云处理和长期保存                              | 有效；capture/context、provider/endpoint processing、retention 分别授权；个人长期画像首版禁止       |
| P5  | cross_account 一概拒绝导致成员注册自己账号后失去访客资格          | 有效；保留现有私人解析拒绝，新增可信路由/身份原因分类；真实 ban 和未知 disabled 不允许 fallback     |
| P6  | resident 没有自己的授权根，可能借最新发言人权限                   | 有效；installation service subject + 有期限 standing grant；来源作者仅作 provenance                 |
| P7  | manage/approve 布尔位无法区分改风格、换云端点、共享 KB 和动用凭证 | 有效；小型动作集合、资源/效果范围、独立 owner 配置、单次 prepared-action 审批；扩权建立新 run       |
| P8  | 个人退出与全群停说/停听混在一起                                   | 有效；平台自助个人排除/派生事实删除与群治理控制分开；已失权或来源不可靠不得敏感操作                 |

源码取证复用：[tenant action presets](../../crates/cognia-tenant-auth/src/actions.rs) 拆分 execution/credential/publish；[shared-session access](../../lib/collab/shared-session-access.ts) 区分读、导出和共享；[knowledge ACL](../../lib/workflow/knowledge/access.ts) 的 principal/group match 只证明 source read，且非 public entrypoint 存在 trusted-local，不能证明外部群发布资格；[principal resolver](../../lib/connectors/principal/resolve.ts) 的 cross_account 同时比较 tenant/principal account，不能直接推断平台 ban；[memory caller](../../lib/memory/api/caller.ts) 与 [session reader](../../lib/knowledge-base/runtime/session-reader.ts) 复用，但须绑定群运行和撤销版本。

### 8.2 第二轮针对新权限契约的反证

| ID  | 残留反例                                                                | 判定与修订                                                                                                                    |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| F1  | 显式 guest 没有 executor，可能要求 guest 拥有模型凭证或借 operator 身份 | 有效；所有群回合分 requester、installation service executor、source subjects；guest 只触发预授权服务                          |
| F2  | 有限审批者不具有资源 share 权，审批资格的签发根仍含糊                   | 有效；资源/凭证治理者签发有限 operation-approval mandate；不含 share/delegate；批准冻结 mandate/父授权 refs，撤销即失效       |
| F3  | opt-out 成员的单次 @ 及 Bot 回复会回流为以后旁听                        | 有效；持久 purpose-bound source use grant；请求/回复/回声不进入 observation 或后续上下文；引用他人来源另验，不因本人 @ 代授权 |

主会话逐条对照新文字并修订 §4.1–4.6、§5 的观察字段/回声入口、§6 的 reader/cache/长期事实、§8 的发送复验及 WP0–WP6。A22–A30 共 9 条新增行为验收覆盖上述反例。此处“处理”仅表示设计已经规定对应阻断条件；没有宣称实现运行成功，也没有将同模型审查描述成跨模型审查。

当前 Host/存储和平台验证仍是受信边界；应用侧授权不能防御拥有本机磁盘/进程控制权的恶意 Host 管理者。来源用途继承覆盖可识别的 source refs、引用、回声和派生链，不能承诺识别任意成员手工复述已获知的信息。后续平台验收须核对实际 provenance 保留能力；无法追溯的引用不自动展开受限原文。

## 9. 2026-10-21 用户追加：短平快与具体群聊场景

新决策对象为方案 §7 的输入组装、profile、发言时效和多人并发语义；不再重新审查完整权限架构。要证伪的是：仅有 FIFO、debounce、256 token 上限及全局新消息取消，便能提供普通群聊体验。用户要求具体场景，主会话补充了 14 类合成时序样例，而非声称已经收集或验证真人记录。

| ID  | 第一轮反例                                                | 修订                                                                                                          |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| C1  | 同为显式 @，闲聊迟到应丢弃，任务却不能静默消失            | participation 与 response profile 正交；social/brief-answer/task 分别规定输出、freshness、任务终态            |
| C2  | 「@Bot 起个名字」「给猫的」「黑色的」被拆成抢答与自主插话 | 在既有 queued job 组装有授权同人 support refs；800ms/1.5s 有界、执行前冻结、独立 @ 不合并                     |
| C3  | A 问 Bot，B/C 聊晚饭，任何新消息都取消导致饥饿            | 按 target/context dependency 和新消息相关性重验；撤权/删除等仍硬取消；不确定最多一次已有预算内 selector 复验  |
| C4  | selector 只选 A，但整批来源都被标记消费，B 话题丢失       | candidate、selected/consumed、context refs 分开；未选来源保留原 expiry，预算/冷却内可重评，不保证每题主动回复 |

新增 §7.5–7.7：social 默认短句单条、brief-answer 先给可用答案、task 保留完整交付；不把 tokens 当字符数，不机械裁断代码/事实归因。每个 profile 单独统计字数、消息数、端到端完整有效回答延迟和过期率；P50≤3s/P95≤8s 仅是条件明确的短答试点目标，不是测量结果。A31–A37 是未来回放和真实平台验收要求，不是本次已通过的行为测试。

第二轮对新场景契约发现 3 项残留并纳入：

| ID  | 反例                                                     | 修订                                                                                                                      |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| C5  | 显式 social 无 episode，排队 40 秒后仍可能补发旧闲聊     | sendBy 属于全部 social run，以目标 freshness 与 job expiry 冻结；claim、模型 deadline 和实际发送均复验                    |
| C6  | task 必须通知失败，与撤权后禁止发送相冲突                | 无条件持久终态；仅在当前 egress 允许时通知，否则 notification_suppressed，在仍授权的状态界面查看                          |
| C7  | eventAt 未明确可信度，未来平台时间或重放可延长旧内容寿命 | 分开展示时间与首次冻结 freshnessAt；校验服务端时间/偏差，未来异常不启动 social；固定 deadline 不随重投/重启续期，补入 A37 |

两轮反例均已逐条修订设计文字；未运行真实模型/平台延迟测量，未声称场景行为已实现。用户此前跳过跨模型的选择继续有效，本轮未调用外部 CLI。

## 10. 2026-10-21 联合对抗：权限、记忆、场景与可交付范围

用户要求把此前分开补充的权限、记忆和具体群聊场景合在一起再反证，并收敛为可落地完整方案。主会话将 artifact 切为数据/authority 生命周期、调度/真实 effect、可实施性/过度设计三个独立视角；reviewer 只读、不修改源码、不调用外部模型 CLI。当前方案使用唯一 canonical Markdown，不再增加第二份不同步的“最终版”。

待证伪判断：分别正确的权限、来源、发言策略合并后仍保持同一语义，且已有机制都必须成为首发前置条件。联合审查证明这两点都不能直接成立：有跨模块缺口，也有可通过明确缩小支持范围而推迟的工程。

### 10.1 第一遍发现、裁定与实施门

| ID  | 具体反例 / 过度设计                                                    | 裁定及最终方案                                                                                                                  | 发布门                                |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| U01 | prompt 已读完后才撤 processing/source grant，预算后仍能请求云模型      | 有效；模型/工具/平台共用实际 dispatch guard；先撤销则未登记操作不开始，已在飞独立记录                                           | R1 两类 effect；R3 扩展真实 sink；A39 |
| U02 | KB registry 仅 sessionId，A 停泊后会读到 B 替换的 reader               | 有效；Host run/attempt handle + 当前 authority；legacy session-only API 不能兜底                                                | R3 KB 开放前；A42                     |
| U03 | Bot R1→R2 派生链依赖实现被推迟到长期 memory 包                         | 有效；最小短期根/中间来源闭包前移 WP2/3，不能回溯就禁止 Bot 文本回流                                                            | R1；A40                               |
| U04 | 批准事实允许存 30 日，但原文 24h/receipt 清扫会令事实不可用或无法撤销  | 有效；bodyExpired 与 delete/revoke 分开，retentionBasis 独立，失效标记保留至最长派生物/恢复期限                                 | R3 事实开放前；A43                    |
| U05 | 源“周一”编辑成“周二”，旧批准事实和向量仍可答周一                       | 有效；version replacement 与 delete 同样先隔离旧派生物，新版本重新批准                                                          | R3；A43                               |
| U06 | mandate、全 runtime、paired 编辑等均阻塞普通文本试点，P2/P3 顺序冲突   | 有效；R1 单组合普通助手，R2 常驻，R3 各能力包独立；其余入口前置硬拒绝                                                           | §1.2/9/12                             |
| U07 | observed job 被重开，episode 和 bus 同时拥有自主执行状态               | 有效；observed 永远终态；episode 唯一调度，共用生命周期中立执行接缝/run/outbox                                                  | R2；A18/A36                           |
| U08 | 全 HTTP/WS/native fencing 改造混作首发一个子项                         | 有效；R1/R2 强制进程生命周期单写者、禁热接管，冲突进程无法执行；多 Host/自动接管 native fencing 独立交付                        | §8.3；A14/A19                         |
| U09 | 10,000 receipt 要留≥7日，1条/min 七日就超限；10分钟压测发现不了        | 有效；可信原始创建时间下短期窗口24h+5min，速率/窗口/cap公式一致，默认60新ID/min需≥86,820；单列metadata磁盘额度与完整horizon测试 | R1；A38                               |
| U10 | 合批、selector、wait、生成、复验、重生成串联，15s内常无发送机会        | 有效；R2默认本地预筛+一次生成/ignore，默认关闭wait/replan/二次语义复验/重生成；提供共享总时延预算                               | R2；A32/A33/A37                       |
| U11 | 同时贯通全部后端/SDK/draft/sync，扩大首发正文清理面                    | 有效；正文副本清单；首Host选headless/sqlite-v5，复用capture/store，不建第二SQL业务schema；不支持的副本不产生                    | R1；§5.3/9                            |
| U12 | Adapter.send 内多次真实 send/upload，外层semaphore检查覆盖不了中途撤权 | 有效；每个物理operation校验并独立登记，social序列化只准一个可见操作                                                             | R1选定Adapter；R3媒体/分段；A41       |
| U13 | unknown等待人工终结占住唯一episode槽，30s清扫又可能删证据              | 有效；delivery_unknown为调度终态，不释放已消费来源；outbound/run无正文证据保留，独立话题可继续                                  | R2；A44                               |
| U14 | 已批准工具等槽期间被取消，AbortSignal不足以证明副作用没开始            | 有效；真实effect sink对preparedActionHash进行cancel/dispatch CAS，先dispatch不能宣称回滚                                        | R3工具开放前；A45                     |
| U15 | 截止前调用平台，但平台25s后才显示，不能宣称可见时限绝对保证            | 有效；dispatchBeforeDeadline是本机硬门，platformAck/visibleAge是独立真实验收，timeout仍可能unknown                              | R1/R2；A37/A41                        |

“延后”只表示该能力在对应 gate 之前保持空集合或不支持；不是允许先用不完整实现。首发保留了身份、私有数据阻断、用途、短期派生链、保留/重放、硬预算、单写者和真实 dispatch/投递门。

### 10.2 第二遍与最终窄范围核对

流程 reviewer 第二遍未发现新的实质阻断项；数据与可实施性 reviewer 各指出一项窄残余：

- **U16 中间消息不能在根展开时丢失。** A→Bot R1→Bot R2，删/改 R1而A未变，R2仍须失效。修订 §5.4，分 directSourceRefs/rootAuthorityDependencies，全部中间 id/version/epoch 与根共同受64条/8KiB上限；A40增加该反例。
- **U17 历史/拒绝回放不能挤占安全receipt。** 过期create没有既有条目/依赖就不新建ID行；拒绝审计独立、有界、可淘汰；新安全ID速率包括delete-before-create。A38叠加满速健康消息与大量拒绝/历史回放。

两位 reviewer 第三遍只核对对应修订，均确认原缺口在文字契约中闭合、未发现该修订的残余实质矛盾，停止新增审查轮。主会话另明确 R1/R2 禁 SDK 隐藏 retry/fallback/repair；任何未来物理重试都要独立 guard/reservation。磁盘commit故障必须在后续model/send前停止/终止的故障注入保留为验收条件；未仅凭静态源码认定当前持久化失败，也未另加存储服务。

### 10.3 最终产物与证据界限

完整实施方案已统一：R1/R2/R3支持矩阵、7步运行链、正文副本清单、最小短期来源闭包、长期事实独立保留、run-bound KB reader、唯一episode调度、模型/平台effect门、14类基本场景及9类权限×记忆×场景组合、45条验收和8个工作包。上线可按R1→R2执行，R3各包不阻塞聊天核心。

联合复核只读校验了当前关键owning source，包括bus入口、room memory初始化、KB registry、11个Adapter分支、headless lease和capture/store/sqlite通用持久化；HEAD已从初查变化到`0d138eefc6f1d3535ffd57db71a898e540e3686f`，共享修改未被纳入本任务。2026-10-20的337/338测试结果保留为历史记录，未拿来证明本轮设计已实施或当前测试状态。

本轮没有业务代码、真实群授权、模型调用、部署、全量lint/typecheck/build或运行时E2E。文档格式、引用、验收编号和图表独立检查；自然度、时延、完整horizon容量、双owner与磁盘故障仍须按各发布门真实验证。用户此前明确跳过跨模型审查，本次未调用外部CLI。

本轮静态验证结果：Prettier check 通过；73个本地引用存在；13个主章节、7个目标、45条验收、8个工作包编号完整；14类基础与9类交叉场景一致；容量公式检查通过；两张Mermaid实际渲染并查看。以上均为文档/设计验证，不是功能测试通过。

## 11. 2026-10-21 打断补充：目标归属、控制快路与并发边界

用户追问“还有打断什么有考虑到吗”。既有生成取消/source失效规则不足以当成完整群聊控制协议，主方案新增§7.10的10类打断场景，并对齐§7.1、动作集合、effect requestRef、WP与A46–A49。普通成员可取消自己的明确请求，控制绕过普通FIFO；新合法显式请求抢占全部非终态resident工作，不取消他人显式任务；更正新建独立请求，不live steer、不继承旧审批。已发送或已dispatch的副作用分开核对，取消不等于撤回或忘记。

fresh-context reviewer只读检查窄契约，第一遍发现3项有效问题：

| ID  | 反例                                                            | 修订与验收                                                                                                                                     |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | job已经claim为running但尚无executionRunId，取消落在两条路径之间 | 在原job持久request级cancelRevision等事实，queued/running-unbound/bound均可取消；claim/bind/start/effect均检查同一事实；A46屏障测试             |
| B2  | 先取消后创建更正job，两步间崩溃会丢失或重复替代请求             | 同一capture transaction记录取消、control disposition、固定replacementJobId/localSequence和queued/rejected；恢复按处置而非重新解释正文；A47/A48 |
| B3  | 只抢占generating，遗漏deciding和等发送槽的delivering            | 抢占覆盖collecting/deciding/ready/generating/delivering，阻断全部未登记effect；已登记请求保留在飞事实；A47/A49                                 |

第二遍仅复核以上修订，reviewer未发现这三项仍有实质矛盾。未开启跨模型CLI，未修改业务源码或声称群控已经可用。现有run-control的revision/idempotency/journal和inbound job CAS可复用；follow-up-control当前对普通parent group排除裸词控制，不能把私聊的conversationKey级live steer直接扩成公共群控制。

当前主方案共有49条未来验收。该补充不增加调度服务/新数据库表；R1文本请求取消、R2自主抢占、R3副作用/恢复按原发布门实施。静态验证覆盖格式、76个本地引用、G/A/WP编号和14+9+10场景表；原两张图结构未变。真实取消时延、claim→bind屏障、崩溃恢复及平台在飞行为仍须实施测试。
