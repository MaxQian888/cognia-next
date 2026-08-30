import type { MemoryContaminationState, MemoryProvenance, MemoryScope } from "./memory"

/**
 * Every evidence kind, as a value so downstream allowlists can DERIVE from it.
 *
 * `lib/data/apply-package.ts` used to hand-maintain a parallel `Set` of these
 * for backup import; a kind added to the union but missed there was silently
 * dropped on restore, taking the memory's provenance with it. Deriving removes
 * that whole class of drift.
 *
 * `tool-result` is kept distinct from `message` because a tool result is
 * something the environment DID, not something a participant said — an outcome
 * claim needs one, and an assistant sentence will not do. A test run is
 * deliberately NOT its own kind: it is a tool result whose tool happened to be a
 * test command, and that belongs in `sourceId`
 * (`tool:<toolName>:<messageId>:<partIndex>`), not in the vocabulary.
 *
 * `code-location` is provenance you can show, not proof — see
 * `MemoryValidationStrategy`, where it maps to `"none"`.
 */
export const MEMORY_EVIDENCE_KINDS = [
  "message",
  "file",
  "external",
  "manual",
  "checkpoint",
  "agent-finding",
  "tool-result",
  "code-location",
] as const

export type MemoryEvidenceKind = (typeof MEMORY_EVIDENCE_KINDS)[number]

/** Narrowing guard for untrusted input — backup imports, RPC payloads. */
export function isMemoryEvidenceKind(value: unknown): value is MemoryEvidenceKind {
  return MEMORY_EVIDENCE_KINDS.includes(value as MemoryEvidenceKind)
}

/**
 * How a piece of evidence can be re-checked.
 *
 * DORMANT ON PURPOSE — `code-location` maps to `"none"` and always validates as
 * `"unverifiable"` with zero support weight. Checking it needs a file read plus a
 * content hash, and `readTextFile` throws outside Tauri and browser dev, so the
 * same memory would be eligible on desktop and ineligible on mobile. There is
 * also no `stat`/mtime helper in `lib/`, and `GitStatus` carries no HEAD sha to
 * anchor a fingerprint to. Doing it properly needs a native batched command and
 * is its own change; until then the strategy is declared, labelled inert in the
 * console, and pinned by a test.
 */
export const MEMORY_VALIDATION_STRATEGIES = [
  /** The source message still exists and its excerpt still hashes the same. */
  "message-presence",
  /** The tool part still exists at the recorded index and its output still hashes the same. */
  "tool-result-hash",
  /** A human marked the memory verified. Outranks anything the miner concluded. */
  "user-confirmation",
  /** Not checkable on this platform. Contributes no support. */
  "none",
] as const

export type MemoryValidationStrategy = (typeof MEMORY_VALIDATION_STRATEGIES)[number]

export function isMemoryValidationStrategy(value: unknown): value is MemoryValidationStrategy {
  return MEMORY_VALIDATION_STRATEGIES.includes(value as MemoryValidationStrategy)
}

export const MEMORY_VALIDATION_STATES = [
  /** Never checked. Contributes reduced support, not full support. */
  "unvalidated",
  /** Re-checked and still true. */
  "valid",
  /** The source is gone or changed. Contributes no support. */
  "revoked",
  /** Checkable in principle, but not here. Contributes no support. */
  "unverifiable",
] as const

export type MemoryValidationState = (typeof MEMORY_VALIDATION_STATES)[number]

export function isMemoryValidationState(value: unknown): value is MemoryValidationState {
  return MEMORY_VALIDATION_STATES.includes(value as MemoryValidationState)
}

export interface MemoryEvidence {
  id: string
  /** Set when the evidence has been attached to a learned memory. */
  memoryId?: string
  kind: MemoryEvidenceKind
  /** Durable source identity; never raw source content. */
  sourceId: string
  sessionId?: string
  messageId?: string
  /** Prevents assistant/tool evidence from being mistaken for a user assertion. */
  sourceRole?: "user" | "assistant" | "tool" | "system"
  /** Hash of the redacted excerpt used to support this memory. */
  excerptHash?: string
  contaminationState: MemoryContaminationState
  reviewed: boolean
  createdAt: number
  /** `ChatSession.transcriptRevision` when this evidence was captured. */
  sourceRevision?: number
  /** How this row is re-checked. Absent reads as `"none"`. */
  validationStrategy?: MemoryValidationStrategy
  /** Result of the last re-check. Absent reads as `"unvalidated"`. */
  validationState?: MemoryValidationState
  /** When the last re-check ran. Undefined means never. */
  validatedAt?: number
}

/**
 * Every job kind, as a value — same derivation discipline as
 * `MEMORY_EVIDENCE_KINDS`, and for the same reason: two hand-maintained copies
 * of this list existed (the backup importer's allowlist and the console's
 * summary axis), and a kind missing from either failed silently.
 *
 * `project-mining` handles one transcript window. History backfill deliberately
 * has no kind of its own: a backfill run is bookkeeping that enqueues ordinary
 * `project-mining` jobs, so the actual work has exactly one code path whether it
 * came from a live turn or from a sweep of old sessions.
 */
