---
title: "0239 — 外发动作由请求授权，而不是由工具授权"
description: "智能体有约十条路径可以向第三方发送内容，每条各有各的门禁或根本没有，也没有任何地方记录一次发送是发给谁的、由谁要求的。本 ADR 补上 Action Review 契约早已预留的策略引擎：外发动作需要一个已授权的收件人。请求所在的线程隐含授权；其他收件人需要显式授予（仅本次、本条指令内，或由人配置的持久策略）。人工拒绝会屏蔽同一发送，直到请求人给出新指令；无人值守运行绝不发给未授权的收件人。"
---

# ADR 0239 — 外发动作由请求授权，而不是由工具授权

**状态：** 已接受（第一期、第二期 2a 与 2b 已实现，各自默认影子模式）
**日期：** 2026-10-24
**相关：** [ADR-0070](./0070-risk-ceremony-policy-layer)（风险 → 仪式；“回复到发起线程”的先例）、[ADR-0169](./0169-one-runtime-one-review-one-control-machine)（统一审核契约）、[ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched)（按次运行的能力授予）、[ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)（在 Host 上的无人值守运行）
**更正：** Action Review 契约文件头引用了 ADR-0102（一份可观测性决策）和一个从未实现的策略引擎

## 背景

### 已有的部分

Cognia 已经具备授权系统的大部分组成：

- **Action Review 契约**（`packages/agent-config-types/src/action-review.ts`）定义了请求、决定和持久化的 receipt，以及 15 个渠道。其中 `ActionReviewAuthority` 刻意不含 `"model"`：模型只能填写 `recommendation`，契约写明策略引擎“把它复制到请求上，但从不读取”。
- **Receipt**（`lib/db/action-review-receipts.ts`）保留 90 天，上限 20,000 行。聊天工具、七个 Squad 门禁和 workflow 步骤会写入。
- **确定性规则**：按工具的 `allow | ask | deny` 规则集（显式 deny 优先）、命令安全检查，以及 ADR-0070 的风险分类器，其中 `external-send` 被评为高风险。
- **无人值守处理**：定时、Bot 和插件的 turn 携带 `permissionProfile`（ADR-0198）。它们的工具审批会停泊 30 分钟并推送到手机（`lib/claude/unattended-park.ts`）；一直无人应答的运行以 `needs_approval` 结束。
- **Connector 防护**：写入类 HITL 卡片默认开启（`lib/connectors/permission-resolve.ts`），有草稿队列（`runtime.ts` 的 `createDraft`），每次自动投递都经过 PII 门禁（`lib/connectors/delivery-gateway.ts`）。
- **拒绝记忆**：`lib/claude/permissions/session-denials.ts` 把人工拒绝变成本会话剩余时间内的显式 deny 规则。

### 缺失的部分

**策略引擎从未实现。** 契约文件头提到 `lib/policy/action-review/policy.ts` 和 `planActionReview` 函数，两者都不存在。各个生产方自行判定，事后再写 receipt，而且只有部分会写：`connector-tool`、`connector-workflow`、`github-delivery`、`thread-handoff` 和 `generic` 没有任何生产方写入，`bot-step` 只查询了自己的 adapter。

**没有任何地方知道一次发送是发给谁的。** 智能体可以经由约十条路径触达第三方，每条各有门禁或根本没有：

| 路径 | 现有门禁 |
| --- | --- |
| IM 自动回复（`lib/connectors/runtime.ts`，`source: "ai-run"`） | 只有 PII 门禁 |
| 定时 digest、`/schedule`、external-bridge 的 `connectors_send_message`（`lib/connectors/scheduled-outbound.ts`） | 发送时无门禁。digest turn **没有传入权限响应器**，其审批无人应答，直到超时 |
| `im.broadcast`（最多 20 个目标）、`im.create_chat`、`im.dispatch_task` | 写入类 HITL 卡片 |
| 插件 `ctx.connectors.enqueueSend`（`source: "plugin"`） | IM turn 中逐次弹卡 |
| Workflow `action.connector.send` | 节点风险门禁，仅当该 workflow 开启 `riskGating` |
| Bot 投递 | 走 connector 路径 |
| `send_email` 等内建与 MCP 工具 | 普通的 `ask` 阶梯；MCP 注解不被信任 |
| 经集成 broker 的 GitHub 写入：PR、issue、评论、评审（聊天工具、workflow 节点、插件、Bot） | 写入需要按仓库限定的能力授予，或由人在集成审批队列里批准。Bot 的写入需要已批准的 `bot_approval` 中断；设为自动发布的 Bot 在安装允许免审批写入时按策略通过。没有任何地方把仓库与请求对照 |
| Squad 堆叠交付（运行结束时 `POST /pulls`）；shell 里的 `gh pr create`、`gh api -X POST` 等 `gh` 写入 | 无：`gh` 被归为安全命令 |
| 浏览器点击、按键、填表 | 普通阶梯。没有任何路径知道一次动作会不会提交 |

代码里任何地方都没有外发收件人白名单：所有 “allowlist” 管的都是入站触发；`/schedule` 的白名单管的是谁可以创建定时任务，而不是谁会收到。外发 job 记录了 `source`，但没有记录是谁要求的。

**规则集的 allow 等于授权所有收件人。** 对发送工具点了“始终允许”，或该工具在 `alwaysAllowTools` 中，之后每一次调用、发给任何人都会放行。

**拒绝不持久。** 会话拒绝只存在渲染进程内存里，重载即丢。它们以命令或路径为键，而发送工具两者都没有，于是一次拒绝会变成整个会话内对该工具名的 deny。它们从下一次发送起生效，而不是当前 turn。子任务运行在自己的 session id 上，看不到这些拒绝。只有主聊天里的人工拒绝会被记录；auto-mode 的拒绝、超时、ACP 应答、队友审批和无人值守停泊都不会。`clearSessionDenials` 没有任何生产调用方。没有任何机制把一次拒绝和它所回应的指令关联起来，所以“不要发”只在模型记得时才有效。

