import type { MemoryContaminationState, MemoryProvenance, MemoryScope } from "./memory"

export type MemoryEvidenceKind =
  "message" | "file" | "external" | "manual" | "checkpoint" | "agent-finding"

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
}

export type MemoryJobKind = "turn-extraction" | "session-distill" | "vector-reconcile"
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
