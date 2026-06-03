---
title: ADR-0045 — Unified Plan Execution Hub
description: "Promote the built-in agent's Plan mode from an SDK passthrough into a first-class, structured AgentPlan that serves as the canonical intermediate representation (IR) for all multi-step agentic execution. A plan is a DAG of typed PlanSteps; approving one runs it under a hybrid-adaptive engine that executes simple linear plans in-conversation and compiles delegation/parallel plans into the existing workflow orchestrator. Plans are authored four ways (ExitPlanMode capture, an explicit agent tool, a planner LLM, and Team/Goal projection), support manual / step-failure / judge-deviation replanning, and unify the three formerly disconnected decompose-and-drive mechanisms (Plan mode, Goal, Agent Team)."
---

# ADR-0045 — Unified Plan Execution Hub

**Status**: Proposed (2026-06-03)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the SDK plan-permission passthrough (`lib/claude/build-options.ts:resolveSendOptions` → `sidecar/dispatch/anthropic.mjs`), the plan-mode → tasks bridge (`lib/agent/plan-mode-bridge.ts`), the Goal command (ADR-0019; `lib/goal/*`), the Agent Team runtime (ADR-0022/0032; `lib/ai/agent/*`), and the Visual Workflow orchestrator (ADR-0011/0022; `lib/workflow/runtime/orchestrator.ts`)
**Affects**: `types/agent/plan.ts` (rewrite of the orphaned `types/agent/agent.ts`), `lib/agent/plan/*` (new: `runtime`, `synthesize-workflow`, `context-injector`, `prompts`, `planner`, `projections`, `pii-gate`), `lib/db/schema.ts` (Dexie **v71**) + `lib/db/plans.ts` (new), `lib/claude/build-options.ts` (`appendPlanContext` + `session.activePlan`), `lib/claude/types.ts` (`SendOptions`/session plan fields), `lib/workflow/nodes/built-ins.ts` + `catalog.ts` + `params-schemas.ts` (new `action.plan.step.dispatch` node), `sidecar/plan-tools/*` (new explicit `CreatePlan`/`UpdatePlan` tool defs, mirroring `sidecar/a2ui-tools/tool-defs.mjs`), `hooks/chat/use-claude-chat.ts` (ExitPlanMode capture + tool dispatch), `components/agent/plan/*` (new UI), `stores/agent/*`, `i18n/messages/{en,zh-CN}.json`

## Context

The built-in agent's **Plan mode is thin**. Three layers exist and none of them owns a plan:

1. **Permission passthrough** — `permissionMode: "plan"` resolves through the precedence chain (`build-options.ts:750`: session → mode → character → appSettings) and is handed verbatim to the Claude Agent SDK `query()` in `sidecar/dispatch/anthropic.mjs:242`. **All plan semantics live inside the SDK; this repo does not own them.**
2. **Tasks bridge** — `lib/agent/plan-mode-bridge.ts` maps the SDK's `TodoWrite` / `TaskCreate` / `ExitPlanMode` tool_use blocks into the `agent-team-store` as a synthetic `solo:<sessionId>` team, surfaced read-only by `components/agent/workspace/plan-mode-tasks-sheet.tsx`.
3. **Render** — `components/chat/message-parts/mcp-renderers/plan-card.tsx` renders an `ExitPlanMode` block with its own local `PlanStep` interface.

A whole **structured plan model is dead code**: `types/agent/agent.ts` (`AgentPlan`, `PlanStep`, `PlanRefinementRequest/Result`, `CreatePlanInput`, `AgentExecutionContext`, `PLAN_REFINEMENT_PROMPTS`) has **zero importers** repo-wide. Its companion plugin hooks `onAgentPlanCreate` / `onAgentPlanStepComplete` were demoted to `DEPRECATED_HOOK_POINTS` (ADR-0016). It is an aspirational "plan → approve → refine → execute" design that was never built.

Meanwhile **orchestration is mature but disconnected**. The Agent Team runtime (`lib/ai/agent/agent-team-runtime.ts:runTeamLifecycle`) gates capability + plan approval, then **compiles a task DAG into a `VisualWorkflow`** (`lib/ai/agent/team/synthesize-workflow.ts`) and delegates to `runWorkflow` — inheriting idempotency, crash recovery, concurrency, and an event log. But the **built-in chat agent cannot reach orchestration directly**: the only chat→team path is the `action.team.run` workflow node. And the **Goal** subsystem (`lib/goal/*`) is a *third* self-driving loop (turn-driver + judge + subgoal decomposition) that shares nothing with either.

The result is **three parallel decompose-and-drive mechanisms** with no common representation:

