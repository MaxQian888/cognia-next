---
title: "ADR-0045 — 统一计划执行中心"
description: "将内置代理的计划模式从SDK直通提升为一类结构化AgentPlan，作为所有多步代理执行的规范中间表示（IR）。计划是DAG的打字PlanSteps;批准时，它运行在一个混合自适应引擎上，该引擎在对话中执行简单的线性计划，并将delegation/parallel计划编译到现有的工作流编排器中。计划有四种编写方式（ExitPlanMode捕获、显式代理工具、规划器LLM和Team/Goal投影），支持手动/步进失败/判断偏差重新规划，并统一了之前断开的三种拆解驱动机制（计划模式、目标模式、Agent Team）。"
---

# ADR-0045 — 统一计划执行中心

**状态**：提议（2026-06-03）**作者**：Max Qian + Claude Opus 4.8 **基于**基础：SDK计划权限直通（`lib/claude/build-options.ts:resolveSendOptions` → `sidecar/dispatch/anthropic.mjs`）、计划模式→任务桥接（`lib/agent/plan-mode-bridge.ts`）、目标命令（ADR-0019;`lib/goal/*`）、Agent Team 运行时（ADR-0022/0032;`lib/ai/agent/*`）、以及可视化工作流程编排器（ADR-0011/0022;`lib/workflow/runtime/orchestrator.ts`） **影响**：`types/agent/plan.ts`（孤儿`types/agent/agent.ts`重写）、`lib/agent/plan/*`（新：`runtime`、`synthesize-workflow`、`context-injector`、`prompts`、`planner`、`projections`、`pii-gate`）、`lib/db/schema.ts`（Dexie **v71**） + `lib/db/plans.ts`（新）、`lib/claude/build-options.ts`（`appendPlanContext` + `session.activePlan`）、`lib/claude/types.ts`（`SendOptions`/session plan字段）、`lib/workflow/nodes/built-ins.ts` + `catalog.ts` + `params-schemas.ts`（新`action.plan.step.dispatch`节点）、`sidecar/plan-tools/*`（新的显式`CreatePlan`/`UpdatePlan`工具def，镜像`sidecar/a2ui-tools/tool-defs.mjs`）、`hooks/chat/use-claude-chat.ts`（ExitPlanMode捕获+工具调度）、`components/agent/plan/*`（新UI）、`stores/agent/*`、`i18n/messages/{en,zh-CN}.json`

## 背景

内置代理的**计划模式很薄**。存在三层，但没有一层拥有统一的平面图：

1. **权限直通** — `permissionMode: "plan"`通过优先链（`build-options.ts:750`：会话→模式→字符→ appSettings）解析，并逐字交付给Claude Agent SDK `query()` `sidecar/dispatch/anthropic.mjs:242`。**所有计划语义都存在于SDK中;本仓库不拥有这些内容。**
2. **任务桥接** — `lib/agent/plan-mode-bridge.ts`将SDK的 `TodoWrite` / `TaskCreate` / `ExitPlanMode` tool_use 块映射到`agent-team-store`中，作为合成`solo:<sessionId>`团队，由 `components/agent/workspace/plan-mode-tasks-sheet.tsx` 只读浮出。
3. **渲染** — `components/chat/message-parts/mcp-renderers/plan-card.tsx`渲染一个带有本地`PlanStep`接口的`ExitPlanMode`块。

整个**结构化计划模型是死代码**：`types/agent/agent.ts`（`AgentPlan`、`PlanStep`、`PlanRefinementRequest/Result`、`CreatePlanInput`、`AgentExecutionContext`、`PLAN_REFINEMENT_PROMPTS`）仓库范围内**零导入者**。其配套插件hook `onAgentPlanCreate` / `onAgentPlanStepComplete` 被降级为 `DEPRECATED_HOOK_POINTS`（ADR-0016）。这是一种“计划→、批准→完善→执行”的理想设计，但从未建成。

