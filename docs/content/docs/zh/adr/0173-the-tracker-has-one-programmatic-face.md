---
title: "0173：事项追踪器只有一个程序化入口"
description: "工作流节点、/issue 命令、ctx.issues 与 External Bridge 全部经由 lib/issues/service.ts 和看板自己的门禁访问追踪器，活动记录通过一条进程内总线扇出，指向事项的工作提交终于被读取。"
---

# ADR 0173：事项追踪器只有一个程序化入口

**状态：** 已接受
**日期：** 2026-09-06
**修订：** ADR-0132（事项追踪器）、ADR-0045（计划中枢）
**相关：** ADR-0008（External Bridge）、ADR-0123（持久化工作提交）、ADR-0155（插件作者边界）、ADR-0011（可视化工作流）

## 背景

ADR-0132 把追踪器建成了一块看板。所有写入都走 `IssueBulkAction` 和
`canApplyBulkAction`，所以无论在看板哪里点击，人被拒绝的动作和理由都一致。但除了看板，
没有别的东西能触达它：工作流有十五个 `action.plan.*` 节点却没有 `action.issue.*`，
组合器有 `/plan`、`/goal`、`/squad` 却没有 `/issue`，插件有 `ctx.plans`、`ctx.goals`、
`ctx.team` 却没有 `ctx.issues`，External Bridge 向外部代理开放了记忆、工作流和用量，
却没有一个事项。

有两条接缝只存在于纸面上。`WorkSubmissionIntentV1` 自 ADR-0123 起就带有可选的
`workItemRef`（`kind: "issue"`），仓库里没有任何代码读它：为某个事项发起的提交校验通过后
就把事项忘了。`PlanStep` 无法表达自己在为哪个事项工作，所以解决了事项的计划不会在事项上
留下任何痕迹。

活动记录是只追加的，通过 Dexie liveQuery 读回。这对详情面板够用，但插件、工作流触发器
和通知漏斗除了轮询表之外没有任何可订阅的东西。

## 决定

### 一个服务，一个门禁

`lib/issues/service.ts` 是追踪器的程序化入口。它按行 id 或打印编号解析事项，创建到某个
容器（按 id、按 key，或工作区的第一个），带着工作区的运行中集合通过 `applyIssueBulkAction`
应用一个 `IssueBulkAction`，并用看板同样的筛选条件加上文本子串列出事项。下面的每个调用方
都经由它，于是工作流、斜杠命令、插件和 MCP 客户端在运行中的事项上被拒绝的方式与看板完全
一致，每次写入都以说明来源的执行者落入活动记录：`workflow:<id>`、`plugin:<id>`、`mcp`
或本人。

### 四个调用方

- **工作流节点。** `action.issue.create / get / list / update / assign / comment / label`
  与触发器 `trigger.issue.event`，带参数模式、目录条目和本地化标签，与其他内置节点一致。
- **`/issue`。** `list`、`new`（从标题里抽出 `#KEY`、`!priority`、`@me`）、`show`、
  `status`、`priority`、`assign`、`comment`、`chat` 与 `plan`。
- **`ctx.issues`。** 一个带 `issue:read` / `issue:write` 权限的目录命名空间，发布在
  `@cognia/plugin-sdk/api/issues`。`onEvent` 与 `registerSyncProvider` 返回 disposer，
  并在契约里如此标记，按既有规则自动不进入 Python 面。
- **External Bridge。** `issues_list`、`issues_get`、`issues_create`、`issues_update`、
  `issues_comment`，位于两个新作用域 `issues:read` 与 `issues:write` 之后，默认关闭，
  并在 Rust 作用域校验表中镜像。

### 一条总线

`lib/issues/event-bus.ts` 在 `appendIssueEvent` 提交之后发布每条活动记录。工作流触发器
和 `ctx.issues.onEvent` 都订阅它。订阅者只会看到已存在的行，抛错的订阅者会被记录，
永远不会打断写入路径。

### 工作项被读取了

`acceptWorkSubmission` 把 `workItemRef` 保留在提交行上，并在提交之后向事项的活动记录
写入 `work_started`；`settleWorkSubmission` 写入带结果的 `work_settled`。两者都在写入
路径之外且尽力而为：事项被删除不是拒绝一个回合的理由。生产者是 `ChatSession.issueId`，
由 `/issue chat` 设置，该会话的每个回合都把它作为 `workItemRef` 转发。

`PlanStep.issueId` 把步骤绑定到事项；步骤到达终态时 `setStepStatus` 写入 `work_settled`。
`/issue plan` 以这种方式起草一个单步手动计划。

### 双向溯源

从回复（"存为记忆"旁的"存为事项"）或 `/issue new` 创建的事项记录
`origin: { kind: "chat", sessionId, messageId? }`。详情面板和移动端抽屉通过既有的消息
永久链接把它渲染成回到对话的链接。

## 后果

- 拒绝是统一的。插件无法移动看板不允许人移动的事项，且活动记录能看出是哪个插件尝试了。
- 活动记录新增 `work_started` 与 `work_settled` 两种条目。旧手机用同一个宽容的投影器渲染。
- 总线是进程内的。手机或无头宿主不会通过它收到其他设备的活动记录，跨设备投递仍然是伴侣
  同步拉取。
- `ctx.issues` 的 `runtimes` 是 `frontend` 与 `hybrid`。反向 RPC 通道审计完成后，向 Python
  开放只需改目录里的一行。
- Bridge 作用域默认关闭，并像 `memory:*` 一样在设置中受门禁。

## 未做

- 除看板外没有面向其他调用方的迭代入口：迭代是容器，手机和 Bridge 只读它们。
- `issue` 之外的 `WorkItemRef` 种类仍然没有读者。
