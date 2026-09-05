---
title: "0169 — 一个运行时、一份审批契约、一台控制状态机"
description: "统一小队执行链：durable-v2 是唯一运行时，ExecutionRunInterrupt 是唯一待决记录，RunControlCommand 是唯一控制入口，所有界面读同一份投影快照。"
---

# ADR 0169 — 一个运行时、一份审批契约、一台控制状态机

**状态：** 已接受
**日期：** 2026-09-05
**修订：** ADR-0022（运行时加固）、ADR-0140（小队即执行者）

## 背景

一个小队可以跑在两套运行时上。旧路径（`runTeamLifecycle` 搭配内存里的 `approval-bus`，
运行历史写在 `__team__:` 前缀的 `workflowRuns` 行里，控制句柄只有 `agentTeamManager`）
和持久化路径（`agentTeamRuns` 及其子表、检查点、租约，以及一个能跨重启恢复的协调器）。
`config.runtimeVersion` 逐个小队做选择，`DEFAULT_TEAM_CONFIG` 默认是旧的那套，
运维页里还有一个「迁移到持久化」按钮把小队搬过去。

于是每个界面回答「这个小队在干什么」时要同时看三处：store 里乐观的 `team.status`、
旧的 `workflowRuns` 行、持久化运行记录。刷新之后、崩溃之后、只同步了其中一张表的手机上，
三者各说各话。五个 HITL 闸门骑在一条刷新即清空的按标签页总线上。Abort 是 pause 的别名。
从工作流节点、定时任务、斜杠命令、连接器、编辑器发起的同一个生命周期走五条不同的路，
各自有各自的「先查什么」。

## 决定

### 一个运行时

`durable-v2` 是唯一可执行的运行时。`AgentTeamRuntimeVersion`、`config.runtimeVersion`
以及读它们的所有分支都已删除。没有选择器、没有回退、没有迁移界面。仍带着运行时选择器的
已保存定义会在每个边界被剥掉（persist 迁移 v9、Dexie 水合、同步入站净化、CLI、插件 API），
由 `lib/agent-team/definition-contract.ts` 完成，它同时盖上 `contractVersion: 2`，
并且**只在恰好存在一个确定性候选时**推断协调器需要的两个绑定（主仓库、环境）。

`AgentTeam` 只是定义。状态、进度、结果、成本、恢复信息都在 `AgentTeamRunRecord` 上。
`ExecutionRun` 是所有界面读取的单向投影。store 里的 `status` 是生命周期运行器写的镜像，
别处不写。

### 一个启动入口

`startSquadRun` 是小队启动的唯一方式，聊天、工作流节点、调度器、斜杠命令、插件、
连接器分发、CLI 远程调用、已配对手机的意图，一视同仁。它的顺序就是契约：

1. 运行时就绪（`awaitSquadRuntimeReady`，否则 `runtime_not_ready`）；
2. `SquadReadiness` 无阻塞项（`not_ready`，带稳定码如 `missing_primary_repository`、
   `environment_not_found`、`workspace_controller_unavailable`、`host_unavailable`）；
3. 该小队没有活跃运行（`already_running`，带正在运行的 id）；
4. 持久化运行记录、规范 `ExecutionRun` 及其 `run.started` 事件**在一个事务里**写入
   （`journal_failed` 意味着什么都不会执行）；
5. 然后才派发生命周期，发后即忘。

被阻塞的小队仍然可见、可编辑，只是不派发。

### 一台控制状态机

`RunControlCommand` 是唯一控制入口：校验 revision、幂等、鉴权。Pause 是协作式的、可恢复的。
Resume 只从已验证的安全检查点重入。其余情况把运行停在 `needs_input` 并带上原因码，
同时提出一个 `team_recovery` 审批。Stop 是终态，级联到子运行，并拒绝所有待决中断。
Retry 是经由 `startSquadRun` 的关联替代运行，已结束的历史绝不改写。Steer 落一份回执并过 PII 门。
Abort 动词已删除。可见的破坏性动作只有 Stop。

回填的旧运行（`recoveryReason: legacy_run_not_resumable`）永不恢复。它的恢复审批只提供
`restart_run` 和 `terminate`，决策校验器会对照中断的 `subject.choices` 拒绝其余选项。

### 一份审批契约

