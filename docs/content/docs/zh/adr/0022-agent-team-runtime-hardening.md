---
title: "ADR 0022 — Agent 团队运行时加固"
description: "通过并发预设调度、一个精简团队合成器产生VisualWorkflow、每运行共享状态（带断路器TeammatePool，BudgetGuard有四个onCritical动作，TeamNotifier为三通道路由），以及现有审批总线上的六个 HITL 门禁，将代理团队运行时汇聚到工作流程编排器上。"
---

# ADR 0022 — Agent 团队运行时加固

> **状态**：提议于2026-05-17。计划在6 PRs内实施，历时~4周。PR 1（工作流编排器并发调度）是切换风险PR;PR 4是团队运行时切换。

> **由 ADR-0169 修订（2026-09-05）。** 本文描述的 approval-bus HITL 闸门与基于 `workflowRuns` 的运行历史已退役。小队审批作为 `ExecutionRunInterrupt` 行骑在 Action Review 契约上，`durable-v2` 是唯一运行时，`startSquadRun` 是唯一启动入口。关于每道门*为什么*存在的部分仍然成立。

## 背景

代理团队子系统（`lib/ai/agent/agent-team-runtime.ts:runTeamLifecycle`）自称是多代理编排器，但实际上只实现了其宣称能力的 ~30%。对项目的“生产可靠性”标准进行读取后，发现了以下空白：

**发动机间隙**——配置字段存在，但没有引擎驱动它们：

- `maxRetries` / `enableTaskRetry`：永远不读取;失败的任务在第一次错误中永久失败
- `defaultTimeout`：从未转接给`executeAgent`——卡住的LLM通话只能通过外部中止终止
- `tokenBudget` / `warningThreshold` / `criticalThreshold` / `onCritical`：代币会被加总但从不检查
- `task.dependencies`：忽略——队列仅按`task.order`排序，因此未满足的任务仍然运行
- `enableDeadlockRecovery`：装饰性;不存在死锁检测逻辑
- `delegationIds` / `consensusIds` / `TeamDelegationRecord` / `ConsensusRequest`：全型，零发动机
- `defaultMaxSteps`：未转交给执行人

**运行时结构缺口**：

- 轮换队友轮换（`teammateRotation % workers.length`）不会过滤掉失败的队友——刚刚失败的队友会获得下一个任务
- `inflightControllers`是模块范围`Map<string, AbortController>`;在应用重新加载时，团队状态保持在商店`executing`，但没有控制器可以提前显示
- `stores/agent/agent-team-store/store.ts:24-29` `partialize`只会持续存在`templates`、`defaultConfig`、`displayMode`、`workspaceTab`。**`teams` / `teammates` / `tasks` / `messages` / `executionReports` NOT持久化**——浏览器刷新会抹除所有运行状态。刷新是上述任何失败模式中唯一面向用户的回退。

**建筑复制**：

- `lib/workflow/runtime/orchestrator.ts`已经具备拓扑排序、IdempotencyCache、崩溃恢复（`resumeInFlightRuns`）、Dexie持久化（`workflowRuns` + `workflowRunEvents`）、`RunLogger` + 实时查询UI、墙时钟超时、中止信号级联
- `action.team.run` 工作流节点类型已经存在（`lib/workflow/nodes/built-ins.ts:1165`）——工作流已经作为原语委派给了 Teams
- 现有的`action.team.run`执行器（`built-ins.ts:1186-1196`）附带了一个`as unknown as`铸造修改器，掩盖了商店形状的不匹配——这是真正的潜在漏洞接口
- 两个长期的协调器：每个跨领域关注点（复习、可观测性、成本遥测）都必须实现两次

预期结果：归结为单一编排器（工作流），赋予其并发预设调度，并将团队执行重新表达为工作流综合 + 每次运行共享状态注入。团队特定的关注点（计划审批、队友池、预算、通知）存在于一个拥有人机环控点的薄合成器中。

## 目标

1. **单一编排器。** 工作流程运行时成为唯一的执行引擎;`runTeamLifecycle`退回到一个~120线合成器，产生`VisualWorkflow`并委派给`runWorkflow`。
2. **工作流程获得并发调度功能。** 用现成的 + `maxConcurrency` 调度器替代顺序`for (stepId of order)`循环。默认`maxConcurrency=1`保留现有工作流行为;团队合成器将其设置为`team.config.maxConcurrentTeammates`。
3. **每个任务重试，队友轮换。** 失败的`team.task.dispatch`节点触发工作流程的标准重试;每次重试的执行者都会从池中重新取回，自然轮换到可用的队友。
4. **每个队友的断路器**（作曲`lib/connectors/circuit-breaker.ts`）用于临时隔离并自动恢复;**每个队友因灾难性故障（认证、配置无效）而被取消资格，需要用户干预。
5. **代币预算，实现了全部四个`onCritical`动作**：`notify`、`pause_for_review`、`reduce_concurrency`、`handoff_to_background`（定义为“降挡档位”：更便宜的型号+并发=1+静默吐司;不是“生成Worker进程”）。
6. **现有通用`lib/runtime/approval-bus`有六HITL 门禁**：计划批准（现有）、预算覆盖、解冻僵局、团队修复（v1）;手动任务重试、pause/resume（v2后续）。
7. **执行程序中的输出验证**：empty/whitespace输出触发重试+旋转;可配置最小长度和拒绝检测。
8. **三通道通知路由**（sonner吐司/Tauri OS通知/工作流事件日志）通过单一~80行`team-notifier.ts`实现。级别：信息（仅日志）、警告（日志+吐司）、关键（日志+吐司+OS+可选门禁）。每事件进行重复处理。
9. **团队运行的崩溃恢复**作为搭乘工作流程运行时的免费副产品——`resumeInFlightRuns()`已经存在，并且已经能处理持久`workflowRuns`桌的飞行中运行。
10. **没有新的Dexie表。** 团队运行是工作流运行;运行UI通过`workflowRuns`上现有的实时查询显示，并按`triggerKind === "team"`过滤。

## Non-Goals

