---
title: "0070 — 风险→审查流程策略层"
description: "一个确定性的风险分类器，决定何时自动运行需要向人类设置检查点，首先连接到Agent Team的计划审批门禁。"
---

## 状态

已接受。第一阶段（Agent Team）于2026年7月15日实施。计划进行第二至第三阶段;这ADR是三者的唯一驻地——每个阶段都附加一个独立的部分，而不是开启新的ADR。

## 路线图

| 阶段 | 接口 | 提升项（现有门禁） | 入侵性 | 现状 |
| ----- | --------------- | -------------------------------------------- | ------------------------ | ------- |
| 1 | Agent Team | `requirePlanApproval` | 低（单一接线点） | 完成 |
| 2 | /目标 | `requireAcceptance` （+ `manualContinue`） | 低 | 计划中 |
| 3 | 可视化工作流程 | 每个风险节点自动插入`approval`等待 | 高（每节点路径） | 计划中 |

论点在每个阶段都是相同的：确定性分类，然后**自动提升接口已有的检查点**。没有阶段发明新的门禁机制，低风险运行从未被动用。

因此，`ceremony.ts`在前期就定义了完整形状（`gate`、`requirePlanApproval`、`requireAcceptance`、`manualContinue`），尽管第一阶段只读取`requirePlanApproval`——因此第二阶段直接接线，无需切换界面或重新测试映射。`manualContinue` 从结构上是**仅互动的**：一个每回合都保持的无头目标永远不会推进，因此消费者（不是这张看不到原点的地图）必须无头抑制它。

## 背景

cognia-next 的自主 接口（`/goal`、Agent Team、可视化工作流程）各自拥有强大的人类检查点**机制****，但没有**策略**决定检查点何时触发，基于运行的实际效果。

具体来说，Agent Team：最强的门禁，`requirePlanApproval`，默认关闭（`DEFAULT_TEAM_CONFIG`），而且没有任何东西会自动提升。一个团队的运行名单可以驱动鼠标、调用 OS或删除数据，但会被完全一样的**零门禁**处理，就像一次总结文档的运行一样。门禁确实存在;没有人决定何时使用。

## 决策

介绍`lib/policy/risk/`——一个跨领域、接口中立的政策层：

| 模块 | 责任 |
| ------------------ | ----------------------------------------------------------- |
| `risk-surfaces.ts` | 风险接口 + 严重度 + i18n 键的穷尽分类法 |
| `classify-risk.ts` | 纯`RiskInput → RiskAssessment`（等级、接口、理由） |
| `ceremony.ts` | `RiskAssessment → RequiredCeremony`（人类应得的） |

它的第一个用户是Agent Team，通过适配器`lib/ai/agent/team/risk-input.ts`（`AgentTeam` + roster → `RiskInput`）。在运行开始前，`agent-team-runtime.ts`对其进行分类，并将所得审查流程 ORs纳入现有的计划审批门禁：

```ts
const riskAssessment = classifyRisk(buildTeamRiskInput({ team, workers, tasks }))
const riskRaisedGate =
  (team.config.riskGating ?? true) && requiredCeremony(riskAssessment).requirePlanApproval
const requirePlanApproval = Boolean(team.config.requirePlanApproval) || riskRaisedGate
```

门禁始终是**升起**，从不降低：算子集`requirePlanApproval`能在 `low` 评估中完好无损。

### 风险 接口

| 接口 | 严重程度 | 主信号 |
| ------------------ | ---------- | ------------------------------------------------ |
| `external-send` | 高 | 代理可调用发送tool/capability ID |
| `computer-use` | 高 | 计算机使用工具ID |
| `native-command` | 高 | 一个Bash/shell工具ID（沙盒时→高） |
| `data-destructive` | 高 | 删除工具ID，或文本中的破坏动词 |
| `credential-auth` | 提升 | keyring/secret/auth身份，或者凭证术语 |
| `file-write-broad` | 提升 | 一个Write/Edit工具ID**而且**没有沙盒 |

等级 = 击中次数的最大严重程度（`elevated` →中、`high` →高、无→低）。第一阶段的审查流程中高映射完全一致（`requirePlanApproval`）;这一区分适用于后续阶段及面向操作员的考虑。

### 仅确定性

不调用 LLM。安全门禁不应依赖于模型的情绪，而一个可以被其评判对象即时注入的分类器，比没有分类器更糟糕。LLM增强是后期阶段，绝不能成为门禁的唯一判断者。

### 门禁基于确凿证据，而非不确定性

默认级别为`low`（进行），除非有已知危险能力或破坏意图信号被“积极检测”**。这与“除非被证明安全”门禁违约“的做法是有意背道而驰。

