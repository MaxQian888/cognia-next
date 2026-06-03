/**
 * Pure helpers for turning `CreatePlanStepInput[]` (index-based deps) into
 * persisted `PlanStep[]` (id-based deps), and for keeping the denormalised
 * plan counts / current-step cursor in sync. Kept separate from the runtime
 * so they're unit-testable without Dexie. (ADR-0045)
 */

import type { AgentPlan, CreatePlanStepInput, PlanStep, PlanStepStatus } from "@/types/agent/plan"
import { computePlanCounts } from "@/types/agent/plan"

/**
 * Materialise creation inputs into full steps: assign stable ids, resolve
 * `dependsOn` index references into dependency ids (dropping self-refs and
 * out-of-range indices), and stamp the initial `pending` status + 0-based
 * `order`. Cycle validation is deferred to `synthesizePlanWorkflow` (Kahn),
 * which is the single source of truth for DAG legality.
 */
export function materializeSteps(inputs: CreatePlanStepInput[]): PlanStep[] {
  const ids = inputs.map(() => crypto.randomUUID())
  return inputs.map((input, i) => {
    const dependencies = (input.dependsOn ?? [])
      .filter((d) => Number.isInteger(d) && d >= 0 && d < ids.length && d !== i)
      .map((d) => ids[d])
    const step: PlanStep = {
      id: ids[i],
      title: input.title,
      description: input.description,
      kind: input.kind,
      status: "pending",
      order: i,
      dependencies,
      params: input.params,
      attempts: 0,
      estimatedDurationMs: input.estimatedDurationMs,
    }
    return step
  })
}

/**
 * Apply a status (and optional field patch) to one step, returning a new step
 * array plus the recomputed plan counts and current-step cursor. The cursor
 * points at the first `in_progress` step, else the first non-terminal step in
 * `order`, else undefined when everything is terminal.
 */
export function applyStepStatus(
  steps: PlanStep[],
  stepId: string,
  status: PlanStepStatus,
  patch: Partial<Omit<PlanStep, "id" | "status">> = {}
): { steps: PlanStep[]; totalSteps: number; completedSteps: number; currentStepId?: string } {
  const next = steps.map((s) => (s.id === stepId ? { ...s, ...patch, status } : s))
  const counts = computePlanCounts(next)
  const ordered = [...next].sort((a, b) => a.order - b.order)
  const inProgress = ordered.find((s) => s.status === "in_progress")
  const nextOpen = ordered.find(
    (s) => s.status !== "completed" && s.status !== "failed" && s.status !== "skipped"
  )
  return {
    steps: next,
    totalSteps: counts.totalSteps,
    completedSteps: counts.completedSteps,
    currentStepId: (inProgress ?? nextOpen)?.id,
  }
}

/**
 * True when every step has reached a terminal status. Used by the driver /
 * orchestrator to decide whether the plan as a whole is done.
 */
export function allStepsTerminal(plan: Pick<AgentPlan, "steps">): boolean {
  return plan.steps.every(
    (s) => s.status === "completed" || s.status === "failed" || s.status === "skipped"
  )
}
