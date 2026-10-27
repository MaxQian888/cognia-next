import { bootstrapMean, pairedBootstrap, type BootstrapResult } from "./statistics"
import type { EvalCandidateEvidence, EvalExperimentManifest, EvalTask } from "./types"
import type { EvalSample, Score } from "./domain/eval"
import { sampleExecutionFailed } from "./report"

export type EvalEvidenceManifest = Pick<
  EvalExperimentManifest,
  "variants" | "randomSeed" | "decisionPolicy" | "judgePolicy"
>

/** Only the observations needed for candidate metrics, independent of persistence. */
export interface EvalMetricSample {
  id: string
  taskId?: string
  variantId: string
  caseId: string
  actualCost: number
  latencyMs: number
  executionStatus?: EvalSample["executionStatus"]
  error?: string
  metricAvailability?: EvalSample["metricAvailability"]
  repetition?: number
  expectedRepetitions?: number
}

export type EvalMetricScore = Pick<Score, "scorerId" | "value" | "passed"> &
  Partial<Pick<Score, "status">> & { sampleId: string }

export interface EvalEvidenceInput {
  samples: readonly EvalMetricSample[]
  scores: readonly EvalMetricScore[]
  /** Cumulative per-task attempts, including work without a final scored sample. */
  resourceSamples?: readonly EvalMetricSample[]
}

export type EvalEvidenceTask = Pick<EvalTask, "id" | "attempts"> &
  Partial<Pick<EvalTask, "variantId" | "caseId" | "repetition" | "state">> & {
    lastError?: string
  }

/** Use the same attempt ledger and planned repetitions at finalization and review. */
export function projectEvalTaskEvidence(
  manifest: Pick<EvalExperimentManifest, "executionProtocol">,
  input: EvalEvidenceInput & { tasks: readonly EvalEvidenceTask[] }
): EvalEvidenceInput {
  const expectedByCase = new Map<string, number>()
  const key = (row: { variantId: string; caseId: string }) =>
    JSON.stringify([row.variantId, row.caseId])
  for (const row of [...input.samples, ...input.tasks]) {
    if (!row.variantId || !row.caseId) continue
    expectedByCase.set(
      key({ variantId: row.variantId, caseId: row.caseId }),
      Math.max(
        expectedByCase.get(key({ variantId: row.variantId, caseId: row.caseId })) ?? 1,
        row.repetition ?? 1
      )
    )
  }
  const samples = input.samples.map((sample) => ({
    ...sample,
    expectedRepetitions:
      manifest.executionProtocol?.repetitions ??
      Math.max(sample.expectedRepetitions ?? 1, expectedByCase.get(key(sample)) ?? 1),
  }))
  if (input.resourceSamples) {
    return { samples, scores: input.scores, resourceSamples: input.resourceSamples }
  }
  const taskIds = new Set(input.tasks.map((task) => task.id))
  const resourceSamples = input.tasks.flatMap<EvalMetricSample>((task) => {
    const finalSamples = samples.filter((sample) => sample.taskId === task.id)
    if (!task.attempts?.length) return finalSamples
    const variantId = task.variantId ?? finalSamples[0]?.variantId
    const caseId = task.caseId ?? finalSamples[0]?.caseId
    if (!variantId || !caseId) return []
    const measured = task.attempts.filter((attempt) => attempt.capturedCostUsd !== undefined)
    const incomplete = task.attempts.some(
      (attempt) => attempt.costStatus === "partial" || attempt.costStatus === "unavailable"
    )
    const executionStatus =
      task.state === "failed" || task.state === "cancelled" || task.state === "interrupted"
        ? task.state
        : "completed"
    return [
      {
        id: `attempts:${task.id}`,
        taskId: task.id,
        variantId,
        caseId,
        repetition: task.repetition ?? finalSamples[0]?.repetition,
        expectedRepetitions:
          manifest.executionProtocol?.repetitions ??
          expectedByCase.get(key({ variantId, caseId })) ??
          1,
        actualCost: measured.reduce((sum, attempt) => sum + attempt.capturedCostUsd!, 0),
        latencyMs: task.attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0),
        executionStatus,
        ...(executionStatus !== "completed" && task.lastError ? { error: task.lastError } : {}),
        metricAvailability: {
          usage: "unavailable",
          cost: measured.length === 0 ? "unavailable" : incomplete ? "partial" : "estimated",
          latency: "known",
        },
      },
    ]
  })
  resourceSamples.push(...samples.filter((sample) => !sample.taskId || !taskIds.has(sample.taskId)))
  return { samples, scores: input.scores, resourceSamples }
}

