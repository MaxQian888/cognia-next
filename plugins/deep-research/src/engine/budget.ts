/**
 * Budget-forcing predicates. Pure — drive the loop's stop/force decisions.
 * Philosophy (post-DeepSeek-R1): spend tokens for depth, but never run away;
 * once a hard limit is hit, force a decisive answer ("beast mode").
 */
import type { ResearchState } from "./workspace"

/**
 * True when the loop must stop exploring and produce a final answer from
 * whatever it already has (token budget, step ceiling, or too many failed
 * answer attempts).
 */
export function shouldForceAnswer(state: ResearchState): boolean {
  return (
    state.tokensUsed >= state.config.tokenBudget ||
    state.step >= state.config.maxSteps ||
    state.badAttempts > state.config.maxBadAttempts
  )
}

/** Human-readable reason for entering beast mode, for the step log. */
export function beastReason(state: ResearchState): string {
  if (state.badAttempts > state.config.maxBadAttempts) return "too many failed answer attempts"
  if (state.tokensUsed >= state.config.tokenBudget) return "token budget reached"
  if (state.step >= state.config.maxSteps) return "step limit reached"
  return "forced"
}

/**
 * Whether the model is allowed to pick the `answer` action this step. We block
 * it right after a failed evaluation so the loop is forced to gather more
 * before trying again — but always allow it when there's at least some
 * evidence and we haven't just failed.
 */
export function canAnswer(state: ResearchState): boolean {
  return state.allowAnswer && state.knowledge.length > 0
}
