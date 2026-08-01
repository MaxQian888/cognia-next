import type { ProviderBenchmarkMetrics, ProviderDiagnosticSample } from "@cognia/provider-types"

export interface ProviderMetricSummary {
  median: number
  min: number
  max: number
  p95?: number
}

export interface ProviderDiagnosticSummary {
  measuredSamples: number
  successfulSamples: number
  failedSamples: number
  ttftMs?: ProviderMetricSummary
  totalDurationMs?: ProviderMetricSummary
  outputTokensPerSecond?: ProviderMetricSummary
  estimatedCostUsd?: ProviderMetricSummary
}

function percentile(sorted: number[], quantile: number): number {
  const rank = Math.ceil(quantile * sorted.length) - 1
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))]
}

function summarizeMetric(values: number[]): ProviderMetricSummary | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const midpoint = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint]
  return {
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    ...(sorted.length >= 20 ? { p95: percentile(sorted, 0.95) } : {}),
  }
}

function comparableKey(sample: ProviderDiagnosticSample): string {
  return [
    sample.targetId,
    sample.endpoint,
    sample.credentialFingerprint,
    sample.capability,
    sample.promptVersion,
  ].join("\u0000")
}

function metricValues(
  samples: ProviderDiagnosticSample[],
  field: keyof ProviderBenchmarkMetrics
): number[] {
  return samples.flatMap((sample) => {
    const value = sample.metrics?.[field]
    return typeof value === "number" && Number.isFinite(value) ? [value] : []
  })
}

export function summarizeProviderDiagnosticSamples(
  samples: ProviderDiagnosticSample[]
): ProviderDiagnosticSummary {
  const measured = samples.filter((sample) => sample.sampleRole === "measured")
  const keys = new Set(measured.map(comparableKey))
  if (keys.size > 1) {
    throw new Error("Provider diagnostic summaries require samples from one comparable target")
  }
  const successful = measured.filter(
    (sample) => sample.status === "completed" && sample.metrics !== undefined
  )
  return {
    measuredSamples: measured.length,
    successfulSamples: successful.length,
    failedSamples: measured.length - successful.length,
    ttftMs: summarizeMetric(metricValues(successful, "ttftMs")),
    totalDurationMs: summarizeMetric(metricValues(successful, "totalDurationMs")),
    outputTokensPerSecond: summarizeMetric(metricValues(successful, "outputTokensPerSecond")),
    estimatedCostUsd: summarizeMetric(metricValues(successful, "estimatedCostUsd")),
  }
}