**Auto-mode 帮不上忙。** 它只判断 shell 命令，其 judge 收到的是命令、工作目录和回复语言，从不包含用户的请求。对命令安全 judge 来说这是正确的设计，也意味着 auto-mode 对“消息发往何处”无从判断。

### 先例

ADR-0070 否决了把 IM 绑定的运行当作 `external-send`：从某个线程召唤的团队**回复到同一线程**，正是功能本身，因为收件人就是提问的人。真正的风险是“触达请求人没要求的收件人”。本 ADR 让这句话可以被强制执行。

## 决策

### 一个引擎，放在契约预留的位置

`lib/policy/action-review/policy.ts` 导出 `planActionReview(request, context)`。它是纯函数、确定性的，返回一个计划：`allow`、`ask`、`draft`、`park` 或 `deny`，并附上依据的 authority 和授予。生产方在执行之前调用它，而不是事后。它从 context 读取规则集判定、授予和屏障记录；它复制 `recommendation`，但从不读取。每个结果都经现有写入函数记为一条 `ActionReviewReceipt`。

第一期只对**外发动作**调用引擎，其他工具审批保持原路径不变。

### 外发动作及其目标

一个动作在会把内容投递给用户以外的一方时，就是**外发动作**：

- 来自任何自动来源（`ai-run`、`skill`、`plugin`、`workflow`、`notification`、Bot 投递）的 connector 投递。`manual` 和 `draft-approved` 是人本人的操作，不再重复审核；
- 工具被归为外发类的工具调用。只维护一份列表（`lib/policy/risk/outbound-tools.ts`）和一套名称归一化，风险分类器与本引擎共用。分类器的 `external-send` 集合仍是其中较窄的一部分：IM 内建 skill、`team_post_to_chat`、`connectors_send_message` 在这里受审查，但暂不计入风险，因为计入会改变每个能用它们的团队的计划门控。这个差集由测试固定。发往用户自己的会话或队友的消息（`send_session_message`、`team_send_message`）不算外发。

每个外发动作都带有一个**目标**：渠道（connector adapter、邮件或工具族）加归一化的收件人 id（会话键、用户 id、地址）。无法给出目标的生产方，交互场景下得到 `ask`，无人值守场景下得到 `draft` 或 `park`，绝不是 `allow`。

### 谁被授权

`planActionReview` 按以下顺序判定，第一个匹配即为结果：

1. **屏障或显式 deny → `deny`。** deny 规则仍然压过一切，与现状一致。命中屏障（见下文）记为 authority `policy-deny` 的拒绝。
2. **发起线程 → `allow`。** 当前指令所来自的会话隐含授权：用户输入的桌面端或配对设备会话，或请求人发言所在的 IM 线程。Authority 为 `policy-default`。
3. **授予 → `allow`。** 卡片授予的 authority 为 `human`，配置授予为 `policy-rule`。授予有三种范围：
   - `once`：仅此一次动作，来自审批卡片；
   - `instruction`：在指令纪元推进前，此渠道上的此收件人，来自审批卡片；
   - `policy`：由人在 Bot 安装或 connector 频道策略上配置的收件人列表。只有人能写入，智能体、插件和模型都不能。
4. **其余情况：** 交互场景 → `ask`，卡片上显示收件人。无人值守 → connector 投递转为 `draft`（现有草稿队列，由人批准），工具调用转为 `park`（现有无人值守停泊和手机推送）。无人值守运行绝不发给未授权的收件人。

由此有两个推论：

- **规则集的 `allow` 不再授权收件人。** 对外发工具而言，它只表示“这个工具可以用”，收件人仍需满足第 2 或第 3 步。显式 `deny` 保持全部效力。
- **外发动作没有会话级的“始终允许”。** 卡片隐藏该按钮，与现在对 `requiresPerCallApproval` 工具的处理一致。持久授权只能是由人编写的 `policy` 授予。

为保证可判定，外发工具总是会到达渲染进程：sidecar 把 `outbound` 类视为总是询问，无论有没有 `permissionProfile`（现在只在有 profile 时生效）。之后若第 2 或第 3 步匹配，引擎静默放行，所以回复到发起线程的情形不会弹卡。

### 模型只能收紧

模型对请求的理解只能让计划更严格，不能更宽松。例如，用户说了“起草，别发”，模型可以把 allow 变成 ask，但永远不能把 ask 变成 allow。第一期只上线上述确定性顺序；模型收紧放在第三期，且只能经由 `recommendation` 进入。

### 指令纪元

每次外发审核都带有其根会话的**指令纪元**：请求人最新一条消息的 id。以下情况会推进纪元：

- 用户在桌面端或配对设备上发送消息；
- 在 IM 里，原请求人在线程中发送新消息；
- 在共享会话里，本次运行所服务的成员发送新消息；
- 对于没有会话的运行（定时任务、Bot 触发），由人编辑任务或安装配置，或在其会话中发言。

以下情况**不会**推进纪元：定时或 Bot 触发、webhook、模型自己的后续动作、子任务或队友的消息、IM 群或共享会话里其他人的消息。自动化写入的用户角色消息也不会推进：其他会话的 agent、后台任务结果、项目协调器、工作流、插件、校验器、外部运行时、导入的历史。这类消息与本人输入的形状完全相同，所以这些生产者在消息上标记 `metadata.automatedTurn`。只有人的编辑会推进任务或 Bot 的修订号，agent 或插件的编辑不会。

### 拒绝屏障

对外发审核的**人工拒绝**会产生一条屏障记录。只要根会话的纪元不变，任何**指纹**相同的外发动作都会被直接拒绝，不再询问。这包括换一个工具、换个措辞，或同一根会话下的子任务和队友。

