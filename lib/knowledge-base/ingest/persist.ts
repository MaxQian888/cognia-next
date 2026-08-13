import {
  getKnowledgeBaseSourcesByIds,
  listKnowledgeBaseChunksBySource,
} from "@/lib/db/knowledge-bases"
import { getDb } from "@/lib/db/schema"
import { runGenerationSwap } from "@/lib/rag/generation-ingest"
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
  profileFingerprint?: string
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
  generationId?: string
  cleanupPending?: boolean
}

function vectorDocId(
  knowledgeBaseId: string,
  sourceId: string,
  generationId: string,
  index: number
): string {
  return `${knowledgeBaseId}__${sourceId}__${generationId}__${index.toString(36)}`
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
  const oldVectors = existing.map((row) => ({
    collection: row.vectorCollection,
    id: row.vectorDocId,
  }))

  const now = Date.now()
  const result = await runGenerationSwap({
    idPrefix: "kbgen",
    corpusId: `knowledge_base:${input.knowledgeBaseId}:source:${input.sourceId}`,
    domain: "kb",
    profileFingerprint:
      input.profileFingerprint ?? `legacy:${input.vectorBackend}:${dimension ?? "none"}`,
    collection,
    store: input.store,
    contentHash: input.contentHash,
    expectedCount: input.chunks.length,
    expectedDimension: dimension,
    oldVectors,
    now,
    build: (generationId) => {
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
        vectorDocId: vectorDocId(input.knowledgeBaseId, input.sourceId, generationId, index),
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
            knowledgeBaseId: row.knowledgeBaseId,
            chunkId: row.id,
            sourceId: row.sourceId,
            generationId: row.generationId,
          },
          embedding: input.embeddings[index],
        })),
      }
    },
    commit: async (rows, activate) => {
      const db = getDb()
      await db.transaction(
        "rw",
        [db.knowledgeBaseChunks, db.retrievalGenerations, db.retrievalActivePointers],
        async () => {
          await db.knowledgeBaseChunks.where("sourceId").equals(input.sourceId).delete()
          if (rows.length > 0) await db.knowledgeBaseChunks.bulkPut(rows)
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
