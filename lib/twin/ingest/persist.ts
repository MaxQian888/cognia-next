/**
 * Persist stage of the twin ingest pipeline.
 *
 * Writes chunks to BOTH Dexie (full text + provenance) AND the remote
 * vector store (vector + lightweight payload), atomically enough that a
 * crash mid-flight leaves the two stores reconcilable via `vectorDocId`.
 *
 * The `vectorBackend` + `vectorCollection` ids are stamped on every
 * `twinChunks` row so a future migration / re-host can iterate the table
 * and replay vectors without re-embedding.
 */

import { bulkCreateTwinChunks, listTwinChunksBySource } from "@/lib/db/twin-chunks"
import { getDb } from "@/lib/db/schema"
import { updateTwinSource } from "@/lib/db/twin-sources"
import { runGenerationSwap } from "@/lib/rag/generation-ingest"
import type { IVectorStore } from "@cognia/vector/store"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import type { ChunkingStrategyId, TwinChunk, TwinChunkMetadata, VectorBackend } from "@/types/twin"

const COLLECTION_PREFIX = "cognia_twin_"

export function vectorCollectionName(twinId: string): string {
  return `${COLLECTION_PREFIX}${twinId}`
}

export interface PersistInput {
  twinId: string
  sourceId: string
  vectorBackend: VectorBackend
  /** Default `cognia_twin_{twinId}` — overridable for sharded deployments. */
  vectorCollection?: string
  store: IVectorStore
  /** Per-chunk parallel arrays. All four MUST share the same length. */
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
  profileFingerprint?: string
  /** Source revision hash used to validate and reconcile the generation. */
  contentHash?: string
}

export interface PersistResult {
  rows: TwinChunk[]
  vectorDocIds: string[]
  generationId?: string
  cleanupPending?: boolean
}

function newVectorDocId(
  twinId: string,
  sourceId: string,
  generationId: string,
  idx: number
): string {
  return `${twinId}__${sourceId}__${generationId}__${idx.toString(36)}`
}

/**
 * Double-write strategy:
 *   1. Build TwinChunk rows in memory + assign vectorDocId.
 *   2. Upsert to remote vector store first (failure → throw, nothing in Dexie).
 *   3. bulkAdd to Dexie (failure → out of sync; persist.test asserts callers
 *      compensate by re-issuing the upsert idempotently next run).
 *
 * Step 2 before step 1 keeps Dexie eventually consistent even if a remote
 * upsert silently dedupes — the row is the canonical record locally.
 */
export async function persistChunks(input: PersistInput): Promise<PersistResult> {
  if (input.chunks.length !== input.embeddings.length) {
    throw new Error(
      `persistChunks: chunks (${input.chunks.length}) and embeddings (${input.embeddings.length}) length mismatch`
    )
  }

  const collection = input.vectorCollection ?? vectorCollectionName(input.twinId)
  const now = Date.now()

  // 0. Dimension guard. If this collection already exists with a different
  //    dimension (e.g. the embedding model was changed after the first
  //    ingest), block before writing mismatched vectors instead of silently
  //    corrupting the index.
  await ensureCollectionDimensionCompatible(input.store, collection, input.embeddings[0]?.length)

  // 0a. Ensure the collection exists. Most vector backends raise on
  //     addDocuments-before-create; calling this once per persist call is
  //     cheap (clients short-circuit when the collection is already there).
  //     Failures here are non-fatal — if the upsert below works anyway, the
  //     backend already had the collection or auto-created it.
  try {
    await input.store.createCollection(collection, {
      dimension: input.embeddings[0]?.length,
    })
  } catch {
    // ignore — most clients throw "already exists" which we treat as success
  }

  // Keep the active generation intact until the replacement has passed
  // vector write, shape validation, and the atomic local pointer switch.
  const existing = await listTwinChunksBySource(input.sourceId)
  const oldVectors = existing.map((row) => ({
    collection: row.vectorCollection,
    id: row.vectorDocId,
  }))
  const dimension = input.embeddings[0]?.length
  const result = await runGenerationSwap({
    idPrefix: "twgen",
    corpusId: `twin:${input.twinId}:source:${input.sourceId}`,
    domain: "twin",
    profileFingerprint:
      input.profileFingerprint ?? `legacy:${input.vectorBackend}:${dimension ?? "none"}`,
    collection,
    store: input.store,
    contentHash: input.contentHash ?? `legacy-source:${input.sourceId}`,
    expectedCount: input.chunks.length,
    expectedDimension: dimension,
    oldVectors,
    now,
    build: (generationId) => {
      const rows: TwinChunk[] = input.chunks.map((chunk, index) => ({
        id: `twc_${now.toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        twinId: input.twinId,
        sourceId: input.sourceId,
        content: chunk.content,
        contentRedacted: chunk.contentRedacted,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        vectorBackend: input.vectorBackend,
        vectorCollection: collection,
        vectorDocId: newVectorDocId(input.twinId, input.sourceId, generationId, index),
        generationId,
        strategy: chunk.strategy,
        tokenCount: chunk.tokenCount,
        metadata: chunk.metadata,
        createdAt: now,
      }))
      return {
        value: rows,
        count: rows.length,
        documents: rows.map((row, index) => ({
          id: row.vectorDocId,
          content: row.contentRedacted,
          metadata: {
            twinId: row.twinId,
            chunkId: row.id,
            sourceId: row.sourceId,
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
        [db.twinChunks, db.twinSources, db.retrievalGenerations, db.retrievalActivePointers],
        async () => {
          await db.twinChunks.where("sourceId").equals(input.sourceId).delete()
          await bulkCreateTwinChunks(rows)
          await updateTwinSource(input.sourceId, {
            chunkCount: rows.length,
            status: "parsed",
            parsedAt: now,
          })
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
