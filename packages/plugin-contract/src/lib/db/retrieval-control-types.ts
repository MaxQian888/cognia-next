/**
 * The plugin contract's share of `lib/db/retrieval-control-types.ts`, which re-exports these.
 */
import type { EncryptedContentEnvelopeV1, RetrievalProfileV1 } from "@cognia/rag"

export interface RetrievalProfileRow {
  id: string
  schemaVersion: 1
  fingerprint: string
  profile: RetrievalProfileV1
  active: boolean
  createdAt: number
  updatedAt: number
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
