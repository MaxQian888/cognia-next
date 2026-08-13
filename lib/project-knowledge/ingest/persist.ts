/**
 * Persist stage of the project-knowledge ingest pipeline.
 *
 * Writes chunks to BOTH Dexie (`projectChunks`, full text + provenance) AND the
 * remote vector store (vector + lightweight payload), reconcilable via the
 * deterministic `vectorDocId`. Mirrors `lib/twin/ingest/persist.ts` but keyed by
 * `projectId` / `fileId` and writing the project-scoped `cognia_project_{id}`
 * collection.
 */

import { bulkCreateProjectChunks, listProjectChunksByFile } from "@/lib/db/project-chunks"
import { getDb } from "@/lib/db/schema"
import { runGenerationSwap } from "@/lib/rag/generation-ingest"
import type { IVectorStore } from "@cognia/vector/store"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import type { ProjectChunk } from "@/types/project-knowledge"
import type { ChunkingStrategyId, TwinChunkMetadata, VectorBackend } from "@/types/twin"

const COLLECTION_PREFIX = "cognia_project_"

export function projectVectorCollectionName(projectId: string): string {
  return `${COLLECTION_PREFIX}${projectId}`
}

function newVectorDocId(
  projectId: string,
  fileId: string,
  generationId: string,
  idx: number
): string {
  return `${projectId}__${fileId}__${generationId}__${idx.toString(36)}`
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
  /** Stable profile fingerprint; legacy callers derive a backend/dimension fingerprint. */
  profileFingerprint?: string
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
  generationId?: string
  cleanupPending?: boolean
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
  const corpusId = `project:${input.projectId}:file:${input.fileId}`
  const dimension = input.embeddings[0]?.length
  const profileFingerprint =
    input.profileFingerprint ?? `legacy:${input.vectorBackend}:${dimension ?? "none"}`
  // 0. Dimension guard — block before writing vectors of a different dimension
  //    than an existing collection (e.g. the embedding model was changed).
  await ensureCollectionDimensionCompatible(input.store, collection, dimension)

  // 0a. Ensure the collection exists (idempotent; clients short-circuit when
  //     already present). Non-fatal — the upsert below may auto-create.
  if (dimension !== undefined) {
    try {
      await input.store.createCollection(collection, { dimension })
    } catch {
      // ignore — most clients throw "already exists" which we treat as success
    }
  }

  // Keep the old active rows and vectors until the new generation is fully
  // written and validated. Generation-specific vector ids make a failed local
  // commit recoverable without overwriting the active remote vectors.
  const existing = await listProjectChunksByFile(input.projectId, input.fileId)
  const oldVectors = existing.map((row) => ({
    collection: row.vectorCollection,
    id: row.vectorDocId,
  }))

  const result = await runGenerationSwap({
    idPrefix: "pgen",
    corpusId,
    domain: "project",
    profileFingerprint,
    collection,
    store: input.store,
    contentHash: input.contentHash,
    expectedCount: input.chunks.length,
    expectedDimension: dimension,
    oldVectors,
    now,
    build: (generationId) => {
      const rows: ProjectChunk[] = input.chunks.map((chunk, index) => ({
        id: `pkc_${now.toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        projectId: input.projectId,
        fileId: input.fileId,
        content: chunk.content,
        contentRedacted: chunk.contentRedacted,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        vectorBackend: input.vectorBackend,
        vectorCollection: collection,
        vectorDocId: newVectorDocId(input.projectId, input.fileId, generationId, index),
        generationId,
        strategy: chunk.strategy,
        tokenCount: chunk.tokenCount,
        metadata: chunk.metadata,
        contentHash: input.contentHash,
        createdAt: now,
      }))
      return {
        value: rows,
        count: rows.length,
        documents: rows.map((row, index) => ({
          id: row.vectorDocId,
          content: row.contentRedacted,
          metadata: {
            projectId: row.projectId,
            chunkId: row.id,
            fileId: row.fileId,
            generationId: row.generationId,
            contentPreview: row.contentRedacted.slice(0, 200),
          },
          embedding: input.embeddings[index],
        })),
      }
    },
    commit: async (rows, activate) => {
      const db = getDb()
      await db.transaction(
        "rw",
        [db.projectChunks, db.retrievalGenerations, db.retrievalActivePointers],
        async () => {
          await db.projectChunks
            .where("[projectId+fileId]")
            .equals([input.projectId, input.fileId])
            .delete()
          await bulkCreateProjectChunks(rows)
          await activate()
        }
      )
    },
  })

  return {
    rows: result.value,
    vectorDocIds: result.vectorDocIds,
    generationId: result.generationId,
    cleanupPending: result.cleanupPending,
  }
}
