/**
 * PII red-line for plan text (ADR-0045).
 *
 * Any plan that reaches an LLM — the planner decomposition call, a refinement
 * call, or the system-section injection — must first clear this gate, exactly
 * as `lib/goal/redact-objective.ts` gates goal objectives and
 * `lib/connectors/ai-loop/safe-send-prompt.ts` gates auto-mode sends. The
 * shared detector is `packages/redact/src/index.ts:hasNoLeakingPii(Deep)`.
 *
 * The gate is a *check*, not a redactor: plans are the agent's own structured
 * output, so a leak is a signal to surface (and let the caller redact at the
 * source) rather than to silently rewrite mid-pipeline.
 *
 * One function, deliberately: every call site wants the LOCATION (to log what
 * tripped) and must fail OPEN on the flow — skip the send, keep the plan. The
 * throwing / boolean wrappers this module used to also export had no call site
 * that wanted either shape, so they were removed rather than left dormant.
 */

import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@cognia/redact"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"

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