| Mechanism | Data model | Trigger | Engine | Chat relationship |
| --- | --- | --- | --- | --- |
| Plan mode | none (SDK + tasks bridge) | Shift+Tab | Claude SDK | native, read-only |
| Goal | `Goal` / `GoalSubgoal` (Dexie v30) | `/goal` | turn-driver loop | injects system prompt |
| Team / Workflow | `AgentTeam` / `AgentTeamTask` | `action.team.run` | workflow orchestrator | only via workflow |

## Decision

Make a **rewritten `AgentPlan` the canonical intermediate representation (IR)** for every multi-step agentic execution, and build the **execution hub** that runs it. The dead `types/agent/agent.ts` is rewritten as `types/agent/plan.ts` (the generic `agent.ts` name is itself a smell against the broader `types/agent/*` domain); the orphan file is removed as cleanup the rewrite creates.

### 1. AgentPlan as a typed step-DAG IR

A plan is a DAG of `PlanStep`s. Each step carries an **executor kind** so a single representation can express in-session reasoning, delegation, tool calls, sub-workflows, and approval gates:

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

An append-only `PlanEvent` log mirrors `GoalEvent` exactly (`created | approved | rejected | refined | step_started | step_completed | step_failed | replanned | paused | resumed | exit`).

### 2. Hybrid-adaptive execution

Approving a plan runs it; the engine **picks the strategy from plan shape** (`executionMode: "auto"`):

- **In-session sequential** — when every step is `agent_turn` and the DAG is linear. A driver mirrors `lib/goal/turn-driver.ts`: each step is a turn in the *current visible chat session*, so the user watches the agent work the plan conversationally. This preserves the native Claude-Code plan-mode feel ("approve, then watch it execute").
- **Orchestrated** — when the plan contains `teammate_dispatch` / `sub_workflow` steps or any parallelism. `lib/agent/plan/synthesize-workflow.ts:synthesizePlanWorkflow(plan)` compiles the plan into a `VisualWorkflow` of `action.plan.step.dispatch` nodes (a pure function mirroring `synthesizeTeamWorkflow`, `__plan__:<planId>:<nonce>` id, Kahn cycle check) and hands it to `runWorkflow`. The plan thus **white-boxes the orchestrator's idempotency, crash recovery, concurrency, and event log** instead of reimplementing them.

This is exactly how the **chat agent gains direct orchestration**: a `teammate_dispatch` step *is* the delegation, executed by the existing `dispatchTeammate` / `runTeamLifecycle` seam — no new orchestration engine, no mandatory detour through the workflow editor.

The per-step node executor (`action.plan.step.dispatch` in `lib/workflow/nodes/built-ins.ts`) routes by `step.kind`:

```
agent_turn        → in-session turn (executeAgent / sidecar runAndCaptureAssistantReply)
teammate_dispatch → dispatchTeammate(teamCtx, …)        (reuses ADR-0022 primitive)
tool_call         → resolved tool invocation
sub_workflow      → nested runWorkflow(params.workflowId)
approval_gate     → waitForDecision(scope, id, signal)  (reuses approval-bus)
```

### 3. Four plan authors, one model

A plan can be born four ways, all producing the same `AgentPlan` (`source` records provenance):

1. **Capture `ExitPlanMode`** — when the SDK's plan-mode `ExitPlanMode` tool_use is seen (`hooks/chat/use-claude-chat.ts`, alongside the existing `applyPlanModeBridge`), build an `AgentPlan(draft, source="exit_plan_mode")` and surface it for approval. This is the closure the native plan mode never had: it now owns *what happens after approval*.
2. **Explicit agent tool** — expose `CreatePlan` / `UpdatePlan` to the agent via `sidecar/plan-tools/tool-defs.mjs` (single source of names/schemas, mirroring the `sidecar/a2ui-tools/tool-defs.mjs` pattern; dispatched in the renderer because the sidecar cannot import `lib/`). Lets the agent structure and update a plan as it works.
3. **Planner LLM** — `lib/agent/plan/planner.ts:decomposeIntoPlan` turns a one-line objective into a step DAG, reusing the `LlmClient` abstraction and `extractJson` exactly as `lib/goal/subgoals.ts:decomposeObjective` does.
4. **Team / Goal projection** — `lib/agent/plan/projections.ts` converts `AgentTeamTask[]` ⇄ `PlanStep[]` and `GoalSubgoal[]` → `PlanStep[]` (and back), so the two existing mechanisms feed the same execution + tracking pipeline.

### 4. Three replan triggers (PlanRefinement)

`lib/agent/plan/runtime.ts:refinePlan(request)` reuses `PLAN_REFINEMENT_PROMPTS` and fires from:

