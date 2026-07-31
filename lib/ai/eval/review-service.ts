import {
  buildBlindAssignments,
  type BlindPairInput,
  type BlindPrivateMapping,
  type BlindPublicAssignment,
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

export async function createBlindReviewBatch(input: {
  experimentId: string
  pairs: BlindPairInput[]
  seed: number
  artifactKey: Uint8Array
}): Promise<EvalReviewBatchRow> {
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
  await getDb().evalReviewBatches.add(row)
  return row
}

export async function openBlindReviewBatch(
  batchId: string,
  artifactKey: Uint8Array
): Promise<OpenReviewBatch> {
  const batch = await getDb().evalReviewBatches.get(batchId)
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
  return { assignments, privateMapping }
}

export async function createEvalReviewBundle(
  batchId: string,
  artifactKey: Uint8Array,
  votes: EvalReviewVoteRow[],
  password: string
): Promise<EvalReviewBundle> {
  const batch = await getDb().evalReviewBatches.get(batchId)
  if (!batch) throw new Error(`Evaluation review batch ${batchId} not found`)
  const { assignments } = await openBlindReviewBatch(batchId, artifactKey)
  const dataKey = createEvalDataKey()
  const payload: EvalReviewBundlePayload = {
    batchId,
    experimentId: batch.experimentId,
    blindedAssignmentDigest: batch.blindedAssignmentDigest,
    assignments,
    votes,
  }
  return {
    schema: "cognia-eval-review/v1",
    wrappedKey: await wrapEvalDataKey(dataKey, password),
    payload: await encryptEvalArtifact(dataKey, payload),
  }
}

export async function importEvalReviewBundle(
  bundle: EvalReviewBundle,
  password: string
): Promise<number> {
  if (bundle.schema !== "cognia-eval-review/v1") {
    throw new Error("Unsupported evaluation review bundle")
  }
  const payload = await decryptEvalArtifact<EvalReviewBundlePayload>(
    await unwrapEvalDataKey(bundle.wrappedKey, password),
    bundle.payload
  )
  const batch = await getDb().evalReviewBatches.get(payload.batchId)
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
  return mergeEvalReviewVotes(payload.votes)
}

export async function adjudicateEvalReview(input: {
  batchId: string
  pairId: string
  adjudicatorId: string
  decision: EvalAdjudicationRow["decision"]
  reasoning?: string
  artifactKey: Uint8Array
}): Promise<EvalAdjudicationRow> {
  const batch = await getDb().evalReviewBatches.get(input.batchId)
  if (!batch) throw new Error(`Evaluation review batch ${input.batchId} not found`)
  const row: EvalAdjudicationRow = {
    id: crypto.randomUUID(),
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
  await getDb().transaction(
    "rw",
    [getDb().evalAdjudications, getDb().evalReviewBatches],
    async () => {
      await getDb().evalAdjudications.add(row)
      await getDb().evalReviewBatches.update(batch.id, {
        status: "adjudicated",
        updatedAt: Date.now(),
      })
    }
  )
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
