import { sha256Hex } from "./retrieval-profile"
import type { RetrievalDomain, RetrievalTraceV1 } from "./retrieval-kernel"

export type IndexGenerationStatus = "staging" | "validating" | "active" | "retiring" | "failed"

export interface IndexGenerationValidation {
  count: number
  contentHash: string
  dimensions?: number
  valid: boolean
  failureCode?: string
}

export interface IndexGeneration {
  id: string
  corpusId: string
  domain: RetrievalDomain
  profileFingerprint: string
  status: IndexGenerationStatus
  createdAt: number
  activatedAt?: number
  retiredAt?: number
  failedAt?: number
  validation?: IndexGenerationValidation
}

export interface CreateIndexGenerationInput extends Omit<IndexGeneration, "status" | "validation"> {
  status?: IndexGenerationStatus
  validation?: IndexGenerationValidation
}

export function createIndexGeneration(input: CreateIndexGenerationInput): IndexGeneration {
  if (!input.id || !input.corpusId || !input.profileFingerprint) {
    throw new Error("Generation id, corpus id, and profile fingerprint are required")
  }
  return { ...input, status: input.status ?? "staging" }
}

export function activateValidatedGeneration(
  next: IndexGeneration,
  previous: IndexGeneration | undefined,
  now: number
): { active: IndexGeneration; retired?: IndexGeneration } {
  if (next.status !== "validating") throw new Error("Generation must be validating")
  if (!next.validation?.valid) throw new Error("Generation validation must pass before activation")
  if (previous && previous.status !== "active") {
    throw new Error("Previous generation must be active")
  }
  if (previous && (previous.corpusId !== next.corpusId || previous.domain !== next.domain)) {
    throw new Error("Generation activation cannot cross corpus or domain boundaries")
  }

  return {
    active: { ...next, status: "active", activatedAt: now },
    ...(previous ? { retired: { ...previous, status: "retiring" as const, retiredAt: now } } : {}),
  }
}

export type RetrievalJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "no_output"
  | "skipped"
  | "failed"
  | "cancelled"

export type RetrievalJobKind =
  | "ingest"
  | "reindex"
  | "reconcile"
  | "delete"
  | "key_rotation"
  | "memory_extract"
  | "memory_distill"
  | "memory_consolidate"

export interface RetrievalJob {
  id: string
  dedupeKey: string
  kind: RetrievalJobKind
  corpusId: string
  profileFingerprint?: string
  generationId?: string
  status: RetrievalJobStatus
  queuedAt: number
  startedAt?: number
  completedAt?: number
  nextAttemptAt?: number
  leaseOwner?: string
  leaseExpiresAt?: number
  heartbeatAt?: number
  attempt: number
  maxAttempts: number
  resultCode?: string
  cancellationRequestedAt?: number
}

export interface CreateRetrievalJobInput extends Omit<RetrievalJob, "status" | "attempt"> {
  status?: RetrievalJobStatus
  attempt?: number
}

const TERMINAL_JOB_STATUSES = new Set<RetrievalJobStatus>([
  "succeeded",
  "no_output",
  "skipped",
  "failed",
  "cancelled",
])

const JOB_TRANSITIONS: Record<RetrievalJobStatus, ReadonlySet<RetrievalJobStatus>> = {
  queued: new Set(["running", "cancelled", "skipped"]),
  running: new Set(["retry_wait", "succeeded", "no_output", "skipped", "failed", "cancelled"]),
  retry_wait: new Set(["running", "cancelled", "failed"]),
  succeeded: new Set(),
  no_output: new Set(),
  skipped: new Set(),
  failed: new Set(),
  cancelled: new Set(),
}

export class RetrievalJobTransitionError extends Error {
  constructor(from: RetrievalJobStatus, to: RetrievalJobStatus) {
    super(`Invalid retrieval job transition: ${from} -> ${to}`)
    this.name = "RetrievalJobTransitionError"
  }
}

export function createRetrievalJob(input: CreateRetrievalJobInput): RetrievalJob {
  if (!input.id || !input.dedupeKey || !input.corpusId) {
    throw new Error("Job id, dedupe key, and corpus id are required")
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("Job maxAttempts must be a positive integer")
  }
  return { ...input, status: input.status ?? "queued", attempt: input.attempt ?? 0 }
}

export function canClaimRetrievalJob(job: RetrievalJob, now: number): boolean {
  if (job.status === "queued") return true
  if (job.status === "retry_wait") return (job.nextAttemptAt ?? Number.POSITIVE_INFINITY) <= now
  return job.status === "running" && (job.leaseExpiresAt ?? Number.POSITIVE_INFINITY) <= now
}