与此同时，**编曲成熟但脱节**。Agent Team 运行时（`lib/ai/agent/agent-team-runtime.ts:runTeamLifecycle`）会门禁能力+计划审批，然后**将任务DAG编译成`VisualWorkflow`**（`lib/ai/agent/team/synthesize-workflow.ts`），并委派给`runWorkflow`——继承幂等性、崩溃恢复、并发和事件日志。但**内置的聊天代理无法直接访问编排**：唯一的聊天→团队路径是`action.team.run`工作流节点。而**Goal**子系统（`lib/goal/*`）是一个*第三*自驱动循环（turn-driver + judge + subgoal 分解），与两者都不共享。

结果是**三个并行的分解-驱动机制**，且没有统一表示：

| 机制 | 数据模型 | 触发器 | 发动机 | 聊天关系 |
| --- | --- | --- | --- | --- |
| 计划模式 | 无（SDK + 任务桥接） | Shift+Tab | Claude SDK | 本地，唯读 |
| 目标 | `Goal` / `GoalSubgoal`（Dexie v30） | `/goal` | 转向驱动器环路 | 注入系统提示 |
| 团队 / 工作流程 | `AgentTeam` / `AgentTeamTask` | `action.team.run` | 工作流程编排器 | 只有通过工作流程 |

## 决策

为每个多步代理执行创建一个**重`AgentPlan`写的“规范中间表示（IR）”，并构建运行它的**执行中心**。死`types/agent/agent.ts`被重写为`types/agent/plan.ts`（`agent.ts`通用名称本身就是对更广泛`types/agent/*`领域的一种气味）;随着重写的清理，孤儿文件会被移除。

### 1. AgentPlan类型step-DAG IR

计划是`PlanStep`s的一大块的 DAG。每个步骤都携带一个执行者类型**，因此一个表示可以表达会话中的推理、委托、工具调用、子工作流和批准门禁：

```ts
// types/agent/plan.ts
export type PlanStepKind =
  | "agent_turn"        // an in-session turn by the main agent (visible, conversational)
  | "teammate_dispatch" // delegate to a teammate / subagent — reuses dispatchTeammate
  | "tool_call"         // a specific tool invocation with fixed input
  | "sub_workflow"      // run a nested VisualWorkflow — reuses runWorkflow
  | "approval_gate"     // human approval checkpoint — reuses lib/runtime/approval-bus

export type PlanStepStatus =
  | "pending" | "ready" | "in_progress" | "completed" | "failed" | "skipped" | "blocked"

export interface PlanStep {
  id: string
  title: string
  description?: string
  kind: PlanStepKind
  status: PlanStepStatus
  order: number
  dependencies: string[]           // DAG edges (step ids)
  params?: PlanStepParams          // kind-tagged union: { teammateId } | { toolName, input } | { workflowId } | ...
  result?: string
  output?: unknown
  error?: string
  attempts?: number
  toolCallIds?: string[]
  startedAt?: Date
  completedAt?: Date
  estimatedDurationMs?: number
  actualDurationMs?: number
}

export interface AgentPlan {
  id: string
  sessionId: string
  characterId?: string
  title: string
  description?: string
  source: "exit_plan_mode" | "agent_tool" | "planner_llm" | "team_projection" | "goal_projection" | "manual"
  executionMode: "in_session" | "orchestrated" | "auto"  // "auto" = hybrid-adaptive (default)
  steps: PlanStep[]
  status: "draft" | "awaiting_approval" | "approved" | "executing" | "paused" | "completed" | "failed" | "cancelled"
  currentStepId?: string
  totalSteps: number
  completedSteps: number
  config: PlanConfig
  generationId: number             // staleness guard, mirrors Goal.generationId
  createdAt: Date
  updatedAt: Date
  startedAt?: Date
  completedAt?: Date
  metadata?: Record<string, unknown>
}

export interface PlanConfig {
  requireApproval: boolean         // gate before execution (default true)
  executionMode: AgentPlan["executionMode"]
  maxAutoRefinements: number       // cap on automatic replans
  maxStepRetries: number
  judgeDeviation: boolean          // run a between-steps judge (reuses goal judge pattern)
  maxTokens?: number
}

export interface PlanRefinementRequest {
  planId: string
  refinementType: "optimize" | "simplify" | "expand" | "reorder" | "repair"
  trigger: "manual" | "step_failure" | "judge_deviation"
  failedStepId?: string
  customInstructions?: string
}
```

仅附加`PlanEvent`日志恰好镜像`GoalEvent`（`created | approved | rejected | refined | step_started | step_completed | step_failed | replanned | paused | resumed | exit`）。

