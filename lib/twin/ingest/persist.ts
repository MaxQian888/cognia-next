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

import { bulkCreateTwinChunks } from "@/lib/db/twin-chunks"
import { updateTwinSource } from "@/lib/db/twin-sources"
import type { IVectorStore } from "@/lib/vector/store"
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
}

export interface PersistResult {
  rows: TwinChunk[]
  vectorDocIds: string[]
}

function newVectorDocId(twinId: string, sourceId: string, idx: number): string {
  return `${twinId}__${sourceId}__${idx.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
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

  // 1. Build rows + ids in memory.
  const rows: TwinChunk[] = input.chunks.map((c, i) => ({
    id: `twc_${now.toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    twinId: input.twinId,
    sourceId: input.sourceId,
    content: c.content,
    contentRedacted: c.contentRedacted,
    charStart: c.charStart,
    charEnd: c.charEnd,
    vectorBackend: input.vectorBackend,
    vectorCollection: collection,
    vectorDocId: newVectorDocId(input.twinId, input.sourceId, i),
    strategy: c.strategy,
    tokenCount: c.tokenCount,
    metadata: c.metadata,
    createdAt: now,
  }))

  // 2. Remote upsert. Vector payload is intentionally minimal (`twinId` /
  //    `chunkId` / `sourceId` / 200-char preview) — full text stays in Dexie
  //    so we don't pay remote storage for it twice.
  await input.store.addDocuments(
    collection,
    rows.map((row, i) => ({
      id: row.vectorDocId,
      content: row.contentRedacted,
      metadata: {
        twinId: row.twinId,
        chunkId: row.id,
        sourceId: row.sourceId,
        contentPreview: row.contentRedacted.slice(0, 200),
      },
      embedding: input.embeddings[i],
    }))
  )

  // 3. Dexie bulk add. (`bulkCreateTwinChunks` accepts the row drafts and
  //    assigns ids itself, but we already minted ids in step 1 to keep
  //    them in sync with the remote payload.)
  await bulkCreateTwinChunks(rows)

  // 4. Stamp the source row so the workbench reflects the new chunk count.
  await updateTwinSource(input.sourceId, {
    chunkCount: rows.length,
    status: "parsed",
    parsedAt: now,
  })

  return { rows, vectorDocIds: rows.map((r) => r.vectorDocId) }
}