export const MEMORY_JOB_KINDS = [
  "turn-extraction",
  "session-distill",
  "vector-reconcile",
  "project-mining",
  "project-claim-revalidate",
] as const

export type MemoryJobKind = (typeof MEMORY_JOB_KINDS)[number]

/** Narrowing guard for untrusted input — backup imports. */
export function isMemoryJobKind(value: unknown): value is MemoryJobKind {
  return MEMORY_JOB_KINDS.includes(value as MemoryJobKind)
}
export type MemoryJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "no_output"
  | "skipped"
  | "failed"
  | "cancelled"

/**
 * Durable identity of the transcript window a learning job was enqueued for.
 *
 * Learning jobs persist only source identities, never transcript content, so a
 * recovering worker has to re-derive the conversation prefix that existed at
 * enqueue time. That used to be encoded as a message COUNT in the dedupe key,
 * which silently replayed the wrong content whenever an edit left the length
 * unchanged. Message ids pin the window to actual rows instead.
 *
 * `transcriptRevision` is a soft signal only: `updateMessageMetadata` bumps it
 * without changing a single character, so drift triggers re-verification of the
 * id window rather than discarding the job.
 */
export interface MemoryJobCheckpoint {
  /** `ChatSession.transcriptRevision` when the job was enqueued. */
  transcriptRevision: number
  /** Id of the first message in the window. */
  firstMessageId: string
  /** Id of the last message in the window. */
  lastMessageId: string
  /** Number of messages the window spanned, inclusive of both endpoints. */
  messageCount: number
}

export interface MemoryJob {
  id: string
  dedupeKey: string
  kind: MemoryJobKind
  status: MemoryJobStatus
  sessionId?: string
  projectId?: string
  characterId?: string
  agentId?: string
  scope: MemoryScope
  provenance: MemoryProvenance
  /** Evidence references only. Raw transcript content is never persisted here. */
  evidenceIds: string[]
  /**
   * Transcript window this job was enqueued for. Absent on rows written before
   * this field existed — those still fall back to the trailing `:<count>` of
   * `dedupeKey`, so shipped databases keep working unchanged.
   */
  checkpoint?: MemoryJobCheckpoint
  /**
   * The single memory this job targets, for kinds that act on one row
   * (`project-claim-revalidate`). Absent means "sweep": re-check the claims
   * that have gone longest without one.
   *
   * A field rather than a slice of `dedupeKey`. Parsing state back out of a key
   * is exactly what made the transcript checkpoint replay the wrong window, and
   * a key is for deduping, not for carrying arguments.
   */
  memoryId?: string
  queuedAt: number
  startedAt?: number
  completedAt?: number
  leaseOwner?: string
  leaseExpiresAt?: number
  heartbeatAt?: number
  attempt?: number
  maxAttempts?: number
  cancellationRequestedAt?: number
  retryCount: number
  nextAttemptAt?: number
  errorCode?: string
  resultCode?: string
}

/**
 * Explicit history backfill (ADR-0069 project-context mining).
 *
 * One row per user-started sweep of a workspace's own conversation history. The
 * row owns a lease and a keyset cursor and does nothing else: the actual mining
 * is ordinary `project-mining` jobs, so a backfilled claim is byte-identical in
 * provenance to one mined live.
 */
export type ProjectMiningRunStatus =
  /** Created with an estimate, waiting for a person to agree to the cost. */
  "preconsent" | "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled"

export interface ProjectMiningRunEstimateRow {
  sessions: number
  messages: number
  windows: number
  estimatedInputTokens: number
}

export interface ProjectMiningRun {
  id: string
  projectId: string
  status: ProjectMiningRunStatus
  /** Counted once at creation, from index walks that never read `parts`. */
  estimate: ProjectMiningRunEstimateRow
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  /**
   * Keyset watermark: the oldest session already CHECKED, newest-first.
   * Advanced on "checked" and not on "produced a claim", so an unproductive
   * stretch of history cannot loop forever.
   */
  cursorCreatedAt?: number
  cursorSessionId?: string
  sessionsScanned: number
  jobsEnqueued: number
  claimsProduced: number
  /** Same protocol as `claimMemoryJob`: owner, expiry, heartbeat. */
  leaseOwner?: string
  leaseExpiresAt?: number
  heartbeatAt?: number
  errorCode?: string
}

export type MemoryAuditAction =
  | "recall-allowed"
  | "recall-denied"
  | "learn-allowed"
  | "learn-denied"
  | "created"
  | "revised"
  | "promoted"
  | "invalidated"
  | "deleted"
  | "conflict"
  | "pinned"
  | "unpinned"
  /**
   * A user's verdict on a recalled memory (helpful / wrong / outdated).
   *
   * On the AUDIT ledger, not as a `memoryEvidence` row: evidence is what the
   * inspector's provenance timeline renders, and a per-vote entry there would
   * bury the handful of rows that explain where a memory came from.
   */
  | "feedback"

export interface MemoryAuditEvent {
  id: string
  action: MemoryAuditAction
  memoryId?: string
  sessionId?: string
  reason: string
  createdAt: number
  /** Structured counters/identifiers only; never memory or transcript text. */
  metadata?: Record<string, string | number | boolean>
}
