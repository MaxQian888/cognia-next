/**
 * Per-run shared state consulted by the `action.plan.step.dispatch` executor.
 * (ADR-0045 P2)
 *
 * Lifecycle mirrors `lib/ai/agent/team/team-run-context.ts`: `runPlan`
 * `register`s before calling `runWorkflow` and `unregister`s in a `finally`.
 * The executor reads `getPlanRunContext(ctx.runId)`; if missing (a stale run),
 * it throws nonRetryable.
 *
 * The context carries a snapshot of the plan (so the executor can read each
 * step's kind / params without a DB round-trip) plus a minimal `writer` seam
 * the executor uses to mark steps in_progress / completed / failed. Keeping
 * the writer abstract decouples the executor from the Dexie-backed runtime so
 * tests can pass a plain object.
 */

import type { AgentPlan, PlanStep, PlanStepStatus } from "@/types/agent/plan"

/** Minimal step-status write surface the dispatch executor needs. */
export interface PlanRunStepWriter {
  setStepStatus(
    stepId: string,
    status: PlanStepStatus,
    patch?: Partial<Omit<PlanStep, "id" | "status">>
  ): Promise<void>
}

export interface PlanRunContext {
  readonly runId: string
  readonly planId: string
  /** Snapshot of the plan at run start. */
  readonly plan: AgentPlan
  /** Character the plan's `agent_turn` steps run as (session character). */
  readonly characterId?: string
  readonly writer: PlanRunStepWriter
}

const registry = new Map<string, PlanRunContext>()

export function registerPlanRunContext(ctx: PlanRunContext): void {
  registry.set(ctx.runId, ctx)
}

export function getPlanRunContext(runId: string): PlanRunContext | undefined {
  return registry.get(runId)
}

export function unregisterPlanRunContext(runId: string): void {
  registry.delete(runId)
}

/** Look up a step in a run's plan snapshot by id. */
export function getRunStep(ctx: PlanRunContext, stepId: string): PlanStep | undefined {
  return ctx.plan.steps.find((s) => s.id === stepId)
}

/** Test-only escape hatch. Production code must not call this. */
export function __resetPlanRunContextForTesting(): void {
  registry.clear()
}
