import {
  deleteKnowledgeBaseChunksBySource,
  getKnowledgeBaseSourcesByIds,
  listKnowledgeBaseChunksBySource,
  putKnowledgeBaseChunks,
} from "@/lib/db/knowledge-bases"
import { knowledgeBaseVectorCollectionName } from "@/lib/knowledge-base/runtime/retrieve"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import type { IVectorStore } from "@cognia/vector/store"
import type { KnowledgeBaseChunk } from "@/types/knowledge-base"
import type { ChunkingStrategyId, TwinChunkMetadata, VectorBackend } from "@/types/twin"

export interface PersistKnowledgeBaseChunksInput {
  knowledgeBaseId: string
  sourceId: string
  vectorBackend: VectorBackend
  vectorCollection?: string
  store: IVectorStore
  contentHash: string
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

export interface PersistKnowledgeBaseChunksResult {
  rows: KnowledgeBaseChunk[]
  vectorDocIds: string[]
}

function vectorDocId(knowledgeBaseId: string, sourceId: string, index: number): string {
  return `${knowledgeBaseId}__${sourceId}__${index.toString(36)}`
}

export async function persistKnowledgeBaseChunks(
  input: PersistKnowledgeBaseChunksInput
): Promise<PersistKnowledgeBaseChunksResult> {
  if (input.chunks.length !== input.embeddings.length) {
    throw new Error(
      `persistKnowledgeBaseChunks: chunks (${input.chunks.length}) and embeddings (${input.embeddings.length}) length mismatch`
    )
  }

  const [source] = await getKnowledgeBaseSourcesByIds([input.sourceId])
  if (!source || source.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new Error("Knowledge Base source ownership does not match")
  }

  const collection =
    input.vectorCollection ?? knowledgeBaseVectorCollectionName(input.knowledgeBaseId)
  const dimension = input.embeddings[0]?.length
  await ensureCollectionDimensionCompatible(input.store, collection, dimension)

  if (dimension !== undefined) {
    try {
      await input.store.createCollection(collection, { dimension })
    } catch {
      // Existing collections are valid after the dimension guard above.
    }
  }

  const existing = await listKnowledgeBaseChunksBySource(input.sourceId)
  if (existing.length > 0) {
    const oldVectorIds = existing.map((row) => row.vectorDocId).filter(Boolean)
    if (oldVectorIds.length > 0 && typeof input.store.deleteDocuments === "function") {
      try {
        await input.store.deleteDocuments(collection, oldVectorIds)
      } catch {
        // Local derived rows remain authoritative and can be rebuilt later.
      }
    }
    await deleteKnowledgeBaseChunksBySource(input.sourceId)
  }

  const now = Date.now()
  const rows: KnowledgeBaseChunk[] = input.chunks.map((chunk, index) => ({
    id: `kbc_${now.toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceId: input.sourceId,
    content: chunk.content,
    contentRedacted: chunk.contentRedacted,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    vectorBackend: input.vectorBackend,
    vectorCollection: collection,
    vectorDocId: vectorDocId(input.knowledgeBaseId, input.sourceId, index),
    strategy: chunk.strategy,
    tokenCount: chunk.tokenCount,
    metadata: chunk.metadata,
    contentHash: input.contentHash,
    createdAt: now,
  }))

  if (rows.length > 0) {
    await input.store.addDocuments(
      collection,
      rows.map((row, index) => ({
        id: row.vectorDocId,
        content: row.contentRedacted,
        metadata: {
          knowledgeBaseId: row.knowledgeBaseId,
          chunkId: row.id,
          sourceId: row.sourceId,
        },
        embedding: input.embeddings[index],
      }))
    )
    await putKnowledgeBaseChunks(rows)
  }

  return { rows, vectorDocIds: rows.map((row) => row.vectorDocId) }
}