- **持久Worker进程/外部队列**（时序风格）——明确表示超出范围。`handoff_to_background`被解释为进程内下移，而非跨进程切换。
- **委派/共识引擎**——类型保留在`types/agent/agent-team.ts`中，但不添加引擎。这些模块可以作为未来的模块，无需重新架构。
- **手动任务重试UI和 Pause/Resume** — 推迟到 v2;需要工作流运行时扩展（将节点注入飞行中运行;唤醒总线集成到编排器中），这些扩展不会阻塞 v1。
- **既有的工作流程重构**在并发调度器更改之外——`topo-sort.ts`保持工作流耦合;团队合成器编写一个小型聚焦的Kahn查找。提取共享`kahn-core`是未来的机会。
- **持久代理团队数据迁移**——目前存储仅存存templates/UI个偏好;teams/teammates/tasks/messages存储在内存中。没有现有数据可迁移。
- **父子运行UI用于嵌套工作流**（用户调用`action.team.run`产生两行`workflowRuns`行）。`parentRunId`将记录在事件中，供未来接口工作使用。
- **对团队工作UI空间的区域路由或i18n更改****——新模态的复制键遵循`i18n/messages/{en,zh-CN}.json`现有模式，但不适用于更广泛的i18n范围。
- **Agent作者的工作流程生成**（一个从用户提示产生`VisualWorkflow` JSON的代理）——由一个独立即将发布的ADR明确处理;该设计不会产生限制未来工作的基础设施。

## 经过验证的发现，塑造了该案情

1. **`flow.split` 是一个标记节点，不是扇出原语。** `built-ins.ts:262` 的执行器会逐字返回上游;编排器的顺序 for 循环是序列化执行的关键。让编排器静默地并发将`flow.split`升级为真正的扇出——在执行者层面向下兼容，但会改变任何已使用该工作流的可观察行为。这被默认`maxConcurrency=1`缓解。
2. **`lib/queue/retry-policy.ts`已经实现了**`decideNextAttempt`、`backoffDelayMs`、`isRetryable`，带`NON_RETRYABLE_PATTERNS`（401/403/404/400/validation/schema）。直接重用;不要在`lib/ai/agent/team/`中创建并行的`retry-policy.ts`。
3. **`lib/connectors/circuit-breaker.ts`已经实现了**具有`closed / open / half_open`状态的滑动窗口断路器。每个队友的断路器组合（而非二元隔离布尔）严格更强。
4. **`lib/runtime/approval-bus.ts`** 是通用的HITL原始元素;`plan-approval-bus.ts` 是个薄包装。同样的原始元素已经为 GitHub Delivery 的HITL卫动能了。所有新门禁（预算、僵局、队友修复）都会重复使用它。
5. **`lib/workflow/runtime/wake-bus.ts`** 是带超时 + 信号的进程中事件订阅;这是 v2 pause/resume 和手动重试事件的正确原语。
6. **`lib/tauri/notification.ts`**已经用权限管理包住Tauri `sendNotification`，并且降级为非操作权限，Tauri。`notify()`助手是团队通知器的OS-notification通道。
7. **`lib/scheduler/notification-integration.ts`** 是“多通道通知”模式（toast + desktop + webhook）的先例。团队通知器遵循相同的形状，但按层级而非任务配置路由。
8. **没有现有的池/Worker抽象。** `lib/ai/agent/background-agent-manager.ts`只是插件触发后不等待代理的AbortController注册表——不是团队成员池。需要新代码。
9. **工作流程`IdempotencyCache`**通过`(runId, stepId)`记忆，仅在步骤成功完成时写入。`runStep`内重试不会污染缓存——因此“用不同队友重试”在不影响缓存的情况下有效。
10. **最新的Dexie模式版本是35**（`lib/db/schema.ts`）。这项工作不需要额外提升，因为团队搭载在`workflowRuns`+`workflowRunEvents`上。

## 决策：路径F（编排器收敛）

单个编排器（工作流运行时）执行所有DAGs。团队执行则变成一个薄合成器，生成一个节点为`team.task.dispatch`实例的 `VisualWorkflow`，每次运行共享状态（`TeammatePool`、`BudgetGuard`、`TeamNotifier`、`ConcurrencyController`、`ModelPreferenceController`）注册在模块范围的 `WeakMap<runId, TeamRunContext>`，节点执行者会参考该状态。

### 为什么不考虑其他选择

- **路径A**（`runTeamLifecycle`的原位演化）：最小差值，但文件超过600行，五个责任纠缠在一起;违反项目的小有界单元指南。
- **路径B**（独立运行时，重用工具）：长期保持两个编排器;现有的`action.team.run` cast破解表明两条路径必须相互作用，分歧会持续产生类似的bug。
- **路径C**（x状态驱动FSM）：增加了依赖性;FSM收益需要100+状态来摊销，当前范围为<20。
- **路径D**（真实持久Worker进程）：需要时序类基础设施（队列、长IPC、持久收件箱）;用户明确取消了该范围。
- **Path E**（共享`run-history`可观察层，保留两个引擎）：解决可观察性问题，但不解决 action.team.run 黑客的根本原因。

选择路径F的原因在于：它消除了重复的编排器，修复了作为副作用的action.team.run破解，并且工作流编排器获得并发执行权是严格的功能升级，其他工作流程用户（GitHub Delivery、twin）可以选择加入。

### 模图

```
┌─────────────────────────────────────────────────────────────────┐
│  Single orchestrator: lib/workflow/runtime/orchestrator.ts      │
│  Old: for (stepId of order) await runStep(...)                  │
│  New: ready-set + maxConcurrency + Promise.race scheduling      │
└─────────────────────────────────────────────────────────────────┘
                       ▲                          ▲
                       │                          │
            User-authored workflow         Team synthesizer
                                           runTeamLifecycle()
                                           ├─ planning gate (existing)
                                           ├─ synthesizeTeamWorkflow → VW
                                           ├─ register TeamRunContext
                                           ├─ runWorkflow(VW, concurrency, signal)
                                           └─ map result → { runId, status }
                                                      │
                                                      ▼
                                       ┌─────────────────────────────┐
                                       │ TeamRunContext               │
                                       │ WeakMap<runId, {             │
                                       │   pool, budget, notifier,    │
                                       │   concurrency, modelPref,    │
                                       │   storeWriter                │
                                       │ }>                           │
                                       └─────────────────────────────┘
                                                      ▲
                                                      │
                                       ┌─────────────────────────────┐
                                       │ team.task.dispatch executor │
                                       │ (registered in built-ins)   │
                                       │                              │
                                       │ 1. ctx = getTeamRunContext   │
                                       │ 2. teammate = pool.claim()   │
                                       │ 3. AbortSignal.any([...])    │
                                       │ 4. executeAgent(prompt)      │
                                       │ 5. validate output           │
                                       │ 6. pool.record(s/f) +        │
                                       │    budget.add() +            │
                                       │    storeWriter.addMessage    │
                                       └─────────────────────────────┘
```