小队 HITL 走 Action Review 契约。`ExecutionRunInterrupt` 是唯一待决记录，
`ActionReviewRequest / Decision / Receipt` 是唯一协议。审批种类是类型化的（`plan`、
`capability_audit`、`budget_extension`、`deadlock`、`teammate_repair`、`replan`、
`team_recovery`），各有各的 `SquadReviewDecision` 形状，由 `validateSquadReviewDecision`
在任何处理器看到命令之前校验。`team_recovery` 的决策是 `retry_same_host`、`retry_host`、
`restart_run` 或 `terminate`。自由文本（计划反馈）在存储前脱敏，永不进入运行日志。
中断是重启安全的：打开前先写检查点，重新武装的生命周期找到的是同一行确定性记录，
过期即拒绝（持久化的人工交接除外）。`approval-bus`、`pending-gates-store`、`GateModalsHost`
已没有任何小队侧读者。

### 一个引导序列

`runSquadBootstrap` 给启动排序：已解锁账户、水合并迁移定义、安装运行时与控制适配器、
把旧运行历史导入规范记录、对账中断并恢复活跃运行、重新武装待决恢复、最后翻转就绪信号。
过早到达的启动请求会等待这个信号，信号始终不翻转就被拒绝。

### 一个驾驶舱

`/squads` 保留定义、成员、就绪状态和任务板。它的「运行」页签就是规范的 `/agent-runs` 面板，
钉住 `kind = team`（以及选中的小队）。运行卡片深链到 `/agent-runs?run=…`。
退役的指挥中心和逐小队运行列表，连同它们各自的历史查询，已删除。桌面、Web、移动端、
聊天、连接器、CLI 读同一份投影快照和同一份 `allowedActions`。伴侣壳把控制命令以
`execution_run_control` 提交给桌面宿主，那就是驾驶舱自己的命令，走同一道门。
退役的 `team_run_pause|resume|stop` 回答 `upgrade-required`。

### 用码，不用句子

原始状态和运行时写的英文句子换成原因码与事件码，在 `en` 和 `zh-CN` 里本地化
（`waitingReason` 是 `waiting_review` 或 `recovery_required`，阻塞码经
`squads.readiness.blockers` 渲染，决策与交付节点状态各有自己的表）。

### 遥测

沿用既有的 agent-trace 底座：每个小队运行一个根 span（队员的 `invoke_agent` span 已通过
`traceId` 挂在其下），每个审批一个子 span，带闸门等待时长和结果，另有派发延迟、恢复结果、
重复控制的事件。根 span 以终态原因码和 token 总量收尾。不输出任何提示词、参数或密钥。

## 后果

- 每个界面都从同一条记录回答「这个小队在干什么」，刷新、崩溃、手机得到同一个答案。
- 过去刷新即丢的五个闸门变成手机也能回答的持久化行，每个回答都留回执。
- 旧版配对客户端保留只读历史，升级前失去小队写操作。这是单一契约的代价。
- 用户手上还未结束的旧运行一次性变成 `recovery_required`，给出两个诚实的选项。
  它们的历史保持不可变。
- ADR-0022 的 approval-bus 闸门和 ADR-0140 的 `agentTeamManager` 控制面由本文取代。
  两份文档保留的是「为什么有这些部件」的记录。

## 不变量（由测试钉死）

1. 没有代码路径读 `runtimeVersion`（`definition-contract.test.ts`、
   `store.migrate.test.ts`、`agent-team-definitions.test.ts`）。
2. `startSquadRun` 先写记录再派发，宁可拒绝也不竞态（`start-squad-run.test.ts`、
   `squad-run-records.test.ts`）。
3. Resume 绝不越过不安全检查点或旧运行行重入（`squad-control.test.ts`、
   `team-recovery.test.ts`）。
4. 每种审批都经类型化决策与回执往返（`squad-review-gate.test.ts`、
   `squad-review-decision.test.ts`）。
5. 引导按序执行，过早的启动会等待（`bootstrap.test.ts`）。
6. `/squads` 的运行页签就是 `/agent-runs` 面板（`squad-fleet-console.test.tsx`、
   `squads-mobile-body.test.tsx`）。

## 相关

- 文档：[HITL 审批](/docs/chat/agent-teams/hitl-gates)、
  [数据模型](/docs/chat/agent-teams/data-model)、
  [界面](/docs/chat/agent-teams/surfaces)、
  [生命周期](/docs/chat/agent-teams/lifecycle-and-synthesis)。
- ADR-0090（统一执行）、ADR-0045（计划中枢）、ADR-0136（跨设备放置）、
  ADR-0152（本机常驻宿主）。
