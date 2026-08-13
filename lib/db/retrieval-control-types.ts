import type {
  EncryptedContentEnvelopeV1,
  IndexGeneration,
  PersistedRetrievalTrace,
  RetrievalJob,
  RetrievalProfileV1,
} from "@cognia/rag"

export interface RetrievalProfileRow {
  id: string
  schemaVersion: 1
  fingerprint: string
  profile: RetrievalProfileV1
  active: boolean
  createdAt: number
  updatedAt: number
}

export type RetrievalGenerationRow = IndexGeneration
export type RetrievalJobRow = RetrievalJob

export interface RetrievalActivePointerRow {
  corpusId: string
  generationId: string
  domain: IndexGeneration["domain"]
  profileFingerprint: string
  updatedAt: number
}

export interface RetrievalTraceRow extends PersistedRetrievalTrace {
  corpusId: string
  domain: IndexGeneration["domain"]
}

export type RetrievalEncryptedContentKind =
  "canonical" | "safe_projection" | "evidence_excerpt" | "lexical_segment"

export interface RetrievalEncryptedContentRow {
  id: string
  entityType: string
  entityId: string
  corpusId: string
  generationId?: string
  kind: RetrievalEncryptedContentKind
  envelope: EncryptedContentEnvelopeV1
  createdAt: number
  updatedAt: number
}

export interface RetrievalTombstoneRow {
  id: string
  entityType: string
  entityId: string
  corpusId: string
  createdAt: number
  acknowledgedDeviceIds: string[]
  pendingDeviceIds: string[]
  eligiblePurgeAt?: number
}

export type RetrievalMigrationPhase =
  | "schema"
  | "dual_read"
  | "encrypt_content"
  | "backfill_governance"
  | "build_generation"
  | "quality_gate"
  | "cutover"

export interface RetrievalMigrationJournalRow {
  id: string
  phase: RetrievalMigrationPhase
  status: "pending" | "running" | "succeeded" | "failed"
  watermark?: string
  processedCount: number
  failureCode?: string
  createdAt: number
  updatedAt: number
}