- **指纹**：`outbound | 渠道 | 归一化收件人`。不包含消息正文，所以换措辞绕不过屏障；换了收件人则重新评估。
- **根会话**：子任务、队友和后台子运行经由现有的审批路由映射到根会话（`lib/claude/agents/subagent-approval-routes.ts`、`lib/chat/approval-routing.ts`）。
- **存储**：屏障不是新的存储，而是从拒绝 receipt 推导，所以重载后仍然有效，也不需要第二个事实来源。Receipt 增加可选字段（契约版本 1，仅追加）：`subject.targets`、`origin.rootSessionId`、`origin.instructionEpoch`、`request.plan` 和 `decision.grant`。目标只存渠道和指纹。收件人本身（会话键、平台用户 id、地址）属于个人数据，而 receipt 表被归为 metadata-only；持有同样目标的定时任务正是因此被加密存储。用一个 multiEntry 索引 `*authKeys`（`deny|根会话|纪元|指纹` 与 `grant|…`）同时服务屏障和指令授予；Dexie 不支持把 multiEntry 字段放进复合索引。该索引在 schema v249 加入。查询走内存缓存。
- **不构成屏障的情况**：超时或过期不是拒绝。它只拒绝当次动作，下次尝试会重新询问（现有的 doom-loop 防护仍然限制重复次数）。模型的意见永远不会形成屏障。
- **有效期**：直到纪元推进，上限为 receipt 的保留期。处于休眠的 `pruneActionReviewReceipts` 现在由中央保留期清理器执行；行数上限永不裁剪带有屏障或授予的 receipt。

`session-denials.ts` 继续处理非外发工具；外发类的拒绝改走屏障。

### 两个咽喉点

- **工具调用**：桌面端权限处理（`hooks/chat/claude-chat-events.ts`）、无人值守响应器（`lib/claude/unattended-permission-responder.ts`）和队友路径（`lib/chat/room/runner.ts`）在弹卡或自动应答之前，对外发工具调用 `planActionReview`。
- **Connector 投递**：`enqueueOutbound` 在创建 job 之前为每个自动来源做计划。未授权的无人值守投递变为草稿。已带有工具调用授予的投递不会被问第二次：job 会携带授权它的 receipt id。

### 谁要求的

外发 job 记录 `authorizedBy`：receipt id、请求人身份和授予范围。仅凭 job 就能回答“谁授权了这条消息”；之后面向收件人的归属展示（[roadmap](../../../../plans/2026-10-24-grok-gap-roadmap.md) 中的邮件 connector）也将读取它。

### 顺带修复

- `scheduled-outbound.ts` 中的 digest turn 获得与其他定时 turn 相同的无人值守响应器，其审批改为停泊，而不是无人应答。
- 契约文件头改为引用本 ADR 而非 ADR-0102；`registry.ts` 不再声称有九个渠道（实际是 15 个）；修正已失效的 `lib/ai/agent/agent-team-runtime.ts` 路径。

### 第二期：GitHub 写入与浏览器提交

第二期把同一个引擎扩展到另外两类收件人，而且只收紧：引擎放行一次 GitHub 写入时，现有的门（sidecar 卡片、能力授予、集成审批队列、`bot_approval`）照常生效。引擎只在三种情况下改变结果：无人值守地写给未授权的收件人时把写入挂起，被屏障的收件人直接拒绝，聊天里要写到发起线程以外的地方时先询问。

- **GitHub 的收件人是仓库。** 一次写入的目标是 `github:<host>/<owner>/<repo>`。它写入的 PR 或 issue 是线程：写回请求所在的线程（Bot 在 PR #12 被提及后回复 PR #12）属于回复到发起线程。名单条目、授予和屏障都覆盖整个仓库。正文里被 @ 的人和指派人不作为收件人审查。
- **纳入的路径**：集成 broker 的全部写动作（聊天工具、workflow 节点、插件代码、Bot），带凭据的非 GET 原始请求（如 Issue Loop 的 `POST /pulls`），Squad 堆叠交付，以及 shell 里的 `gh` 写子命令。`gh` 的仓库取 `-R`、API 路径或工作目录的 remote，取不到时为未知目标。`git push` 维持现有询问：它供给代码，不指向任何人。GitHub MCP 服务器的工具留在普通阶梯，因为它们的名称和形状不由我们定义、不可信。写到用户自己仓库的备份不算外发。
- **已配置的自动化照常工作。** 按仓库限定的能力授予、Bot 安装的仓库范围加自动发布、Squad 团队绑定仓库并开启堆叠交付，都是人写下并点名了该仓库的配置，各自算作对该仓库的 `policy` 授予。新增只能由人写的名单：Bot 安装的名单可以包含仓库；每个 GitHub 集成账号有一份仓库名单，覆盖经该账号的全部无人值守写入。
- **未授权的无人值守写入会等待。** 执行模式下，即使能力授予或 Bot 绑定本会让它直接入队，也一律停在集成审批队列，并像停泊的工具审批一样推送给用户。Squad 的发布等待“批准并发布”。
- **人自己的点击就是授权。** 堆叠发布与合并、issue 发布与回写、评审发布、线程 PR 按钮只记录一条 `human` receipt，行为不变。
- **浏览器的收件人是站点**：一次提交所发请求的 origin。交互请求用“本次请求允许”授予；无人值守的运行用“设置 → 安全”里的全局站点名单，Bot 的名单也可以包含站点。2b 先逐个引擎实测：提交能否在发出前被识别或挂起。没有可靠信号的引擎上，执行模式下对未授权站点的点击、按键、填表按可能的提交处理。
- **每个类别有自己的开关。** 消息与邮件（第一期）、GitHub、浏览器各自从影子模式起步，由人逐个确认后才执行。因此升级后，已对消息开启执行的用户不会突然开始拦截 GitHub 或浏览器写入。

## 分期

| 期 | 范围 |
| --- | --- |
| 1 | 引擎；外发列表与目标；发起线程、授予、草稿/停泊的判定顺序；指令纪元；屏障及其 receipt 字段与索引；两个咽喉点；`authorizedBy`；digest 响应器；对外发工具隐藏“始终允许”；文档更正 |
| 2a | GitHub 写入：集成 broker、带凭据的原始请求、Squad 堆叠交付、`gh` 写命令（计划：`docs/plans/2026-10-25-adr-0239-phase-2.md`） |
| 2b | 浏览器表单提交，先用 spike 逐个浏览器引擎确定提交信号 |
| 3 | 经由 `recommendation` 的模型收紧 |