其理由是产品UX，且是承载性的：这是一个终端用户产品，而非CI机器人。一个对所有未识别工具ID都触发的门禁，训练操作员点击浏览它——或者全面禁用`riskGating`——这样就保护不了任何人。**未知≠风险高。** 这种选择的代价是，真正危险的*新*工具在被加入分类法之前是未分类的;`risk-surfaces.ts` 中的详尽 `Record` 使得添加 接口 成为编译时的义务，而 `classify-risk.test.ts` 中的夹具表则固定了所有规则。

Tool/capability **存在感**是主要信号;关键词集是粗略的次级，仅用于任何工具ID无法表达的意图（销毁数据、处理凭证）。关键词集保持小巧高精度——`clear`和`remove`被排除，因为“清理文档”是普通工作，而虚假门禁是真正的代价。

## 行为改变（意图，默认拒绝）

`gate-policy.ts`将计划审批映射到**无头**起源（调度器/IM/桥接/插件/team→team）到`fail-fast`。如果`riskGating`默认为真，无头队的运行名单现在medium/high风险，选择**拒绝**而不是无人观看，失败原因会命名接口：

> 该运行会接触`high — computer-use`，且不能无人值守地继续（origin=调度器）;可以交互运行，或者设置 riskGating=false 以选择退出。

这就是ADR的意义，而不是副作用。`AgentTeamConfig.riskGating`（默认`true`）是操作员的退出选项，恢复之前的行为。

当门禁是风险升高且操作员也设定了`requirePlanApproval`时，操作员的选择会被指定为原因——告诉他们这是风险评估是谎言。

## 已拒绝：把连接器绑定当作`external-send`

第一阶段计划提议 `connectorBound === true`（IM-triggered运行）作为独立的`external-send`/high信号。**已拒绝**，因为这样会悄无声息地禁用一个已发布的功能：`startTeamRunFromIM`（`lib/connectors/team-dispatch.ts`，通过`lib/connectors/runtime.ts`和`im/dispatch-task`技能达到）是无头 `origin: "im"`流，所以*每*IM-bound队伍的运行默认都会很快失败。一个@提到飞书绑定队伍的用户会得到拒绝而非回复。

而且它也不是合适的型号。从一个帖子中召唤的团队回复**在同一个帖子**中，这就是功能：收件人是提问的人，并且他们在观看。真正的`external-send`风险是到达请求者未请求的收件人，这需要一个可代理呼叫的发送工具——这正是分类器所匹配的。而且后果会比差距更糟：操作员会全面禁用`riskGating`以恢复IM队伍，失去computer-use/shell门槛，即实际价值。

因此，分类器是**来源盲**的——它评判阵容*能达到*的范围，而不是得分的来源。一次IM-bound的游戏，队友仍门禁（无头仍拒绝）;普通的却没有。被`classify-risk.test.ts`（“起源盲”）和两项运行时测试钉住。

## 第二阶段 — /goal

创建时，`GoalRuntime.createGoal`会对目标进行分类，并将所欠审查流程合并到其配置中：中等→ `requireAcceptance`（完成后停留位于`awaitingAcceptance`以示签字）;高→也`manualContinue`。现有的验收机制（`turn-driver.ts` → `acceptance.ts`）无需改变——它已经启动了`config.requireAcceptance`。评估记录在`goal_created`事件上，并通过**localized**的 接口 标签在活动标签中呈现（分类器的`reason`仅为英文诊断文本）。

两个不变量：

- **仅限发声。** 每次合并都是`configured || raised`，因此用户设置的旗帜能经`low`评估存活。该政策补充了审查流程;它从未去除过任何一个。
- **`manualContinue`仅限互动。**为一个不在场的人类每回合都守住无头目标是延迟，而不是门禁。因此`createGoal`需要一个`GoalRunOrigin`;五个无头调用器（调度器、插件API、远程控制、工作流节点、伴随写源）传递了他们的指令，抑制存在于消费者中，因为审查流程映射无法看到起点。

**诚实的限制。** 目标没有名单，所以创建时间的唯一信号是被删减的目标和会话的*配置*姿态——比第一阶段弱。证据仅来自显式配置（允许列表的工具、`enableComputerUse`、支持操作员的内置套件）。它故意NOT推断“Anthropic SDK发布原生 Bash，因此每个目标都能支付”：确实如此，但没用——它会门禁所有默认目标，并教操作员关闭`riskGating`。SDK-native工具仍受每次调用权限门禁覆盖。真正的解决办法是每回合工具调用拦截，这里超出范围。

**行为改变：**一个风险较高的无头目标（调度器）现在停在`awaitingAcceptance`而不是自动完成。用`GoalConfig.riskGating: false`（或`GoalDefaults.riskGating`应用默认）选择退出。