export function claimRetrievalJob(
  job: RetrievalJob,
  workerId: string,
  now: number,
  leaseTtlMs: number
): RetrievalJob {
  if (!canClaimRetrievalJob(job, now)) {
    throw new RetrievalJobTransitionError(job.status, "running")
  }
  if (!workerId || leaseTtlMs <= 0) throw new Error("A worker and positive lease TTL are required")
  const attempt = job.attempt + 1
  if (attempt > job.maxAttempts) {
    throw new Error("Retrieval job attempts are exhausted")
  }
  return {
    ...job,
    status: "running",
    attempt,
    startedAt: job.startedAt ?? now,
    heartbeatAt: now,
    leaseOwner: workerId,
    leaseExpiresAt: now + leaseTtlMs,
    nextAttemptAt: undefined,
    completedAt: undefined,
  }
}

export function heartbeatRetrievalJob(
  job: RetrievalJob,
  workerId: string,
  now: number,
  leaseTtlMs: number
): RetrievalJob {
  if (job.status !== "running" || job.leaseOwner !== workerId) {
    throw new Error("Only the current lease owner can heartbeat a running job")
  }
  if ((job.leaseExpiresAt ?? 0) < now) throw new Error("Retrieval job lease has expired")
  return { ...job, heartbeatAt: now, leaseExpiresAt: now + leaseTtlMs }
}

export function transitionRetrievalJob(
  job: RetrievalJob,
  status: RetrievalJobStatus,
  now: number,
  patch: Partial<Omit<RetrievalJob, "id" | "status" | "kind" | "dedupeKey">> = {}
): RetrievalJob {
  if (!JOB_TRANSITIONS[job.status].has(status)) {
    throw new RetrievalJobTransitionError(job.status, status)
  }
  if (status === "retry_wait" && patch.nextAttemptAt === undefined) {
    throw new Error("retry_wait requires nextAttemptAt")
  }
  if (status === "retry_wait" && job.attempt >= job.maxAttempts) {
    throw new Error("Cannot retry after maxAttempts")
  }
  const terminal = TERMINAL_JOB_STATUSES.has(status)
  return {
    ...job,
    ...patch,
    status,
    ...(terminal ? { completedAt: now } : {}),
    ...(status === "running" ? {} : { leaseOwner: undefined, leaseExpiresAt: undefined }),
  }
}

export interface EncryptedContentEnvelopeV1 {
  version: 1
  algorithm: "AES-256-GCM"
  keyId: string
  iv: string
  ciphertext: string
  aadHash: string
}

export interface ContentEnvelopeCryptoInput {
  key: CryptoKey
  additionalData: string
}

export interface EncryptContentEnvelopeInput extends ContentEnvelopeCryptoInput {
  keyId: string
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(bytes).toString("base64")
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

function assertAes256Key(key: CryptoKey): void {
  if (key.algorithm.name !== "AES-GCM" || (key.algorithm as AesKeyAlgorithm).length !== 256) {
    throw new Error("Content encryption requires an AES-256-GCM key")
  }
}

export async function encryptContentEnvelope(
  plainText: string,
  input: EncryptContentEnvelopeInput
): Promise<EncryptedContentEnvelopeV1> {
  assertAes256Key(input.key)
  if (!input.keyId || !input.additionalData) throw new Error("keyId and AAD are required")
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = new TextEncoder().encode(input.additionalData)
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv), additionalData: toBufferSource(aad) },
    input.key,
    toBufferSource(new TextEncoder().encode(plainText))
  )
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    keyId: input.keyId,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
    aadHash: await sha256Hex(input.additionalData),
  }
}

export async function decryptContentEnvelope(
  envelope: EncryptedContentEnvelopeV1,
  input: ContentEnvelopeCryptoInput
): Promise<string> {
  assertAes256Key(input.key)
  if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
    throw new Error("Unsupported encrypted content envelope")
  }
  if ((await sha256Hex(input.additionalData)) !== envelope.aadHash) {
    throw new Error("AAD hash mismatch")
  }
  const aad = new TextEncoder().encode(input.additionalData)
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(fromBase64(envelope.iv)),
      additionalData: toBufferSource(aad),
    },
    input.key,
    toBufferSource(fromBase64(envelope.ciphertext))
  )
  return new TextDecoder().decode(decrypted)
}

export type RetrievalLifecycleStage =
  "extraction" | "consolidation" | "retrieval" | "promotion" | "deletion" | "compaction"

export interface MemoryRagLifecycleEventV1 {
  schemaVersion: 1
  id: string
  stage: RetrievalLifecycleStage
  phase: "before" | "after"
  at: number
  status: "started" | "succeeded" | "no_output" | "skipped" | "failed" | "cancelled"
  entityIds: string[]
  counts: Record<string, number>
  resultCode?: string
}

export interface CompactionCheckpointV1 {
  schemaVersion: 1
  id: string
  createdAt: number
  goal: string
  completedWork: string[]
  activeState: string[]
  decisions: Array<{ decision: string; rationale: string }>
  evidenceRefs: string[]
  blockers: string[]
  nextSteps: string[]
  constraints: string[]
  doNotRepeat: string[]
  reinjection: Array<{ kind: string; id: string; version: string }>
  tokensBefore: number
  tokensAfter: number
}

export interface PersistedRetrievalTrace extends RetrievalTraceV1 {
  createdAt: number
  expiresAt: number
}
