/**
 * Projections between the unified `AgentPlan` IR and the two pre-existing
 * decompose-and-drive models — Agent Team task DAGs and Goal subgoals
 * (ADR-0045 §3, P4). Pure data mappers: they shape types only, so the same
 * execution + tracking + persistence pipeline can run plans that originated
 * as a team or a goal.
 *
 * Forward:
 *   • `planInputFromTeam`  — AgentTeam + tasks → CreatePlanInput
 *     (`teammate_dispatch` steps, orchestrated mode).
 *   • `planInputFromGoal`  — Goal subgoals → CreatePlanInput
 *     (`agent_turn` steps, linear, in-session mode).
 * Reverse:
 *   • `teamTaskInputsFromPlan` — PlanStep[] → team-task-shaped rows, reusing
 *     each step id so the dependency DAG survives the round trip.
 */

import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"
import type { Goal } from "@/types/goal"
import type { AgentPlan, CreatePlanInput, CreatePlanStepInput } from "@/types/agent/plan"
import { linearAgentTurnSteps } from "./steps"

// ─────────────────────────────────────────────────────────────────────────────
// Team → Plan
// ─────────────────────────────────────────────────────────────────────────────

/** Map an ordered team task list into `teammate_dispatch` plan steps. */
export function planStepsFromTeamTasks(tasks: AgentTeamTask[]): CreatePlanStepInput[] {
  const idToIndex = new Map(tasks.map((t, i) => [t.id, i]))
  return tasks.map((t) => {
    const dependsOn = t.dependencies
      .map((d) => idToIndex.get(d))
      .filter((i): i is number => i !== undefined)
    const teammateId = t.assignedTo && t.assignedTo !== "any" ? t.assignedTo : undefined
    const step: CreatePlanStepInput = {
      title: t.title,
      kind: "teammate_dispatch",
      params: { kind: "teammate_dispatch", ...(teammateId ? { teammateId } : {}) },
      ...(t.description ? { description: t.description } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(t.estimatedDuration ? { estimatedDurationMs: t.estimatedDuration } : {}),
    }
    return step
  })
}

/** Project an AgentTeam + its tasks into a `CreatePlanInput`. */
export function planInputFromTeam(
  team: AgentTeam,
  tasks: AgentTeamTask[],
  opts: { sessionId: string }
): CreatePlanInput {
  return {
    sessionId: opts.sessionId,
    title: team.name,
    ...(team.description ? { description: team.description } : {}),
    source: "team_projection",
    executionMode: "orchestrated",
    steps: planStepsFromTeamTasks(tasks),
    metadata: { teamId: team.id },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal → Plan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Project a Goal into a `CreatePlanInput`: its (PII-redacted) subgoals become
 * linear `agent_turn` steps. A goal with no subgoals yields a single
 * agent_turn step from the objective itself. Always uses `goal.safeObjective`
 * / `subgoal.text`, which are already redacted, so no PII reaches the plan.
 */
export function planInputFromGoal(goal: Goal, opts: { sessionId?: string } = {}): CreatePlanInput {
  const subgoals = (goal.subgoals ?? []).slice().sort((a, b) => a.order - b.order)
  const titles = subgoals.length > 0 ? subgoals.map((s) => s.text) : [goal.safeObjective]
  const steps: CreatePlanStepInput[] = linearAgentTurnSteps(titles)
  return {
    sessionId: opts.sessionId ?? goal.sessionId,
    ...(goal.characterId ? { characterId: goal.characterId } : {}),
    title: goal.safeObjective.slice(0, 120) || "Goal",
    source: "goal_projection",
    executionMode: "in_session",
    steps,
    metadata: { goalId: goal.id },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan → Team tasks (reverse / round-trip)
// ─────────────────────────────────────────────────────────────────────────────

/** A team-task-shaped row derived from a plan step (ids preserved). */
export interface ProjectedTeamTaskInput {
  id: string
  title: string
  description: string
  dependencies: string[]
  expectedOutput?: string
}

/**
 * Project a plan's steps back into team-task inputs, reusing each step id so
 * the dependency DAG is preserved exactly. The inverse of
 * `planStepsFromTeamTasks` for round-trip fidelity (modulo the index↔id
 * remap, which is lossless because step ids are stable).
 */
export function teamTaskInputsFromPlan(plan: Pick<AgentPlan, "steps">): ProjectedTeamTaskInput[] {
  return plan.steps.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description ?? "",
    dependencies: [...s.dependencies],
  }))
}
