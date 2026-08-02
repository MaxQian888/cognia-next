/**
 * Derivations behind the Diagnostics tab's matrix and history views:
 * filtering the sample log, grouping it per target, and ranking targets for a
 * usage scenario.
 *
 * Lives in `lib/` rather than the component because it is pure decision logic —
 * "which endpoint should this user pick for batch work" is a claim the app
 * makes, and it needs to be testable without mounting a panel.
 */

import { summarizeProviderDiagnosticSamples, type ProviderDiagnosticSummary } from "./statistics"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"

/** What the user optimises for; decides how the matrix is ranked. */
export type ProviderDiagnosticScenario = "interactive" | "batch" | "economy"

/** Time window for the history filters. */
export type ProviderDiagnosticRange = "24h" | "7d" | "all"

/** `"all"` means the axis is unfiltered. */
export interface ProviderDiagnosticFilters {
  status: "all" | "completed" | "failed"
  modelId: string
  capability: string
  credentialFingerprint: string
  endpoint: string
  range: ProviderDiagnosticRange
}

export interface ProviderDiagnosticMatrixRow {
  targetId: string
  /** Newest sample for the target — supplies the labels (model, endpoint, error). */
  sample: ProviderDiagnosticSample | undefined
  summary: ProviderDiagnosticSummary
}

const DAY_MS = 24 * 60 * 60_000

/** Epoch millis the given range starts at, relative to `now`. */
export function rangeStartMs(range: ProviderDiagnosticRange, now: number): number {
  if (range === "all") return 0
  return now - (range === "24h" ? DAY_MS : 7 * DAY_MS)
}

/**
 * Apply every history filter axis. Each axis is independent and `"all"` opts
 * out of it, so an axis whose value no longer exists in the data (a model the
 * user has since removed) hides everything rather than silently widening.
 */
export function filterDiagnosticSamples(
  samples: ProviderDiagnosticSample[],
  filters: ProviderDiagnosticFilters,
  now: number
): ProviderDiagnosticSample[] {
  const start = rangeStartMs(filters.range, now)
  return samples.filter(
    (sample) =>
      (filters.status === "all" || sample.status === filters.status) &&
      (filters.modelId === "all" || sample.modelId === filters.modelId) &&
      (filters.capability === "all" || sample.capability === filters.capability) &&
      (filters.credentialFingerprint === "all" ||
        sample.credentialFingerprint === filters.credentialFingerprint) &&
      (filters.endpoint === "all" || sample.endpoint === filters.endpoint) &&
      sample.startedAt >= start
  )
}

/**
 * Group samples per target and rank them for `scenario`.
 *
 * Ranking is "best first" in all three cases, which means the comparator flips
 * direction: throughput is better high, latency and cost better low. Targets
 * with no measurement for the ranked metric sort last rather than first — an
 * unmeasured endpoint must never be presented as the recommendation.
 */
export function buildDiagnosticMatrix(
  samples: ProviderDiagnosticSample[],
  scenario: ProviderDiagnosticScenario
): ProviderDiagnosticMatrixRow[] {
  const ids = [...new Set(samples.map((sample) => sample.targetId))]
  const rows: ProviderDiagnosticMatrixRow[] = ids.map((targetId) => ({
    targetId,
    sample: samples.find((sample) => sample.targetId === targetId),
    summary: summarizeProviderDiagnosticSamples(
      samples.filter((sample) => sample.targetId === targetId)
    ),
  }))

  rows.sort((left, right) => {
    if (scenario === "batch") {
      return (
        (right.summary.outputTokensPerSecond?.median ?? -1) -
        (left.summary.outputTokensPerSecond?.median ?? -1)
      )
    }
    if (scenario === "economy") {
      return (
        (left.summary.estimatedCostUsd?.median ?? Number.POSITIVE_INFINITY) -
        (right.summary.estimatedCostUsd?.median ?? Number.POSITIVE_INFINITY)
      )
    }
    return (
      (left.summary.ttftMs?.median ?? Number.POSITIVE_INFINITY) -
      (right.summary.ttftMs?.median ?? Number.POSITIVE_INFINITY)
    )
  })
  return rows
}

export interface ProviderDiagnosticTrend {
  /** Oldest-to-newest, so the bars read left to right like a timeline. */
  samples: ProviderDiagnosticSample[]
  /** Bar-height denominator; never 0, so the chart cannot divide by zero. */
  maxDurationMs: number
}

/** The duration a trend bar represents — a full run if measured, else the probe. */
export function trendDurationMs(sample: ProviderDiagnosticSample): number {
  return sample.metrics?.totalDurationMs ?? sample.probe?.durationMs ?? 0
}

/** The newest `limit` timed samples, oldest first, with their scale. */
export function selectDiagnosticTrend(
  samples: ProviderDiagnosticSample[],
  limit = 20
): ProviderDiagnosticTrend {
  const timed = samples
    .filter(
      (sample) =>
        sample.metrics?.totalDurationMs !== undefined || sample.probe?.durationMs !== undefined
    )
    .slice(0, limit)
    .reverse()
  return {
    samples: timed,
    maxDurationMs: Math.max(1, ...timed.map(trendDurationMs)),
  }
}

/** Distinct values present on an axis, for populating its filter dropdown. */
export function collectFilterOptions(samples: ProviderDiagnosticSample[]): {
  models: string[]
  credentials: string[]
  endpoints: string[]
} {
  return {
    models: [...new Set(samples.flatMap((sample) => (sample.modelId ? [sample.modelId] : [])))],
    credentials: [...new Set(samples.map((sample) => sample.credentialFingerprint))],
    endpoints: [...new Set(samples.map((sample) => sample.endpoint))],
  }
}