### 2. 混合自适应执行

批准计划时，它运行;引擎**从计划形状中选择策略**（`executionMode: "auto"`年）：

- **会话中顺序式**——每一步都`agent_turn`，DAG线性。驱动程序会镜像`lib/goal/turn-driver.ts`：每一步都是*当前可见聊天会话*中的一个轮流，用户观察座席如何对话式地操作计划。这保留了原生Claude-Code计划模式的感觉（“批准，然后观看执行”）。
- **有序的**——当计划包含`teammate_dispatch`/`sub_workflow`步或任何平行性时。`lib/agent/plan/synthesize-workflow.ts:synthesizePlanWorkflow(plan)`将计划编译成`action.plan.step.dispatch` `VisualWorkflow`节点（纯函数镜像`synthesizeTeamWorkflow`、`__plan__:<planId>:<nonce>` id、Kahn周期检查），然后交`runWorkflow`。因此，该计划将编排器的幂等性、崩溃恢复、并发和事件日志都白箱化，而不是重新实现它们。

这正是聊天代理获得直接编排的原理：`teammate_dispatch`步骤*是委托，由现有的`dispatchTeammate`/`runTeamLifecycle`接缝执行——无需新的编排引擎，也无需强制绕行工作流程编辑器。

每步节点执行器（`action.plan.step.dispatch` in `lib/workflow/nodes/built-ins.ts`）路由如下`step.kind`：

```
agent_turn        → in-session turn (executeAgent / sidecar runAndCaptureAssistantReply)
teammate_dispatch → dispatchTeammate(teamCtx, …)        (reuses ADR-0022 primitive)
tool_call         → resolved tool invocation
sub_workflow      → nested runWorkflow(params.workflowId)
approval_gate     → waitForDecision(scope, id, signal)  (reuses approval-bus)
```

### 3. 四位计划作者，一个模型

一个计划可以有四种方式，都会产生相同的`AgentPlan`（`source`记录来源）：

1. **捕捉`ExitPlanMode`**——当SDK的计划模式`ExitPlanMode` tool_use出现（`hooks/chat/use-claude-chat.ts`，与现有`applyPlanModeBridge`并列），构建`AgentPlan(draft, source="exit_plan_mode")`并接口审批。这是原生计划模式从未有过的关闭：它现在拥有*批准后发生的事情*。
2. **显式代理工具** — 通过`sidecar/plan-tools/tool-defs.mjs`（单一names/schemas源，镜像`sidecar/a2ui-tools/tool-defs.mjs`模式;在渲染器中调度，因sidecar无法导入`lib/`而向代理展示`CreatePlan`/`UpdatePlan`）。让代理在计划运行时构建和更新。
3. **Planner LLM** — `lib/agent/plan/planner.ts:decomposeIntoPlan`将一行目标转化为步骤DAG，重复使用`LlmClient`抽象和`extractJson`，完全像`lib/goal/subgoals.ts:decomposeObjective`一样。
4. **团队/目标预测** — `lib/agent/plan/projections.ts`转换`AgentTeamTask[]`⇄ `PlanStep[]`和`GoalSubgoal[]` → `PlanStep[]`（以及反向），使两种现有机制共享相同的执行+跟踪流水线。

### 4. 三次重新规划触发器（PlanRefinement）

`lib/agent/plan/runtime.ts:refinePlan(request)`重复利用以下部位的`PLAN_REFINEMENT_PROMPTS`和发射：

- **阶梯失败**——当阶梯耗尽`maxStepRetries`时，运行时自动发出`repair`细化（Devin式重规划环），并以 `config.maxAutoRefinements` 封闭。
- **手动** — 用户在套餐面板上点击优化/简化/展开/重新排序。
- **裁判偏差** — 当`config.judgeDeviation`开启时，步间调节器（重复使用`lib/goal/judge.ts`模式+`LlmClient`）检查对齐并触发漂移细化。

### 5. 整合接缝——重复使用，绝不重建

