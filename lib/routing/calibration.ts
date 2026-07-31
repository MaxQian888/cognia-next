import type { AgentTraceSpan } from "@/types/agent-trace/span"

export interface RoutingCalibrationResult {
  status: "insufficient-total" | "insufficient-tier" | "ready"
  sampleSize: number
  perTier: { fast: number; balanced: number; powerful: number }
  shadowDiffRate: number
  confidence: number
  recommendedThresholds?: { balanced: number; powerful: number }
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
  for (const span of spans) {
    for (const event of span.events ?? []) {
      const decisionId =
        typeof event.attributes?.decisionId === "string" ? event.attributes.decisionId : undefined
      if (!decisionId) continue
      if (event.name === "routing.plan") {
        const score = boundedScore(event.attributes?.difficultyScore)
        if (score !== undefined) decisions.set(decisionId, score)
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
