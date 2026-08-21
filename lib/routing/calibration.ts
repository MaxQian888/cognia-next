import type { AgentTraceSpan } from "@/types/agent-trace/span"

export interface RoutingCalibrationResult {
  status: "insufficient-total" | "insufficient-tier" | "ready"
  sampleSize: number
  perTier: { fast: number; balanced: number; powerful: number }
  shadowDiffRate: number
  confidence: number
  recommendedThresholds?: { balanced: number; powerful: number }
  /**
   * How the difficulty judge actually behaved on this workload.
   *
   * The point of a second-opinion layer is that it is worth its cost, and that
   * is an empirical question. `consulted` over the sample says how often the
   * ambiguity band was hit; `overrodeRate` over `consulted` says how often
   * asking changed the answer. A band that is never hit is dead weight; a judge
   * that never overrides is paying for agreement.
   */
  judge: {
    consulted: number
    agreed: number
    overrode: number
    unavailable: number
    /** Share of consulted decisions the judge moved. Zero when never consulted. */
    overrodeRate: number
    /** Mean round trip in ms across consulted decisions, when any reported one. */
    meanLatencyMs?: number
  }
}

const MIN_TOTAL_SAMPLES = 50
const MIN_TIER_SAMPLES = 10

function boundedScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined
}

function quantile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[index]
}

/**
 * Build an opt-in workload calibration recommendation from bounded local
 * routing trace features. It never reads prompt content and never mutates
 * settings; callers must explicitly apply the returned thresholds.
 */
export function analyzeRoutingCalibration(
  spans: readonly AgentTraceSpan[],
  currentThresholds: { balanced: number; powerful: number }
): RoutingCalibrationResult {
  const decisions = new Map<string, number>()
  const shadowDiffs = new Set<string>()
  const judge = { consulted: 0, agreed: 0, overrode: 0, unavailable: 0 }
  const judgeLatencies: number[] = []
  for (const span of spans) {
    for (const event of span.events ?? []) {
      const decisionId =
        typeof event.attributes?.decisionId === "string" ? event.attributes.decisionId : undefined
      if (!decisionId) continue
      if (event.name === "routing.plan") {
        const score = boundedScore(event.attributes?.difficultyScore)
        if (score !== undefined) decisions.set(decisionId, score)
        if (event.attributes?.judgeUsed === true) {
          judge.consulted += 1
          const judgeTier = event.attributes.judgeTier
          const deterministicTier = event.attributes.deterministicTier
          if (typeof judgeTier !== "string") judge.unavailable += 1
          else if (judgeTier === deterministicTier) judge.agreed += 1
          else judge.overrode += 1
          const latency = event.attributes.judgeLatencyMs
          if (typeof latency === "number" && Number.isFinite(latency) && latency >= 0) {
            judgeLatencies.push(latency)
          }
        }
      } else if (event.name === "routing.shadow_diff") {
        shadowDiffs.add(decisionId)
      }
    }
  }

  const scores = [...decisions.values()].sort((left, right) => left - right)
  const perTier = scores.reduce(
    (counts, score) => {
      if (score < currentThresholds.balanced) counts.fast += 1
      else if (score < currentThresholds.powerful) counts.balanced += 1
      else counts.powerful += 1
      return counts
    },
    { fast: 0, balanced: 0, powerful: 0 }
  )
  const sampleSize = scores.length
  const shadowDiffRate =
    sampleSize > 0
      ? [...shadowDiffs].filter((decisionId) => decisions.has(decisionId)).length / sampleSize
      : 0
  const base = {
    sampleSize,
    perTier,
    shadowDiffRate,
    confidence: Math.min(0.99, sampleSize / 200) * (1 - shadowDiffRate * 0.25),
    judge: {
      ...judge,
      overrodeRate: judge.consulted > 0 ? judge.overrode / judge.consulted : 0,
      ...(judgeLatencies.length > 0
        ? {
            meanLatencyMs:
              judgeLatencies.reduce((sum, value) => sum + value, 0) / judgeLatencies.length,
          }
        : {}),
    },
  }
  if (sampleSize < MIN_TOTAL_SAMPLES) {
    return { status: "insufficient-total", ...base }
  }
  if (Math.min(perTier.fast, perTier.balanced, perTier.powerful) < MIN_TIER_SAMPLES) {
    return { status: "insufficient-tier", ...base }
  }

  const balanced = Math.round(quantile(scores, 0.4) * 100) / 100
  const powerfulRaw = Math.round(quantile(scores, 0.8) * 100) / 100
  const powerful = Math.min(1, Math.max(powerfulRaw, balanced + 0.05))
  return {
    status: "ready",
    ...base,
    recommendedThresholds: { balanced, powerful },
  }
}
