import type {
  ChunkingStrategyId,
  TwinChunkMetadata,
  TwinSourceFormat,
  TwinSourceKind,
  VectorBackend,
} from "@/types/twin"

/** A reusable, Agent-bindable knowledge collection independent of any Project or Twin. */
export interface KnowledgeBase {
  id: string
  name: string
  description?: string
  createdAt: number
  updatedAt: number
}

export type KnowledgeBaseSourceStatus = "pending" | "processing" | "ready" | "failed"
export type KnowledgeBaseSourceContentEncoding = "utf8" | "base64"

export type KnowledgeBaseSourceVisibility = "private" | "restricted" | "public"

/** Document-level access policy evaluated after a deployment selects a Knowledge Base. */
export interface KnowledgeBaseSourceAcl {
  visibility: KnowledgeBaseSourceVisibility
  /** Verified OIDC subjects. App-local/Dify `user` keys are never principals. */
  principalIds?: string[]
  /** Verified OIDC group ids. */
  groupIds?: string[]
}

/** Original imported material. Content is portable; device-local paths are only provenance. */
export interface KnowledgeBaseSource {
  id: string
  knowledgeBaseId: string
  kind: TwinSourceKind
  format: TwinSourceFormat
  title: string
  content: string
  /** Omitted on legacy/plain-text rows; binary document uploads use base64. */
  contentEncoding?: KnowledgeBaseSourceContentEncoding
  originalLocation?: string
  bytes: number
  fingerprint: string
  status: KnowledgeBaseSourceStatus
  chunkCount: number
  errorCode?: string
  /** Missing on legacy rows and therefore private to trusted local execution. */
  acl?: KnowledgeBaseSourceAcl
  createdAt: number
  updatedAt: number
}

/** Derived searchable slice with enough provenance to return to the original source. */
export interface KnowledgeBaseChunk {
  id: string
  knowledgeBaseId: string
  sourceId: string
  content: string
  contentRedacted: string
  charStart: number
  charEnd: number
  vectorBackend: VectorBackend
  vectorCollection: string
  vectorDocId: string
  /** Immutable generation containing this chunk; absent only on legacy rows. */
  generationId?: string
  strategy: ChunkingStrategyId
  tokenCount: number
  metadata: TwinChunkMetadata
  contentHash: string
  createdAt: number
}

export type KnowledgeBaseIngestJobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled"

/** Durable ingest state. Error metadata is bounded and never contains source content. */
export interface KnowledgeBaseIngestJob {
  id: string
  knowledgeBaseId: string
  sourceId: string
  status: KnowledgeBaseIngestJobStatus
  phase: string
  progress: number
  attempts: number
  queuedAt: number
  startedAt?: number
  completedAt?: number
  errorCode?: string
  updatedAt: number
}

export interface KnowledgeBaseReference {
  kind: "agent" | "workflow"
  id: string
  name: string
}
