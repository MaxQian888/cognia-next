---
title: ADR-0125 — 可持久的工作提交与不可变输入归属
description: "在派发之前，把用户消息、冻结输入与执行运行放进同一个事务提交，让崩溃不再留下一条永远无人应答的可见消息；并且一旦观察到工具调用，就绝不自动重放。"
---

# ADR-0125 — 可持久的工作提交与不可变输入归属

**状态**：已接受，由 `durableWorkSubmission` 开关控制（默认关闭）
**日期**：2026-08-15

## 背景

用户按下发送后，「要做这件事」的意图只活在渲染进程的内存里。
`hooks/chat/use-claude-chat-controller.ts` 先写用户消息、再建 `ExecutionRun`、
再调 `sendPrompt` —— 三次独立提交，之间有真实的时间窗。任一窗口崩溃都会留下两种坏
状态之一：用户看得见、但永远不会有人回答的消息；或者有运行却没有消息。两者都无法恢
复，因为没有任何地方记录过「这份工作已被接受」。

重试有一个相关的问题。没有任何东西拥有输入，于是重试会按「重试那一刻的会话长什么样」
重新推导 prompt。在对话已经往前走之后再重试，得到的是一个顶着同一个 id 的**另一个**
turn。

另外两个事实决定了设计形状，它们都是在当前代码树上逐条核对的，不是假设：

- **Direct Chat 从未接触过 `AgentExecutionService`。** 它直接调 `sendPrompt`：不解析
  spec、不算 fingerprint、不过能力门。`surface: "chat"` 这个枚举值存在，但没有任何生产
  者。让 Chat 走 ADR-0090 的解析器是另一件更大的事，而且 `agentExecutionResolverV2`
  至今默认关闭。
- **输入与上下文不在同一时刻定稿。** `effectiveContent` 在 Workbench 载荷门处定稿；
  而 `sendOptions` 在此后数百行里还会继续变化 —— 项目根目录、task workspace、task 执
  行根，最后是路由。任何单一冻结点，对其中一半来说都是错的。

## 决策

先持久化，再派发；并让持久化的那一份成为任何重放的权威。

### 一个接受事务

用户消息、`workSubmissions` 行、冻结的 `workInputBatches` 行与 `ExecutionRun` 在同一个
Dexie 事务（v169）里一起提交。唤醒 runner、事件总线广播、UI 通知一律发生在**提交之
后** —— 否则监听方可能观察到数据库尚未接受、随后又被回滚抹掉的状态。

运行以 `queued` 打开，而不是 `running`。`run.started` 会经
`lib/execution/run-reducer.ts` 把运行投影成 `running`，而对「已接受但仍在等 runner」的
工作来说这是假的 —— `queued` 恰好就是那个状态。启动事件改在派发时发出。

### 两个冻结点，不是一个

`acceptWorkSubmission` 在内容冻结点冻结模型侧输入。`bindWorkExecutionContext` 在派发
前一刻冻结执行上下文，并带**一次性写入**保护：重试时以已存储的 bundle 为准。这条保护
就是「重试重放的是原始环境」的执行点，而不是拿宿主后来的样子重新解析项目根目录。

### 派发状态不是生命周期

`workSubmissions.dispatchState` 只回答「谁欠一次派发」。`ExecutionRun.status` 仍然是
唯一的用户可见生命周期权威。把两者分开，才不会出现产品终态与队列终态互相打架。

### 重放需要证据，而不是「没有疑点」

恢复是刻意不对称的。重放已经跑过工具的工作，可能二次触发用户无法撤销的副作用；而把工
作停在那里，代价只是一次显式恢复。所以自动重放要求**存在「什么都没发生」的正面证据**。
语义日志里任何 `tool.*` 事件、canonical envelope 日志里未闭合的工具调用、日志损坏、日
志读不出来，一律把提交停成 `recovery_required`。

这是**复用** `lib/ai/agent/recovery/` 既有的零重放机制
（`readCanonicalEnvelopes` → `candidateFromEnvelopes` → `planRecovery`），而不是并列
第二套恢复机。先查语义日志，是因为 Direct Chat 早在 canonical envelope 存在之前就已经
在那里写 `tool.*` 了。

恢复决策也发生在**认领之前**，所以绝不可重放的工作连「被再次尝试」的标记都不会拿到。

## 后果

- 用户看得见的 turn，要么可恢复，要么明确停下等人处理，不会静默消失。
- 每次重试重放逐字节相同的输入，可用 digest 证明。
- 本阶段 Chat 仍走旧路由。冻结的 spec 标记为 `specAuthority: "shadow"`，避免日后被当
  成它从未担任过的路由证据来读。
- Headless 宿主获得了它从来没有的陈旧运行恢复：
  `recoverStaleDirectChatExecutionRuns` 只挂在渲染端初始化器上，中途死掉的 brain 的运
  行此前无人对账。
- 回滚就是一个开关。`durableWorkSubmission` 关闭时，每个入口都返回 null，聊天路径与今
  天逐字节一致。

## 关系

- **ADR-0090（统一 Agent 执行）** —— 不变。本 ADR 不让 Chat 走解析器，只在旧路径旁记
  录一份 shadow spec。
- **ADR-0116（Host 权威会话状态）** —— 不变。`HOST_STATE_PROTOCOL_VERSION` 保持 1，
  `AllowedHostStateIntentV1` 不动；Host 侧包住既有的 `message.enqueue`。
- **ADR-0079（Scheduler 扩展契约）** —— 本阶段不受影响。Automation 接入时将通过既有的
  `registerTaskExecutor` 注册执行器，不新增 timing driver，并且因为
  `CogniaSchedulerDB` 是独立数据库，只能靠幂等键对账，不能假设共享事务。
- **ADR-0086 / ADR-0111（任务级工作区）** —— 冻结上下文以逻辑 ref 携带 workspace
  binding，工作区归属不变。
