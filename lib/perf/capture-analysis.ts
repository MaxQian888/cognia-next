/**
 * Capture comparison and budget evaluation over decrypted capture frames.
 *
 * `comparison.ts` holds the statistics and the eligibility / verdict rules
 * ADR-0035 specifies; this module is the missing join between those rules and
 * real captures. The Captures tab used to call `compareMetricSeries` on the
 * main process CPU of whichever two rows were ticked — no eligibility check,
 * so a Renderer capture (which has no processes) "compared" against a host
 * capture as two empty series, and budget profiles had a service and a verdict
 * function but no caller at all.
 */

import type { PerfFrame } from "./backend/types"
import type { PerformanceBudgetProfile } from "./budget-service"
import type { CogniaDB } from "@/lib/db/schema"
import {
  readPerformanceCaptureFrames,
  readPerformanceCaptureMetadata,
  type PerformanceCaptureMetadata,
} from "./capture-portability"
import type { PerformanceCaptureRow } from "./capture-types"
import {
  assessCaptureComparisonEligibility,
  compareMetricSeries,
  evaluateBudget,
  type BudgetVerdict,
  type CaptureComparisonDescriptor,
  type CaptureComparisonEligibility,
  type MetricComparison,
  type MetricInterval,
} from "./comparison"
import { getPerfMetric, metricIntervals, type PerfMetricDefinition } from "./metric-catalog"

export interface DecodedCapture {
  row: PerformanceCaptureRow
  frames: PerfFrame[]
  metadata: PerformanceCaptureMetadata | null
}

