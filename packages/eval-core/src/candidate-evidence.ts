import { bootstrapMean, pairedBootstrap, type BootstrapResult } from "./statistics"
import type { EvalCandidateEvidence, EvalExperimentManifest } from "./types"
import type { Score } from "./domain/eval"

export type EvalEvidenceManifest = Pick<
  EvalExperimentManifest,
  "variants" | "randomSeed" | "decisionPolicy" | "judgePolicy"
>

/** Only the observations needed for candidate metrics, independent of persistence. */
export interface EvalMetricSample {
  id: string
  variantId: string
  caseId: string
  actualCost: number
  latencyMs: number
}

export type EvalMetricScore = Pick<Score, "scorerId" | "value" | "passed"> &
  Partial<Pick<Score, "status">> & { sampleId: string }

export interface EvalEvidenceInput {
  samples: readonly EvalMetricSample[]
  scores: readonly EvalMetricScore[]
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
  return new Map([...values].map(([sampleId, scores]) => [sampleId, mean(scores)]))
}

export interface EvalPairedComparison {
  leftVariantId: string
  rightVariantId: string
  metric: "quality"
  result: BootstrapResult
}

export function buildPairedQualityComparisons(
  manifest: EvalEvidenceManifest,
  rows: EvalEvidenceInput
): EvalPairedComparison[] {
  const sampleQuality = qualityBySample(rows)
  const byVariant = new Map<string, Map<string, number[]>>()
  for (const sample of rows.samples) {
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
    const graded = samples.flatMap((sample) => {
      const scores = (scoresBySample.get(sample.id) ?? []).filter(
        (score) => score.status === undefined || score.status === "scored"
      )
      if (!scores.length) return []
      return [
        {
          caseId: sample.caseId,
          quality: mean(scores.map((score) => score.value)),
          reliability: scores.every((score) => score.passed) ? 1 : 0,
          cost: sample.actualCost,
          latency: sample.latencyMs,
        },
      ]
    })
    const values = {
      quality: graded.map((item) => item.quality),
      reliability: graded.map((item) => item.reliability),
      cost: graded.map((item) => item.cost),
      latency: graded.map((item) => item.latency),
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
      raw: {
        quality: interval("quality"),
        reliability: interval("reliability"),
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
    metrics: {
      quality: item.raw.quality.mean,
      reliability: item.raw.reliability.mean,
      cost: item.raw.cost.mean / maxCost,
      latency: item.raw.latency.mean / maxLatency,
    },
    intervals: {
      quality: { low: item.raw.quality.low, high: item.raw.quality.high },
      reliability: { low: item.raw.reliability.low, high: item.raw.reliability.high },
      cost: { low: item.raw.cost.low / maxCost, high: item.raw.cost.high / maxCost },
      latency: {
        low: item.raw.latency.low / maxLatency,
        high: item.raw.latency.high / maxLatency,
      },
    },
    calibrationPassed: calibrationPassed(manifest) && !item.hasErroredJudge,
  }))
}
