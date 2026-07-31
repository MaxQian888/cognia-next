export interface EvalAdaptiveCandidate {
  variantId: string
  repetitions: number
  constraintMargins: number[]
  rankingInterval: [number, number]
}

export interface EvalAdaptivePlanItem {
  variantId: string
  nextRepetition: 2 | 3
  reason: "constraint_boundary" | "ranking_boundary"
}

function overlaps(left: [number, number], right: [number, number]): boolean {
  return left[0] <= right[1] && right[0] <= left[1]
}

export function selectAdaptiveRepetitions(
  candidates: readonly EvalAdaptiveCandidate[],
  options: { boundaryMargin: number }
): EvalAdaptivePlanItem[] {
  return candidates.flatMap((candidate) => {
    if (candidate.repetitions >= 3) return []
    const nearConstraint = candidate.constraintMargins.some(
      (margin) => Math.abs(margin) <= options.boundaryMargin
    )
    const nearRanking = candidates.some(
      (other) =>
        other.variantId !== candidate.variantId &&
        overlaps(candidate.rankingInterval, other.rankingInterval)
    )
    if (!nearConstraint && !nearRanking) return []
    return [
      {
        variantId: candidate.variantId,
        nextRepetition: (candidate.repetitions + 1) as 2 | 3,
        reason: nearConstraint ? "constraint_boundary" : "ranking_boundary",
      },
    ]
  })
}