## 实现（第一期）

第一期分十二个工作包落地（计划：`docs/plans/2026-10-24-adr-0239-phase-1.md`）。引擎默认运行在**影子模式**：每次外发工具调用和 connector 投递都会规划，计划记在 receipt 上（`plan.enforced: false`），但不改变任何发送。用户在“设置 → 安全”中查看执行后会改变什么，再开启执行（`agentPermissions.outboundAuthorization: "enforce"`）。

### 代码位置

- **引擎**：`lib/policy/action-review/policy.ts`（`planActionReview`、`readOutboundAuthorizationMode`）与 `plan-context.ts`（会话、定时任务 `task:<id>`、Bot `bot:<id>`、workflow 运行的 origin；屏障与本次请求授予取自 receipt 的 `authKeys`，schema v249）。
- **目标**：`lib/policy/risk/outbound-tools.ts`（外发工具名单）与 `lib/policy/action-review/outbound-targets.ts`（规范化目标与指纹）。
- **工具咽喉点**：`plan-tool-call.ts`，由桌面询问路径、所有 headless 捕获的 `run-and-capture.ts`、定时任务执行器和 CLI 工具宿主调用。sidecar 对外发类工具总是询问。
- **投递咽喉点**：`plan-delivery.ts`，由 `lib/connectors/delivery-gateway.ts` 的 `enqueueGoverned` / `enqueueAuthorized` 调用，每个 job 记录 `authorizedBy`。工具发起的投递经 `authorized-tool-calls.ts`（内存中记录已规划、已放行的调用）对应到该次调用。
- **策略授予**：`configured-grants.ts` 读取三份只能由人写的名单：connector 实例的 `outboundRecipients`（`adapter:<id>`，经该账号的所有无人值守发送）、会话的 `proactivePush` 开关、Bot 安装的 `outboundRecipients`（`bot:<id>`，只覆盖该安装的运行）。在连接设置和 Bot 详情中用同一个编辑器编辑。
- **卡片**：桌面与手机的审批卡片显示每个收件人，并提供“本次请求允许”（`instruction` 范围）。外发工具不再显示“始终允许”。
- **影子报告与开关**：`shadow-report.ts` 与 `components/settings/security/outbound-authorization-card.tsx`。

### 实施中的决定

- **receipt 不存收件人。** 目标只以频道和指纹持久化（`ActionReviewTarget`），因为 receipt 表只存元数据。收件人名称只存在于内存中的待审批项上。影子报告用本机已有的数据反查指纹：connector 会话状态、绑定的会话和已配置的名单；查不到的只计数，不显示名称。
- **名单存收件人原文**（引擎的规范化形式），方便人看清自己允许了谁；指纹在规划时计算。
- **无人值守运行在应答权限请求的地方规划**（`run-and-capture.ts` 的 `answerWithOutboundPolicy`），而不是在每个 responder 里。digest turn 的审批：定时触发时像定时任务一样停泊；由卡片点击触发时在该会话里询问；来自外部桥接时当场拒绝。
- **通知目标不需要名单。** 受治理的通知推送直接写 job；设为主动推送的目标本身就是人的授予（记为 `policy-rule`），仅回复发起方的目标只发审批请求。
- **`authorizedBy` 尚未包含请求人。** 请求人已用于纪元推断，但还没写到 connector job 上。

### 已知缺口

- 经 `/lark` 斜杠命令路径做出的批准不经过宿主的 `approveTool`，其后的工具投递按无人值守判定。
- 执行模式下，外部桥接需要审批的 digest 会转为草稿。
- 本机驱动配对 Host 时，开关和报告只显示说明：设置和 receipt 都在 Host 上，尚无远程读取。
- 执行模式已有单元与集成测试，但还没有在真实桌面和手机上跑过（一次发起线程回复、一次跨群发送、一次在手机上批准的停泊审批、一次 Bot 定时投递从草稿到批准发送）。

## 实现（第二期 2a）

第二期 2a（GitHub 写入）分十个工作包落地（计划：`docs/plans/2026-10-25-adr-0239-phase-2.md`）。它有自己的开关，从**影子模式**开始：每次 GitHub 写入都会规划并记录，但不改变任何结果，直到用户在“设置 → 安全”中开启（`agentPermissions.outboundAuthorizationByCategory.github: "enforce"`）。对消息开启执行不会对 GitHub 开启执行。

### 代码位置