> **实现说明（更正）:** 注册表是普通的 `Map<string, TeamRunContext>`，** 不是** `WeakMap`。上图显示了原始送气，但这里不适用WeakMap：密钥是字符串 `runId`，派遣执行器通过该字符串查找上下文（`getTeamRunContext(ctx.runId)`）——合成器注册器和执行者之间没有共享对象令牌，因此弱键控不可能。泄漏安全则依赖于生命周期的 `finally`-block `unregisterTeamRunContext`，并通过两个非抛弃性诊断（`team-run-context.ts`）：重新注册仍在运行的`runId`时的警告（未注册）和注册表超过软上限时的警告（不平衡register/unregister）。参见`team-run-context.test.ts`。

### 文件清单

| 路径 | 行动 | 直线（impl + test） |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| `lib/workflow/runtime/orchestrator.ts` | 将主循环修改为预设调度器 | +80 −40 / +120 测试 |
| `lib/workflow/runtime/concurrency-controller.ts` | 新 | ~40 / ~80 |
| `lib/workflow/runtime/model-preference-controller.ts` | 新 | ~30 / ~60 |
| `types/workflow/visual.ts` | 在设置中添加`maxConcurrency?: number`;扩展`TriggerEvent.kind`与`"team"`变体的并集 | +10 |
| `lib/workflow/nodes/built-ins.ts` | 注册 `team.task.dispatch`;修复`action.team.run`黑客 | +60 −20 / +80 测试 |
| `lib/ai/agent/team/team-run-context.ts` | 新（WeakMap注册） | ~40 / ~80 |
| `lib/ai/agent/team/teammate-pool.ts` | 新（电路断路器） | ~120 / ~180 |
| `lib/ai/agent/team/budget-guard.ts` | 新（四动作onCritical） | ~110 / ~160 |
| `lib/ai/agent/team/team-notifier.ts` | 新（3通道路由+去重+挂起） | ~80 / ~140 |
| `lib/ai/agent/team/synthesize-workflow.ts` | 新成员（→ VisualWorkflow队） | ~80 / ~140 |
| `lib/ai/agent/agent-team-runtime.ts` | 重写为薄合成器 | 280→ ~120 |
| `lib/ai/agent/agent-team-runtime-deps.ts` | 简化;删除`runTeammateTask` | −150 |
| `components/agent/approval-gate-dialog.tsx` | 新的共享模态 | ~100 / ~120 |
| 团队UI：工作区页面 | 将数据源迁移到`workflowRuns` | 各异 |

净差估算：**+1100 / −200条生产线，+1300条测试线**。

### 重复使用表（无重新发明）

| 需求 | 重复使用 primitive | 路径 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| DAG拓扑排序 | `topoSort()` 来自工作流程（由编排器使用）;团队合成器在`AgentTeamTask[]`上写入自己的~30行Kahn，以保持本地耦合 | `lib/workflow/runtime/topo-sort.ts`（仅为团队参考） |
| 工作流程重试 + 不可重试分类 | `decideNextAttempt`，`isRetryable`，`NON_RETRYABLE_PATTERNS` | `lib/queue/retry-policy.ts` |
| 队友断路器 | `createCircuitBreaker`（滑动窗+半开探头） | `lib/connectors/circuit-breaker.ts` |
| 每个任务超时 | `AbortSignal.timeout` + `AbortSignal.any` | 网页标准 |
| HITL 门禁 | `waitForDecision` / `approve` / `reject` | `lib/runtime/approval-bus.ts` |
| 计划批准（现有） | `plan-approval-bus`（薄包装纸） | `lib/ai/agent/plan-approval-bus.ts` |
| LLM派遣 | `executeAgent`（未变） | `lib/ai/agent/agent-executor.ts` |
| OS通知 | `notify` + `ensureNotificationPermission` | `lib/tauri/notification.ts` |
| 应用内吐司 | `sonner` | NPM DEP |
| 崩溃恢复 | `resumeInFlightRuns`（今天在应用启动时打电话） | `lib/workflow/runtime/resume-controller.ts` |
| 运行持久化 | `workflowRuns` + `workflowRunEvents`（未变模式） | `lib/db/schema.ts` |
| 事件日志+实时UI | `RunLogger` + 运行页面 live-query | `lib/workflow/runtime/event-log.ts` |
| 尾波总线（v2 hook） | `subscribeWake` + `emitWake` | `lib/workflow/runtime/wake-bus.ts` |

## 模块合同

### TeamRunContext（`lib/ai/agent/team/team-run-context.ts`）

```ts
export interface TeamRunContext {
  readonly runId: string
  readonly teamId: string
  readonly team: AgentTeam
  readonly pool: TeammatePool
  readonly budget: BudgetGuard
  readonly notifier: TeamNotifier
  readonly concurrency: ConcurrencyController
  readonly modelPref: ModelPreferenceController
  readonly storeWriter: TeamStoreWriter
}

export function registerTeamRunContext(ctx: TeamRunContext): void
export function getTeamRunContext(runId: string): TeamRunContext | undefined
export function unregisterTeamRunContext(runId: string): void

export interface TeamStoreWriter {
  addMessage(input: SendMessageInput): void
  setTaskStatus(taskId: string, status: TeamTaskStatus, result?: string, error?: string): void
  updateTeammate(teammateId: string, updates: Partial<AgentTeammate>): void
}
```

### TeammatePool（`lib/ai/agent/team/teammate-pool.ts`）

