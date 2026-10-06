import {
  buildBlindAssignments,
  type BlindPairInput,
  type BlindPrivateMapping,
  type BlindPublicAssignment,
  type EvalReportCaseEvidence,
} from "@cognia/eval-core"
import {
  createEvalDataKey,
  decryptEvalArtifact,
  encryptEvalArtifact,
  unwrapEvalDataKey,
  wrapEvalDataKey,
  type EvalEncryptedEnvelope,
  type EvalWrappedDataKey,
} from "./artifact-crypto"
import {
  mergeEvalReviewVotes,
  type EvalAdjudicationRow,
  type EvalReviewBatchRow,
  type EvalReviewVoteRow,
} from "@/lib/db/eval-lab"
import { getDb } from "@/lib/db/schema"
import { refreshEvalRecommendationAfterReview, type EvalFinalizationScope } from "./finalization"

function captureScope(): EvalFinalizationScope {
  return { db: getDb(), assertActive: () => {} }
}

interface OpenReviewBatch {
  assignments: BlindPublicAssignment[]
  privateMapping: Record<string, BlindPrivateMapping>
}

export interface EvalReviewBundle {
  schema: "cognia-eval-review/v1"
  wrappedKey: EvalWrappedDataKey
  payload: EvalEncryptedEnvelope
}