**偶尔修复。** `resolveGoalConfig`从未通过`requireAcceptance`，所以`createGoal({ config: { requireAcceptance: true } })`默默放弃了——该标志只能通过设置标签进行后处理。仅加注保证取决于来电者自己的选择，因此这里加入了直通功能。

## 第三阶段 — 可视化工作流程

工作流程是一个DAG，每个节点都做着一项具体的事情，因此节点**类型是证据**——比名单或目标更强大。`action.desktop.performAction`不仅能接触机器;它执行修订绑定的UI突变。因此，`node-risk.ts`将类型直接映射到接口（`RISKY_NODE_KINDS`，详尽`Record`），只重复使用严重性表，因此节点的等级和名单的等级仍然含义相同。

`risk-gate.ts`在编排器中的每一步之前运行，并且**不发明新的门禁**：它重用`action.approval.request`自己的机制（`registerPendingApproval` + a `step.long_running.checkpoint` + `subscribeWake`），因此自动门禁在崩溃后恢复，就像作者自设的批准节点一样，并且同样的待批准UI回答它。三条规则：当批准节点是传递祖先（`ancestorsOf`，重用自`run-single-node.ts`）时去重复处理;默认拒绝在无头触发器上;绝不要碰低风险节点。

### 分类判断

缺席就是设计。门控：连接器send/forward、git push、移动共享（离开机器，无法撤回）;每一个行动或捕获的`action.desktop.*`;实壳节点;连接器删除。**非**门控：`.draft`和`.reaction`（可轻易可逆）;本地git commit/stage/branch;删除应用本地记录（`action.goal.delete`、`action.plan.delete`、`action.scheduler.task.delete`）——整理自身目标的工作流程是常规自动化，门控教操作员关闭`riskGating`，失去了关键的shell/mouse/send门控;以及`action.plugin.invoke` / `action.skill.invoke`——通配符，但规则是门禁每个插件调用门禁最真实的工作流程，并且这些工作流都被按能力限制的插件权限保护保护。这层门禁了应用无法逃脱或无法撤销的部分，而不是所有突变。

### 迁移——决策#2（“B”），以及为何它不是假设性

`VisualWorkflow.riskGating`是**选择加入**：`undefined` → OFF，故意反转Team/goal默认。本ADR之前编写的工作流程没有字段;开启门槛会追溯性地暂停（交互式）或失败（无头）用户已经依赖的自动化。一项对第一方工作流程定义的调查发现，已发布内容中恰好有一个风险节点——`plugins/zhihu-content-pipeline/src/workflow/template.ts:59`使用真实`action.system.terminal`——因此迁移“A”（全局默认为真）会破坏该节点。`lib/db/workflows.ts:createWorkflow`会盖章`riskGating: true`，因此新作品被封闭，现有作品保持原样。

### 两个值得记录的陷阱

1. **zod schema 是引擎的 唯一事实来源。** 编排器读取的是 `validated`，而不是呼叫者的对象，`z.object` 剥离未知密钥——因此`riskGating`被悄无声息地丢弃，门禁 在真实运行路径中死去，而所有单元测试都通过了。必须在`lib/workflow/definition/validate.ts`年宣布。仅通过编排器级别的整合测试发现;这是仓库经典的“建成但休眠”缺陷。
2. **能力预检（Capability preflight，ADR-0060）先运行。** Desktop/terminal节点已经在桌面端（`capability-missing:pty`）预检失败，因此它们永远不会达到门禁的风险。桌面版门禁很重要;需要在桌面外进行测试的测试必须使用无能力要求的类型。

## 后果

- Agent Team获得风险触发计划批准，且在低风险运行路上没有新的摩擦（快速通道未被触及——通过专门测试验证）。
- 无头冒险默认拒绝，原因接口。
- `lib/policy/risk/`对传输无关：在后期阶段通过添加自己的适配器来`/goal`和工作流程线路，而不是通过触摸分类器。
- `ceremony.ts`集中化了层级→审查流程映射，因此后续阶段在不涉及消费者的情况下添加字段（`requireAcceptance`、`requireStepConfirm`）。

## 超出范围（后期阶段）

`/goal`与工作流程接线;LLM-assisted分类;与每个工具`bypassPermissions`的交互;一种独特的“即使在旁路中也有硬阻挡”审查流程;`riskGating`设置UI（第一阶段默认配置即可）。

## 当前状态修订（2026-08-13）

AgentTeam、Goal、Workflow risk gate 以及 `riskGating` settings UI 均已实现；“phase 2–3 planned”的描述对这些 surface 已陈旧。后续 policy 变化必须复用现有 ceremony classifier 与 gate，不得新增逐 surface 的 risk logic。