```ts
export type TeammateFailureKind =
  | "ordinary" // standard failure → sliding-window breaker
  | "rate_limited" // 429 → immediate open, cooldown recovers
  | "catastrophic" // 401/403/404/auth → disqualified, no auto-recovery
  | "empty_output" // ordinary path
  | "refusal" // ordinary path

export interface TeammatePool {
  claim(taskId: string): AgentTeammate | null
  recordSuccess(teammateId: string): void
  recordFailure(teammateId: string, error: unknown): void
  availableCount(): number
  isDisqualified(teammateId: string): boolean
  allUnavailable(): boolean // quarantined ∪ disqualified == all
  onAllUnavailable(cb: () => void): () => void
  onTeammateDisqualified(cb: (teammateId: string, reason: TeammateFailureKind) => void): () => void
  forceUnquarantine(input: { teammateIds?: string[]; resetAll?: boolean }): void
  rejoin(teammateId: string): void // user fixed config; clear disqualified
}

export interface TeammatePoolOptions {
  teammates: AgentTeammate[]
  breakerOptions?: Partial<CircuitBreakerOptions>
  strategy?: "round-robin" // v1 only
  now?: () => number
}

export function createTeammatePool(opts: TeammatePoolOptions): TeammatePool
```

**不变量**：

- `claim()`只有在`canPass() && !isDisqualified()`时才回传队友——呼叫者从不查看状态
- 灾难性故障绕过滑动窗口，立即被取消资格
- `forceUnquarantine`重置断路器;`rejoin`清除失格——它们是不同的操作
- 队友名单**冻结在泳池建设** — 中跑additions/deletions到球队商店时不会变异泳池

### BudgetGuard（`lib/ai/agent/team/budget-guard.ts`）

```ts
export type BudgetEventName =
  | "warning_crossed"
  | "critical_crossed"
  | "pause_for_review"
  | "entered_background_mode"

export interface BudgetGuardOptions {
  runId: string
  limit: number // 0 = unlimited
  warnAt?: number // default 0.80
  critAt?: number // default 0.95
  onCritical: TeamBudgetEscalationAction
  notifier: TeamNotifier
  concurrencyCtrl?: ConcurrencyController
  modelCtrl?: ModelPreferenceController
}

export interface BudgetGuard {
  add(usage: SubAgentTokenUsage): void
  status(): { used: number; limit: number; level: "ok" | "warning" | "critical" }
  extendLimit(extraTokens: number): void // HITL approve resets thresholds
  on(event: BudgetEventName, cb: (payload: { runId: string }) => void): () => void
}

export function createBudgetGuard(opts: BudgetGuardOptions): BudgetGuard
```

`onCritical`调度：

- `"notify"`：发射 `notifier.notify({ level: "critical", ... })`，无后续影响
- `"pause_for_review"`：发射`pause_for_review`事件（合成器打开门禁）
- `"reduce_concurrency"`：`concurrencyCtrl.reduceTo(1)`，发出警告通知
- `"handoff_to_background"`：`concurrencyCtrl.reduceTo(1)` + `modelCtrl.downshift()` + `notifier.suspend()` + 发射`entered_background_mode`

### TeamNotifier（`lib/ai/agent/team/team-notifier.ts`）

```ts
export type TeamNotifyLevel = "info" | "warn" | "critical"

export interface TeamNotifyPayload {
  level: TeamNotifyLevel
  title: string
  body?: string
  runId: string
  teamId: string
  taskId?: string
  openApproval?: ApprovalKey // only allowed at critical level
  detailHref?: string
  dedupeKey?: string // same key 5min window → suppressed
}

export interface TeamNotifier {
  notify(p: TeamNotifyPayload): void
  suspend(): void // handoff_to_background → toast/OS off
  resume(): void // v2 use
}

export interface TeamNotifierDeps {
  toast?: (msg: string, opts?: { description?: string }) => void
  osNotify?: (opts: { title: string; body?: string }) => Promise<void>
  log?: (level: "info" | "warn" | "error", message: string, payload?: unknown) => Promise<void>
  now?: () => number
}

export function createTeamNotifier(
  runCtx: { runId: string; teamId: string },
  deps?: TeamNotifierDeps
): TeamNotifier
```

按层级划分通道路由：

| 级别 | 索纳祝酒词 | OS通知 | 事件日志 |
| -------- | ------------ | --------- | --------- |
| 信息 | 不 | 不 | 是的 |
| 警告 | 是的 | 不 | 是的 |
| 关键 | 是的 | 是的 | 是的 |

### ConcurrencyController（`lib/workflow/runtime/concurrency-controller.ts`）

```ts
export interface ConcurrencyController {
  get(): number
  reduceTo(n: number): void // monotone non-increasing only; cannot raise
  subscribe(fn: (n: number) => void): () => void
}

export function createConcurrencyController(initial: number): ConcurrencyController
```

向后兼容性：`RunWorkflowInput.concurrency`为可选。省略时，编排器会从`workflow.settings.maxConcurrency ?? 1`构建内部控制器——其行为与今日的顺序执行完全相同。

### ModelPreferenceController（`lib/workflow/runtime/model-preference-controller.ts`）

```ts
export interface ModelPreferenceController {
  get(): { preferCheap?: boolean; modelHint?: string }
  downshift(): void // set preferCheap=true, optionally apply modelHint
}

export function createModelPreferenceController(opts?: {
  cheapModel?: string // e.g. "claude-haiku-4-5"
}): ModelPreferenceController
```

### synthesizeTeamWorkflow（`lib/ai/agent/team/synthesize-workflow.ts`）

```ts
export interface SynthesizeInput {
  team: AgentTeam
  tasks: AgentTeamTask[]
  initialConcurrency: number
  wallClockTimeoutMs?: number
  perTaskTimeoutMs?: number
}

export interface SynthesizeResult {
  workflow: VisualWorkflow
  nodeIdToTaskId: Map<string, string>
}

export function synthesizeTeamWorkflow(input: SynthesizeInput): SynthesizeResult

export class SynthesizeError extends Error {
  constructor(reason: "cycle" | "empty" | "invalid_dep", details: string)
}
```

综合工作流程形态：

- `id`：`__team__:${team.id}:${nanoid(8)}` — 合成前缀;UI不得为此ID导航到工作流程定义
- 每个任务→一个节点，节点为`type: "team.task.dispatch"`、`typeVersion: 1`、`data.params: { teamId, taskId, title, description, expectedOutput }`
- 每个`task.dependencies[]`条目→一条边`{ id: ${depId}->${task.id}, source: depId, target: task.id }`
- `settings.maxConcurrency = initialConcurrency`（合成器通过`team.config.maxConcurrentTeammates ?? 5`）
- `settings.timeoutMs = wallClockTimeoutMs`（合成器通过墙钟帽）

