import { paretoFrontier } from "./statistics"
import type {
  EvalCandidateEvidence,
  EvalDecisionConstraint,
  EvalDecisionPolicy,
  EvalRecommendationResult,
} from "./types"

function satisfies(candidate: EvalCandidateEvidence, constraint: EvalDecisionConstraint): boolean {
  const value = candidate.metrics[constraint.metric]
  if (value === undefined) return false
  switch (constraint.operator) {
    case "gte":
      return value >= constraint.value
    case "lte":
      return value <= constraint.value
    case "gt":
      return value > constraint.value
    case "lt":
      return value < constraint.value
  }
}

function utility(candidate: EvalCandidateEvidence, policy: EvalDecisionPolicy): number {
  return policy.dimensions.reduce((sum, dimension) => {
    const value = candidate.metrics[dimension.metric] ?? 0
    const directedValue = dimension.direction === "maximize" ? value : 1 - value
    return sum + directedValue * dimension.weight
  }, 0)
}

function intervalsOverlap(
  left: EvalCandidateEvidence,
  right: EvalCandidateEvidence,
  policy: EvalDecisionPolicy
): boolean {
  const comparable = policy.dimensions.flatMap((dimension) => {
    const a = left.intervals[dimension.metric]
    const b = right.intervals[dimension.metric]
    return a && b ? [{ a, b }] : []
  })
  return comparable.length > 0 && comparable.every(({ a, b }) => a.low <= b.high && b.low <= a.high)
}

export function recommendVariants(
  policy: EvalDecisionPolicy,
  candidates: readonly EvalCandidateEvidence[]
): EvalRecommendationResult {
  const excluded: EvalRecommendationResult["excluded"] = []
  const sufficient = candidates.filter((candidate) => {
    if (candidate.effectiveCases < policy.minimumEffectiveCases) {
      excluded.push({ variantId: candidate.variantId, reason: "insufficient_cases" })
      return false
    }
    if (!candidate.calibrationPassed) {
      excluded.push({ variantId: candidate.variantId, reason: "calibration_failed" })
      return false
    }
    if (!policy.constraints.every((constraint) => satisfies(candidate, constraint))) {
      excluded.push({ variantId: candidate.variantId, reason: "constraint_failed" })
      return false
    }
    return true
  })

  const emptyResult = (reason: EvalRecommendationResult["reason"]): EvalRecommendationResult => ({
    status: "no_conclusion",
    reason,
    paretoVariantIds: [],
    utilityByVariant: {},
    excluded,
  })

  if (!sufficient.length) {
    if (candidates.some((candidate) => candidate.effectiveCases < policy.minimumEffectiveCases)) {
      return emptyResult("insufficient_cases")
    }
    if (candidates.some((candidate) => !candidate.calibrationPassed)) {
      return emptyResult("calibration_failed")
    }
    return emptyResult("no_candidate_satisfies_constraints")
  }

  const frontier = paretoFrontier(
    sufficient.map((candidate) => ({ ...candidate, id: candidate.variantId })),
    policy.dimensions
  )
  for (const candidate of sufficient) {
    if (!frontier.some((item) => item.variantId === candidate.variantId)) {
      excluded.push({ variantId: candidate.variantId, reason: "dominated" })
    }
  }
  const utilityByVariant = Object.fromEntries(
    frontier.map((candidate) => [candidate.variantId, utility(candidate, policy)])
  )
  const ranked = [...frontier].sort(
    (a, b) => utilityByVariant[b.variantId] - utilityByVariant[a.variantId]
  )
  const runnerUp = sufficient
    .filter((candidate) => candidate.variantId !== ranked[0].variantId)
    .sort((a, b) => utility(b, policy) - utility(a, policy))[0]
  if (runnerUp && intervalsOverlap(ranked[0], runnerUp, policy)) {
    return {
      status: "no_conclusion",
      reason: "confidence_overlap",
      paretoVariantIds: frontier.map((candidate) => candidate.variantId),
      utilityByVariant,
      excluded,
    }
  }
  return {
    status: "recommended",
    recommendedVariantId: ranked[0].variantId,
    paretoVariantIds: frontier.map((candidate) => candidate.variantId),
    utilityByVariant,
    excluded,
  }
}
