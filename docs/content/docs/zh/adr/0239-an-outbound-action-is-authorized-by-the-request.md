---
title: "0239 — 外发动作由请求授权，而不是由工具授权"
description: "智能体有约十条路径可以向第三方发送内容，每条各有各的门禁或根本没有，也没有任何地方记录一次发送是发给谁的、由谁要求的。本 ADR 补上 Action Review 契约早已预留的策略引擎：外发动作需要一个已授权的收件人。请求所在的线程隐含授权；其他收件人需要显式授予（仅本次、本条指令内，或由人配置的持久策略）。人工拒绝会屏蔽同一发送，直到请求人给出新指令；无人值守运行绝不发给未授权的收件人。"
---

# ADR 0239 — 外发动作由请求授权，而不是由工具授权

**状态：** 提议中
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
| 浏览器点击/填写、GitHub 创建 PR 与评论 | 普通阶梯或无 |

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
- 工具被归为外发类的工具调用。只维护一份列表，风险分类器的 `EXTERNAL_SEND_IDS` 和 sidecar 的 `outbound` 权限类共用，并有一致性测试。同时修正分类器的名称归一化，让 `connectors_send_message`、`send_session_message` 等名称能被匹配。

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
- 对于没有会话的运行（定时任务、Bot 触发），由人编辑任务或安装配置，或在其会话中发言。

以下情况**不会**推进纪元：定时或 Bot 触发、webhook、模型自己的后续动作、子任务或队友的消息、IM 群里其他人的消息。

### 拒绝屏障

对外发审核的**人工拒绝**会产生一条屏障记录。只要根会话的纪元不变，任何**指纹**相同的外发动作都会被直接拒绝，不再询问。这包括换一个工具、换个措辞，或同一根会话下的子任务和队友。

- **指纹**：`outbound | 渠道 | 归一化收件人`。不包含消息正文，所以换措辞绕不过屏障；换了收件人则重新评估。
- **根会话**：子任务、队友和后台子运行经由现有的审批路由映射到根会话（`lib/claude/agents/subagent-approval-routes.ts`、`lib/chat/approval-routing.ts`）。
- **存储**：屏障不是新的存储，而是从拒绝 receipt 推导，所以重载后仍然有效，也不需要第二个事实来源。Receipt 增加可选字段（契约版本 1，仅追加）：`subject.target`、`request.fingerprint`、`origin.rootSessionId`、`origin.instructionEpoch` 和 `decision.grant`。新增一个复合索引 `[rootSessionId+fingerprint]`，需要按既定流程升级一次 Dexie schema 版本。查询走内存缓存。
- **不构成屏障的情况**：超时或过期不是拒绝。它只拒绝当次动作，下次尝试会重新询问（现有的 doom-loop 防护仍然限制重复次数）。模型的意见永远不会形成屏障。
- **有效期**：直到纪元推进，上限为 receipt 的保留期。处于休眠的 `pruneActionReviewReceipts` 需要有调用方；行数上限优先裁剪不带有效屏障记录的 receipt。

`session-denials.ts` 继续处理非外发工具；外发类的拒绝改走屏障。

### 两个咽喉点

- **工具调用**：桌面端权限处理（`hooks/chat/claude-chat-events.ts`）、无人值守响应器（`lib/claude/unattended-permission-responder.ts`）和队友路径（`lib/chat/room/runner.ts`）在弹卡或自动应答之前，对外发工具调用 `planActionReview`。
- **Connector 投递**：`enqueueOutbound` 在创建 job 之前为每个自动来源做计划。未授权的无人值守投递变为草稿。已带有工具调用授予的投递不会被问第二次：job 会携带授权它的 receipt id。

### 谁要求的

外发 job 记录 `authorizedBy`：receipt id、请求人身份和授予范围。仅凭 job 就能回答“谁授权了这条消息”；之后面向收件人的归属展示（[roadmap](../../../../plans/2026-10-24-grok-gap-roadmap.md) 中的邮件 connector）也将读取它。

### 顺带修复

- `scheduled-outbound.ts` 中的 digest turn 获得与其他定时 turn 相同的无人值守响应器，其审批改为停泊，而不是无人应答。
- 契约文件头改为引用本 ADR 而非 ADR-0102；`registry.ts` 不再声称有九个渠道（实际是 15 个）；修正已失效的 `lib/ai/agent/agent-team-runtime.ts` 路径。

## 分期

| 期 | 范围 |
| --- | --- |
| 1 | 引擎；外发列表与目标；发起线程、授予、草稿/停泊的判定顺序；指令纪元；屏障及其 receipt 字段与索引；两个咽喉点；`authorizedBy`；digest 响应器；对外发工具隐藏“始终允许”；文档更正 |
| 2 | 浏览器表单提交、GitHub 创建与评论，前提是有可靠的“这次点击会提交”信号 |
| 3 | 经由 `recommendation` 的模型收紧 |

## 影响

- 交互聊天中，发给请求人所在线程以外的任何人，第一次会询问，之后只在没有授予覆盖时询问。回复到提问的地方依然静默。
- **行为变化**：无人值守运行发给未配置的收件人时，现在会生成草稿或停泊审批，而不是直接发送。定时任务向多个目标执行 `im.broadcast`，需要一个列出这些目标的 `policy` 授予。
- 外发工具不再有“始终允许”。这些工具已有的 `toolRules` allow 条目不再授权收件人；它们不会被删除，因为仍然允许使用该工具。
- 一次拒绝在重载、换工具、换措辞和子运行之间都保持有效，直到提出请求的人说了新的话。
- 每个外发决定都有 receipt，写明 authority、授予以及它服务的那条指令。
- 为新索引升级一次 Dexie schema 版本。

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

## 术语

- **外发动作**：把内容投递给用户以外的一方，通过来自自动来源的 connector 投递，或通过被归为外发类的工具。
- **目标**：外发动作的渠道加归一化收件人。
- **发起线程**：当前指令所来自的会话，隐含授权。
- **授予**：对某个目标的显式授权，范围为 `once`、`instruction` 或 `policy`。
- **指令纪元**：根会话中请求人最新一条消息的 id。范围为 `instruction` 的授予和屏障记录在它推进前有效。
- **屏障**：当前纪元内被人拒绝过的目标集合，从拒绝 receipt 推导。