`SynthesizeInput`的默认采购：

- `perTaskTimeoutMs`退回`team.config.defaultTimeout ?? 600_000`（10分钟）;执行人从中读出，`TeamRunContext`与`ctx.signal`通过`AbortSignal.any`合并
- `wallClockTimeoutMs`默认为`0`（无墙时钟上限），当团队配置未设置时钟上限时;合成器依赖`tokenBudget`+`externalSignal`作为自然界限

### Team.Task.Dispatch 节点（注册于 `lib/workflow/nodes/built-ins.ts`）

```ts
registerNodeExecutor({
  kind: "team.task.dispatch",
  typeVersion: 1,
  retryable: true,
  // timeoutMs is set per-run via workflow.settings.timeoutMs; runStep already honors that
  execute: async (ctx) => {
    /* see contract below */
  },
})

interface TeamTaskDispatchParams {
  teamId: string
  taskId: string
  title: string
  description: string
  expectedOutput?: string
}

interface TeamTaskDispatchOutput {
  text: string
  teammateId: string
  teammateName: string
  tokenUsage?: SubAgentTokenUsage
  attempt: number
}
```

执行人合同：

1. `getTeamRunContext(ctx.runId)` →如果缺少，就扔`nonRetryable("team run context not registered")`
2. `pool.claim(taskId)` →如果`null`，就扔`RetryableError("no available teammate")`
3. 构造`AbortSignal.any([ctx.signal, AbortSignal.timeout(perTaskTimeoutMs)])`
4. `executeAgent(prompt, { systemPrompt, model: modelPref.get().modelHint, abortSignal })`
5. 验证输出：
   - `text.trim().length === 0` → `pool.recordFailure(teammate, EmptyOutputError)`，投掷可重试
   - 下面`team.config.minOutputChars` →同
   - 拒绝检测（启用时）→同样
6. 成功：`pool.recordSuccess` + `budget.add(usage)` + `storeWriter.addMessage(result_share)` + `storeWriter.setTaskStatus(completed, text)`
7. 失败：`pool.recordFailure(teammate, error)`（内部分类）+ `storeWriter.setTaskStatus(failed, undefined, errorMessage)` + 重投

### runTeamLifecycle（`lib/ai/agent/agent-team-runtime.ts`年重写）

```ts
export interface RunTeamLifecycleDeps {
  storeReader: {
    getTeam(teamId: string): AgentTeam | undefined
    getTeammates(teamId: string): AgentTeammate[]
    getTeamTasks(teamId: string): AgentTeamTask[]
  }
  storeWriter: TeamStoreWriter
  runLeadPlanning?: (params: {
    team: AgentTeam
    lead: AgentTeammate
    feedback?: string
    signal: AbortSignal
  }) => Promise<LeadPlanResult>
  notifierDeps?: TeamNotifierDeps
}

export interface RunTeamLifecycleResult {
  runId: string // matches workflowRuns row
  status: "completed" | "failed" | "cancelled"
  reason?: string
}

export async function runTeamLifecycle(
  teamId: string,
  deps: RunTeamLifecycleDeps,
  externalSignal?: AbortSignal
): Promise<RunTeamLifecycleResult>
```

合成器的职责（按顺序）：

1. team/tasks/teammates `storeReader`
2. 计划审批门禁（如果`team.config.requirePlanApproval`），重复利用`waitForDecision({scope: "agent-team", id: teamId})`
3. 每运行构建模块：`TeammatePool`、`BudgetGuard`、`TeamNotifier`、`ConcurrencyController(maxConcurrentTeammates)`、`ModelPreferenceController`
4. 订阅`pool.onAllUnavailable` →僵局门禁（通过`reduceTo(0)`封锁后等待裁决）
5. 订阅`pool.onTeammateDisqualified` →非阻塞队友修复通知+门禁
6. 通过`reduceTo(0)`订阅`budget.on("pause_for_review")` →阻挡门禁
7. `synthesizeTeamWorkflow(...)` → `VisualWorkflow`
8. `registerTeamRunContext(...)`在`try`区
9. `runWorkflow({ workflow, trigger: { kind: "team", payload: { teamId } }, runId, signal, concurrency })`
10. `finally`：`unregisterTeamRunContext`，处理订阅

### agent-team-运行时-deps.ts（简化版）

```ts
// New role: prompt builders + planning provider; no longer per-task executor
export function buildTeammatePrompt(team, teammate, task): string // unchanged
export function buildLeadPlanningPrompt(team, workers, feedback): string // unchanged
export function buildAgentTeamRuntimeDeps(
  opts?
): Pick<RunTeamLifecycleDeps, "runLeadPlanning" | "notifierDeps">
```

旧`runTeammateTask`被删除——执行人直接调用`executeAgent`。

## 回退层

该系统有五层回退，按最内层到最外层排列。除第四层外，所有层均继承自现有的原体。

### 第1层 — 单次执行尝试（执行者主体）

- `AbortSignal.any([ctx.signal, AbortSignal.timeout(perTaskTimeoutMs)])`——结束了LLM通话
- `try` / `finally` 确保`pool.recordSuccess`或`recordFailure`总是发射

### 第1.5层 — 输出验证（执行体，post-LLM）

- 空输出 → `RetryableError("EMPTY_OUTPUT")` + `pool.recordFailure`
- 以下`minOutputChars`（默认1）→相同
- 拒绝检测（默认关闭）→一样

### 第二层 — 工作流程节点重试（`runStep`）

- `workflow.retryDefaults.maxAttempts`与`backoffMs`荣誉
- 每次重试都会重新进入执行者，执行者从池中重新夺回→自然轮换给另一名队友

### 第2.5层——`recordFailure`内部的池错误分类）

| 错误模式 | 治疗 |
| ------------------------------------------------------ | ------------------------------------------------- |
| `EMPTY_OUTPUT`，`REFUSAL_DETECTED` | 普通（滑动窗口） |
| `\b429\b` / 速率限制 | 断路器立即打开，冷却恢复 |
| `\b40[134]\b` / 未授权 / 无效密钥 / 禁止 | **灾难性** →被取消资格，无法自动恢复 |
| 其他 | 普通 |

### 第三层 — Orchestrator（工作流程运行时，无新代码）