- **`build-options.ts`** — 新`lib/agent/plan/context-injector.ts:appendPlanContext` `appendGoalContext`（`context-injector.ts:26`）并被调用在球门阻挡（`build-options.ts:~1239`）旁边;`session.activePlan`与`session.activeGoal`遵循相同的优先顺序模式。执行计划状态（当前+剩余步数）被注入到`appendSystemPrompt`中。
- **PII 门禁**——`lib/agent/plan/pii-gate.ts`在任何LLM/embed之前就运行计划titles/steps到`hasNoLeakingPii`，正如`lib/goal/redact-objective.ts`和`lib/connectors/ai-loop/safe-send-prompt.ts`所做的那样。
- **通知**——步骤启动/完成/阻止/重新规划通过`lib/notifications/notify()`（ADR-0042）。
- **权限** — `tool_call` / `teammate_dispatch` 步通过ADR-0041自动模式三级安全门禁。
- **持久性** — **Dexie v71**，加法，无升级hook：`agentPlans` + `agentPlanEvents`，索引镜像`chatGoals` / `chatGoalEvents`（`schema.ts:1092`）：每会话一个活跃计划，由作者强制执行（`lib/db/plans.ts`），每个计划仅添加事件上限。

### 6. UI

- **在线 approval/edit 卡片**在聊天（`components/agent/plan/plan-approval-card.tsx`）中 — 审核、编辑步骤、批准/拒绝/优化后再执行。
- **在现有代理工作区中规划追踪面板** — 带有状态的实时步骤DAG，重复使用目前托管`PlanModeTasksSheet`的工作区壳层。
- 两者都有精细控制（优化/简化/扩展/重新排序/修复）。

## 后果

- 内置代理的计划模式成为真正的、拥有的闭合：结构化计划→ approve/edit/refine →跟踪执行→重新规划——而非SDK黑箱。
- 聊天代理可以直接编排：委派步骤可以重复使用`dispatchTeammate`而无需工作流编辑器的绕道。
- 其中一个IR统一了计划/目标/团队;这三个重复的分解与驱动循环合并为一个执行 + 跟踪 + 持久化流水线。
- 执行引擎是现有的工作流编排器（幂等性、崩溃恢复、并发、事件日志）——无需维护第二引擎。
- `types/agent/agent.ts`从死代码变成了一个活跃的中央模型（更名为`types/agent/plan.ts`）。
- 成本：新Dexie版本、新节点类型、新sidecar工具定义，以及跨聊天+工作区UI的区域接口。通过相位（如下）在每个相位门禁绿灯来缓解。

## 考虑的替代方案

- **保持SDK直通，只改进UI**（设计讨论已拒绝）——使三种机制断开，结构化模型死寂;违反了“禁止简化”的规定。
- **定制计划执行者** 不是编译为`VisualWorkflow`——而是复制了编排器的idempotency/recovery/concurrency;已拒绝用于重复使用。
- **始终在会话中**或**始终被编排**——每种方式都损失了一半的价值（平行扇出，或原生的会话式计划模式感觉）;混合自适应默认保留了两者。

## 分阶段

参见`docs/plans/2026-06-03-unified-plan-execution-hub.md`。每个阶段都是绿色（`pnpm typecheck`，`pnpm test:coverage` ≥90%，`pnpm lint:i18n`，`pnpm sidecar:test`被触及）：

- **P1 — 模型 + 持久性**：重写`types/agent/plan.ts`，删除`types/agent/agent.ts`，Dexie **v71** + `lib/db/plans.ts` CRUD（每次会话的活动计划不变，事件日志封闭），计划运行时生命周期骨架（创建/批准/拒绝/暂停/恢复/取消 + AbortController注册表），`appendPlanContext` + `session.activePlan` 布线。
- **P2 — 执行引擎**：`synthesizePlanWorkflow`，`action.plan.step.dispatch`节点+逐种路由，会话中驱动，混合自适应模式选择，PII 门禁。
- **P3 — 聊天→编排**：`teammate_dispatch`接线`dispatchTeammate`;ExitPlanMode捕获;显式`CreatePlan`/`UpdatePlan`工具 defs + 渲染器调度。
- **P4 — 进球/团队投射**：`projections.ts`双向;通过计划流程路由目标子目标和团队任务。
- **P5 — 规划者 + 重新规划 + UI**： `decomposeIntoPlan`;三种精炼触发器;批准卡、追踪面板、精炼控制;通知。
