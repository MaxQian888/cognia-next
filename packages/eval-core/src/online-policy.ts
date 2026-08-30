/**
 * A policy that scores production traces as they finish.
 *
 * Two rules the shape enforces rather than documents:
 *
 *  1. Deterministic evaluators run on EVERY matched trace; only LLM judges are
 *     sampled. Sampling a free check buys nothing and makes the resulting rate
 *     a sample statistic instead of a fact.
 *  2. A judge cannot run without a positive daily USD cap. An unbounded judge
 *     on a production trace stream is an unbounded bill, and "we'll watch it"
 *     is not a control.
 */

export const ONLINE_EVAL_POLICY_SCHEMA = "cognia-online-eval-policy/v1" as const

/**
 * Matched against cheap span fields only. Nothing here reads message bodies:
 * selection happens on the trace-completion path, and reading content there
 * would put PII handling and real work on a hot path that must stay trivial.
 */
export interface OnlineEvalPolicySelector {
  workspaceId?: string
  projectId?: string
  /** `AgentTraceSpan.surface` values. */
  surfaces?: string[]
  models?: string[]
  operations?: string[]
  tags?: string[]
}

export interface OnlineEvalPolicySampling {
  /** Fraction of matched traces sent to a judge, in [0,1]. */
  judgeRate: number
  /** Hard per-day ceiling on judged traces, independent of the rate. */
  judgeDailyMax: number
}

export interface OnlineEvalPolicyBudget {
  /** Required, positive, and set by a human before any judge may run. */
  dailyUsdCap: number
}

export interface OnlineEvalPolicyEscalation {
  /** Score within ±band of a threshold is too close to call — send it to review. */
  thresholdBand: number
  onEvaluatorConflict: boolean
  onJudgeParseFailure: boolean
  onNegativeFeedback: boolean
}

export interface OnlineEvalPolicyV1 {
  schema: typeof ONLINE_EVAL_POLICY_SCHEMA
  id: string
  /** Immutable; editing a policy mints a new version so scores stay attributable. */
  versionId: string
  name: string
  enabled: boolean
  /**
   * Observe without consequence: evaluate and record, never escalate or
   * promote. The honest way to try a policy on real traffic.
   */
  shadow: boolean
  selector: OnlineEvalPolicySelector
  deterministicEvaluatorVersionIds: string[]
  judgeEvaluatorVersionIds: string[]
  sampling: OnlineEvalPolicySampling
  budget: OnlineEvalPolicyBudget
  escalation: OnlineEvalPolicyEscalation
  createdAt: number
  updatedAt: number
}

/** The cheap facts a finished trace offers the selector. */
export interface OnlineEvalCandidate {
  traceId: string
  workspaceId?: string
  projectId?: string
  surface?: string
  model?: string
  operation?: string
  tags?: string[]
  /** Error traces and negative feedback get priority for the judge sample. */
  priority?: boolean
}

function matchesList(allowed: readonly string[] | undefined, value: string | undefined): boolean {
  if (!allowed || allowed.length === 0) return true
  return value !== undefined && allowed.includes(value)
}

export function matchesOnlineEvalPolicy(
  policy: OnlineEvalPolicyV1,
  candidate: OnlineEvalCandidate
): boolean {
  if (!policy.enabled) return false
  const { selector } = policy
  if (selector.workspaceId && selector.workspaceId !== candidate.workspaceId) return false
  if (selector.projectId && selector.projectId !== candidate.projectId) return false
  if (!matchesList(selector.surfaces, candidate.surface)) return false
  if (!matchesList(selector.models, candidate.model)) return false
  if (!matchesList(selector.operations, candidate.operation)) return false
  if (selector.tags && selector.tags.length > 0) {
    const tags = candidate.tags ?? []
    if (!selector.tags.some((tag) => tags.includes(tag))) return false
  }
  return true
}

/**
 * FNV-1a over the trace id. Sampling has to be deterministic: re-deciding a
 * trace on retry would double-charge it, and `Math.random()` makes a queue
 * that cannot be replayed.
 */
export function sampleFraction(traceId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < traceId.length; index++) {
    hash ^= traceId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x100000000
}

export type JudgeSamplingDecision =
  "run" | "skipped-not-sampled" | "skipped-budget" | "skipped-daily-max" | "skipped-no-judge"

export interface JudgeSamplingInput {
  policy: OnlineEvalPolicyV1
  candidate: OnlineEvalCandidate
  /** USD already spent by this policy today. */
  spentUsdToday: number
  /** Traces this policy has judged today. */
  judgedToday: number
  /** Worst-case USD for this judge call; compared against the remaining cap. */
  estimatedUsd: number
}

/**
 * Never returns a bare boolean: "skipped" has four different meanings and
 * collapsing them is how a policy goes quiet without anyone noticing which
 * control silenced it. Budget exhaustion in particular must be recorded, not
 * dropped — deterministic evaluators keep running either way.
 */
export function decideJudgeSampling(input: JudgeSamplingInput): JudgeSamplingDecision {
  const { policy, candidate, spentUsdToday, judgedToday, estimatedUsd } = input
  if (policy.judgeEvaluatorVersionIds.length === 0) return "skipped-no-judge"
  if (judgedToday >= policy.sampling.judgeDailyMax) return "skipped-daily-max"
  if (spentUsdToday + estimatedUsd > policy.budget.dailyUsdCap) return "skipped-budget"
  // Priority traces (errors, negative feedback) bypass the rate but never the
  // budget or the daily ceiling.
  if (candidate.priority) return "run"
  return sampleFraction(candidate.traceId) < policy.sampling.judgeRate
    ? "run"
    : "skipped-not-sampled"
}

/** Structural problems, as messages. Empty means the policy may be enabled. */
export function validateOnlineEvalPolicy(policy: OnlineEvalPolicyV1): string[] {
  const problems: string[] = []
  if (policy.schema !== ONLINE_EVAL_POLICY_SCHEMA) problems.push(`unknown schema`)
  if (!policy.name.trim()) problems.push("name is required")
  if (!policy.versionId.trim()) problems.push("versionId is required")
  const { judgeRate, judgeDailyMax } = policy.sampling
  if (!(judgeRate >= 0 && judgeRate <= 1)) problems.push("sampling.judgeRate must be within [0,1]")
  if (!Number.isInteger(judgeDailyMax) || judgeDailyMax < 0) {
    problems.push("sampling.judgeDailyMax must be a non-negative integer")
  }
  if (policy.judgeEvaluatorVersionIds.length > 0 && !(policy.budget.dailyUsdCap > 0)) {
    // The one rule worth failing a save over: a judge with no cap is an
    // unbounded spend against a production trace stream.
    problems.push("a policy with LLM judges needs a positive budget.dailyUsdCap")
  }
  if (
    policy.deterministicEvaluatorVersionIds.length === 0 &&
    policy.judgeEvaluatorVersionIds.length === 0
  ) {
    problems.push("a policy needs at least one evaluator")
  }
  if (!(policy.escalation.thresholdBand >= 0 && policy.escalation.thresholdBand <= 1)) {
    problems.push("escalation.thresholdBand must be within [0,1]")
  }
  return problems
}

export const DEFAULT_ONLINE_EVAL_SAMPLING: OnlineEvalPolicySampling = {
  judgeRate: 0.05,
  judgeDailyMax: 200,
}

export const DEFAULT_ONLINE_EVAL_ESCALATION: OnlineEvalPolicyEscalation = {
  thresholdBand: 0.1,
  onEvaluatorConflict: true,
  onJudgeParseFailure: true,
  onNegativeFeedback: true,
}