/** A terminal execution failure is evidence even when no final answer survived. */
function samplesWithResourceFailures(rows: EvalEvidenceInput): EvalMetricSample[] {
  return [
    ...rows.samples,
    ...(rows.resourceSamples ?? []).filter(
      (resource) =>
        sampleExecutionFailed(resource) &&
        !rows.samples.some(
          (sample) =>
            (sample.taskId && (resource.taskId ?? resource.id) === sample.taskId) ||
            (!sample.taskId &&
              sample.variantId === resource.variantId &&
              sample.caseId === resource.caseId &&
              sample.repetition === resource.repetition)
        )
    ),
  ]
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function calibrationPassed(manifest: EvalEvidenceManifest): boolean {
  if (!manifest.decisionPolicy.formal) return true
  return (
    manifest.judgePolicy.calibrated &&
    manifest.judgePolicy.anchorCount >= 30 &&
    manifest.judgePolicy.kappa >= 0.6 &&
    manifest.judgePolicy.accuracy >= 0.8
  )
}

function qualityBySample(rows: EvalEvidenceInput): Map<string, number> {
  const values = new Map<string, number[]>()
  for (const score of rows.scores) {
    if (score.status !== undefined && score.status !== "scored") continue
    const sampleValues = values.get(score.sampleId) ?? []
    sampleValues.push(score.value)
    values.set(score.sampleId, sampleValues)
  }
  const result = new Map([...values].map(([sampleId, scores]) => [sampleId, mean(scores)]))
  for (const sample of samplesWithResourceFailures(rows)) {
    if (sampleExecutionFailed(sample)) result.set(sample.id, 0)
  }
  return result
}

export interface EvalPairedComparison {
  leftVariantId: string
  rightVariantId: string
  metric: "quality"
  result: BootstrapResult
  /** Pair count is a case count, never a count of repeated observations. */
  pairedCaseCount: number
  leftGradedCaseCount: number
  rightGradedCaseCount: number
}

export function buildPairedQualityComparisons(
  manifest: EvalEvidenceManifest,
  rows: EvalEvidenceInput
): EvalPairedComparison[] {
  const sampleQuality = qualityBySample(rows)
  const byVariant = new Map<string, Map<string, number[]>>()
  for (const sample of samplesWithResourceFailures(rows)) {
    const quality = sampleQuality.get(sample.id)
    if (quality === undefined) continue
    const byCase = byVariant.get(sample.variantId) ?? new Map<string, number[]>()
    const values = byCase.get(sample.caseId) ?? []
    values.push(quality)
    byCase.set(sample.caseId, values)
    byVariant.set(sample.variantId, byCase)
  }
  const comparisons: EvalPairedComparison[] = []
  for (let leftIndex = 0; leftIndex < manifest.variants.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < manifest.variants.length; rightIndex++) {
      const left = manifest.variants[leftIndex]
      const right = manifest.variants[rightIndex]
      const leftCases = byVariant.get(left.id) ?? new Map()
      const rightCases = byVariant.get(right.id) ?? new Map()
      const commonCases = [...leftCases.keys()].filter((caseId) => rightCases.has(caseId)).sort()
      if (!commonCases.length) continue
      comparisons.push({
        leftVariantId: left.id,
        rightVariantId: right.id,
        metric: "quality",
        pairedCaseCount: commonCases.length,
        leftGradedCaseCount: leftCases.size,
        rightGradedCaseCount: rightCases.size,
        result: pairedBootstrap(
          commonCases.map((caseId) => mean(leftCases.get(caseId) ?? [])),
          commonCases.map((caseId) => mean(rightCases.get(caseId) ?? [])),
          {
            seed: manifest.randomSeed + leftIndex * 1_009 + rightIndex * 9_173,
            confidenceLevel: manifest.decisionPolicy.confidenceLevel,
          }
        ),
      })
    }
  }
  return comparisons
}

