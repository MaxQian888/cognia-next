/**
 * Unified Plan Execution Hub — type model. (ADR-0045)
 *
 * `AgentPlan` is the canonical intermediate representation (IR) for every
 * multi-step agentic execution in the app. A plan is a DAG of typed
 * `PlanStep`s; approving one runs it under the hybrid-adaptive engine in
 * `lib/agent/plan/runtime.ts` (in-session driver for linear `agent_turn`
 * plans, or compiled to a `VisualWorkflow` via `synthesize-workflow.ts` for
 * anything with delegation / parallelism).
 *
 * Two Dexie tables back the subsystem (see `lib/db/schema.ts` v71):
 *
 *   • `agentPlans`       — one row per plan; session-scoped (at most one
 *                          "open" plan — draft/awaiting_approval/approved/
 *                          executing/paused — per session at a time).
 *   • `agentPlanEvents`  — append-only lifecycle log; drives the tracker
 *                          panel + audit trail.
 *
 * Conventions deliberately mirror `types/goal.ts` (the closest sibling whose
 * runtime / db / prompt patterns this subsystem reuses): `number` epoch-ms
 * timestamps, a `string` `generationId` race guard, a discriminated-union
 * event payload, and a `isTerminal*` helper.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Step kind + params (kind-tagged union)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a single step executes. The `action.plan.step.dispatch` node executor
 * (`lib/workflow/nodes/built-ins.ts`) and the in-session driver both route on
 * this discriminator.
 *
 *   agent_turn        → an in-session turn by the main agent (visible, conversational)
 *   teammate_dispatch → delegate to a teammate / subagent — reuses `dispatchTeammate`
 *   tool_call         → a specific plugin-registered tool invocation with fixed input
 *   mcp_tool_call     → a single MCP server tool invocation — reuses `lib/mcp/invoke`
 *   sub_workflow      → run a nested VisualWorkflow — reuses `runWorkflow`
 *   approval_gate     → human approval checkpoint — reuses `lib/runtime/approval-bus`
 */
export type PlanStepKind =
  | "agent_turn"
  | "teammate_dispatch"
  | "tool_call"
  | "mcp_tool_call"
  | "sub_workflow"
  | "approval_gate"

/** Per-kind execution parameters. Discriminated by `PlanStep.kind`. */
export type PlanStepParams =
  | { kind: "agent_turn"; prompt?: string }
  | { kind: "teammate_dispatch"; teamId?: string; teammateId?: string; spawnPrompt?: string }
  | { kind: "tool_call"; toolName: string; input: Record<string, unknown> }
  | { kind: "mcp_tool_call"; serverId: string; toolName: string; input?: Record<string, unknown> }
  | { kind: "sub_workflow"; workflowId: string; triggerPayload?: unknown }
  | { kind: "approval_gate"; prompt?: string }

// ─────────────────────────────────────────────────────────────────────────────
// PlanStep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step lifecycle.
 *
 *   pending     → not yet schedulable (deps unmet)
 *   ready       → deps satisfied, awaiting a slot
 *   in_progress → executing
 *   completed   → done (terminal)
 *   failed      → exhausted retries (terminal)
 *   skipped     → bypassed by a refinement / branch (terminal)
 *   blocked     → an upstream dep failed and error policy is "stop"
 */
export type PlanStepStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped"
  | "blocked"

export interface PlanStep {
  /** UUIDv4, stable across edits and re-renders. */
  id: string
  title: string
  description?: string
  kind: PlanStepKind
  status: PlanStepStatus
  /** Ascending display/order index (0-based). DAG order comes from `dependencies`. */
  order: number
  /** Step ids that must reach a terminal-success status before this is `ready`. */
  dependencies: string[]
  /** Kind-specific execution params. Absent for a bare `agent_turn` derived from title/description. */
  params?: PlanStepParams
  /** Short human-readable result summary (mirrors AgentTeamTask.result). */
  result?: string
  /** Raw structured output, if the executor produced one. */
  output?: unknown
  error?: string
  /** Number of execution attempts so far (retry accounting). */
  attempts?: number
  /** Tool-call ids associated with this step (chat-render cross-link). */
  toolCallIds?: string[]
  startedAt?: number
  completedAt?: number
  estimatedDurationMs?: number
  actualDurationMs?: number
}

