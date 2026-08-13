import type { PerfSourceKind } from "./backend/types"

export interface MetricInterval {
  value: number | null
  valid: boolean
}

export interface MetricStatistics {
  count: number
  median: number | null
  p95: number | null
  mad: number | null
}

export interface MetricComparison {
  baseline: MetricStatistics
  candidate: MetricStatistics
  absoluteDelta: number | null
  percentDelta: number | null
}

export interface CaptureComparisonDescriptor {
  metricId: string
  metricDefinitionVersion: number
  unit: string
  sourceKind: PerfSourceKind
  metricSchemaVersion: number
  requestedCadenceMs: number
  validIntervals: number
  expectedIntervals: number
  samplingSessionIds: readonly string[]
  incarnationIds: readonly string[]
  environmentFingerprint: string | null
}

export type CaptureComparisonIneligibilityReason =
  | "minimum-valid-intervals"
  | "minimum-coverage"
  | "metric-definition-mismatch"
  | "unit-mismatch"
  | "source-kind-mismatch"
  | "metric-schema-mismatch"
  | "requested-cadence-mismatch"
  | "discontinuous-incarnation"
  | "environment-missing"
  | "environment-mismatch"

export interface CaptureComparisonEligibility {
  eligible: boolean
  reasons: CaptureComparisonIneligibilityReason[]
  baselineCoverage: number
  candidateCoverage: number
  environmentMismatchAccepted: boolean
}

export interface PerfBudgetSnapshot {
  id: string
  version: number
  immutable: boolean
  metricId: string
  metricDefinitionVersion: number
  unit: string
  sourceKind: PerfSourceKind
  metricSchemaVersion: number
  requestedCadenceMs: number
  direction: "lower" | "higher"
  warningThreshold: number
  failureThreshold: number
  comparisonWindow: "interval"
}

function validValues(values: readonly (number | MetricInterval)[]): number[] {
  return values.flatMap((item) => {
    if (typeof item === "number") return Number.isFinite(item) ? [item] : []
    return item.valid && item.value !== null && Number.isFinite(item.value) ? [item.value] : []
  })
}

/** R-compatible type-7 quantile. */
export function type7Percentile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, probability))
  const lower = Math.floor(position)
  const fraction = position - lower
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower])
}

function statistics(values: readonly (number | MetricInterval)[]): MetricStatistics {
  const valid = validValues(values)
  const median = type7Percentile(valid, 0.5)
  const deviations = median === null ? [] : valid.map((value) => Math.abs(value - median))
  return {
    count: valid.length,
    median,
    p95: type7Percentile(valid, 0.95),
    mad: type7Percentile(deviations, 0.5),
  }
}

export function compareMetricSeries(
  baselineValues: readonly (number | MetricInterval)[],
  candidateValues: readonly (number | MetricInterval)[]
): MetricComparison {
  const baseline = statistics(baselineValues)
  const candidate = statistics(candidateValues)
  const absoluteDelta =
    baseline.median === null || candidate.median === null
      ? null
      : candidate.median - baseline.median
  return {
    baseline,
    candidate,
    absoluteDelta,
    percentDelta:
      absoluteDelta === null || baseline.median === null || baseline.median === 0
        ? null
        : (absoluteDelta / Math.abs(baseline.median)) * 100,
  }
}

export function assessCaptureComparisonEligibility(
  baseline: CaptureComparisonDescriptor,
  candidate: CaptureComparisonDescriptor,
  options: { environmentMismatchAccepted?: boolean } = {}
): CaptureComparisonEligibility {
  const reasons = new Set<CaptureComparisonIneligibilityReason>()
  const baselineCoverage =
    baseline.expectedIntervals > 0 ? baseline.validIntervals / baseline.expectedIntervals : 0
  const candidateCoverage =
    candidate.expectedIntervals > 0 ? candidate.validIntervals / candidate.expectedIntervals : 0
  if (baseline.validIntervals < 10 || candidate.validIntervals < 10) {
    reasons.add("minimum-valid-intervals")
  }
  if (baselineCoverage < 0.9 || candidateCoverage < 0.9) reasons.add("minimum-coverage")
  if (
    baseline.metricId !== candidate.metricId ||
    baseline.metricDefinitionVersion !== candidate.metricDefinitionVersion
  ) {
    reasons.add("metric-definition-mismatch")
  }
  if (baseline.unit !== candidate.unit) reasons.add("unit-mismatch")
  if (baseline.sourceKind !== candidate.sourceKind) reasons.add("source-kind-mismatch")
  if (baseline.metricSchemaVersion !== candidate.metricSchemaVersion) {
    reasons.add("metric-schema-mismatch")
  }
  if (baseline.requestedCadenceMs !== candidate.requestedCadenceMs) {
    reasons.add("requested-cadence-mismatch")
  }
  const isContinuous = (descriptor: CaptureComparisonDescriptor) =>
    new Set(descriptor.samplingSessionIds).size === 1 &&
    descriptor.samplingSessionIds.length > 0 &&
    new Set(descriptor.incarnationIds).size <= 1
  if (!isContinuous(baseline) || !isContinuous(candidate)) {
    reasons.add("discontinuous-incarnation")
  }
  if (!baseline.environmentFingerprint || !candidate.environmentFingerprint) {
    reasons.add("environment-missing")
  } else if (
    baseline.environmentFingerprint !== candidate.environmentFingerprint &&
    !options.environmentMismatchAccepted
  ) {
    reasons.add("environment-mismatch")
  }
  return {
    eligible: reasons.size === 0,
    reasons: [...reasons],
    baselineCoverage,
    candidateCoverage,
    environmentMismatchAccepted: options.environmentMismatchAccepted === true,
  }
}

export interface BudgetEvaluationInput {
  value: number
  validIntervals: number
  expectedIntervals: number
  continuousIncarnation: boolean
  metadataMatches: boolean
  environmentMatches: boolean
  environmentMismatchAccepted: boolean
  budget: PerfBudgetSnapshot
}

export type BudgetVerdict = "pass" | "warn" | "fail" | "insufficient-data" | "incomparable"

export function evaluateBudget(input: BudgetEvaluationInput): {
  verdict: BudgetVerdict
  reason: string | null
} {
  if (!input.budget.immutable) return { verdict: "incomparable", reason: "mutable-budget" }
  if (input.validIntervals < 10)
    return { verdict: "insufficient-data", reason: "minimum-valid-intervals" }
  if (input.expectedIntervals <= 0 || input.validIntervals / input.expectedIntervals < 0.9)
    return { verdict: "insufficient-data", reason: "minimum-coverage" }
  if (!input.continuousIncarnation)
    return { verdict: "incomparable", reason: "discontinuous-incarnation" }
  if (!input.metadataMatches) return { verdict: "incomparable", reason: "metadata-mismatch" }
  if (!input.environmentMatches && !input.environmentMismatchAccepted)
    return { verdict: "incomparable", reason: "environment-mismatch" }

  const worse = (threshold: number) =>
    input.budget.direction === "lower" ? input.value >= threshold : input.value <= threshold
  if (worse(input.budget.failureThreshold)) return { verdict: "fail", reason: null }
  if (worse(input.budget.warningThreshold)) return { verdict: "warn", reason: null }
  return { verdict: "pass", reason: null }
}
