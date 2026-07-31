import {
  bootstrapMean,
  pairedBootstrap,
  recommendVariants,
  selectAdaptiveRepetitions,
  type EvalAdaptivePlanItem,
  type EvalCandidateEvidence,
  type EvalDecisionConstraint,
  type EvalExperimentManifest,
  type BootstrapResult,
} from "@cognia/eval-core"
import type { EvalSampleRow, EvalScoreRow } from "@/lib/db/eval-lab"
import { getDb } from "@/lib/db/schema"
import { decryptEvalArtifact } from "./artifact-crypto"

interface EvaluationRows {
  samples: EvalSampleRow[]
  scores: EvalScoreRow[]
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function constraintMargin(value: number, constraint: EvalDecisionConstraint): number {
  return constraint.operator === "gte" || constraint.operator === "gt"
    ? value - constraint.value
    : constraint.value - value
}

function calibrationPassed(manifest: EvalExperimentManifest): boolean {
  if (!manifest.decisionPolicy.formal) return true
  return (
    manifest.judgePolicy.calibrated &&
    manifest.judgePolicy.anchorCount >= 30 &&
    manifest.judgePolicy.kappa >= 0.6 &&
    manifest.judgePolicy.accuracy >= 0.8
  )
}

interface ReviewQualityResult {
  pending: boolean
  qualityByVariant: Map<string, number>
}

async function buildReviewQuality(
  experimentId: string,
  samples: EvalSampleRow[],
  artifactKey?: Uint8Array
): Promise<ReviewQualityResult> {
  const db = getDb()
  const batches = await db.evalReviewBatches.where("experimentId").equals(experimentId).toArray()
  const latestBatch = [...batches].sort((left, right) => right.createdAt - left.createdAt)[0]
  if (!artifactKey || !latestBatch) return { pending: true, qualityByVariant: new Map() }
  const expectedPairs = [
    ...new Set(samples.map((sample) => `${sample.caseId}:${sample.repetition}`)),
  ]
    .map((caseKey) => {
      const variantCount = new Set(
        samples
          .filter((sample) => `${sample.caseId}:${sample.repetition}` === caseKey)
          .map((sample) => sample.variantId)
      ).size
      return (variantCount * (variantCount - 1)) / 2
    })
    .reduce((sum, count) => sum + count, 0)
  const wins = new Map<string, number>()
  const comparisons = new Map<string, number>()
  let resolvedPairs = 0
  let assignmentCount = 0
  for (const batch of [latestBatch]) {
    if (!batch.encryptedAssignments || !batch.encryptedPrivateMapping) continue
    const [assignments, mapping, votes, adjudications] = await Promise.all([
      decryptEvalArtifact<Array<{ assignmentId: string; pairId: string }>>(
        artifactKey,
        batch.encryptedAssignments
      ),
      decryptEvalArtifact<Record<string, { leftVariantId: string; rightVariantId: string }>>(
        artifactKey,
        batch.encryptedPrivateMapping
      ),
      db.evalReviewVotes.where("batchId").equals(batch.id).toArray(),
      db.evalAdjudications.where("batchId").equals(batch.id).toArray(),
    ])
    assignmentCount += assignments.length
    for (const assignment of assignments) {
      const privateMapping = mapping[assignment.assignmentId]
      if (!privateMapping) continue
      const adjudication = adjudications
        .filter((item) => item.pairId === assignment.pairId)
        .sort((left, right) => right.createdAt - left.createdAt)[0]
      let decision: "a" | "b" | "tie" | "exclude" | undefined = adjudication?.decision
      if (!decision) {
        const pairVotes = votes.filter(
          (vote) => vote.pairId === assignment.pairId && vote.preference !== "abstain"
        )
        const reviewers = new Set(pairVotes.map((vote) => vote.reviewerId))
        const preferences = new Set(pairVotes.map((vote) => vote.preference))
        if (reviewers.size >= 2 && preferences.size === 1) {
          decision = pairVotes[0]?.preference as "a" | "b" | "tie" | undefined
        }
      }
      if (!decision) continue
      resolvedPairs += 1
      if (decision === "exclude") continue
      const left = privateMapping.leftVariantId
      const right = privateMapping.rightVariantId
      comparisons.set(left, (comparisons.get(left) ?? 0) + 1)
      comparisons.set(right, (comparisons.get(right) ?? 0) + 1)
      if (decision === "tie") {
        wins.set(left, (wins.get(left) ?? 0) + 0.5)
        wins.set(right, (wins.get(right) ?? 0) + 0.5)
      } else {
        const winner = decision === "a" ? left : right
        wins.set(winner, (wins.get(winner) ?? 0) + 1)
      }
    }
  }
  const qualityByVariant = new Map(
    [...comparisons].map(([variantId, count]) => [
      variantId,
      count > 0 ? (wins.get(variantId) ?? 0) / count : 0,
    ])
  )
  return {
    pending:
      expectedPairs === 0 || assignmentCount < expectedPairs || resolvedPairs < assignmentCount,
    qualityByVariant,
  }
}

function qualityBySample(rows: EvaluationRows): Map<string, number> {
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
  manifest: EvalExperimentManifest,
  rows: EvaluationRows
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
  manifest: EvalExperimentManifest,
  rows: EvaluationRows
): EvalCandidateEvidence[] {
  const scoresBySample = new Map<string, EvalScoreRow[]>()
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

export function planAdaptiveStage(
  manifest: EvalExperimentManifest,
  evidence: EvalCandidateEvidence[],
  completedRepetition: number
): EvalAdaptivePlanItem[] {
  if (completedRepetition >= manifest.adaptiveRepetitions.maximum) return []
  return selectAdaptiveRepetitions(
    evidence.map((candidate) => ({
      variantId: candidate.variantId,
      repetitions: completedRepetition,
      constraintMargins: manifest.decisionPolicy.constraints.map((constraint) =>
        constraintMargin(
          candidate.metrics[constraint.metric] ?? Number.NEGATIVE_INFINITY,
          constraint
        )
      ),
      rankingInterval: [
        candidate.intervals.quality?.low ?? candidate.metrics.quality ?? 0,
        candidate.intervals.quality?.high ?? candidate.metrics.quality ?? 0,
      ],
    })),
    { boundaryMargin: 0.03 }
  )
}

async function evidenceDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}

/** Persist adaptive work or the terminal recommendation before completion. */
export async function prepareNextEvalStage(
  experimentId: string,
  options: { artifactKey?: Uint8Array; forceRecommendation?: boolean } = {}
): Promise<boolean> {
  const db = getDb()
  const experiment = await db.evalExperiments.get(experimentId)
  if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
  const existingRecommendation = await db.evalRecommendations
    .where("experimentId")
    .equals(experimentId)
    .first()
  if (existingRecommendation && !options.forceRecommendation) return false
  const [tasks, samples, scores] = await Promise.all([
    db.evalTasks.where("experimentId").equals(experimentId).toArray(),
    db.evalSamples.where("experimentId").equals(experimentId).toArray(),
    db.evalScores.where("experimentId").equals(experimentId).toArray(),
  ])
  const completedRepetition = Math.max(1, ...tasks.map((task) => task.repetition))
  const evidence = buildEvalCandidateEvidence(experiment.manifest, { samples, scores })
  const plan = tasks.some((task) => task.state !== "completed")
    ? []
    : planAdaptiveStage(experiment.manifest, evidence, completedRepetition)
  if (plan.length) {
    const now = Date.now()
    const sourceByVariant = new Map(
      tasks.filter((task) => task.repetition === 1).map((task) => [task.variantId, task] as const)
    )
    const existing = new Set(
      tasks.map((task) => `${task.variantId}:${task.caseId}:${task.repetition}`)
    )
    const effectiveCaseIds = experiment.manifest.decisionPolicy.formal
      ? experiment.manifest.dataset.holdoutCaseIds
      : experiment.manifest.dataset.caseIds
    const additions = plan.flatMap((item) => {
      const source = sourceByVariant.get(item.variantId)
      if (!source) return []
      return effectiveCaseIds.flatMap((caseId) => {
        const key = `${item.variantId}:${caseId}:${item.nextRepetition}`
        if (existing.has(key)) return []
        return [
          {
            id: crypto.randomUUID(),
            experimentId,
            variantId: item.variantId,
            caseId,
            repetition: item.nextRepetition,
            state: "queued" as const,
            attempt: 0,
            reservedCost: 0,
            estimatedWorstCaseCost: source.estimatedWorstCaseCost,
            providerId: source.providerId,
            updatedAt: now,
          },
        ]
      })
    })
    if (!additions.length) return false
    await db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
      await db.evalTasks.bulkAdd(additions)
      await db.evalExperiments.update(experimentId, { state: "queued", updatedAt: now })
    })
    return true
  }
  const reviewQuality = experiment.manifest.decisionPolicy.formal
    ? await buildReviewQuality(experimentId, samples, options.artifactKey)
    : { pending: false, qualityByVariant: new Map<string, number>() }
  const reviewedEvidence = evidence.map((candidate) => {
    const reviewQualityValue = reviewQuality.qualityByVariant.get(candidate.variantId)
    if (reviewQualityValue === undefined) return candidate
    return {
      ...candidate,
      metrics: {
        ...candidate.metrics,
        quality: (candidate.metrics.quality + reviewQualityValue) / 2,
      },
    }
  })
  const recommendation = reviewQuality.pending
    ? {
        status: "no_conclusion" as const,
        reason: "review_pending" as const,
        paretoVariantIds: [],
        utilityByVariant: {},
        excluded: [],
      }
    : recommendVariants(experiment.manifest.decisionPolicy, reviewedEvidence)
  const pairedComparisons = buildPairedQualityComparisons(experiment.manifest, { samples, scores })
  const recommendationRow = {
    id: crypto.randomUUID(),
    experimentId,
    result: recommendation,
    evidenceDigest: await evidenceDigest({ evidence: reviewedEvidence, reviewQuality }),
    pairedComparisons,
    createdAt: Date.now(),
  }
  if (existingRecommendation) {
    await db.evalRecommendations.put({ ...recommendationRow, id: existingRecommendation.id })
  } else {
    await db.evalRecommendations.add(recommendationRow)
  }
  return false
}

export async function refreshEvalRecommendationAfterReview(
  experimentId: string,
  artifactKey: Uint8Array
): Promise<void> {
  await prepareNextEvalStage(experimentId, { artifactKey, forceRecommendation: true })
}