/** True when a step status can no longer transition. */
export function isTerminalStepStatus(status: PlanStepStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped"
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentPlan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a plan came from. Drives provenance display and decides which author
 * pipeline produced it (ADR-0045 §3).
 */
export type PlanSource =
  | "exit_plan_mode" // captured from the SDK plan-mode ExitPlanMode tool_use
  | "agent_tool" // the agent called CreatePlan / UpdatePlan
  | "planner_llm" // decomposed from a one-line objective
  | "team_projection" // projected from an AgentTeam task DAG
  | "goal_projection" // projected from Goal subgoals
  | "manual" // authored by the user in the plan panel

/**
 * Execution strategy. `auto` = hybrid-adaptive: the runtime picks in-session
 * vs orchestrated from the plan's shape (ADR-0045 §2).
 */
export type PlanExecutionMode = "in_session" | "orchestrated" | "auto"

/**
 * Plan status state machine. `draft`/`awaiting_approval`/`approved` are
 * pre-execution; `executing`/`paused` are live; the rest are terminal.
 */
export type PlanStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"

/** Statuses that count as "open" for the one-open-plan-per-session invariant. */
export const OPEN_PLAN_STATUSES: readonly PlanStatus[] = [
  "draft",
  "awaiting_approval",
  "approved",
  "executing",
  "paused",
]

/** True when a plan status is terminal (cannot transition out). */
export function isTerminalPlanStatus(status: PlanStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

/** Per-plan knobs. Defaults come from `DEFAULT_PLAN_CONFIG`. */
export interface PlanConfig {
  /** Gate execution behind explicit approval (draft → awaiting_approval). Default true. */
  requireApproval: boolean
  /** Cap on automatic (step-failure / judge-deviation) refinements. Default 2. */
  maxAutoRefinements: number
  /** Per-step retry budget before the step fails. Default 1. */
  maxStepRetries: number
  /** Run a between-steps judge that triggers a refinement on drift. Default false. */
  judgeDeviation: boolean
  /** Hard cap on cumulative tokens billed against the plan. Undefined → no cap. */
  maxTokens?: number
  /** Error policy forwarded to the synthesized workflow. Default "stop". */
  errorPolicy?: "stop" | "continue"
  /** Max parallel steps when orchestrated. Default 1 (sequential). */
  maxConcurrency?: number
}

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  requireApproval: true,
  maxAutoRefinements: 2,
  maxStepRetries: 1,
  judgeDeviation: false,
  errorPolicy: "stop",
  maxConcurrency: 1,
}

export interface AgentPlan {
  /** UUIDv4. Globally unique; safe as a Dexie primary key. */
  id: string
  /** FK → ChatSession.id. Session-scoped: at most one "open" plan per session. */
  sessionId: string
  /** Snapshot of the character at creation time (UI avatar; survives character switch). */
  characterId?: string
  title: string
  description?: string
  source: PlanSource
  executionMode: PlanExecutionMode
  steps: PlanStep[]
  status: PlanStatus
  /** Id of the step currently executing (in-session driver / orchestrator cursor). */
  currentStepId?: string
  /** Denormalised counts for cheap progress rendering. Kept in sync by the writer. */
  totalSteps: number
  completedSteps: number
  config: PlanConfig
  /** Count of refinements applied so far (capped by `config.maxAutoRefinements`). */
  refinementCount: number
  /**
   * Race guard. Every status mutation rotates this (UUIDv4). The driver /
   * orchestrator captures it before scheduling and refuses to advance if it
   * changed (pause / cancel / refine mid-step → bumped → stale result dropped).
   */
  generationId: string
  createdAt: number
  updatedAt: number
  /** Set when status becomes terminal. Drives history sorting. */
  endedAt?: number
  metadata?: Record<string, unknown>
}

/** Recompute the denormalised counts from a step array. */
export function computePlanCounts(steps: PlanStep[]): {
  totalSteps: number
  completedSteps: number
} {
  return {
    totalSteps: steps.length,
    completedSteps: steps.filter((s) => s.status === "completed").length,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / update inputs
// ─────────────────────────────────────────────────────────────────────────────

/** Step shape accepted at creation; status/order/id are assigned by the runtime. */
export interface CreatePlanStepInput {
  title: string
  description?: string
  kind: PlanStepKind
  /** Indices into the input array (0-based) of prerequisite steps. Resolved to ids. */
  dependsOn?: number[]
  params?: PlanStepParams
  estimatedDurationMs?: number
}

export interface CreatePlanInput {
  sessionId: string
  characterId?: string
  title: string
  description?: string
  source: PlanSource
  executionMode?: PlanExecutionMode
  steps: CreatePlanStepInput[]
  config?: Partial<PlanConfig>
  metadata?: Record<string, unknown>
}

export interface UpdatePlanInput {
  title?: string
  description?: string
  steps?: PlanStep[]
  executionMode?: PlanExecutionMode
  config?: Partial<PlanConfig>
  metadata?: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────────────────────────
// Refinement (replan)
// ─────────────────────────────────────────────────────────────────────────────

export type PlanRefinementType = "optimize" | "simplify" | "expand" | "reorder" | "repair"

export type PlanRefinementTrigger = "manual" | "step_failure" | "judge_deviation"

export interface PlanRefinementRequest {
  planId: string
  refinementType: PlanRefinementType
  trigger: PlanRefinementTrigger
  /** The step that failed, when `trigger === "step_failure"`. */
  failedStepId?: string
  customInstructions?: string
}

export interface PlanRefinementResult {
  originalPlan: AgentPlan
  refinedPlan: AgentPlan
  /** Human-readable change list for the audit trail. */
  changes: string[]
  reasoning: string
}

/**
 * Prompt fragments the planner LLM uses per refinement type. Ported from the
 * formerly-dead `types/agent/agent.ts:PLAN_REFINEMENT_PROMPTS` with `repair`
 * added for the step-failure auto-replan loop.
 */
export const PLAN_REFINEMENT_PROMPTS: Record<PlanRefinementType, string> = {
  optimize: `Analyze the given plan and optimize it for efficiency. Combine redundant steps, parallelize independent tasks where possible, and ensure the most efficient execution order. Maintain the original goals while reducing complexity.`,

  simplify: `Simplify the given plan by breaking down complex steps into smaller, more manageable tasks. Remove unnecessary complexity while ensuring all original objectives are still achievable.`,

  expand: `Expand the given plan with more detailed steps. Add intermediate checkpoints, validation steps, and error handling considerations. Make the plan more comprehensive and robust.`,

  reorder: `Analyze the dependencies between steps and reorder them for optimal execution. Ensure prerequisites are completed before dependent steps, and group related tasks together.`,

  repair: `A step in this plan failed. Analyze the failure and revise the plan to route around it: add recovery steps, split the failed step into smaller ones, or adjust dependencies so the objective is still reached. Preserve completed steps unchanged.`,
}

// ─────────────────────────────────────────────────────────────────────────────
// PlanEvent — append-only lifecycle log
// ─────────────────────────────────────────────────────────────────────────────

export type PlanEventKind =
  | "plan_created"
  | "plan_updated"
  | "approved"
  | "rejected"
  | "refined"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "replanned"
  | "paused"
  | "resumed"
  | "cancelled"
  | "exit"

/**
 * Per-kind payloads (discriminated union via `kind`). Lets the tracker panel
 * render kind-specific cards without runtime checks beyond the discriminator.
 */
export type PlanEventPayload =
  | {
      kind: "plan_created"
      source: PlanSource
      totalSteps: number
      executionMode: PlanExecutionMode
    }
  | { kind: "plan_updated"; totalSteps: number }
  | { kind: "approved" }
  | { kind: "rejected"; feedback?: string }
  | {
      kind: "refined"
      refinementType: PlanRefinementType
      trigger: PlanRefinementTrigger
      changes: string[]
    }
  | { kind: "step_started"; stepId: string; title: string; stepKind: PlanStepKind }
  | { kind: "step_completed"; stepId: string; title: string; tokensDelta?: number }
  | { kind: "step_failed"; stepId: string; title: string; error: string; attempt: number }
  | { kind: "replanned"; reason: PlanRefinementTrigger; failedStepId?: string }
  | { kind: "paused" }
  | { kind: "resumed" }
  | { kind: "cancelled" }
  | { kind: "exit"; status: PlanStatus; reason: string }

export interface PlanEvent {
  /** UUIDv4 primary key. */
  id: string
  /** FK → AgentPlan.id. Cascade-delete handled at the CRUD layer. */
  planId: string
  kind: PlanEventKind
  ts: number
  payload: PlanEventPayload
}
