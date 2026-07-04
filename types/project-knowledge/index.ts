/**
 * Types for project-scoped RAG (the workspace knowledge base).
 *
 * A `ProjectChunk` is the project-scoped analogue of `TwinChunk`
 * (`@/types/twin`): a single sliced piece of a workspace `KnowledgeFile`
 * (`Project.knowledgeBase`), stored in Dexie with both the original text and a
 * PII-redacted variant, plus a pointer into the remote vector store. Unlike
 * twin chunks (which are profile-global, keyed by `twinId`), project chunks are
 * **project-scoped** — a workspace's knowledge never leaks across workspaces.
 *
 * The chunk metadata / strategy / backend enums are reused verbatim from the
 * twin subsystem so the ingest pipeline can share `prepareChunks`, the
 * dimension guard, and the vector store client.
 */

import type { ChunkingStrategyId, TwinChunkMetadata, VectorBackend } from "@/types/twin"

export interface ProjectChunk {
  id: string
  /** FK → Project.id (the owning workspace). */
  projectId: string
  /** FK → KnowledgeFile.id (`Project.knowledgeBase[].id`). */
  fileId: string

  /**
   * Original chunk text (UI display, citation snippets, and the text returned
   * to the prompt when the backend is fully local). Kept alongside
   * `contentRedacted` so retrieval can surface the user's own data while cloud
   * embeddings only ever see the scrubbed version.
   */
  content: string
  /** PII-stripped version — fed to embed()/the remote store on cloud backends. */
  contentRedacted: string
  charStart: number
  charEnd: number

  /** Backend the vector lives on; routes updates to the right client. */
  vectorBackend: VectorBackend
  /** Collection / namespace name on the remote vector store. */
  vectorCollection: string
  /** Remote doc id; resolves a search hit back to this chunk. */
  vectorDocId: string

  strategy: ChunkingStrategyId
  /** Approximate token count (js-tiktoken style). */
  tokenCount: number

  metadata: TwinChunkMetadata

  /**
   * Change-detection hash of the source `KnowledgeFile.content` at ingest time.
   * Re-ingest is skipped when the file's current content hashes to the same
   * value (all chunks of one file share the hash).
   */
  contentHash: string

  createdAt: number
}

/**
 * Per-project knowledge-base / RAG settings. Stored on `Project.knowledgeSettings`
 * (all fields optional; resolve-at-read via `resolveProjectKnowledgeSettings` so
 * no data migration is needed when defaults change).
 */
export interface ProjectKnowledgeSettings {
  /** Master switch for injecting workspace knowledge into chat. Default on. */
  enableProjectRag?: boolean
  /** Number of chunks to retrieve per turn. Default 5. */
  ragTopK?: number
}

export interface ResolvedProjectKnowledgeSettings {
  enableProjectRag: boolean
  ragTopK: number
}

export const DEFAULT_PROJECT_KNOWLEDGE_SETTINGS: ResolvedProjectKnowledgeSettings = {
  enableProjectRag: true,
  ragTopK: 5,
}

export function resolveProjectKnowledgeSettings(
  settings?: ProjectKnowledgeSettings | null
): ResolvedProjectKnowledgeSettings {
  return {
    enableProjectRag:
      settings?.enableProjectRag ?? DEFAULT_PROJECT_KNOWLEDGE_SETTINGS.enableProjectRag,
    ragTopK:
      settings?.ragTopK && settings.ragTopK > 0
        ? Math.floor(settings.ragTopK)
        : DEFAULT_PROJECT_KNOWLEDGE_SETTINGS.ragTopK,
  }
}
