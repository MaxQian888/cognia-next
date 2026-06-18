/**
 * Unified "Agent Run" view-model (Scheduler Phase D).
 *
 * One normalized shape over the four agent-run sources that otherwise each
 * have their own console: persistent goals (`chatGoals`), agent-team runs
 * (`workflowRuns` whose `workflowId` carries the `__team__:` prefix), unified
 * plans (`agentPlans`), and scheduled agent tasks (scheduler executions of
 * `goal` / `agent-team` / `plan` task types). The `/agent-runs` panel fans all
 * four in through `hooks/agent-runs/use-agent-runs.ts` so a user can see and
 * control every live + historical agent run in one place.
 *
 * Pure module — no React / Dexie imports — so the mappers + comparator are
 * unit-testable in isolation.
 */

import type { Goal, GoalStatus } from "@/types/goal"
import type { AgentPlan, PlanStatus } from "@/types/agent/plan"
import type { TeamStatus } from "@/types/agent/agent-team"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { TaskExecution } from "@/types/scheduler"

export type AgentRunKind = "goal" | "team" | "plan" | "scheduled-task"
export type AgentRunStatus = "running" | "paused" | "succeeded" | "failed" | "cancelled"

export interface AgentRunOrigin {
  /** Source table / store for debugging + the action router. */
  tableName: string
  /** Native row id within that source. */
  nativeId: string
  teamId?: string
  goalId?: string
  planId?: string
}

export interface AgentRun {
  /** `${kind}:${nativeId}` — stable across renders, used for `?run=` deep links. */
  unifiedId: string
  kind: AgentRunKind
  title: string
  status: AgentRunStatus
  startedAt: number
  finishedAt?: number
  /** 0..1 completion ratio when derivable (plan steps); else undefined. */
  progress?: number
  tokensUsed?: number
  /** Non-terminal (running / paused) — drives the abort / pause / resume affordances. */
  isLive: boolean
  origin: AgentRunOrigin
  result?: unknown
  error?: { message: string; code?: string }
}

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set(["succeeded", "failed", "cancelled"])

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

// ── Id helpers ───────────────────────────────────────────────────────────────

export function makeAgentRunId(kind: AgentRunKind, nativeId: string): string {
  return `${kind}:${nativeId}`
}

export function parseAgentRunId(
  unifiedId: string
): { kind: AgentRunKind; nativeId: string } | null {
  const idx = unifiedId.indexOf(":")
  if (idx < 0) return null
  const kind = unifiedId.slice(0, idx) as AgentRunKind
  const nativeId = unifiedId.slice(idx + 1)
  if (!nativeId) return null
  return { kind, nativeId }
}

/** Newest-first comparator. */
export function compareAgentRuns(a: AgentRun, b: AgentRun): number {
  return b.startedAt - a.startedAt
}

// ── Team workflow-id contract (`__team__:<teamId>:<nonce>`) ───────────────────
// Centralized + pinned by a test so a rename of the prefix in
// `lib/ai/agent/team/synthesize-workflow.ts` breaks loudly here.

const TEAM_RUN_PREFIX = "__team__:"

export function isTeamWorkflowId(workflowId: string): boolean {
  return workflowId.startsWith(TEAM_RUN_PREFIX)
}

export function parseTeamWorkflowId(workflowId: string): { teamId: string } | null {
  if (!workflowId.startsWith(TEAM_RUN_PREFIX)) return null
  const rest = workflowId.slice(TEAM_RUN_PREFIX.length)
  const idx = rest.indexOf(":")
  const teamId = idx >= 0 ? rest.slice(0, idx) : rest
  return teamId ? { teamId } : null
}

// ── Status mappers ───────────────────────────────────────────────────────────

export function mapGoalStatus(status: GoalStatus): AgentRunStatus {
  switch (status) {
    case "active":
      return "running"
    case "paused":
      return "paused"
    case "completed":
      return "succeeded"
    case "stopped":
    case "preempted":
      return "cancelled"
    case "budget_limited":
    case "turn_limited":
    case "timed_out":
      return "failed"
    default:
      return "failed"
  }
}

export function mapPlanStatus(status: PlanStatus): AgentRunStatus {
  switch (status) {
    case "draft":
    case "awaiting_approval":
    case "approved":
    case "executing":
      return "running"
    case "paused":
      return "paused"
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    default:
      return "failed"
  }
}