- `workflow.settings.timeoutMs`挂钟中止
- 外部`AbortSignal`级联
- `topoSort`周期检测→运行失败速度很快
- `resumeInFlightRuns()`应用启动时读取`workflowRuns where status = 'running'`并继续运行`IdempotencyCache`

### 第4层 — 合成器HITL 门禁（团队专用）

| 触发器 | 行动 |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pool.onAllUnavailable` | `concurrencyCtrl.reduceTo(0)` →块排程→开放的`agent-team-deadlock` 门禁 |
| `pool.onTeammateDisqualified` | 开放`agent-team-teammate-fix` 门禁**无阻挡**;继续与剩余队友一起跑 |
| `budget.on("pause_for_review")` | `concurrencyCtrl.reduceTo(0)` →块→开放`agent-team-budget` 门禁 |
| 计划批准修订限制 | 经过`maxPlanRevisions` 已拒绝修改后，运行失败，理由是“计划已拒绝” |

## HITL 门禁

这六个门禁都使用`lib/runtime/approval-bus`。每个门禁都有独特的`(scope, id)`键。

| 门禁 | 范围 | 身份证 | 当 | V1 / V2 |
| --------------------- | --------------------------- | ------------------------ | ------------------------------------------------- | ------- |
| 计划审批 | `"agent-team"` | `teamId` | 潜在客户生成计划（现有） | 第一版 |
| 预算覆盖 | `"agent-team-budget"` | `runId` | `onCritical: "pause_for_review"`在95%时触发 | 第一版 |
| 僵局解冻 | `"agent-team-deadlock"` | `runId` | 所有队友不可用 | 第一版 |
| 队友修复 | `"agent-team-teammate-fix"` | `${runId}:${teammateId}` | 单一队友被取消资格 | 第一版 |
| 手动任务重试 | `"agent-team-retry"` | `${runId}:${taskId}` | 任务永久失败后 | V2 |
| 工作流程pause/resume | `"workflow-pause"` | `runId` | 用户点击暂停键 | V2 |

UI：单个`<ApprovalGateDialog>`组件需要`(scope, id, title, body, schema, onApprove, onReject)`。三个具体的v1模态共享该组件，使用不同的载荷模式。

### 门禁 载荷模式

```ts
// agent-team-budget approve payload
{ extraTokens: number }

// agent-team-deadlock approve payload
{ teammateIds?: string[]; resetAll?: boolean }

// agent-team-teammate-fix approve payload
{ action: "rejoin" | "skip_permanently" }
```

## 通知机制

单一公共入口按层路由到三个通道。没有新基础设施——包含`sonner`、`lib/tauri/notification`、工作流程的`RunLogger`。

### 触发点（`notifyTeamRunEvent`开火地点）

| 资料来源 | 事件 | 级别 |
| --------------------- | --------------------------------- | -------- |
| 合成器 | 计划已生成，等待批准 | 关键 |
| 合成器 | 所有队友不可用 | 关键 |
| BudgetGuard | warning_crossed（80%） | 警告 |
| BudgetGuard | critical_crossed（95%） | 关键 |
| 泳池 | 队友被取消资格 | 关键 |
| 执行人 | 队友被隔离 | 警告 |
| 执行人 | 任务重试（尝试> 1） | 信息 |
| 桥→编排器 | 运行完成/失败 | 关键 |

### 去重规则

- BudgetGuard `warning_crossed` / `critical_crossed`每次游戏一次（重置时`extendLimit`）
- 队友隔离：同样teammateId 5分钟内被抑制
- 运行完成通知不会被减重（每次运行触发一次）

## 迁徙计划

六PRs，每个独立合并和可还原。PR 4 是切换;之前的 PRs 增加功能而不改变现有行为。

| PR | 范围 | 风险 | 行为改变 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| **PR 1** | `ConcurrencyController` + `ModelPreferenceController` + 编排器主环重构（默认`maxConcurrency=1`保持顺序行为） | 高（触摸工作流程主循环） | 无（无消费者） |
| **PR 2** | `TeammatePool` + `BudgetGuard` + `TeamNotifier` + `team-run-context` | 低 | 无（无消费者） |
| **PR 3** | `synthesizeTeamWorkflow` + 寄存器 `team.task.dispatch` 节点类型 | 低 | 无（节点注册，无调用者） |
| **PR 4** | **剪辑**：重写`runTeamLifecycle`;删除旧`runTeammateTask`;修复`built-ins.ts:1186` `action.team.run`演员破解 | **高** | 团队执行切换到F路径 |
| **PR 5** | UI：团队详情 / 跑步页面读`workflowRuns where triggerKind="team"`;`<ApprovalGateDialog>` + 3 种模式 | 媒介 | UI获得真实的跑道历史（目前没有） |
| **PR 6** | 第1.5层输出验证 + 第2.5层错误分类 + 失格状态 + 队友修复 门禁 + 重新加入UI | 媒介 | 在队友故障时运行更稳健 |

### 建议时间线

| 一周 | PRs |
| ---- | ----------------------- |
| W1 | PR 1 + PR 2 并联 |
| W2 | PR 3 + PR 4 选秀 |
| W3 | PR 4 土地 + PR 5 |
| W4 | PR 6 |

### 回滚计划

- **PR 1**：编排器回归→ `git revert`。PRs 2和3没有消费者，不受影响。
- **PR 4**：团队执行回归→ `git revert`。恢复旧`runTeamLifecycle`路径;现有`action.team.run`黑客回归（漏洞潜伏，非新）。PR 5 / 6 如果发货，必须倒序恢复。
- **PR 5**：UI回归→还原;后端数据源未变。
- **PR 6**：池回归→还原;v1 回退行为（无输出验证，无灾难性分类）恢复。

### PR 4 之前的现有呼叫站点审计

```bash
rtk grep -r "runTeamLifecycle\|agentTeamManager.start" --include='*.ts' --include='*.tsx'
```

预计迁移的命中点：

- `lib/ai/agent/agent-team.ts:99`（`agentTeamManager.start`）
- `lib/workflow/nodes/built-ins.ts:1199`（`action.team.run`体）
- 团队工作区组件（开始按钮处理器）
- 针对`runTeamLifecycle`和朋友的现有`*.test.ts`

回报价值消费者必须从检查`TeamExecutionReport`转向`runId`查`workflowRuns`。

## 测试策略

### 每个新模块的单元测试

| 模块 | 必修场景 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency-controller` | `reduceTo`触发订阅者;无法提出;并发访问安全 |
| `model-preference-controller` | `downshift` 集合 preferCheap;执行人读出提示 |
| `teammate-pool` | 轮流选择;暂时故障→隔离→冷却恢复;灾难性→取消资格（无自动恢复）;`forceUnquarantine`与`rejoin`区分;`onAllUnavailable`一次边缘触发;速率限制即时开放路径 |
| `budget-guard` | 所有四个`onCritical`动作;一次性警告/关键;`extendLimit`重置阈值;并行执行者同时进行`add()` |
| `team-notifier` | 电平→通道路由;`dedupeKey`抑制;`suspend()`阻断toast/OS但不阻挡日志;non-Tauri 回退（无操作`osNotify`） |
| `synthesize-workflow` | DAG → VW转换;边缘→ deps;周期检测抛弃 `SynthesizeError("cycle")`;空任务抛弃 `SynthesizeError("empty")`;无效 dep ref 抛弃`SynthesizeError("invalid_dep")` |
| `team-run-context` | 注册 / 获取 / 取消注册;WeakMap不会泄漏 |