interface EvalReviewBundlePayload {
  batchId: string
  experimentId: string
  blindedAssignmentDigest: string
  assignments: BlindPublicAssignment[]
  votes: EvalReviewVoteRow[]
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )
  return `sha256:${Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}

export async function createBlindReviewBatch(
  input: {
    experimentId: string
    pairs: BlindPairInput[]
    seed: number
    artifactKey: Uint8Array
  },
  scope = captureScope(),
  reuseExisting = false
): Promise<EvalReviewBatchRow> {
  scope.assertActive()
  if (!input.pairs.length) throw new Error("A review batch requires at least one comparison pair")
  const blinded = buildBlindAssignments(input.pairs, input.seed)
  const now = Date.now()
  const row: EvalReviewBatchRow = {
    id: crypto.randomUUID(),
    experimentId: input.experimentId,
    status: "open",
    blindedAssignmentDigest: await digest(blinded.publicAssignments),
    encryptedAssignments: await encryptEvalArtifact(input.artifactKey, blinded.publicAssignments),
    encryptedPrivateMapping: await encryptEvalArtifact(input.artifactKey, blinded.privateMapping),
    createdAt: now,
    updatedAt: now,
  }
  scope.assertActive()
  return scope.db.transaction("rw", scope.db.evalReviewBatches, async () => {
    scope.assertActive()
    if (reuseExisting) {
      const batches = await scope.db.evalReviewBatches
        .where("experimentId")
        .equals(input.experimentId)
        .toArray()
      scope.assertActive()
      const latest = batches.sort((left, right) => right.createdAt - left.createdAt)[0]
      if (latest?.blindedAssignmentDigest === row.blindedAssignmentDigest) return latest
      // Stable ordering also applies to batches created in the same clock tick.
      row.createdAt = Math.max(row.createdAt, (latest?.createdAt ?? 0) + 1)
      row.updatedAt = row.createdAt
    }
    await scope.db.evalReviewBatches.add(row)
    scope.assertActive()
    return row
  })
}

export async function openBlindReviewBatch(
  batchId: string,
  artifactKey: Uint8Array,
  scope = captureScope()
): Promise<OpenReviewBatch> {
  scope.assertActive()
  const batch = await scope.db.evalReviewBatches.get(batchId)
  if (!batch?.encryptedAssignments || !batch.encryptedPrivateMapping) {
    throw new Error(`Evaluation review batch ${batchId} is unavailable`)
  }
  const [assignments, privateMapping] = await Promise.all([
    decryptEvalArtifact<BlindPublicAssignment[]>(artifactKey, batch.encryptedAssignments),
    decryptEvalArtifact<Record<string, BlindPrivateMapping>>(
      artifactKey,
      batch.encryptedPrivateMapping
    ),
  ])
  scope.assertActive()
  return { assignments, privateMapping }
}

export async function createEvalReviewBundle(
  batchId: string,
  artifactKey: Uint8Array,
  votes: EvalReviewVoteRow[],
  password: string,
  scope = captureScope()
): Promise<EvalReviewBundle> {
  scope.assertActive()
  const batch = await scope.db.evalReviewBatches.get(batchId)
  if (!batch) throw new Error(`Evaluation review batch ${batchId} not found`)
  const { assignments } = await openBlindReviewBatch(batchId, artifactKey, scope)
  const dataKey = createEvalDataKey()
  const payload: EvalReviewBundlePayload = {
    batchId,
    experimentId: batch.experimentId,
    blindedAssignmentDigest: batch.blindedAssignmentDigest,
    assignments,
    votes,
  }
  const bundle: EvalReviewBundle = {
    schema: "cognia-eval-review/v1",
    wrappedKey: await wrapEvalDataKey(dataKey, password),
    payload: await encryptEvalArtifact(dataKey, payload),
  }
  scope.assertActive()
  return bundle
}

export async function importEvalReviewBundle(
  bundle: EvalReviewBundle,
  password: string,
  scope = captureScope(),
  expected?: { experimentId: string; batchId: string }
): Promise<number> {
  scope.assertActive()
  if (bundle.schema !== "cognia-eval-review/v1") {
    throw new Error("Unsupported evaluation review bundle")
  }
  const payload = await decryptEvalArtifact<EvalReviewBundlePayload>(
    await unwrapEvalDataKey(bundle.wrappedKey, password),
    bundle.payload
  )
  scope.assertActive()
  if (
    expected &&
    (payload.experimentId !== expected.experimentId || payload.batchId !== expected.batchId)
  ) {
    throw new Error("Review bundle does not match the selected evaluation batch")
  }
  const batch = await scope.db.evalReviewBatches.get(payload.batchId)
  if (!batch || batch.experimentId !== payload.experimentId) {
    throw new Error("Review bundle does not match a local evaluation batch")
  }
  if (
    payload.blindedAssignmentDigest !== batch.blindedAssignmentDigest ||
    (await digest(payload.assignments)) !== batch.blindedAssignmentDigest
  ) {
    throw new Error("Review assignment digest mismatch")
  }
  if (
    payload.votes.some(
      (vote) => vote.batchId !== batch.id || vote.experimentId !== batch.experimentId
    )
  ) {
    throw new Error("Review bundle contains votes for another batch")
  }
  const pairIds = new Set(payload.assignments.map((assignment) => assignment.pairId))
  if (
    payload.votes.some(
      (vote) =>
        !pairIds.has(vote.pairId) ||
        !vote.id ||
        !vote.reviewerId?.trim() ||
        !["a", "b", "tie", "abstain"].includes(vote.preference) ||
        !Number.isFinite(vote.createdAt)
    )
  ) {
    throw new Error("Review bundle contains an invalid vote")
  }
  scope.assertActive()
  return scope.db.transaction(
    "rw",
    [scope.db.evalReviewVotes, scope.db.evalReviewBatches],
    async () => {
      scope.assertActive()
      const result = await mergeEvalReviewVotes(payload.votes, scope)
      scope.assertActive()
      if (result > 0) await advanceReviewRevision(scope, batch.id)
      scope.assertActive()
      return result
    }
  )
}

export async function adjudicateEvalReview(
  input: {
    batchId: string
    pairId: string
    adjudicatorId: string
    decision: EvalAdjudicationRow["decision"]
    reasoning?: string
    artifactKey: Uint8Array
  },
  scope = captureScope(),
  idempotencyId?: string
): Promise<EvalAdjudicationRow> {
  scope.assertActive()
  const batch = await scope.db.evalReviewBatches.get(input.batchId)
  if (!batch) throw new Error(`Evaluation review batch ${input.batchId} not found`)
  const row: EvalAdjudicationRow = {
    id: idempotencyId ?? crypto.randomUUID(),
    batchId: input.batchId,
    pairId: input.pairId,
    adjudicatorId: input.adjudicatorId,
    decision: input.decision,
    ...(input.reasoning
      ? {
          encryptedReasoning: await encryptEvalArtifact(input.artifactKey, {
            reasoning: input.reasoning,
          }),
        }
      : {}),
    createdAt: Date.now(),
  }
  scope.assertActive()
  await scope.db.transaction(
    "rw",
    [scope.db.evalAdjudications, scope.db.evalReviewBatches],
    async () => {
      scope.assertActive()
      if (idempotencyId && (await scope.db.evalAdjudications.get(idempotencyId))) {
        scope.assertActive()
        return
      }
      await scope.db.evalAdjudications.put(row)
      scope.assertActive()
      await scope.db.evalReviewBatches.update(batch.id, {
        status: "adjudicated",
        updatedAt: Date.now(),
      })
      await advanceReviewRevision(scope, batch.id)
      scope.assertActive()
    }
  )
  scope.assertActive()
  return row
}

export function reviewAgreement(
  votes: Array<Pick<EvalReviewVoteRow, "pairId" | "reviewerId" | "preference">>
): { eligiblePairs: number; agreedPairs: number; agreementRate: number } {
  const byPair = new Map<string, Set<EvalReviewVoteRow["preference"]>>()
  const reviewersByPair = new Map<string, Set<string>>()
  for (const vote of votes) {
    if (vote.preference === "abstain") continue
    const preferences = byPair.get(vote.pairId) ?? new Set()
    preferences.add(vote.preference)
    byPair.set(vote.pairId, preferences)
    const reviewers = reviewersByPair.get(vote.pairId) ?? new Set()
    reviewers.add(vote.reviewerId)
    reviewersByPair.set(vote.pairId, reviewers)
  }
  const eligible = [...byPair.keys()].filter(
    (pairId) => (reviewersByPair.get(pairId)?.size ?? 0) >= 2
  )
  const agreedPairs = eligible.filter((pairId) => byPair.get(pairId)?.size === 1).length
  return {
    eligiblePairs: eligible.length,
    agreedPairs,
    agreementRate: eligible.length ? agreedPairs / eligible.length : 0,
  }
}

export function buildBlindReviewPairs(cases: EvalReportCaseEvidence[]): BlindPairInput[] {
  const groups = new Map<string, EvalReportCaseEvidence[]>()
  for (const item of cases) {
    const key = `${item.case.id}:${item.repetition}`
    const rows = groups.get(key) ?? []
    rows.push(item)
    groups.set(key, rows)
  }
  const pairs: BlindPairInput[] = []
  for (const [key, rows] of groups) {
    const sorted = [...rows].sort((left, right) => left.variantId.localeCompare(right.variantId))
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const left = sorted[leftIndex]
        const right = sorted[rightIndex]
        pairs.push({
          pairId: `${key}:${left.variantId}:${right.variantId}`,
          first: {
            variantId: left.variantId,
            sampleId: left.sampleId,
            output: left.sample.output,
          },
          second: {
            variantId: right.variantId,
            sampleId: right.sampleId,
            output: right.sample.output,
          },
        })
      }
    }
  }
  return pairs
}

/** Must be called in the same transaction as the review mutation. */
async function advanceReviewRevision(scope: EvalFinalizationScope, batchId: string): Promise<void> {
  scope.assertActive()
  const batch = await scope.db.evalReviewBatches.get(batchId)
  scope.assertActive()
  if (!batch) throw new Error("Review batch is unavailable")
  await scope.db.evalReviewBatches.update(batchId, {
    reviewRevision: (batch.reviewRevision ?? 0) + 1,
    updatedAt: Date.now(),
  })
  scope.assertActive()
}

export interface EvalReviewSnapshot {
  batchId: string
  recommendationPending: boolean
  assignments: BlindPublicAssignment[]
  votes: Array<Pick<EvalReviewVoteRow, "id" | "pairId" | "reviewerId" | "preference">>
  agreement: ReturnType<typeof reviewAgreement>
}

export interface EvalReviewMutationResult {
  snapshot: EvalReviewSnapshot
  recommendation: { status: "updated" } | { status: "pending"; message: string }
}

export interface EvalReviewService {
  readonly scopeId: string
  load(input: { experimentId: string }): Promise<EvalReviewSnapshot | null>
  open(input: {
    experimentId: string
    cases: EvalReportCaseEvidence[]
    seed: number
  }): Promise<EvalReviewSnapshot>
  vote(input: {
    experimentId: string
    batchId: string
    pairId: string
    reviewerId: string
    preference: EvalReviewVoteRow["preference"]
  }): Promise<EvalReviewMutationResult>
  exportBundle(input: { experimentId: string; batchId: string; password: string }): Promise<string>
  importBundle(input: {
    experimentId: string
    batchId: string
    text: string
    password: string
  }): Promise<EvalReviewMutationResult>
  adjudicate(input: {
    experimentId: string
    batchId: string
    pairId: string
    adjudicatorId: string
    decision: EvalAdjudicationRow["decision"]
    reasoning?: string
  }): Promise<EvalReviewMutationResult>
  refreshRecommendation(input: {
    experimentId: string
    batchId: string
  }): Promise<EvalReviewMutationResult>
}

/** Account/target-scoped use cases. No artifact key or database row escapes to UI. */
export function createEvalReviewService(options: {
  artifactKey: Uint8Array
  assertActive(): void
  db?: ReturnType<typeof getDb>
}): EvalReviewService {
  const scope: EvalFinalizationScope = {
    db: options.db ?? getDb(),
    assertActive: options.assertActive,
  }
  const { db, assertActive } = scope
  const artifactKey = options.artifactKey
  assertActive()

  async function requireBatch(experimentId: string, batchId: string) {
    assertActive()
    const batch = await db.evalReviewBatches.get(batchId)
    assertActive()
    if (!batch || batch.experimentId !== experimentId)
      throw new Error("Review batch does not match the selected experiment")
    return batch
  }

  async function snapshot(experimentId: string, batchId: string): Promise<EvalReviewSnapshot> {
    await requireBatch(experimentId, batchId)
    const opened = await openBlindReviewBatch(batchId, artifactKey, scope)
    const votes = await db.evalReviewVotes.where("batchId").equals(batchId).toArray()
    const batch = await requireBatch(experimentId, batchId)
    return {
      batchId,
      recommendationPending: (batch.reviewRevision ?? 0) > (batch.recommendationRevision ?? 0),
      assignments: opened.assignments,
      votes: votes.map(({ id, pairId, reviewerId, preference }) => ({
        id,
        pairId,
        reviewerId,
        preference,
      })),
      agreement: reviewAgreement(votes),
    }
  }

  async function mutationResult(
    experimentId: string,
    batchId: string
  ): Promise<EvalReviewMutationResult> {
    const batch = await requireBatch(experimentId, batchId)
    const revision = batch.reviewRevision ?? 0
    try {
      await refreshEvalRecommendationAfterReview(experimentId, artifactKey, scope, {
        batchId,
        revision,
      })
      assertActive()
      const applied = await db.transaction("rw", db.evalReviewBatches, async () => {
        assertActive()
        const latest = await db.evalReviewBatches.get(batchId)
        assertActive()
        if (!latest || (latest.reviewRevision ?? 0) !== revision) return false
        await db.evalReviewBatches.update(batchId, { recommendationRevision: revision })
        assertActive()
        return true
      })
      if (!applied)
        return {
          snapshot: { ...(await snapshot(experimentId, batchId)), recommendationPending: true },
          recommendation: {
            status: "pending",
            message: "Review changed while recommendations were refreshed",
          },
        }
      const current = await snapshot(experimentId, batchId)
      return {
        snapshot: current,
        recommendation: current.recommendationPending
          ? {
              status: "pending",
              message: "Review changed while recommendations were refreshed",
            }
          : { status: "updated" },
      }
    } catch (cause) {
      assertActive()
      return {
        snapshot: { ...(await snapshot(experimentId, batchId)), recommendationPending: true },
        recommendation: {
          status: "pending",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }
    }
  }

  async function requirePair(experimentId: string, batchId: string, pairId: string) {
    const current = await snapshot(experimentId, batchId)
    if (!current.assignments.some((assignment) => assignment.pairId === pairId))
      throw new Error("Review pair is unavailable")
  }

  return {
    scopeId: crypto.randomUUID(),
    async load({ experimentId }) {
      assertActive()
      const batches = await db.evalReviewBatches
        .where("experimentId")
        .equals(experimentId)
        .toArray()
      assertActive()
      const latest = batches.sort((left, right) => right.createdAt - left.createdAt)[0]
      return latest ? snapshot(experimentId, latest.id) : null
    },
    async open({ experimentId, cases, seed }) {
      assertActive()
      const batch = await createBlindReviewBatch(
        { experimentId, pairs: buildBlindReviewPairs(cases), seed, artifactKey },
        scope,
        true
      )
      return snapshot(experimentId, batch.id)
    },
    async vote({ experimentId, batchId, pairId, reviewerId, preference }) {
      const reviewer = reviewerId.trim()
      if (!reviewer || !["a", "b", "tie", "abstain"].includes(preference))
        throw new TypeError("A valid reviewer and preference are required")
      await requirePair(experimentId, batchId, pairId)
      const id = await digest([batchId, pairId, reviewer])
      assertActive()
      await db.transaction("rw", [db.evalReviewVotes, db.evalReviewBatches], async () => {
        assertActive()
        const previous = await db.evalReviewVotes
          .where("[batchId+pairId]")
          .equals([batchId, pairId])
          .filter((vote) => vote.reviewerId === reviewer)
          .first()
        assertActive()
        if (previous?.preference === preference) return
        await db.evalReviewVotes.put({
          id: previous?.id ?? id,
          batchId,
          experimentId,
          pairId,
          reviewerId: reviewer,
          preference,
          rubric: {},
          createdAt: Date.now(),
        })
        await advanceReviewRevision(scope, batchId)
        assertActive()
      })
      return mutationResult(experimentId, batchId)
    },
    async exportBundle({ experimentId, batchId, password }) {
      if (!password) throw new TypeError("A review bundle password is required")
      await requireBatch(experimentId, batchId)
      const votes = await db.evalReviewVotes.where("batchId").equals(batchId).toArray()
      assertActive()
      const bundle = await createEvalReviewBundle(batchId, artifactKey, votes, password, scope)
      return JSON.stringify(bundle, null, 2)
    },
    async importBundle({ experimentId, batchId, text, password }) {
      if (!password) throw new TypeError("A review bundle password is required")
      await requireBatch(experimentId, batchId)
      await importEvalReviewBundle(JSON.parse(text) as EvalReviewBundle, password, scope, {
        experimentId,
        batchId,
      })
      return mutationResult(experimentId, batchId)
    },
    async adjudicate({ experimentId, batchId, pairId, adjudicatorId, decision, reasoning }) {
      const adjudicator = adjudicatorId.trim()
      if (!adjudicator || !["a", "b", "tie", "exclude"].includes(decision))
        throw new TypeError("A valid adjudicator and decision are required")
      await requirePair(experimentId, batchId, pairId)
      const id = await digest([batchId, pairId, adjudicator, decision, reasoning?.trim() ?? ""])
      assertActive()
      await adjudicateEvalReview(
        {
          batchId,
          pairId,
          adjudicatorId: adjudicator,
          decision,
          reasoning: reasoning?.trim() || undefined,
          artifactKey,
        },
        scope,
        id
      )
      return mutationResult(experimentId, batchId)
    },
    refreshRecommendation: ({ experimentId, batchId }) => mutationResult(experimentId, batchId),
  }
}