- **目标与类别**：`outbound-targets.ts` 新增 `repositoryTarget`（`github:<host>/<owner>/<repo>`，host 缺省 `github.com`；PR 或 issue 是只在内存中的 `thread`，只用于匹配发起线程）、供 2b 使用的 `siteTarget`，以及 `outboundCategoryOf`。`readOutboundAuthorizationMode(settings, category)` 读取各类别的模式；一次计划只要有一个目标所在类别为执行，即按执行处理。
- **什么算 GitHub 写入**：`github-targets.ts` 读集成注册表（集成 `github` 或操作 `github.*`，且不是 `read`），仓库取自动作的 `scopeSelectors`。`gh` 命令由 `packages/plugin-contract/src/lib/claude/permissions/gh-command.ts` 分类（读、写、本机；未知命令按写处理），仓库由 `gh-targets.ts` 提取（`-R`、`GH_REPO`、PR 或 issue URL、API 路径，否则取会话检出的 `origin` remote，再取不到为 `unknown`）。`command-safety.ts` 把 `gh` 移出安全命令：写入会询问并算作外发，auto 模式的模型裁判不能放行。
- **broker 咽喉点**：`plan-integration.ts`（`planIntegrationWrite`），由 `executeIntegrationAction` 在写入 job 入队前调用，并由 `authenticatedIntegrationRequest` 对每个非 GET 请求调用（含 Issue Loop 的 `POST /pulls`）。其 receipt 为 `github-delivery` 渠道上的 `integration-action`，写明请求方（`plugin:<id>`、`bot:<id>`、`workflow:<id>`、`tool-call:<会话>`、`agent-team:<id>`、`person:<界面>`）与所经集成账号。被停下的写入以 `awaiting_approval` 入队并带 `outbound.held`，经 `lib/integrations/outbound-hold.ts` 推送；只有人的批准能放行，人取消即对该仓库形成屏障。
- **工具咽喉点**：`plan-tool-call.ts` 把 GitHub 写工具和含 `gh` 写段的 shell 调用作为外发、按 GitHub 类别规划。sidecar、Agent SDK hooks 与 CLI 工具宿主经 `SendOptions.alwaysExplicitGithubWritesMode` 与 `alwaysExplicitGithubTools` 对它们执行 always-explicit 规则，由 `resolveSendOptions` 每轮按 GitHub 模式设置。
- **Squad**：`prepareAndPublishGithubStack` 规划堆叠发布（`team-delivery`）。被停下的发布让运行进入 `needs_input`（`delivery_awaiting_approval`，被拒后为 `delivery_refused`），推送到手机，由运行的持久操作里的“批准并发布”放行。
- **policy 授予**：`configured-grants.ts` 新增集成账号的仓库名单（`integration-account:<id>`，仅宿主可写，在集成中心编辑）、按仓库限定的能力授予（`capability-grant:<id>`）、自动发布的 Bot 的仓库范围，以及团队已同意的仓库。`gh` 命令不指明账号，因此所有 GitHub 账号的名单都对它生效。
- **人自己的写入**：`human-github-write.ts` 在堆叠发布与合并、restack 说明、评审发布、线程 PR 创建与合并、交接后开 PR、团队“批准并合并”之前记一条 `human` receipt。发布 issue 与 issue 回写向 broker 传入 `person` 调用方。
- **开关与报告**：安全卡片每个类别一个开关；`shadow-report.ts` 每个类别一份报告，对仓库提供 Bot 名单或 GitHub 账号名单。

### 实施中的决定

- **`gh` 写入跟随 GitHub 的模式，而不是外发权限类。** 归入外发权限类会在 GitHub 仍处于影子模式时就让无人值守的 `gh` 写入停下。影子模式下，`gh` 写入经普通权限阶梯询问，bypass 模式与 allow 规则仍可跳过；GitHub 执行模式下每次都询问。
- **团队的堆叠交付需要人的同意。** 团队配置并非只由人写：持有 `team:write` 的插件、Agent SDK 和自动编排都会写。在设置卡片中开启堆叠交付会记下 `githubDeliveryPolicy.consent` 及当时绑定的仓库，只有这些仓库被授予。其它写入方最多沿用已存的同意，关闭交付即丢弃。
- **人的点击只记录，不规划。** `person` 授权直接放行并记 `human` receipt。否则已确认的 issue 回写会被当作插件写入规划，在执行模式下被停下。
- **receipt 以 id 记下集成账号**，放在 `subject.input.integrationAccount`，影子报告据此提供能放行这次写入的名单。没有账号的写入（`gh`、堆叠发布）列出仓库所在 host 上的账号供人选择。
- **2a 不提供浏览器开关。** 2b 之前没有任何路径规划浏览器提交，所以卡片在 2b 加上开关之前不显示它。
- **影子报告会启动插件运行时。** 哪些账号是 GitHub 账号来自集成注册表，注册表在插件加载时才填入，而设置页本身不启动插件运行时。

### 已知缺口

- 应用里还没有任何地方写入能力授予，因此 `capability-grant:<id>` 来源在有写入方之前只读。
- 按决定，GitHub MCP 服务器的工具仍走普通权限阶梯。
- GitHub 写入的执行模式已有单元与集成测试，但还没有在真实桌面和手机上跑过（Comment Bot 回复其被提及的 PR、在手机上批准一次写到未列出仓库的无人值守写入、聊天里一次跨仓库的 `gh` 命令）。

## 实现（第二期 2b）

第二期 2b（浏览器提交）先做一次 spike，再分四个工作包实现（计划：`docs/plans/2026-10-25-adr-0239-phase-2.md`；spike：`docs/research/2026-10-25-browser-submit-signal.md`）。它有自己的开关，从**影子模式**起步：每次提交都会规划并记录，结果不变，直到有人在“设置 → 安全”里开启（`agentPermissions.outboundAuthorizationByCategory.browser: "enforce"`）。

### 代码位置

- **信号（spike）**：本地与远程 Chromium 上，`context.route` 能挂起页面发出的每个非 GET 请求，`routeWebSocket` 能挂起 WebSocket 帧。内嵌 webview 与扩展引擎没有可靠信号：注入脚本看不见 worker、`<a ping>` 与跨源框架；扩展里只有 `chrome.debugger` 能挂起请求，而 ADR-0228 §6 不允许。
- **运行时挂起**：`services/workspace-runtime/src/submission-guard.mjs`（模式 `off` / `observe` / `hold`，动作窗口加 3 s 宽限期）与操作 `browser.submission.configure/drain/resolve`。运行时从不等人：宿主在动作进行中取出被挂起的提交并逐个答复。被拒绝的导航以 `204` 应答，页面保持原样；其他请求中止。本地会话按整个 context 路由，service worker 的流量也会被挂起。接管用户自己 Chrome 的会话按页路由，drain 把被 service worker 控制的页面报为 `unguarded`。
- **远程路径**：companion 命令 `browser_submission_configure` / `_drain` / `_resolve`（configure 与 resolve 是交互写，drain 是读）。网关不为它们取 agent 租约，所以有人接管页面时宿主仍能答复。
- **规划**：`lib/policy/action-review/plan-browser.ts`（`planBrowserSubmission`）。收件人是请求的 origin，WebSocket 按其 http(s) 站点计；没有站点的页面是未知目标。全局站点名单（`configuredSiteGrants`，policy ref `browser-sites`）与发起方自己的名单（运行中的 Bot、handler Bot 的名单）放行；同一请求内被人拒绝的站点直接拒绝；其余询问。回执是 `browser-submission` 主体，走它自己的只追加通道，写明发起方（`browser:<会话>`、`workflow:<id>`、`external-bridge:<客户端>`、`plugin:<id>`）。
- **咽喉点**：`lib/browser/submission-gate.ts`（`gateBrowserEngine`）包住 `createBrowserAPI` 交出的每个引擎与 workflow 浏览器节点的引擎（`resolveRunBrowserEngine`）。Chromium 引擎上每页一个 drainer，每个站点在一个窗口内只决定一次；动作在它提出的问题都答完后才返回，被拒绝的站点以 `outbound_refused` 返回，允许的导航之后等页面加载。没有信号的引擎与 `unguarded` 页面上，对页面所在站点的点击、双击、选择、拖动与 Enter / 空格（含修饰键）先规划再执行；输入、填写、悬停、聚焦与滚动不算。
- **问谁**：`lib/browser/submission-ask.ts`。被捕获的轮次（`captured-turns.ts`，由 `run-and-capture` 登记）通过它自己的 responder 询问（IM 卡片或停泊审批），期间停住它的墙钟。桌面聊天与外部桥接客户端在 `components/outbound/outbound-ask-dialog.tsx` 上询问（允许一次、本次请求内允许、拒绝）。其余情况，或没有挂载对话框的交互询问（无头 Host），停泊到驾驶舱与手机。询问最长 9 分钟，对话框 5 分钟；14 个可能提交的工具声明 10 分钟预算（`BROWSER_SUBMITTING_TOOL_TIMEOUT_MS`）。
- **名单、开关与报告**：全局站点名单（`agentPermissions.outboundSites`，`components/settings/security/outbound-site-list.tsx`）与 Bot 的名单可以包含站点。安全卡片有浏览器开关，并写明检查看不见什么。`shadow-report.ts` 列出站点行：Bot 自己的运行可加入 Bot 名单，其余加入全局站点名单。站点名称来自内置浏览器的历史、保存了密码的 origin、浏览器配置的域名授予以及各名单。

