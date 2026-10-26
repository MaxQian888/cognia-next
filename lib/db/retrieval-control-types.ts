import type { IndexGeneration, PersistedRetrievalTrace, RetrievalJob } from "@cognia/rag"
export type {
  RetrievalEncryptedContentKind,
  RetrievalEncryptedContentRow,
  RetrievalProfileRow,
  RetrievalTombstoneRow,
} from "@cognia/plugin-contract/lib/db/retrieval-control-types"

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

export interface RetrievalRuntimeStateRow {
  id: "global"
  killSwitchEngaged: boolean
  changedAt: number
  changedBy: "user" | "migration" | "safety"
  reasonCode?: string
}
