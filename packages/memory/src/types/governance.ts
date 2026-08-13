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