### 实施中的决定

- **运行时不等人，宿主等。** 控制通道上限 180 s，而人可能要几分钟。运行时挂起请求，宿主在动作进行中取出并答复。
- **浏览器工具等到有答复才返回。** 超时只拒绝这一次提交，不形成屏障；拒绝在请求剩余部分内屏蔽该站点。
- **外部桥接客户端没有可挂靠授予的请求**，只能允许一次或拒绝。
- **不禁用 service worker。** context 级路由看得见它们的流量；禁用会让站点失效。
- **不做注入式拦截，不加 `debugger` 权限。** 注入不够可靠，不算信号；扩展保持在 ADR-0228 §6 之内。

### 已知缺口

- 页面用 GET 发出的数据（搜索、GET 表单、跟踪像素）在任何引擎上都不挂起。
- 专用 worker 打开的 WebSocket 在页面级与 context 级 `routeWebSocket` 下都看不见。
- 没有信号的引擎上，输入时的自动保存不算提交，页面脚本自行发出的提交会漏掉。
- 用户自己 Chrome 中被 service worker 控制的页面，提交在动作前判定，而不是被挂起。
- 一次询问最长 9 分钟。
- 浏览器提交的执行模式有单元、jsdom 与真 Chromium 运行时测试，但还没有在真实桌面上跑过（每个可靠引擎上一次表单提交被挂起后批准）。

## 后续：审计修复（2026-10-26）

一次只读的 Codex 审计检查了第一期、2a 与 2b 的绕过路径和重复实现。发现的问题与改动如下：

### 已封堵的绕过

