/**
 * PII red-line for plan text (ADR-0045).
 *
 * Any plan that reaches an LLM — the planner decomposition call, a refinement
 * call, or the system-section injection — must first clear this gate, exactly
 * as `lib/goal/redact-objective.ts` gates goal objectives and
 * `lib/connectors/ai-loop/safe-send-prompt.ts` gates auto-mode sends. The
 * shared detector is `lib/twin/ingest/redact.ts:hasNoLeakingPii(Deep)`.
 *
 * The gate is a *check*, not a redactor: plans are the agent's own structured
 * output, so a leak is a signal to surface (and let the caller redact at the
 * source) rather than to silently rewrite mid-pipeline.
 */

import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@/lib/twin/ingest/redact"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"

/** Raised when plan text carries recognised PII. */
export class PlanPiiLeak extends Error {
  constructor(public readonly where: string) {
    super(`plan text carries PII at: ${where}`)
    this.name = "PlanPiiLeak"
  }
}

/** All the user-facing string fields of a step that could leak. */
function stepStrings(step: PlanStep): string[] {
  const out = [step.title]
  if (step.description) out.push(step.description)
  if (step.result) out.push(step.result)
  return out
}

/**
 * Returns the first leaking location (`"title"`, `"step:<id>:title"`,
 * `"step:<id>:params"`, …) or `null` when the plan is clean. `params` are
 * scanned deeply because a `tool_call` step can smuggle PII through arbitrary
 * input values.
 */
export function findPlanPiiLeak(plan: AgentPlan): string | null {
  if (!hasNoLeakingPii(plan.title)) return "title"
  if (plan.description && !hasNoLeakingPii(plan.description)) return "description"
  for (const step of plan.steps) {
    for (const [i, text] of stepStrings(step).entries()) {
      if (!hasNoLeakingPii(text)) return `step:${step.id}:${i === 0 ? "title" : "text"}`
    }
    if (step.params && !hasNoLeakingPiiDeep(step.params)) return `step:${step.id}:params`
  }
  return null
}

/** True when no recognised PII survives anywhere in the plan. */
export function isPlanPiiSafe(plan: AgentPlan): boolean {
  return findPlanPiiLeak(plan) === null
}

/** Throws {@link PlanPiiLeak} when the plan carries PII; no-op otherwise. */
export function assertPlanPiiSafe(plan: AgentPlan): void {
  const where = findPlanPiiLeak(plan)
  if (where) throw new PlanPiiLeak(where)
}
