import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import {
  EmbeddingDimensionMismatchError,
  ensureCollectionDimensionCompatible,
} from "@cognia/vector/dimension-guard"
import type { IVectorStore } from "@cognia/vector/store"
import { getKnowledgeBaseChunksByVectorDocIds } from "@/lib/db/knowledge-bases"
import type { VectorBackend } from "@/types/twin"
import type { AgentKnowledgeLibraryResult } from "./apply-agent-knowledge-context"

export interface KnowledgeBaseRuntimeDeps {
  store: Pick<IVectorStore, "getCollectionInfo"> & {
    searchByEmbedding?: (
      collection: string,
      embedding: number[],
      options?: { limit?: number }
    ) => Promise<Array<{ id: string; content: string; score: number }>>
  }
  embedding: {
    provider: RagEmbeddingProvider
    model: string
    apiKey: string
    baseURL?: string
  }
  vectorBackend: VectorBackend
}

export interface RetrieveKnowledgeBaseChunksInput {
  knowledgeBaseId: string
  userMessage: string
  topK: number
  precomputedQueryEmbedding?: number[]
  deps: KnowledgeBaseRuntimeDeps
}

export function knowledgeBaseVectorCollectionName(knowledgeBaseId: string): string {
  return `cognia_kb_${knowledgeBaseId}`
}

/** Retrieve one reusable library. All failures are scoped to this library. */
export async function retrieveKnowledgeBaseChunks(
  input: RetrieveKnowledgeBaseChunksInput
): Promise<AgentKnowledgeLibraryResult> {
  const query = input.userMessage.trim()
  const search = input.deps.store.searchByEmbedding
  if (!query || input.topK <= 0 || typeof search !== "function") {
    return { chunks: [], degraded: false }
  }

  try {
    const queryEmbedding =
      input.precomputedQueryEmbedding ??
      (
        await generateSafeEmbedding(query, {
          profileId: `kb:${input.knowledgeBaseId}`,
          purpose: "query",
          embedding: input.deps.embedding,
          vectorBackend: input.deps.vectorBackend,
        })
      ).embedding
    const collection = knowledgeBaseVectorCollectionName(input.knowledgeBaseId)
    await ensureCollectionDimensionCompatible(input.deps.store, collection, queryEmbedding.length, {
      provider: input.deps.embedding.provider,
      model: input.deps.embedding.model,
    })
    const hits = await search(collection, queryEmbedding, { limit: Math.floor(input.topK) })
    const rows = await getKnowledgeBaseChunksByVectorDocIds(
      input.knowledgeBaseId,
      hits.map((hit) => hit.id)
    )
    const rowByVectorId = new Map(rows.map((row) => [row.vectorDocId, row]))
    return {
      chunks: hits
        .map((hit) => {
          const chunk = rowByVectorId.get(hit.id)
          return chunk ? { chunk, score: hit.score } : null
        })
        .filter((value): value is AgentKnowledgeLibraryResult["chunks"][number] => value !== null),
      degraded: false,
    }
  } catch (error) {
    return {
      chunks: [],
      degraded: true,
      degradedReason:
        error instanceof EmbeddingDimensionMismatchError ? "dimension-mismatch" : "retrieve-failed",
    }
  }
}