- **`gh` 分类。** `gh api` 曾把某个 flag 的值读成方法（`-X PUT --jq -XGET` 被算作 GET）；现在每个带值 flag 的值都被消费，只有 `-X` / `--method` 设定方法。`gh extension exec` 会执行扩展代码，因此算写入，而非本地命令。在 `gh` 运行前改变 `gh` 环境的命令（`export GH_REPO=…`、`source`、`.`、`eval`，或在 `gh` 片段之外给 `GH_REPO` / `GH_HOST` 赋值）不再回退到检出目录，仓库按未知处理。sidecar 中的分类器副本改为由宿主源码生成（`scripts/build/gen-sidecar-gh-command.mjs`，由 `gh-targets.sidecar-parity.test.ts` 校验），不再手工维护。
- **插件的投递发往宿主存下的目标**（`lib/connectors/plugin-destination.ts`）。此前策略按会话键规划插件的 `enqueueSend`，而 runner 用插件自己给的引用发送，它可以指向另一个群，在飞书上还可以指向另一个人（`receiveId`）。现在插件的请求一律用宿主为该会话存下的投递目标发送（由入站消息刷新，或由 `bootstrapConversation` 生成）；`replyTo` 或 `editTargetMessageId` 必须指向宿主在该会话里见过的消息。其余情况以 `connector_delivery_destination` 拒绝。
- **消息 id 按落点判断，而不只看是否记得。** 此前插件的 `replyTo` 或 `editTargetMessageId` 只有在入站账本仍记得该 id 时才算数，因此回复同一会话里较早的消息会被拒绝。现在依次判断：入站账本；宿主收到该消息时存下的消息（`messages`，同一 bot、同一群，任意线程）；适配器的 `messageRoute`，即经存下的引用回复或编辑该 id 时会落到哪里。飞书的回复与编辑接口只按消息 id 定位，因此飞书向平台读取消息所在的群（`GET /im/v1/messages/:id`）；Telegram、Slack、Discord 与 Matrix 的编辑会发往复合 id（`chatId:messageId`）所指的群，因此解析 id；其余适配器总是发往引用所指的群。落在其他群的 id 被拒绝（`foreign-message`），无法判断落点的 id 也被拒绝（`unplaced-message`）。Discord 适配器放进 URL 路径的每个 id，以及飞书回复的 id，都作为单个路径段转义（`discordPathId`），任何 id 都不能把请求带到另一个频道的接口（`../../222/messages/333`）。
- **暂时无法判断落点的 id，在发送前再判断一次。** bot 未在运行，或平台暂时无法查询（网络错误、5xx、限流：`messageRoute` 抛出异常）时，排队的投递（`enqueueSend`）把该 id 记入 `metadata.pendingPlacement`（由宿主写入，插件自带的值会被丢弃），出站 runner 在发送前用运行中的适配器再判断一次：落在其他群则死信 `destination_foreign`，无法判断则死信 `destination_unplaced`，仍然无法查询则像网络失败一样重试，直到达到尝试上限。立即发送的投递仍直接拒绝。飞书会话按 open id（`ou_`）指向一个人时没有群 id 可比，此时若消息由该人发送，且所在会话是单聊（`chat_mode: "p2p"`，`GET /im/v1/chats/:id`），即只有 bot 与该人，则判定为落在本会话；群聊或话题群判定为落在别处。bot 自己在单聊里发的消息由账本中的已投递记录判断；已投递记录现在有独立的 50,000 行上限，与 10,000 行的入站窗口分开，入站高峰不会把它们挤掉。
- **open id 会话记住它的单聊。** 发送结果可以带上投递落到的平台会话（`OutboundResult.platformChatId`）；飞书在 bot 按接收者 id 新发一条消息时返回响应中的 `chat_id`，接收者是 open id 时即 bot 与该人的单聊；回复以及以个人身份发送的消息不带。宿主为每个会话与群各记一行 `"landed-chat"` 账本记录，永不清理，并交给 `messageRoute`（`evidence.landedChatIds`）。落在已记录会话里的消息判定为本会话；落在另一个单聊里的判定为别处，因为 bot 与每个人只有一个单聊。没有记录时，单聊里的那个人就是在其中发过言的人：先看消息的发送者，再看会话历史（`GET /im/v1/messages`，按时间倒序，最多 5 页、每页 50 条），因此 bot 自己的旧消息也能判断落点。这些单聊判断只采信 bot 自己读到的结果：以个人身份读到的消息可能位于该个人与他人的单聊中，因此在 open id 会话里只能通过已记录的落点会话判断（Codex 审查）。
- **飞书对 bot 隐藏的消息，改用已连接的个人身份查询。** 应用没有 `im:message.group_msg` 权限时，飞书不让 bot 读取群里未 @ 它的消息（`230027`），也不让它读取对它不可见的消息（`230050`）；但 bot 可能就在这个群里，回复也会落在那里。此时改用连接到该 bot 的个人身份（`user_access_token`，即以用户身份发送所用的身份）再查一次：消息在哪个群，与由谁读取无关；适配器会记录一次缺少权限的日志。其余拒绝仍是最终结论，因为飞书同样会拒绝这次投递：bot 不在消息所在的群（`230002`），或消息已删除（`230110`）。已撤回的消息仍会连同所在群一并返回。
- **直接发送与转发都经过规划。** 插件已弃用的 `send` / `sendText`、插件的 `forwardMessage` 以及工作流节点 `action.connector.forward` 都经过 `ConnectorDeliveryGateway.sendNow` / `forward`。这类投递无法作为草稿等待，规划器按 `immediate` 处理：别的投递会被存为草稿的地方，它们被拒绝（`unapproved`，以失败结果 `connector_delivery_denied` 返回）。只给出引用的直接发送，收件人未知，没有任何授权能覆盖。影子模式下它们照旧发出，receipt 记下执行模式会拒绝。
- **加急推送按它通知的人规划。** 加急推送就已发出的消息再次提醒指定成员，因此规划器取它的 `recipients`（每人一个 `person:<bot>:<id>` 目标）而不是会话，且每个人都必须获得授权。插件的 `sendUrgent` 与 SLA 升级的加急步骤都经过 `ConnectorDeliveryGateway.urgent`：它按 `immediate` 规划推送，被拒绝时什么也不发（审计记为 `delivery.urgent_direct`）。`sendUrgent` 与 `enqueueSend` 一样接受 `{ botRunId }`。升级步骤的提醒消息也经过规划；此前它被当作人自己的发送，即使发往另一个会话。该步骤的两次发送都是巡检的无人值守投递，步骤中的目标会话与用户 id 就是配置该策略的人的名单（`escalation:conversation:<key>` 或 `escalation:adapter:<bot>`）。为保证这一点，插件的 `createInstance` / `updateInstance` 不能给加急步骤新增用户 id 或目标会话（`connector_escalation_reach`）；删减可以。它的 patch 也不能使用键路径（`"defaultEscalation.steps"`），否则 Dexie 的 `update` 会绕过检查直接写入；收件人名单自身的防护也会丢弃指向它内部的键路径（`"outboundRecipients.0"`）。
- **`streamReply` 无法规划。** 流式回复没有会话键，且每次更新发一帧。消息类处于执行模式时，插件的 `streamReply` 返回 `false`，即文档约定的"不支持流式"，插件随之回退到受管控的发送。影子模式下它照常流式发送，每条流的第一帧（发往同一平台引用、间隔不到一分钟的帧算同一条流，`ConnectorDeliveryGateway.streamUnplanned`）写一条 receipt：收件人为该 bot 上的未知对象，规划结果为 `deny`；同时写一条 `delivery.stream_unplanned` 审计记录，影子报告因此能列出执行模式会拦下的流。
- **handler Bot 的名单只借给指明它的运行。** 所有运行中安装名单的并集已去掉。插件的代码由它的所有安装共用，因此一个动作只有在指明自己的运行、且宿主确认该运行仍在进行并属于该插件时才借到名单（`liveBotRun`）：`ctx.connectors.enqueueSend(…, { botRunId })`，以及浏览器引擎路由上下文或 `ensureLocalEngine` 的 `botRunId`。该动作随即在该安装的根与纪元下规划，其屏障生效。集成写入经动作的 `binding` 指明运行（`bot` 授权），因此 broker 的插件路径不借出任何名单。未指明运行的动作（包括某次运行遗留的回调）按插件自身的动作规划。
- **浏览器提交。** 在 hold 安装之前就已打开的 socket，会让页面保持 `unguarded`，直到 socket 关闭或页面载入新文档；同文档导航（`pushState`、hash 变化）不会关闭它，页面仍为 unguarded。选择文件在动作的提交窗口内执行，页面随即发出的内容会被停下。影子模式下 drain 失败不再阻塞动作。
- **人的回答记为人的。** HostState 批准（配对设备）在解决前记下 human receipt 并提升该工具调用，写明设备。Issue Loop 只有在运行由人发起时才以人为调用方（唤醒触发的和智能体的 `issue_run` 调用都不记任何人）。Issue 同步推送只有在其携带的每个本地编辑都来自人时才以人为调用方（`editedBy`、`localEditorOf`）；智能体或团队的编辑仍由策略规划。