### 编排器并发测试（`orchestrator.test.ts`年新增）

- 向后兼容：现有测试都默认通过`maxConcurrency=1`
- 纯并行：3个独立节点，`maxConcurrency=3` →测量墙钟<节点时长之和
- 依赖链：A → B → C，`maxConcurrency=3` →仍为串行（只有 A 先准备好）
- 半平行：A → {B， C};B 和 C 在 A 之后并行运行
- `reduceTo(0)`运行中：无新调度，飞行中完成，恢复后继续运行
- 分支 + 并行：分裂决策导致部分节点跳过;保持准备并行运行

### 集成/端对端测试

- **快乐路径**：3个任务，2个队友，1个依赖→全部完成;断言`workflowRuns.status === "completed"`，所有任务`setTaskStatus(completed)`呼叫已触发
- **重试+轮换**：队友A失败两次，B成功;断言pool.recordFailure在A上被叫两次，recordSuccess在A或B上;任务结束`completed`
- **僵局+恢复**：模拟所有失败的队友→ `onAllUnavailable`开火→通知器发出关键→ 门禁开启，→测试批准，`{teammateIds: ["W1"]}` →重置池重置W1→完成。
- **死锁+拒绝**：门禁打开→测试拒绝→中止信号触发→运行结束`cancelled`
- **预算 pause_for_review**：模拟高标记任务→ critical_crossed → 门禁开启→批准`{extraTokens: N}` →持续完成
- **预算reduce_concurrency**：触发计量的机上住宿`concurrencyCtrl.reduceTo(1)` → ≤ 1
- **预算handoff_to_background**：断言`modelPref.downshift()`被调用，通知者`suspend()`调用，事件日志仍能接收写入
- **灾难性队友**：W→1的模拟401被立即取消资格→通知者打开队友修正门禁程序而未被阻→挡，其他任务在W2继续→批准`rejoin` →W1可重新认领
- **空输出**：模拟executeAgent返回`""` → recordFailure `EMPTY_OUTPUT` →工作流程重试→换队友第二次尝试成功
- **计划批准因修订限制被拒**：门禁拒绝`maxPlanRevisions`次→运行结束`failed`理由“计划已拒绝”
- **崩溃恢复**（手动）：启用工作流程镜像启动运行→模拟进程中止→调用`resumeInFlightRuns()` →断言飞行中团队运行继续IdempotencyCache

### 覆盖范围门禁

所有新模块均适用`CLAUDE.md`的覆盖要求（≥90%lines/branches/functions）。编排器的修改主环路必须保持现有覆盖。

## 后果

### 阳性

- **单一思维模型。** 任何想了解“这怎么运行”的人都得读一遍工作流程运行时。团队专用代码包含~500行专注关注点。
- **免费崩溃恢复。** 团队通过`resumeInFlightRuns()`运行生存应用重启，且没有任何团队专属的持久化代码。
- **统一可观察性。** 运行页面（一个URL）显示手写工作流和团队运行;用户学习一个UI。
- **`flow.split`变得有意义。**已经使用split/join的工作流程在选择加入`maxConcurrency > 1`时会获得并行执行。
- **未来工作的基础。** Agent作者的工作流程（独立ADR）针对相同的`VisualWorkflow` 产物和执行引擎——生成器不需要知道团队的具体情况。
- **漏洞债务已清除。** `action.team.run`角色改版作为重写的副作用消失了。

### 负面/已接受权衡

- **工作流编排器的主循环被触动了。** 一个细微的调度错误可能会影响GitHub交付、双重工作流程以及任何用户工作流程。通过默认`maxConcurrency=1`+广泛的测试矩阵来缓解，但这是风险最高的工作。
- **两行工作流用于嵌套执行。** 包含`action.team.run`的用户工作流程会产生一行父行和一行合成子行。UI在 v1 中不接口父子链接（延迟）。
- **团队配置字段语义上迁移。** `maxRetries`、`defaultTimeout`、`defaultMaxSteps`、`enableTaskRetry` `enableDeadlockRecovery` 不再是团队私有的——它们映射到工作流程设置 + 节点重试策略。团队配置页面的UI标签可能需要更新以反映这一点。
- **计划批准门禁无持久恢复。**如果用户被要求批准计划并关闭应用，运行将被取消（批准总线订阅为内存中）。这符合当前行为;持久批准如有需要，是第二版后续。
- **合成工作流有合成的IDs。** UI组件试图导航到`__team__:...` ID的工作流程定义时，必须优雅地处理“无定义”。

### 带外音

在设计讨论中，多个相邻文件（`src-tauri/src/vector/`、`src-tauri/src/tray*`、`src-tauri/src/keyring_secrets.rs`）中出现了多个Rust诊断，分别代表E0432 / E0277 / E0583 / E0761硬编译错误。这些错误与本作无关ADR但会阻碍Rust构建。在PR 1登陆前，应在单独任务中处理这些问题，因为PR 1需要`pnpm tauri dev`才能干净地运行进行集成测试。

## 开放性问题及v2后续问题

