/**
 * Persist stage of the project-knowledge ingest pipeline.
 *
 * Writes chunks to BOTH Dexie (`projectChunks`, full text + provenance) AND the
 * remote vector store (vector + lightweight payload), reconcilable via the
 * deterministic `vectorDocId`. Mirrors `lib/twin/ingest/persist.ts` but keyed by
 * `projectId` / `fileId` and writing the project-scoped `cognia_project_{id}`
 * collection.
 */

import {
  bulkCreateProjectChunks,
  deleteProjectChunksByFile,
  listProjectChunksByFile,
} from "@/lib/db/project-chunks"
import type { IVectorStore } from "@cognia/vector/store"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import type { ProjectChunk } from "@/types/project-knowledge"
import type { ChunkingStrategyId, TwinChunkMetadata, VectorBackend } from "@/types/twin"

const COLLECTION_PREFIX = "cognia_project_"

export function projectVectorCollectionName(projectId: string): string {
  return `${COLLECTION_PREFIX}${projectId}`
}

function newVectorDocId(projectId: string, fileId: string, idx: number): string {
  // Deterministic so a re-ingest of the same file OVERWRITES prior vectors
  // instead of orphaning them (see the twin persist rationale).
  return `${projectId}__${fileId}__${idx.toString(36)}`
}

export interface PersistProjectChunksInput {
  projectId: string
  fileId: string
  vectorBackend: VectorBackend
  /** Default `cognia_project_{projectId}`. */
  vectorCollection?: string
  store: IVectorStore
  /** Change-detection hash of the source file content — stamped on every row. */
  contentHash: string
  /** Per-chunk arrays. `chunks` and `embeddings` MUST share the same length. */
  chunks: Array<{
    content: string
    contentRedacted: string
    charStart: number
    charEnd: number
    strategy: ChunkingStrategyId
    tokenCount: number
    metadata: TwinChunkMetadata
  }>
  embeddings: number[][]
}

export interface PersistProjectChunksResult {
  rows: ProjectChunk[]
  vectorDocIds: string[]
}

export async function persistProjectChunks(
  input: PersistProjectChunksInput
): Promise<PersistProjectChunksResult> {
  if (input.chunks.length !== input.embeddings.length) {
    throw new Error(
      `persistProjectChunks: chunks (${input.chunks.length}) and embeddings (${input.embeddings.length}) length mismatch`
    )
  }

  const collection = input.vectorCollection ?? projectVectorCollectionName(input.projectId)
  const now = Date.now()

  // 0. Dimension guard — block before writing vectors of a different dimension
  //    than an existing collection (e.g. the embedding model was changed).
  await ensureCollectionDimensionCompatible(input.store, collection, input.embeddings[0]?.length)

  // 0a. Ensure the collection exists (idempotent; clients short-circuit when
  //     already present). Non-fatal — the upsert below may auto-create.
  try {
    await input.store.createCollection(collection, {
      dimension: input.embeddings[0]?.length,
    })
  } catch {
    // ignore — most clients throw "already exists" which we treat as success
  }

  // 0b. Idempotent replace: drop the file's prior vectors + Dexie rows so a
  //     re-ingest (edited content) doesn't leave stale chunks in either store.
  const existing = await listProjectChunksByFile(input.projectId, input.fileId)
  if (existing.length > 0) {
    const oldVectorIds = existing
      .map((row) => row.vectorDocId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    if (oldVectorIds.length > 0 && typeof input.store.deleteDocuments === "function") {
      try {
        await input.store.deleteDocuments(collection, oldVectorIds)
      } catch {
        // Tolerate remote delete failure — the Dexie cleanup below still runs.
      }
    }
    await deleteProjectChunksByFile(input.projectId, input.fileId)
  }

  // 1. Build rows + deterministic ids in memory.
  const rows: ProjectChunk[] = input.chunks.map((c, i) => ({
    id: `pkc_${now.toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    projectId: input.projectId,
    fileId: input.fileId,
    content: c.content,
    contentRedacted: c.contentRedacted,
    charStart: c.charStart,
    charEnd: c.charEnd,
    vectorBackend: input.vectorBackend,
    vectorCollection: collection,
    vectorDocId: newVectorDocId(input.projectId, input.fileId, i),
    strategy: c.strategy,
    tokenCount: c.tokenCount,
    metadata: c.metadata,
    contentHash: input.contentHash,
    createdAt: now,
  }))

  // 2. Remote upsert. The vector payload embeds `contentRedacted` only (cloud
  //    backends never see originals); full text stays in Dexie.
  await input.store.addDocuments(
    collection,
    rows.map((row, i) => ({
      id: row.vectorDocId,
      content: row.contentRedacted,
      metadata: {
        projectId: row.projectId,
        chunkId: row.id,
        fileId: row.fileId,
        contentPreview: row.contentRedacted.slice(0, 200),
      },
      embedding: input.embeddings[i],
    }))
  )

  // 3. Dexie bulk add (ids already minted in step 1 to match the remote payload).
  await bulkCreateProjectChunks(rows)

  return { rows, vectorDocIds: rows.map((r) => r.vectorDocId) }
}
