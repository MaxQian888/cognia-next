import {
  recommendVariants,
  buildEvalCandidateEvidence,
  buildPairedQualityComparisons,
  selectAdaptiveRepetitions,
  type EvalAdaptivePlanItem,
  type EvalCandidateEvidence,
  type EvalDecisionConstraint,
  type EvalExperimentManifest,
} from "@cognia/eval-core"
import type { EvalSampleRow } from "@/lib/db/eval-lab"
import { getDb } from "@/lib/db/schema"
import { decryptEvalArtifact } from "./artifact-crypto"

export interface EvalFinalizationScope {
  db: ReturnType<typeof getDb>
  assertActive(): void
}

function constraintMargin(value: number, constraint: EvalDecisionConstraint): number {
  return constraint.operator === "gte" || constraint.operator === "gt"
    ? value - constraint.value
    : constraint.value - value
}

interface ReviewQualityResult {
  pending: boolean
  qualityByVariant: Map<string, number>
}

async function buildReviewQuality(
  experimentId: string,
  samples: EvalSampleRow[],
  artifactKey: Uint8Array | undefined,
  scope: EvalFinalizationScope
): Promise<ReviewQualityResult> {
  const { db } = scope
  scope.assertActive()
  const batches = await db.evalReviewBatches.where("experimentId").equals(experimentId).toArray()
  scope.assertActive()
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
    scope.assertActive()
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
  options: {
    artifactKey?: Uint8Array
    forceRecommendation?: boolean
    scope?: EvalFinalizationScope
    reviewRevision?: { batchId: string; revision: number }
  } = {}
): Promise<boolean> {
  const scope = options.scope ?? { db: getDb(), assertActive: () => {} }
  const { db } = scope
  scope.assertActive()
  const experiment = await db.evalExperiments.get(experimentId)
  scope.assertActive()
  if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
  const existingRecommendation = await db.evalRecommendations
    .where("experimentId")
    .equals(experimentId)
    .first()
  scope.assertActive()
  if (existingRecommendation && !options.forceRecommendation) return false
  const [tasks, samples, scores] = await Promise.all([
    db.evalTasks.where("experimentId").equals(experimentId).toArray(),
    db.evalSamples.where("experimentId").equals(experimentId).toArray(),
    db.evalScores.where("experimentId").equals(experimentId).toArray(),
  ])
  scope.assertActive()
  const completedRepetition = Math.max(1, ...tasks.map((task) => task.repetition))
  const evidence = buildEvalCandidateEvidence(experiment.manifest, { samples, scores })
  const plan =
    options.forceRecommendation || tasks.some((task) => task.state !== "completed")
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
      scope.assertActive()
      await db.evalTasks.bulkAdd(additions)
      scope.assertActive()
      await db.evalExperiments.update(experimentId, { state: "queued", updatedAt: now })
      scope.assertActive()
    })
    scope.assertActive()
    return true
  }
  const reviewQuality = experiment.manifest.decisionPolicy.formal
    ? await buildReviewQuality(experimentId, samples, options.artifactKey, scope)
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
  await db.transaction("rw", [db.evalRecommendations, db.evalReviewBatches], async () => {
    scope.assertActive()
    if (options.reviewRevision) {
      const batch = await db.evalReviewBatches.get(options.reviewRevision.batchId)
      const batches = await db.evalReviewBatches
        .where("experimentId")
        .equals(experimentId)
        .toArray()
      const latest = batches.sort((left, right) => right.createdAt - left.createdAt)[0]
      scope.assertActive()
      if (
        !batch ||
        batch.experimentId !== experimentId ||
        latest?.id !== batch.id ||
        (batch.reviewRevision ?? 0) !== options.reviewRevision.revision
      ) {
        throw new Error("Review changed while recommendations were refreshed")
      }
    }
    if (existingRecommendation) {
      await db.evalRecommendations.put({ ...recommendationRow, id: existingRecommendation.id })
    } else {
      await db.evalRecommendations.add(recommendationRow)
    }
    scope.assertActive()
  })
  return false
}

export async function refreshEvalRecommendationAfterReview(
  experimentId: string,
  artifactKey: Uint8Array,
  scope?: EvalFinalizationScope,
  reviewRevision?: { batchId: string; revision: number }
): Promise<void> {
  await prepareNextEvalStage(experimentId, {
    artifactKey,
    forceRecommendation: true,
    scope,
    reviewRevision,
  })
}

// Compatibility exports for callers that previously used the persistence module.
export {
  buildEvalCandidateEvidence,
  buildPairedQualityComparisons,
  type EvalPairedComparison,
} from "@cognia/eval-core"