| 项目 | 为什么要延期 | 重访的触发点 |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 手动任务重试 | 工作流程运行时需要“注入节点到飞行中运行”——这是可加但不简单的 | v1发布后的第一个用户请求 |
| 暂停 / 继续 | 唤醒总线集成到编排器调度器循环中 | 我也是 |
| 嵌套工作流的父子运行UI（例如包含`action.team.run`的用户工作流） | UX-only;事件中已捕获的数据 | 当运行页面重新设计发生时 |
| `handoff_to_background` “实”模式（独立进程/队列） | 需要Worker队列、长存、IPC、持久收件箱——完整的架构添加（D路径） | 如果LLM成本成为用户的主要痛点 |
| 提取数据`kahn-core`工作流拓扑排序和团队合成器共享 | 外观重构;两个实现都很小 | 当第三位卡恩使用者出现时 |
| 委托生命周期（`TeamDelegationRecord`）引擎 | 明确的范围去化 | 如果委派变成用户请求 |
| 共识投票引擎 | 明确的范围去化 | 如果共识变成了用户请求 |
| Agent作者工作流程生成 | 另外一个问题;这个ADR的合成器会产生`VisualWorkflow`，而LLM发生器则会产生相同类型的耦合为零 | 即将推出的代理-工作流程生成ADR跟踪 |

## 附录（2026-05-30）— Ultracode 编排

将Claude Code的**ultracode**模式（以努力驱动的多代理工作流创作+质量模式）移植到该子系统上。Ultracode是平面任务DAG之外的第二条综合路径——它重用了整个Path-F引擎（编排器、`ConcurrencyController`、`BudgetGuard`、`TeammatePool`、事件日志、IM扇出、HITL 门禁），并增加了三项内容。

**1.工具支持的队友。** 平坦路径的`action.team.task.dispatch`让队友通过`executeAgent`（AI SDK `streamText`，仅文本）。调度核心被提取成可重用的原始`lib/ai/agent/team/dispatch-teammate.ts:dispatchTeammate`（声称→运行→验证→记录pool/budget/hooks）。在桌面端，它将回合路由到Tauri sidecar（`runAndCaptureAssistantReply` + `resolveSendOptions`），使队友获得真正的Bash/Read/Edit/MCP/skills/native-tools;在 web/mobile 上，它会退回到 `executeAgent`。桥接器`teammate-character.ts:teammateToCharacter`从`AgentTeammate` + 其`ResolvedCapabilities`合成内存内`Character`，因此完整的构建选项流水线适用（子代理来自 `session.kind === "team"`）。结构化输出使用`structured-dispatch.ts:dispatchStructured`（JSON-fenced指令→ `parseProposedPlan` → Zod 验证一次→一次），在两个通道上保持一致。平面派遣执行器被重写为委派给 `dispatchTeammate`，因此标准运行保持不变，但桌面上启用了工具。

**2.高阶节点的质量模式。** 六个`pattern.*`节点执行者（`lib/ai/agent/team/patterns/`）每个在内部扇出`dispatchTeammate`/`dispatchStructured`——受运行`ConcurrencyController`界，发出`run_log`子事件——运行时因此未知的扇出（循环至干，评审团）存在于一个工作流节点内，外部DAG保持有效：`multi-modal-sweep`、`loop-until-dry`、`adversarial-verify`（多数反驳杀戮;视角多样）、`judge-panel`、`completeness-critic`、`synthesize`。验证器运行时启用了工具。

**3.计划 + 触发器。** `ultracode-planner.ts:planUltracodeWorkflow` 有一位规划员队友编写了一份类型化的`UltracodePlan`（负责图案、计数、透镜）;`synthesize-ultracode.ts:synthesizeUltracodeWorkflow`将其降为`pattern.*` DAG（查找者→验证→合成，合成从每个前节点扇入）。`runTeamLifecycle` 分支在`ultracode-trigger.ts:isUltracodeActive`（操作员覆盖 > `ultracode.enabled` + `autoMode`;`auto`键关闭 `routingAssessment.factors.taskComplexity === "complex"`）。终端`pattern.synthesize`输出变为`team.finalResult`。配置 + 手动“使用超代码运行”在工作区（`components/agent/workspace/settings/section-ultracode.tsx`，`overview.tsx`）中实时运行。

**已知的限制。** 工具支持的队友需要Tauri sidecar;web/mobile退回到仅文本推理（在UI中体现），这是静态导出壳固有的——而非简化。

## 修订说明（2026-07-08）——已提交的后续与修正

上述若干陈述已被取代（完整设计见 ADR-0066）：

- **手动任务重试：已交付**——不是通过运行中节点注入，而是作为受保护的`failed → pending`板移动（`task-move-guard.ts:canMoveTask`）;下一run/resume重新派遣任务。
- **暂停 / 恢复：已送达** — `agentTeamManager.resume()`会因尚未完成的任务重新进入`runTeamLifecycle`（`RunTeamLifecycleDeps.taskFilter`，过滤ID变为`satisfiedDependencyIds`），并进行unstrand/reset处理和黑板从持久`task.result`重新种回。
- **委托与共识“仅类型”**：过时——现已存在引擎代码（`team/delegation-orchestrator.ts`，`team/consensus-orchestrator.ts`）。
- **“无新Dexie表”**：团队RUNS仍然适用（保持`workflowRuns`行）。还有两个相邻的表用于其他问题：`teamPrObservations`（v103，PR反馈）和`agentTeamBoard`（v104，移动同步的单向板镜——存储仍为单一写源）。
- **波次跑者修复**：每波路径重用一个`runId`，后期ADR-0061 P4所有者守卫在第一波后将其视为终端——悄无声息地跳过后续波次。运行时现在重新打开波与波之间的行（伴随的软取消仍被遵守）。
- **Workspace 标签页**：`AgentTeamWorkspaceTab` union 被更正为实际渲染的标签页（未实现的 `graph`/`analytics` 值被移除）。

## 当前状态修订（2026-08-13）

Manual retry、pause/resume、delegation、consensus、persistence、review 与 remote dispatch 已由 AgentTeam runtime 和后续 ADR 交付。durable external queue 仍被明确排除。当前 owner 需结合 ADR-0066、ADR-0071、ADR-0111 与 ADR-0113 理解；本 ADR 不再表示需要另建一套编排状态。