export function mapTeamStatus(status: TeamStatus): AgentRunStatus {
  switch (status) {
    case "planning":
    case "executing":
      return "running"
    case "paused":
      return "paused"
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "idle":
    default:
      return "succeeded"
  }
}

export function mapWorkflowRunStatus(status: WorkflowRunRow["status"]): AgentRunStatus {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "running"
    case "paused":
      return "paused"
    case "succeeded":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    default:
      return "failed"
  }
}

export function mapTaskExecStatus(status: TaskExecution["status"]): AgentRunStatus {
  switch (status) {
    case "pending":
    case "running":
      return "running"
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
    case "skipped":
      return "cancelled"
    default:
      return "failed"
  }
}

// ── Row mappers ──────────────────────────────────────────────────────────────

export function toAgentRunFromGoal(goal: Goal): AgentRun {
  const status = mapGoalStatus(goal.status)
  return {
    unifiedId: makeAgentRunId("goal", goal.id),
    kind: "goal",
    title: goal.safeObjective || "Goal",
    status,
    startedAt: goal.createdAt,
    finishedAt: isTerminalAgentRunStatus(status) ? goal.updatedAt : undefined,
    tokensUsed: goal.tokensUsed,
    isLive: !isTerminalAgentRunStatus(status),
    origin: { tableName: "chatGoals", nativeId: goal.id, goalId: goal.id },
  }
}

export function toAgentRunFromPlan(plan: AgentPlan): AgentRun {
  const status = mapPlanStatus(plan.status)
  const progress =
    plan.totalSteps > 0 ? Math.min(1, plan.completedSteps / plan.totalSteps) : undefined
  return {
    unifiedId: makeAgentRunId("plan", plan.id),
    kind: "plan",
    title: plan.title || "Plan",
    status,
    startedAt: plan.createdAt,
    finishedAt: isTerminalAgentRunStatus(status) ? plan.updatedAt : undefined,
    ...(progress !== undefined ? { progress } : {}),
    isLive: !isTerminalAgentRunStatus(status),
    origin: { tableName: "agentPlans", nativeId: plan.id, planId: plan.id },
  }
}

/**
 * Map a team's `workflowRuns` row. Caller filters to team rows first
 * ({@link isTeamWorkflowId}); `liveTeamStatus`, when supplied from the in-memory
 * store, overrides the persisted run status so an in-flight team shows live.
 */
export function toAgentRunFromTeamRun(row: WorkflowRunRow, liveTeamStatus?: TeamStatus): AgentRun {
  const teamId = parseTeamWorkflowId(row.workflowId)?.teamId
  const status = liveTeamStatus ? mapTeamStatus(liveTeamStatus) : mapWorkflowRunStatus(row.status)
  return {
    unifiedId: makeAgentRunId("team", row.id),
    kind: "team",
    // Prefer the small-model "work content" title generated on completion;
    // fall back to the static workflow/team name.
    title: row.title ?? row.workflowSnapshot?.name ?? teamId ?? "Team run",
    status,
    startedAt: row.startedAt,
    finishedAt: isTerminalAgentRunStatus(status) ? row.completedAt : undefined,
    isLive: !isTerminalAgentRunStatus(status),
    origin: {
      tableName: "workflowRuns",
      nativeId: row.id,
      ...(teamId ? { teamId } : {}),
    },
    result: row.output,
    error: row.error ? { message: row.error.message, code: row.error.code } : undefined,
  }
}

/** Map a scheduler execution of a `goal` / `agent-team` / `plan` task. */
export function toAgentRunFromTaskExecution(exec: TaskExecution): AgentRun {
  const status = mapTaskExecStatus(exec.status)
  return {
    unifiedId: makeAgentRunId("scheduled-task", exec.id),
    kind: "scheduled-task",
    title: exec.taskName || "Scheduled run",
    status,
    startedAt: exec.startedAt.getTime(),
    finishedAt: exec.completedAt ? exec.completedAt.getTime() : undefined,
    isLive: !isTerminalAgentRunStatus(status),
    origin: { tableName: "schedulerDb.executions", nativeId: exec.id },
    result: exec.output,
    error: exec.error ? { message: exec.error } : undefined,
  }
}
