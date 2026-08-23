import {
  decryptContentEnvelope,
  encryptContentEnvelope,
  type EncryptedContentEnvelopeV1,
} from "@cognia/rag"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import { redactText } from "@cognia/redact"
import { loadOrCreateAccountArtifactKey } from "@/lib/ai/eval/artifact-crypto"
import { addCase, importedCaseId } from "@/lib/db/eval-datasets"
import { getDb } from "@/lib/db/schema"
import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import type {
  WorkflowAnnotationEntry,
  WorkflowAnnotationMatch,
  WorkflowAnnotationSet,
  WorkflowAnnotationSetRevision,
  WorkflowFeedbackCandidate,
  WorkflowFeedbackPayload,
  WorkflowFeedbackRating,
} from "@/types/workflow/quality"

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export interface WorkflowQualityCryptoDeps {
  loadKey?: (accountId: string, domain: string) => Promise<Uint8Array>
  embed?: (
    text: string,
    config: Pick<
      WorkflowAnnotationSetRevision,
      "embeddingProfileId" | "embeddingProvider" | "embeddingModel" | "vectorBackend"
    >,
    purpose: "document" | "query"
  ) => Promise<number[]>
}

export class WorkflowQualityError extends Error {
  constructor(
    readonly code:
      | "invalid_feedback"
      | "feedback_not_found"
      | "invalid_transition"
      | "authentication_required"
      | "annotation_set_not_found"
      | "annotation_revision_invalid",
    message: string
  ) {
    super(message)
    this.name = "WorkflowQualityError"
  }
}

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

async function key(
  accountId: string,
  domain: string,
  usage: KeyUsage,
  deps: WorkflowQualityCryptoDeps
): Promise<CryptoKey> {
  const raw = deps.loadKey
    ? await deps.loadKey(accountId, domain)
    : await loadOrCreateAccountArtifactKey(accountId, domain)
  return crypto.subtle.importKey("raw", bytes(raw), { name: "AES-GCM" }, false, [usage])
}

async function encryptJson(
  accountId: string,
  domain: string,
  aad: string,
  value: unknown,
  deps: WorkflowQualityCryptoDeps
): Promise<EncryptedContentEnvelopeV1> {
  return encryptContentEnvelope(JSON.stringify(value), {
    key: await key(accountId, domain, "encrypt", deps),
    keyId: `${domain}-v1`,
    additionalData: aad,
  })
}

async function decryptJson<T>(
  accountId: string,
  domain: string,
  aad: string,
  envelope: EncryptedContentEnvelopeV1,
  deps: WorkflowQualityCryptoDeps
): Promise<T> {
  const plaintext = await decryptContentEnvelope(envelope, {
    key: await key(accountId, domain, "decrypt", deps),
    additionalData: aad,
  })
  return JSON.parse(plaintext) as T
}

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function feedbackAad(
  row: Pick<WorkflowFeedbackCandidate, "id" | "accountId" | "appId" | "appReleaseId">
): string {
  return `workflow-feedback-v1:${row.accountId}:${row.appId}:${row.appReleaseId}:${row.id}`
}

function annotationAad(
  row: Pick<WorkflowAnnotationSetRevision, "id" | "accountId" | "appId" | "setId" | "sequence">
): string {
  return `workflow-annotation-v1:${row.accountId}:${row.appId}:${row.setId}:${row.sequence}:${row.id}`
}

