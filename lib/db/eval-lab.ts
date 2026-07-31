import type {
  EvalExperimentManifest,
  EvalExperimentState,
  EvalProject,
  EvalRecommendationResult,
  EvalTask,
} from "@cognia/eval-core"
import type { EvalEncryptedEnvelope } from "@/lib/ai/eval/artifact-crypto"
import { getDb } from "./schema"

export type EvalProjectRow = EvalProject

export interface EvalExperimentRow {
  id: string
  projectId: string
  manifest: EvalExperimentManifest
  state: EvalExperimentState
  spentCost: number
  reservedCost: number
  /** Mutable dispatch ceiling; the immutable manifest keeps the original cap. */
  budgetCap?: number
  budgetExtensions?: Array<{ previousCap: number; nextCap: number; createdAt: number }>
  pauseReason?: "user" | "budget" | "rate-limit" | "recovery"
  failure?: string
  createdAt: number
  updatedAt: number
}

export type EvalTaskRow = EvalTask & { providerId?: string; lastError?: string }

export interface EvalSampleRow {
  id: string
  experimentId: string
  taskId: string
  variantId: string
  caseId: string
  repetition: 1 | 2 | 3
  encryptedArtifact: EvalEncryptedEnvelope
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  judgeInputTokens?: number
  judgeOutputTokens?: number
  judgeCost?: number
  judgeRedactionPolicy?: "redacted"
  judgeRedactionDigest?: string
  actualCost: number
  providerRequestId?: string
  createdAt: number
  expiresAt: number
}

export interface EvalScoreRow {
  id: string
  experimentId: string
  sampleId: string
  scorerId: string
  scorerVersion: string
  value: number
  passed: boolean
  status?: import("@/types/eval/eval").ScoreStatus
  dimension?: import("@/types/eval/eval").EvalDimension
  error?: string
  metadata?: Record<string, unknown>
  encryptedReasoning?: EvalEncryptedEnvelope
  createdAt: number
}

export interface EvalReviewBatchRow {
  id: string
  experimentId: string
  status: "open" | "completed" | "adjudicated"
  blindedAssignmentDigest: string
  encryptedAssignments?: EvalEncryptedEnvelope
  encryptedPrivateMapping?: EvalEncryptedEnvelope
  createdAt: number
  updatedAt: number
}

export interface EvalReviewVoteRow {
  id: string
  batchId: string
  experimentId: string
  pairId: string
  reviewerId: string
  preference: "a" | "b" | "tie" | "abstain"
  rubric: Record<string, number>
  createdAt: number
}

export interface EvalAdjudicationRow {
  id: string
  batchId: string
  pairId: string
  adjudicatorId: string
  decision: "a" | "b" | "tie" | "exclude"
  encryptedReasoning?: EvalEncryptedEnvelope
  createdAt: number
}

export interface EvalRecommendationRow {
  id: string
  experimentId: string
  result: EvalRecommendationResult
  evidenceDigest: string
  pairedComparisons?: Array<{
    leftVariantId: string
    rightVariantId: string
    metric: "quality"
    result: import("@cognia/eval-core").BootstrapResult
  }>
  createdAt: number
}

export interface EvalConfigurationApplyRow {
  id: string
  experimentId: string
  targetType: "default-model" | "character" | "workflow" | "routing-policy"
  targetId: string
  previousConfiguration: Record<string, unknown>
  appliedConfiguration: Record<string, unknown>
  appliedAt: number
  rolledBackAt?: number
}

export interface EvalAssetRow {
  digest: string
  mediaType: string
  size: number
  encryptedBytes: EvalEncryptedEnvelope
  referenceCount: number
  clearance?: {
    method: "scan" | "manual"
    actorId?: string
    scannerId?: string
    evidenceDigest?: string
    clearedAt: number
    contentDigest: string
  }
  createdAt: number
  expiresAt: number
}

export async function saveEvalAsset(asset: EvalAssetRow): Promise<void> {
  const existing = await getDb().evalAssets.get(asset.digest)
  if (existing) {
    if (existing.mediaType !== asset.mediaType || existing.size !== asset.size) {
      throw new Error(`Evaluation asset ${asset.digest} metadata does not match stored content`)
    }
    await getDb().evalAssets.update(asset.digest, {
      expiresAt: Math.max(existing.expiresAt, asset.expiresAt),
    })
    return
  }
  await getDb().evalAssets.add(asset)
}

export async function saveEvalProject(project: EvalProject): Promise<void> {
  await getDb().evalProjects.put(project)
}