export function buildEvalCandidateEvidence(
  manifest: EvalEvidenceManifest,
  rows: EvalEvidenceInput
): EvalCandidateEvidence[] {
  const scoresBySample = new Map<string, EvalMetricScore[]>()
  for (const score of rows.scores) {
    const list = scoresBySample.get(score.sampleId) ?? []
    list.push(score)
    scoresBySample.set(score.sampleId, list)
  }
  const provisional = manifest.variants.map((variant, variantIndex) => {
    const samples = rows.samples.filter((sample) => sample.variantId === variant.id)
    const resourceSamples = (rows.resourceSamples ?? rows.samples).filter(
      (sample) => sample.variantId === variant.id
    )
    const gradingSamples = samplesWithResourceFailures(rows).filter(
      (sample) => sample.variantId === variant.id
    )
    const graded = gradingSamples.flatMap((sample) => {
      const scores = (scoresBySample.get(sample.id) ?? []).filter(
        (score) => score.status === undefined || score.status === "scored"
      )
      const failed = sampleExecutionFailed(sample)
      if (!scores.length && !failed) return []
      return [
        {
          caseId: sample.caseId,
          sampleId: sample.id,
          quality: failed ? 0 : mean(scores.map((score) => score.value)),
          reliability: !failed && scores.every((score) => score.passed) ? 1 : 0,
        },
      ]
    })
    // Each bootstrap observation is one case cluster. Repeating one easy
    // task must not turn it into several independent tasks or erase costly
    // attempts whose output could not be graded.
    const clusterMeans = <T extends { caseId: string }>(
      items: readonly T[],
      value: (item: T) => number
    ) => {
      const byCase = new Map<string, number[]>()
      for (const item of items) {
        const values = byCase.get(item.caseId) ?? []
        values.push(value(item))
        byCase.set(item.caseId, values)
      }
      return [...byCase.values()].map(mean)
    }
    const knownCost = resourceSamples.filter(
      (sample) =>
        sample.metricAvailability?.cost !== "unavailable" &&
        sample.metricAvailability?.cost !== "partial" &&
        Number.isFinite(sample.actualCost)
    )
    const knownLatency = resourceSamples.filter(
      (sample) =>
        sample.metricAvailability?.latency !== "unavailable" && Number.isFinite(sample.latencyMs)
    )
    const byCase = new Map<string, EvalMetricSample[]>()
    for (const sample of gradingSamples) {
      const group = byCase.get(sample.caseId) ?? []
      group.push(sample)
      byCase.set(sample.caseId, group)
    }
    const verdicts = new Map(graded.map((item) => [item.sampleId, item.reliability]))
    const completeCases: number[] = []
    let incompleteCases = 0
    for (const group of byCase.values()) {
      const expected = Math.max(
        ...group.map((item) => item.expectedRepetitions ?? item.repetition ?? group.length)
      )
      if (group.length < expected) {
        incompleteCases += 1
        if (group.some((item) => verdicts.has(item.id))) completeCases.push(0)
        continue
      }
      if (!group.every((item) => verdicts.has(item.id))) {
        if (group.some((item) => verdicts.has(item.id))) completeCases.push(0)
        continue
      }
      completeCases.push(group.every((item) => verdicts.get(item.id) === 1) ? 1 : 0)
    }
    const values = {
      quality: clusterMeans(graded, (item) => item.quality),
      reliability: clusterMeans(graded, (item) => item.reliability),
      allRepeatReliability: completeCases,
      cost: clusterMeans(knownCost, (item) => item.actualCost),
      latency: clusterMeans(knownLatency, (item) => item.latencyMs),
    }
    const seed = manifest.randomSeed + variantIndex * 10_007
    const interval = (metric: keyof typeof values) =>
      values[metric].length
        ? bootstrapMean(values[metric], {
            seed,
            confidenceLevel: manifest.decisionPolicy.confidenceLevel,
          })
        : { mean: 0, low: 0, high: 0 }
    const hasErroredJudge = samples.some((sample) =>
      (scoresBySample.get(sample.id) ?? []).some(
        (score) =>
          score.status === "errored" &&
          (score.scorerId.startsWith("judge-") || score.scorerId.startsWith("rag-"))
      )
    )
    return {
      variantId: variant.id,
      effectiveCases: new Set(graded.map((item) => item.caseId)).size,
      observationCounts: {
        attemptedCases: new Set([...gradingSamples, ...resourceSamples].map((item) => item.caseId))
          .size,
        attemptedSamples: Math.max(gradingSamples.length, resourceSamples.length),
        gradedCases: new Set(graded.map((item) => item.caseId)).size,
        gradedSamples: graded.length,
        ungradedSamples: Math.max(gradingSamples.length, resourceSamples.length) - graded.length,
        executionFailures: (rows.resourceSamples ? resourceSamples : samples).filter(
          sampleExecutionFailed
        ).length,
        incompleteCases,
      },
      resourceTotals: {
        costUsd: resourceSamples.reduce(
          (sum, item) => sum + (Number.isFinite(item.actualCost) ? item.actualCost : 0),
          0
        ),
        latencyMs: knownLatency.reduce((sum, item) => sum + item.latencyMs, 0),
      },
      resourceAvailability: {
        cost:
          knownCost.length === resourceSamples.length && resourceSamples.length > 0
            ? ("known" as const)
            : knownCost.length > 0 ||
                resourceSamples.some((sample) => sample.metricAvailability?.cost === "partial")
              ? ("partial" as const)
              : ("unavailable" as const),
        latency:
          knownLatency.length === resourceSamples.length && resourceSamples.length > 0
            ? ("known" as const)
            : knownLatency.length > 0
              ? ("partial" as const)
              : ("unavailable" as const),
      },
      raw: {
        quality: interval("quality"),
        reliability: interval("reliability"),
        allRepeatReliability: interval("allRepeatReliability"),
        cost: interval("cost"),
        latency: interval("latency"),
      },
      hasErroredJudge,
    }
  })
  const maxCost = Math.max(1e-12, ...provisional.map((item) => item.raw.cost.mean))
  const maxLatency = Math.max(1e-12, ...provisional.map((item) => item.raw.latency.mean))
  return provisional.map((item) => ({
    variantId: item.variantId,
    effectiveCases: item.effectiveCases,
    observationCounts: item.observationCounts,
    resourceTotals: item.resourceTotals,
    resourceAvailability: item.resourceAvailability,
    metrics: {
      quality: item.raw.quality.mean,
      reliability: item.raw.reliability.mean,
      attemptReliability: item.raw.reliability.mean,
      allRepeatReliability: item.raw.allRepeatReliability.mean,
      cost: item.raw.cost.mean / maxCost,
      latency: item.raw.latency.mean / maxLatency,
    },
    intervals: {
      quality: { low: item.raw.quality.low, high: item.raw.quality.high },
      reliability: { low: item.raw.reliability.low, high: item.raw.reliability.high },
      attemptReliability: { low: item.raw.reliability.low, high: item.raw.reliability.high },
      allRepeatReliability: {
        low: item.raw.allRepeatReliability.low,
        high: item.raw.allRepeatReliability.high,
      },
      cost: { low: item.raw.cost.low / maxCost, high: item.raw.cost.high / maxCost },
      latency: {
        low: item.raw.latency.low / maxLatency,
        high: item.raw.latency.high / maxLatency,
      },
    },
    calibrationPassed: calibrationPassed(manifest) && !item.hasErroredJudge,
  }))
}