function normalizeFeedbackPayload(payload: WorkflowFeedbackPayload): WorkflowFeedbackPayload {
  const input = payload.input.trim()
  const output = payload.output.trim()
  const correction = payload.correction?.trim()
  if (!input || !output) {
    throw new WorkflowQualityError("invalid_feedback", "Feedback input and output are required")
  }
  if (input.length > 100_000 || output.length > 100_000 || (correction?.length ?? 0) > 100_000) {
    throw new WorkflowQualityError("invalid_feedback", "Feedback content exceeds the size limit")
  }
  return {
    input,
    output,
    ...(correction ? { correction } : {}),
    tags: [...new Set(payload.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 50),
  }
}

export async function submitWorkflowFeedback(
  input: {
    accountId: string
    appId: string
    appReleaseId: string
    externalSubjectKey: string
    rating: WorkflowFeedbackRating
    payload: WorkflowFeedbackPayload
    runId?: string
    conversationId?: string
    messageId?: string
    now?: number
  },
  deps: WorkflowQualityCryptoDeps = {}
): Promise<WorkflowFeedbackCandidate> {
  if (!input.externalSubjectKey.trim()) {
    throw new WorkflowQualityError("invalid_feedback", "Feedback subject is required")
  }
  const payload = normalizeFeedbackPayload(input.payload)
  const fingerprint = await digest(
    JSON.stringify([
      input.appId,
      input.messageId ?? input.runId ?? "",
      payload.input,
      payload.output,
    ])
  )
  const existing = await getDb()
    .workflowFeedbackCandidates.where("[accountId+fingerprint]")
    .equals([input.accountId, fingerprint])
    .first()
  if (existing) return existing
  const now = input.now ?? Date.now()
  const identity = {
    id: `wff_${crypto.randomUUID()}`,
    accountId: input.accountId,
    appId: input.appId,
    appReleaseId: input.appReleaseId,
  }
  const candidate: WorkflowFeedbackCandidate = {
    ...identity,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    externalSubjectKey: input.externalSubjectKey,
    rating: input.rating,
    status: "candidate",
    fingerprint,
    envelope: await encryptJson(
      input.accountId,
      "workflow-feedback",
      feedbackAad(identity),
      payload,
      deps
    ),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + RETENTION_MS,
  }
  try {
    await getDb().workflowFeedbackCandidates.add(candidate)
  } catch (error) {
    if ((error as { name?: string }).name === "ConstraintError") {
      return (
        (await getDb()
          .workflowFeedbackCandidates.where("[accountId+fingerprint]")
          .equals([input.accountId, fingerprint])
          .first()) ?? candidate
      )
    }
    throw error
  }
  return candidate
}

export async function openWorkflowFeedback(
  accountId: string,
  feedbackId: string,
  deps: WorkflowQualityCryptoDeps = {}
): Promise<{ candidate: WorkflowFeedbackCandidate; payload: WorkflowFeedbackPayload }> {
  const candidate = await getDb().workflowFeedbackCandidates.get(feedbackId)
  if (!candidate || candidate.accountId !== accountId) {
    throw new WorkflowQualityError("feedback_not_found", "Workflow feedback was not found")
  }
  const payload = await decryptJson<WorkflowFeedbackPayload>(
    accountId,
    "workflow-feedback",
    feedbackAad(candidate),
    candidate.envelope,
    deps
  )
  return { candidate, payload }
}

export async function reviewWorkflowFeedback(
  input: {
    accountId: string
    feedbackId: string
    reviewerSubjectId: string
    decision: "confirm" | "reject"
    reason: string
    now?: number
  },
  deps: WorkflowQualityCryptoDeps = {}
): Promise<WorkflowFeedbackCandidate> {
  if (!input.reviewerSubjectId.trim()) {
    throw new WorkflowQualityError("authentication_required", "OIDC reviewer is required")
  }
  const { candidate, payload } = await openWorkflowFeedback(input.accountId, input.feedbackId, deps)
  if (candidate.status !== "candidate") {
    throw new WorkflowQualityError("invalid_transition", "Feedback was already reviewed")
  }
  const now = input.now ?? Date.now()
  const redacted: WorkflowFeedbackPayload = {
    input: redactText(payload.input).redacted,
    output: redactText(payload.output).redacted,
    ...(payload.correction ? { correction: redactText(payload.correction).redacted } : {}),
    tags: payload.tags.map((tag) => redactText(tag).redacted),
  }
  const updated: WorkflowFeedbackCandidate = {
    ...candidate,
    status: input.decision === "confirm" ? "confirmed" : "rejected",
    envelope: await encryptJson(
      candidate.accountId,
      "workflow-feedback",
      feedbackAad(candidate),
      redacted,
      deps
    ),
    reviewedBy: input.reviewerSubjectId,
    reviewReason: input.reason.slice(0, 500),
    updatedAt: now,
  }
  await getDb().workflowFeedbackCandidates.put(updated)
  return updated
}

export async function removeWorkflowFeedback(input: {
  accountId: string
  feedbackId: string
  externalSubjectKey: string
  now?: number
}): Promise<void> {
  const candidate = await getDb().workflowFeedbackCandidates.get(input.feedbackId)
  if (
    !candidate ||
    candidate.accountId !== input.accountId ||
    candidate.externalSubjectKey !== input.externalSubjectKey
  ) {
    throw new WorkflowQualityError("feedback_not_found", "Workflow feedback was not found")
  }
  if (candidate.status !== "candidate") {
    throw new WorkflowQualityError("invalid_transition", "Reviewed feedback cannot be removed")
  }
  const now = input.now ?? Date.now()
  await getDb().workflowFeedbackCandidates.put({
    ...candidate,
    status: "rejected",
    reviewReason: "Removed by feedback author",
    updatedAt: now,
  })
}

export async function promoteWorkflowFeedbackToEval(
  input: { accountId: string; feedbackId: string; datasetId: string; reviewerSubjectId: string },
  deps: WorkflowQualityCryptoDeps = {}
): Promise<{ feedback: WorkflowFeedbackCandidate; caseId: string }> {
  if (!input.reviewerSubjectId.trim()) {
    throw new WorkflowQualityError("authentication_required", "OIDC reviewer is required")
  }
  const { candidate, payload } = await openWorkflowFeedback(input.accountId, input.feedbackId, deps)
  if (candidate.status === "promoted" && candidate.promotedCaseId) {
    return { feedback: candidate, caseId: candidate.promotedCaseId }
  }
  if (candidate.status !== "confirmed") {
    throw new WorkflowQualityError("invalid_transition", "Only confirmed feedback can be promoted")
  }
  const caseId = importedCaseId(input.datasetId, candidate.id)
  await addCase(input.datasetId, {
    id: caseId,
    input: payload.input,
    reference: {
      expectedOutput: payload.correction ?? payload.output,
      grading: { mode: "exact", normalize: { caseInsensitive: true, collapseWhitespace: true } },
    },
    source: "real-trace",
    ...(candidate.runId ? { sourceTraceId: candidate.runId } : {}),
    tags: [...payload.tags, `workflow-app:${candidate.appId}`],
    metadata: {
      workflowFeedbackId: candidate.id,
      appReleaseId: candidate.appReleaseId,
      promotedBy: input.reviewerSubjectId,
    },
  })
  const feedback: WorkflowFeedbackCandidate = {
    ...candidate,
    status: "promoted",
    promotedDatasetId: input.datasetId,
    promotedCaseId: caseId,
    updatedAt: Date.now(),
  }
  await getDb().workflowFeedbackCandidates.put(feedback)
  return { feedback, caseId }
}

export async function createWorkflowAnnotationSet(input: {
  accountId: string
  appId: string
  name: string
  createdBy: string
  now?: number
}): Promise<WorkflowAnnotationSet> {
  if (!input.createdBy.trim()) {
    throw new WorkflowQualityError("authentication_required", "OIDC owner is required")
  }
  const now = input.now ?? Date.now()
  const set: WorkflowAnnotationSet = {
    id: `wfas_${crypto.randomUUID()}`,
    accountId: input.accountId,
    appId: input.appId,
    name: input.name.trim() || "Annotation set",
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  }
  await getDb().workflowAnnotationSets.add(set)
  return set
}

async function embed(
  text: string,
  config: Pick<
    WorkflowAnnotationSetRevision,
    "embeddingProfileId" | "embeddingProvider" | "embeddingModel" | "vectorBackend"
  >,
  purpose: "document" | "query",
  deps: WorkflowQualityCryptoDeps
): Promise<number[]> {
  if (deps.embed) return deps.embed(text, config, purpose)
  const result = await generateSafeEmbedding(text, {
    profileId: config.embeddingProfileId,
    purpose,
    embedding: {
      provider: config.embeddingProvider as RagEmbeddingProvider,
      model: config.embeddingModel,
    },
    vectorBackend: config.vectorBackend,
  })
  return result.embedding
}

export async function createWorkflowAnnotationRevision(
  input: {
    accountId: string
    appId: string
    setId: string
    createdBy: string
    entries: Array<Omit<WorkflowAnnotationEntry, "vector">>
    embeddingProfileId: string
    embeddingProvider: string
    embeddingModel: string
    vectorBackend: WorkflowAnnotationSetRevision["vectorBackend"]
    now?: number
  },
  deps: WorkflowQualityCryptoDeps = {}
): Promise<WorkflowAnnotationSetRevision> {
  if (!input.createdBy.trim()) {
    throw new WorkflowQualityError("authentication_required", "OIDC author is required")
  }
  const set = await getDb().workflowAnnotationSets.get(input.setId)
  if (!set || set.accountId !== input.accountId || set.appId !== input.appId) {
    throw new WorkflowQualityError("annotation_set_not_found", "Annotation set was not found")
  }
  const errors: string[] = []
  if (input.entries.length === 0) errors.push("At least one annotation entry is required")
  const ids = new Set<string>()
  const normalized = input.entries.map((entry, index) => {
    const id = entry.id.trim()
    const question = entry.question.trim()
    const answer = entry.answer.trim()
    if (!id || ids.has(id)) errors.push(`Entry ${index + 1} has a missing or duplicate id`)
    if (!question || !answer) errors.push(`Entry ${index + 1} requires a question and answer`)
    ids.add(id)
    return { ...entry, id, question, answer, tags: [...new Set(entry.tags)] }
  })
  if (errors.length > 0) {
    throw new WorkflowQualityError("annotation_revision_invalid", errors.join("; "))
  }
  const config = {
    embeddingProfileId: input.embeddingProfileId,
    embeddingProvider: input.embeddingProvider,
    embeddingModel: input.embeddingModel,
    vectorBackend: input.vectorBackend,
  }
  const entries: WorkflowAnnotationEntry[] = []
  for (const entry of normalized) {
    entries.push({ ...entry, vector: await embed(entry.question, config, "document", deps) })
  }
  const dimensions = new Set(entries.map((entry) => entry.vector.length))
  if (
    dimensions.size !== 1 ||
    entries.some((entry) => entry.vector.some((value) => !Number.isFinite(value)))
  ) {
    throw new WorkflowQualityError(
      "annotation_revision_invalid",
      "Annotation embeddings have inconsistent dimensions or invalid values"
    )
  }
  const prior = await getDb()
    .workflowAnnotationSetRevisions.where("setId")
    .equals(input.setId)
    .sortBy("sequence")
  const sequence = (prior.at(-1)?.sequence ?? 0) + 1
  const now = input.now ?? Date.now()
  const identity = {
    id: `wfasr_${input.setId}_${sequence}`,
    accountId: input.accountId,
    appId: input.appId,
    setId: input.setId,
    sequence,
  }
  const revision: WorkflowAnnotationSetRevision = {
    ...identity,
    digest: await digest(JSON.stringify(entries)),
    entryCount: entries.length,
    dimensions: entries[0].vector.length,
    ...config,
    validation: { valid: true, errors: [], validatedAt: now },
    envelope: await encryptJson(
      input.accountId,
      "workflow-annotation",
      annotationAad(identity),
      entries,
      deps
    ),
    createdAt: now,
    createdBy: input.createdBy,
  }
  await getDb().workflowAnnotationSetRevisions.add(revision)
  return revision
}

export async function publishWorkflowAnnotationRevision(input: {
  accountId: string
  setId: string
  revisionId: string
  actorSubjectId: string
  now?: number
}): Promise<WorkflowAnnotationSet> {
  if (!input.actorSubjectId.trim()) {
    throw new WorkflowQualityError("authentication_required", "OIDC publisher is required")
  }
  const db = getDb()
  return db.transaction(
    "rw",
    [db.workflowAnnotationSets, db.workflowAnnotationSetRevisions],
    async () => {
      const [set, revision] = await Promise.all([
        db.workflowAnnotationSets.get(input.setId),
        db.workflowAnnotationSetRevisions.get(input.revisionId),
      ])
      if (!set || set.accountId !== input.accountId || !revision || revision.setId !== set.id) {
        throw new WorkflowQualityError(
          "annotation_set_not_found",
          "Annotation revision was not found"
        )
      }
      if (!revision.validation.valid) {
        throw new WorkflowQualityError(
          "annotation_revision_invalid",
          "Annotation revision is invalid"
        )
      }
      const updated = {
        ...set,
        currentRevisionId: revision.id,
        updatedAt: input.now ?? Date.now(),
      }
      await db.workflowAnnotationSets.put(updated)
      return updated
    }
  )
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : -1
}

export async function matchWorkflowAnnotation(
  input: { accountId: string; revisionId: string; query: string; threshold: number },
  deps: WorkflowQualityCryptoDeps = {}
): Promise<WorkflowAnnotationMatch | undefined> {
  const revision = await getDb().workflowAnnotationSetRevisions.get(input.revisionId)
  if (!revision || revision.accountId !== input.accountId || !revision.validation.valid) {
    throw new WorkflowQualityError("annotation_set_not_found", "Annotation revision was not found")
  }
  const entries = await decryptJson<WorkflowAnnotationEntry[]>(
    input.accountId,
    "workflow-annotation",
    annotationAad(revision),
    revision.envelope,
    deps
  )
  const queryVector = await embed(input.query, revision, "query", deps)
  let best: { entry: WorkflowAnnotationEntry; score: number } | undefined
  for (const entry of entries) {
    const score = cosine(queryVector, entry.vector)
    if (!best || score > best.score) best = { entry, score }
  }
  if (!best || best.score < input.threshold) return undefined
  return {
    revisionId: revision.id,
    setId: revision.setId,
    entryId: best.entry.id,
    answer: best.entry.answer,
    tags: best.entry.tags,
    score: best.score,
  }
}

export function pruneExpiredWorkflowFeedback(now = Date.now()): Promise<number> {
  return getDb().workflowFeedbackCandidates.where("expiresAt").belowOrEqual(now).delete()
}
