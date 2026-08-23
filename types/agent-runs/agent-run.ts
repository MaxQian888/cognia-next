/**
 * Legacy adapters for the two run sources that predate the execution journal.
 *
 * This was once a rival view model for `/agent-runs`, with a four-member kind
 * union (`goal | team | plan | scheduled-task`) and a canonical mapper that
 * returned `null` for `agent-turn`, `workflow` and `delegation` — so the panel
 * built on it structurally could not show most of what actually runs. The
 * cockpit reads `UnifiedExecutionRow` (`lib/execution/monitor-model.ts`) now.
 *
 * What survives is the part that still has a job: `chatGoals` and `agentPlans`
 * rows written before `agent-state-bridge.ts` existed have no journal history
 * and must not be given a forged one (`appendInsideTransaction` refuses events
 * on a terminal run by design), so they are READ through these mappers and
 * projected by `lib/execution/cockpit-model.ts`.
 *
 * Everything that existed only to serve the old panel went with it: the team,
 * scheduler and execution-run mappers, their status helpers, and the
 * `__team__:` id parser — whose "single source of truth" claim was untrue while
 * it stood here, since the producers never imported it. That format now has a
 * real owner next to its producers: `lib/ai/agent/team/team-workflow-id.ts`.
 *
 * Pure module — no React / Dexie imports — so the mappers stay unit-testable.
 */

import type { Goal, GoalStatus } from "@/types/goal"
import type { AgentPlan, PlanStatus } from "@/types/agent/plan"

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
  executionRunId?: string
}

export interface AgentRun {
  /** `${kind}:${nativeId}` — stable across renders. */
  unifiedId: string
  kind: AgentRunKind
  title: string
  status: AgentRunStatus
  startedAt: number
  finishedAt?: number
  /** 0..1 completion ratio when derivable (plan steps); else undefined. */
  progress?: number
  tokensUsed?: number
  /** Non-terminal (running / paused). */
  isLive: boolean
  origin: AgentRunOrigin
  result?: unknown
  error?: { message: string; code?: string }
}

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set(["succeeded", "failed", "cancelled"])

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function makeAgentRunId(kind: AgentRunKind, nativeId: string): string {
  return `${kind}:${nativeId}`
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

// ── Source mappers ───────────────────────────────────────────────────────────

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