### 已去除的重复

- 三个咽喉点（投递、集成、浏览器）的 receipt 共用一个构造器（`outbound-receipt.ts`：`outboundReceipt`、`outboundReview`、`jobAuthorizationOf`）。PR/issue 编号解析只保留一份（`threadNumber`）。浏览器询问改用 `@cognia/primitives` 的 `withTimeout`。
- 有意保持分开的：`siteTarget` / `repositoryTarget` 与 forge 远端解析（`lib/stack/forge/remote.ts`、`lib/github/host.ts`）看起来相似，但在授权依赖的地方不同（带端口的 host 与 hostname、取前几段路径与取最后几段）。`captured-turns.ts` 与审批注册表生命周期相同而数据不同；外发询问 store 与 ask-user store 队列形状相同而安全规则不同。

### 已知缺口

- 插件回复或编辑宿主没有记录的消息时，以下情况仍会被拒绝：飞书对 bot 隐藏该消息且没有连接个人身份（或个人身份同样读不到；为应用开通 `im:message.group_msg` 即可解除）；在飞书 open id 会话中，该消息是 bot 自己发的，所在单聊宿主从未经该会话发过消息，且对方在最近 250 条消息里没有发过言。一直无法判断落点（bot 不再运行）的投递，在达到尝试上限后进入死信。

## 影响

- 交互聊天中，发给请求人所在线程以外的任何人，第一次会询问，之后只在没有授予覆盖时询问。回复到提问的地方依然静默。
- **行为变化**：无人值守运行发给未配置的收件人时，现在会生成草稿或停泊审批，而不是直接发送。定时任务向多个目标执行 `im.broadcast`，需要一个列出这些目标的 `policy` 授予。
- 外发工具不再有“始终允许”。这些工具已有的 `toolRules` allow 条目不再授权收件人；它们不会被删除，因为仍然允许使用该工具。
- 一次拒绝在重载、换工具、换措辞和子运行之间都保持有效，直到提出请求的人说了新的话。
- 每个外发决定都有 receipt，写明 authority、授予以及它服务的那条指令。
- 为新索引升级一次 Dexie schema 版本。
- **第二期 2a 行为变化**：写入 GitHub 的 `gh` 命令在聊天里会询问（此前视为安全），auto 模式不再自行放行。对 GitHub 写入开启执行后，无人值守写到无人允许的仓库会等待批准，Squad 堆叠发布等待“批准并发布”，`gh` 写入在 bypass 下也会询问。
- **第二期 2b 行为变化**：14 个浏览器动作工具最长可能需要 10 分钟。对浏览器提交开启执行后，提交到未列入名单的站点会询问这台电脑前的人或等待批准，动作等到有答复。

## 被否决的方案

- **让模型根据请求判断授权。** 模型可能被它正在判断的内容注入提示。ADR-0070 已在风险门禁上否决这一点，契约也已让“模型 authority”无法表达。
- **按完整工具参数做指纹。** 改一个字就能绕过屏障。
- **屏障放在内存里。** 重载仍会丢失，子运行仍然看不到。Receipt 本来就是持久的，也已带有会话信息。
- **把所有 IM 绑定的运行都当作 external-send。** 与 ADR-0070 的否决理由相同：会挡住功能本身，运营方会把门禁关掉。
- **对发送保留会话级“始终允许”。** 一次点击就重新回到“授权所有收件人”。持久授予必须是由人写下的收件人列表。
- **把群里任何成员的消息都算作新指令。** 在共享群里，别人就能解除请求人的拒绝。

## 验证义务

- “给 A 起草一封邮件，不要发。”任何路径都发不出去。在卡片上点拒绝后，A 在所有工具和子运行上都被屏蔽；请求人发出新消息后屏障解除。
- IM 里的提问回复到同一线程时不弹卡；同一个智能体发往另一个群时第一次会询问。
- 定时 `im.broadcast` 发往未列出的群时生成草稿；有列出该群的 `policy` 授予时直接发送。定时或 Bot 触发永远不会推进纪元。
- 屏障在重载后仍然有效，并且对子任务和队友发往同一收件人同样生效。
- 超时不形成屏障：下一次尝试会重新询问。
- 以上每个结果都写入一条带有 authority、授予范围和纪元的 receipt，每个 connector job 都带有 `authorizedBy`。
- digest turn 的审批会停泊并推送，而不是无人应答。
- 第二期：Bot 在 PR 上被提及后回复该 PR，不询问；同一运行写到另一个仓库时，执行模式下等待批准。人为某个仓库配置的自动化在开启执行后照常工作。聊天里的 `gh pr create -R other/repo` 会询问并写明仓库，GitHub 执行模式下 bypass 也是如此。影子模式下 GitHub 与浏览器的结果都不改变。可靠引擎上提交到未列入名单站点的表单会被挂起，直到有人答复；没有信号的引擎上，可能触发提交的点击会在执行前询问。

## 术语

- **外发动作**：把内容投递给用户以外的一方，通过来自自动来源的 connector 投递，或通过被归为外发类的工具。
- **目标**：外发动作的渠道加归一化收件人。
- **发起线程**：当前指令所来自的会话，隐含授权。
- **授予**：对某个目标的显式授权，范围为 `once`、`instruction` 或 `policy`。
- **指令纪元**：根会话中请求人最新一条消息的 id。范围为 `instruction` 的授予和屏障记录在它推进前有效。
- **屏障**：当前纪元内被人拒绝过的目标集合，从拒绝 receipt 推导。
- **类别**：消息与邮件、GitHub、浏览器，各自有影子或执行模式。
- **站点**：浏览器提交所发请求的 origin，即浏览器的收件人。