- **Step failure** — when a step exhausts `maxStepRetries`, the runtime auto-issues a `repair` refinement (Devin-style replan loop), capped by `config.maxAutoRefinements`.
- **Manual** — the user clicks optimize / simplify / expand / reorder on the plan panel.
- **Judge deviation** — when `config.judgeDeviation` is on, a between-steps judge (reusing the `lib/goal/judge.ts` pattern + `LlmClient`) checks alignment and triggers a refinement on drift.

### 5. Integration seams — reuse, never rebuild

- **`build-options.ts`** — new `lib/agent/plan/context-injector.ts:appendPlanContext` mirrors `appendGoalContext` (`context-injector.ts:26`) and is invoked next to the goal block (`build-options.ts:~1239`); `session.activePlan` rides the same precedence pattern as `session.activeGoal`. Executing-plan state (current + remaining steps) is injected into `appendSystemPrompt`.
- **PII gate** — `lib/agent/plan/pii-gate.ts` runs plan titles/steps through `hasNoLeakingPii` before any LLM/embed, exactly as `lib/goal/redact-objective.ts` and `lib/connectors/ai-loop/safe-send-prompt.ts` do.
- **Notifications** — step start / completion / block / replan fan out through `lib/notifications/notify()` (ADR-0042).
- **Permissions** — `tool_call` / `teammate_dispatch` steps pass the ADR-0041 auto-mode three-tier safety gate.
- **Persistence** — **Dexie v71**, additive, no upgrade hook: `agentPlans` + `agentPlanEvents`, indices mirroring `chatGoals` / `chatGoalEvents` (`schema.ts:1092`): one active plan per session enforced by the writer (`lib/db/plans.ts`), append-only events capped per plan.

### 6. UI

- **Inline approval/edit card** in chat (`components/agent/plan/plan-approval-card.tsx`) — review, edit steps, approve / reject / refine before execution.
- **Plan tracker panel** in the existing agent workspace — live step DAG with status, reusing the workspace shell that today hosts `PlanModeTasksSheet`.
- Refinement controls (optimize / simplify / expand / reorder / repair) on both.

## Consequences

- The built-in agent's Plan mode becomes a real, owned closure: structured plan → approve/edit/refine → tracked execution → replan — not an SDK black box.
- The chat agent can orchestrate directly: a delegation step reuses `dispatchTeammate` with no workflow-editor detour.
- One IR unifies Plan / Goal / Team; the three duplicate decompose-and-drive loops collapse onto one execution + tracking + persistence pipeline.
- The execution engine is the existing workflow orchestrator (idempotency, crash recovery, concurrency, event log) — no second engine to maintain.
- `types/agent/agent.ts` goes from dead code to a live, central model (renamed `types/agent/plan.ts`).
- Cost: a new Dexie version, a new node type, new sidecar tool defs, and surface area across chat + workspace UI. Mitigated by phasing (below) with green gates each phase.

## Alternatives considered

- **Keep the SDK passthrough, only improve UI** (rejected by the design discussion) — leaves the three mechanisms disconnected and the structured model dead; violates the "no simplification" mandate.
- **A bespoke plan executor** instead of compiling to `VisualWorkflow` — duplicates the orchestrator's idempotency/recovery/concurrency; rejected for reuse.
- **Always in-session** or **always orchestrated** — each loses half the value (parallel fan-out, or the native conversational plan-mode feel); the hybrid-adaptive default keeps both.

## Phasing

See `docs/plans/2026-06-03-unified-plan-execution-hub.md`. Each phase ships green (`pnpm typecheck`, `pnpm test:coverage` ≥90%, `pnpm lint:i18n`, `pnpm sidecar:test` where touched):

- **P1 — Model + persistence**: rewrite `types/agent/plan.ts`, delete `types/agent/agent.ts`, Dexie **v71** + `lib/db/plans.ts` CRUD (active-plan-per-session invariant, capped event log), plan runtime lifecycle skeleton (create / approve / reject / pause / resume / cancel + AbortController registry), `appendPlanContext` + `session.activePlan` wiring.
- **P2 — Execution engine**: `synthesizePlanWorkflow`, the `action.plan.step.dispatch` node + per-kind routing, the in-session driver, hybrid-adaptive mode selection, PII gate.
- **P3 — Chat → orchestration**: `teammate_dispatch` wired to `dispatchTeammate`; ExitPlanMode capture; explicit `CreatePlan`/`UpdatePlan` tool defs + renderer dispatch.
- **P4 — Goal / Team projection**: `projections.ts` both directions; route Goal subgoals and Team tasks through the plan pipeline.
- **P5 — Planner + replan + UI**: `decomposeIntoPlan`; all three refinement triggers; approval card, tracker panel, refinement controls; notifications.