export async function listEvalProjects(): Promise<EvalProjectRow[]> {
  const projects = await getDb().evalProjects.toArray()
  return projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listEvalExperiments(projectId: string): Promise<EvalExperimentRow[]> {
  const experiments = await getDb().evalExperiments.where("projectId").equals(projectId).toArray()
  return experiments.sort((left, right) => right.createdAt - left.createdAt)
}

export async function getLatestEvalConfigurationApply(
  experimentId: string
): Promise<EvalConfigurationApplyRow | undefined> {
  const rows = await getDb()
    .evalConfigurationApplies.where("experimentId")
    .equals(experimentId)
    .toArray()
  return rows.sort((left, right) => right.appliedAt - left.appliedAt)[0]
}

export async function createEvalExperiment(manifest: EvalExperimentManifest): Promise<void> {
  const db = getDb()
  if (await db.evalExperiments.get(manifest.id)) {
    throw new Error(`Evaluation experiment ${manifest.id} already exists`)
  }
  await db.evalExperiments.add({
    id: manifest.id,
    projectId: manifest.projectId,
    manifest,
    state: "draft",
    spentCost: 0,
    reservedCost: 0,
    budgetCap: manifest.budget.hardCap,
    budgetExtensions: [],
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
  })
}

export async function getEvalExperiment(id: string): Promise<EvalExperimentRow | undefined> {
  return getDb().evalExperiments.get(id)
}

export async function completeEvalTask(input: {
  task: EvalTask
  sample: EvalSampleRow
  scores: EvalScoreRow[]
}): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    [db.evalSamples, db.evalScores, db.evalTasks, db.evalExperiments],
    async () => {
      const experiment = await db.evalExperiments.get(input.task.experimentId)
      if (!experiment) throw new Error(`Evaluation experiment ${input.task.experimentId} not found`)
      await db.evalSamples.add(input.sample)
      if (input.scores.length) await db.evalScores.bulkAdd(input.scores)
      await db.evalTasks.update(input.task.id, {
        state: "completed",
        reservedCost: 0,
        updatedAt: Date.now(),
      })
      await db.evalExperiments.update(experiment.id, {
        spentCost: experiment.spentCost + input.sample.actualCost,
        reservedCost: Math.max(0, experiment.reservedCost - input.task.reservedCost),
        updatedAt: Date.now(),
      })
    }
  )
}

export async function recoverInterruptedEvalWork(experimentId: string): Promise<{
  interruptedTaskIds: string[]
  requeuedTaskIds: string[]
}> {
  const db = getDb()
  const running = await db.evalTasks
    .where("[experimentId+state]")
    .equals([experimentId, "running"])
    .toArray()
  const interruptedTaskIds = running.filter((task) => !task.idempotencyKey).map((task) => task.id)
  const requeuedTaskIds = running.filter((task) => task.idempotencyKey).map((task) => task.id)
  await db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
    const releasedReservation = running.reduce((sum, task) => sum + task.reservedCost, 0)
    if (interruptedTaskIds.length) {
      await db.evalTasks.where("id").anyOf(interruptedTaskIds).modify({
        state: "interrupted",
        reservedCost: 0,
        interruptionSpendAmbiguous: true,
        updatedAt: Date.now(),
      })
    }
    if (requeuedTaskIds.length) {
      await db.evalTasks.where("id").anyOf(requeuedTaskIds).modify({
        state: "queued",
        reservedCost: 0,
        updatedAt: Date.now(),
      })
    }
    const experiment = await db.evalExperiments.get(experimentId)
    await db.evalExperiments.update(experimentId, {
      state: interruptedTaskIds.length > 0 ? "interrupted" : "queued",
      pauseReason: interruptedTaskIds.length > 0 ? "recovery" : undefined,
      reservedCost: Math.max(0, (experiment?.reservedCost ?? 0) - releasedReservation),
      updatedAt: Date.now(),
    })
  })
  return { interruptedTaskIds, requeuedTaskIds }
}

export async function deleteExpiredEvalArtifacts(now = Date.now()): Promise<{
  samplesDeleted: number
  assetsDeleted: number
}> {
  const db = getDb()
  return db.transaction("rw", [db.evalSamples, db.evalAssets], async () => {
    const samplesDeleted = await db.evalSamples.where("expiresAt").belowOrEqual(now).delete()
    const assetsDeleted = await db.evalAssets
      .filter((asset) => asset.referenceCount <= 0 && asset.expiresAt <= now)
      .delete()
    return { samplesDeleted, assetsDeleted }
  })
}

export async function markEvalAssetCleared(
  digest: string,
  clearance:
    | { method: "manual"; actorId: string }
    | { method: "scan"; scannerId: string; evidenceDigest: string },
  now = Date.now()
): Promise<void> {
  const asset = await getDb().evalAssets.get(digest)
  if (!asset) throw new Error(`Evaluation asset ${digest} is unavailable`)
  if (clearance.method === "manual" && !clearance.actorId?.trim()) {
    throw new Error("Manual media clearance requires reviewer identity")
  }
  if (
    clearance.method === "scan" &&
    (!clearance.scannerId.trim() || !clearance.evidenceDigest.trim())
  ) {
    throw new Error("Scanned media clearance requires scanner identity and evidence")
  }
  await getDb().evalAssets.update(digest, {
    clearance: {
      method: clearance.method,
      ...(clearance.method === "manual"
        ? { actorId: clearance.actorId.trim() }
        : {
            scannerId: clearance.scannerId.trim(),
            evidenceDigest: clearance.evidenceDigest.trim(),
          }),
      clearedAt: now,
      contentDigest: asset.digest,
    },
  })
}

export async function mergeEvalReviewVotes(votes: EvalReviewVoteRow[]): Promise<number> {
  if (!votes.length) return 0
  const db = getDb()
  const unique = new Map(votes.map((vote) => [vote.id, vote]))
  const existing = new Set(
    await db.evalReviewVotes
      .where("id")
      .anyOf([...unique.keys()])
      .primaryKeys()
  )
  const additions = [...unique.values()].filter((vote) => !existing.has(vote.id))
  if (additions.length) await db.evalReviewVotes.bulkAdd(additions)
  return additions.length
}