/** Decrypt one stored capture's frames and metadata for analysis. */
export async function readDecodedCapture(input: {
  db: CogniaDB
  accountId: string
  targetDatabase: string
  captureId: string
  key: Uint8Array
}): Promise<DecodedCapture> {
  const row = await input.db.performanceCaptures.get(input.captureId)
  if (!row) throw new Error("performance-capture-not-found")
  if (row.status !== "ready") throw new Error("performance-capture-not-ready")
  const [frames, metadata] = await Promise.all([
    readPerformanceCaptureFrames(input),
    readPerformanceCaptureMetadata(input),
  ])
  return { row, frames, metadata }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** The cadence the capture asked for: the metadata envelope, else the frames. */
export function captureCadenceMs(capture: DecodedCapture): number | null {
  return capture.metadata?.requestedCadenceMs ?? capture.frames[0]?.requestedIntervalMs ?? null
}

/**
 * Intervals the capture should have produced: its wall duration at the
 * requested cadence, never fewer than the frames it actually holds.
 */
export function expectedIntervals(capture: DecodedCapture): number {
  const cadence = captureCadenceMs(capture)
  const end = capture.row.stoppedAt ?? capture.row.updatedAt
  const byDuration =
    cadence && cadence > 0 ? Math.floor(Math.max(0, end - capture.row.startedAt) / cadence) : 0
  return Math.max(capture.frames.length, byDuration)
}

/**
 * What identifies "the same running thing" across a capture: the main
 * process incarnation for a host (a restart changes it), the document for
 * the Renderer (a reload changes it).
 */
function incarnationIds(capture: DecodedCapture): string[] {
  if (capture.row.sourceKind === "renderer") {
    return unique(capture.frames.map((frame) => frame.hostInstanceId))
  }
  return unique(
    capture.frames.flatMap((frame) => {
      const main = frame.processes.find((process) => process.role === "main")
      return main?.incarnation ? [main.incarnation] : []
    })
  )
}

export function describeCaptureForComparison(
  capture: DecodedCapture,
  metric: PerfMetricDefinition
): { descriptor: CaptureComparisonDescriptor; intervals: MetricInterval[] } {
  const intervals = metricIntervals(capture.frames, metric)
  return {
    intervals,
    descriptor: {
      metricId: metric.id,
      metricDefinitionVersion: metric.definitionVersion,
      unit: metric.unit,
      sourceKind: capture.row.sourceKind,
      metricSchemaVersion: capture.row.metricSchemaVersion,
      requestedCadenceMs: captureCadenceMs(capture) ?? 0,
      validIntervals: intervals.filter((interval) => interval.valid).length,
      expectedIntervals: expectedIntervals(capture),
      samplingSessionIds: unique(capture.frames.map((frame) => frame.samplingSessionId)),
      incarnationIds: incarnationIds(capture),
      environmentFingerprint: capture.row.environmentDigest ?? null,
    },
  }
}

export interface CaptureComparisonResult {
  metric: PerfMetricDefinition
  comparison: MetricComparison
  eligibility: CaptureComparisonEligibility
  baseline: CaptureComparisonDescriptor
  candidate: CaptureComparisonDescriptor
}

/**
 * Statistics are always reported (ADR-0035: median, type-7 p95, MAD,
 * absolute and percent delta); `eligibility` says whether they may be read as
 * a like-for-like verdict, and why not.
 */
export function compareCaptures(
  baseline: DecodedCapture,
  candidate: DecodedCapture,
  metric: PerfMetricDefinition,
  options: { environmentMismatchAccepted?: boolean } = {}
): CaptureComparisonResult {
  const left = describeCaptureForComparison(baseline, metric)
  const right = describeCaptureForComparison(candidate, metric)
  // The metric is chosen once for both captures, so a capture from a source
  // that cannot measure it reaches the eligibility rules as zero valid
  // intervals rather than as a silent empty comparison.
  return {
    metric,
    comparison: compareMetricSeries(left.intervals, right.intervals),
    eligibility: assessCaptureComparisonEligibility(left.descriptor, right.descriptor, options),
    baseline: left.descriptor,
    candidate: right.descriptor,
  }
}

export type BudgetEvaluationReason =
  | "unknown-metric"
  | "mutable-budget"
  | "minimum-valid-intervals"
  | "minimum-coverage"
  | "discontinuous-incarnation"
  | "metadata-mismatch"
  | "environment-mismatch"

export interface CaptureBudgetEvaluation {
  verdict: BudgetVerdict
  reason: BudgetEvaluationReason | null
  /** The aggregated value the thresholds were applied to. */
  value: number | null
  validIntervals: number
  expectedIntervals: number
  environmentMatches: boolean
}

function environmentMatches(
  budget: PerformanceBudgetProfile,
  metadata: PerformanceCaptureMetadata | null
): boolean {
  const source = metadata?.source
  if (!source) return false
  return (
    budget.applicability.runtimeKinds.includes(source.runtimeKind) &&
    budget.applicability.buildProfiles.includes(source.build.profile)
  )
}

export function evaluateCaptureAgainstBudget(
  capture: DecodedCapture,
  budget: PerformanceBudgetProfile,
  options: { environmentMismatchAccepted?: boolean } = {}
): CaptureBudgetEvaluation {
  const metric = getPerfMetric(budget.metricId)
  const expected = expectedIntervals(capture)
  const envMatches = environmentMatches(budget, capture.metadata)
  if (!metric) {
    return {
      verdict: "incomparable",
      reason: "unknown-metric",
      value: null,
      validIntervals: 0,
      expectedIntervals: expected,
      environmentMatches: envMatches,
    }
  }
  const { descriptor, intervals } = describeCaptureForComparison(capture, metric)
  const stats = compareMetricSeries(intervals, []).baseline
  const value = budget.aggregation === "p95" ? stats.p95 : stats.median
  const continuous =
    descriptor.samplingSessionIds.length === 1 && descriptor.incarnationIds.length <= 1
  const metadataMatches =
    metric.definitionVersion === budget.metricDefinitionVersion &&
    metric.unit === budget.unit &&
    capture.row.sourceKind === budget.sourceKind &&
    capture.row.metricSchemaVersion === budget.metricSchemaVersion &&
    descriptor.requestedCadenceMs === budget.requestedCadenceMs
  const base = {
    value,
    validIntervals: descriptor.validIntervals,
    expectedIntervals: descriptor.expectedIntervals,
    environmentMatches: envMatches,
  }
  if (value === null) {
    return { ...base, verdict: "insufficient-data", reason: "minimum-valid-intervals" }
  }
  const result = evaluateBudget({
    value,
    validIntervals: descriptor.validIntervals,
    expectedIntervals: descriptor.expectedIntervals,
    continuousIncarnation: continuous,
    metadataMatches,
    environmentMatches: envMatches,
    environmentMismatchAccepted: options.environmentMismatchAccepted === true,
    budget,
  })
  return {
    ...base,
    verdict: result.verdict,
    reason: result.reason as BudgetEvaluationReason | null,
  }
}
