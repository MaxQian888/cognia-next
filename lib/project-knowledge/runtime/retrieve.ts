/**
 * Retrieval core for project-scoped RAG.
 *
 * A thin parallel of the twin retrieval middle (`apply-twin-context.ts`), but
 * scoped to a project's `cognia_project_{projectId}` collection and loading from
 * the `projectChunks` table. Reuses the same provider-agnostic leaf utilities:
 * embedding, the dimension guard, RRF, LLM query expansion, the reranker, and
 * the corrective-RAG filter. The hybrid BM25 leg is intentionally omitted in v1
 * (a project-scoped keyword index is a later add).
 *
 * Never throws — any failure degrades to an empty result set (mirrors the twin /
 * memory runtimes).
 */

import { generateEmbedding } from "@cognia/provider-embedding/embedding"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import {
  ensureCollectionDimensionCompatible,
  EmbeddingDimensionMismatchError,
} from "@cognia/vector/dimension-guard"
import { reciprocalRankFusion } from "@cognia/rag/hybrid-search"
import { generateHypotheticalAnswer, generateStepBackQuery } from "@cognia/rag/query-expansion"
import type { IVectorStore } from "@cognia/vector/store"
import type { LanguageModel } from "ai"
import { rerank, type RerankCandidate } from "@/lib/twin/runtime/reranker"
import { filterByGrade } from "@/lib/ai/retrieval/corrective-filter"
import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"
import type { ProjectChunk } from "@/types/project-knowledge"
import { getProjectChunksByVectorDocIds } from "@/lib/db/project-chunks"
import { projectVectorCollectionName } from "../ingest/persist"

export interface ProjectKnowledgeRuntimeDeps {
  store: IVectorStore
  embedding: { provider: RagEmbeddingProvider; model: string; apiKey: string; baseURL?: string }
  /** Optional reranker (mirrors the twin deps shape). */
  reranker?: {
    model?: string
    overFetch?: number
    timeoutMs?: number
    scorer?: (
      query: string,
      candidate: RerankCandidate,
      opts?: { signal?: AbortSignal }
    ) => number | Promise<number>
    batchScorer?: (
      query: string,
      candidates: readonly RerankCandidate[],
      opts?: { signal?: AbortSignal }
    ) => number[] | Promise<number[]>
  }
  /** Optional LLM query expansion (HyDE / step-back). */
  expansion?: { model: LanguageModel; strategy: "hyde" | "stepback" }
  /** Override the collection name. Defaults to `cognia_project_{projectId}`. */
  vectorCollection?: string
}

export interface RetrievedProjectChunk {
  chunk: ProjectChunk
  score: number
}

export interface RetrieveProjectChunksInput {
  projectId: string
  userMessage: string
  topK: number
  precomputedQueryEmbedding?: number[]
  /** Run LLM query expansion when a model dep is present. Default true. */
  enableQueryExpansion?: boolean
  /** Run the heuristic corrective-RAG filter. Default true. */
  enableCorrectiveFilter?: boolean
  correctiveMinKeep?: number
  deps: ProjectKnowledgeRuntimeDeps
}

export interface RetrieveProjectChunksResult {
  chunks: RetrievedProjectChunk[]
  degraded: boolean
  degradedReason?: string
}

const EMPTY: RetrieveProjectChunksResult = { chunks: [], degraded: false }

export async function retrieveProjectChunks(
  input: RetrieveProjectChunksInput
): Promise<RetrieveProjectChunksResult> {
  const { projectId, userMessage, topK, deps } = input
  if (topK <= 0 || !userMessage.trim()) return EMPTY
  if (typeof deps.store.searchByEmbedding !== "function") return EMPTY

  const collection = deps.vectorCollection ?? projectVectorCollectionName(projectId)
  let degraded = false
  let degradedReason: string | undefined

  try {
    // 1. Embed the query (reuse the turn's embedding when provided).
    let queryEmbedding = input.precomputedQueryEmbedding ?? null
    if (!queryEmbedding) {
      const result = await generateEmbedding(userMessage, deps.embedding)
      queryEmbedding = result.embedding
    }

    const overFetch = deps.reranker?.overFetch ?? 3
    const fetchLimit = deps.reranker ? Math.max(topK * overFetch, topK) : topK

    // 2. Dimension guard — block a mismatched query vector against a collection
    //    built with a different embedding model.
    await ensureCollectionDimensionCompatible(deps.store, collection, queryEmbedding.length, {
      provider: deps.embedding.provider,
      model: deps.embedding.model,
    })

    const vectorHits = await deps.store.searchByEmbedding(collection, queryEmbedding, {
      limit: fetchLimit,
    })
    let vectorRanking = vectorHits.map((h) => ({ id: h.id, score: h.score }))

    // 3. Optional LLM query expansion (HyDE / step-back) fused via RRF. Skipped
    //    when the raw message carries PII (never send it to the expansion LLM).
    const wantExpansion = input.enableQueryExpansion !== false && !!deps.expansion
    if (wantExpansion && deps.expansion) {
      if (hasNoLeakingPii(userMessage)) {
        try {
          const expandedText =
            deps.expansion.strategy === "stepback"
              ? await generateStepBackQuery(userMessage, deps.expansion.model)
              : await generateHypotheticalAnswer(userMessage, deps.expansion.model)
          if (expandedText.trim().length > 0) {
            const expEmbedding = (await generateEmbedding(expandedText, deps.embedding)).embedding
            const expHits = await deps.store.searchByEmbedding(collection, expEmbedding, {
              limit: fetchLimit,
            })
            vectorRanking = reciprocalRankFusion(
              [vectorRanking, expHits.map((h) => ({ id: h.id, score: h.score }))],
              [0.6, 0.4],
              60
            )
          }
        } catch (err) {
          degraded = true
          degradedReason =
            err instanceof Error ? `expansion-failed: ${err.message}` : "expansion-failed"
        }
      } else {
        degraded = true
        degradedReason = "expansion-pii-skip"
      }
    }

    // 4. Resolve ids → Dexie chunks, preserving ranking order.
    const orderedIds = vectorRanking.map((h) => h.id)
    const scoreById = new Map(vectorRanking.map((h) => [h.id, h.score]))
    const dbChunks = await getProjectChunksByVectorDocIds(orderedIds)
    const chunkById = new Map<string, ProjectChunk>(dbChunks.map((c) => [c.vectorDocId, c]))

    let enriched: RetrievedProjectChunk[] = []
    for (const id of orderedIds) {
      const chunk = chunkById.get(id)
      if (!chunk) continue
      enriched.push({ chunk, score: scoreById.get(id) ?? 0 })
    }

    // 5. Optional rerank pass (never throws — identity fallback on failure).
    if (deps.reranker && enriched.length > topK) {
      const candidates: RerankCandidate[] = enriched.map((rc) => ({
        id: rc.chunk.vectorDocId,
        content: rc.chunk.content,
        score: rc.score,
      }))
      const reranked = await rerank(userMessage, candidates, { ...deps.reranker, topK })
      const byId = new Map(enriched.map((rc) => [rc.chunk.vectorDocId, rc]))
      enriched = reranked.candidates
        .map((c) => {
          const original = byId.get(c.id)
          return original ? { ...original, score: c.score } : null
        })
        .filter((x): x is RetrievedProjectChunk => x !== null)
    } else {
      enriched = enriched.slice(0, topK)
    }

    // 6. Optional corrective-RAG filter (heuristic, no LLM).
    if (input.enableCorrectiveFilter !== false && enriched.length > 0) {
      const kept = await filterByGrade(
        userMessage,
        enriched.map((rc) => ({
          id: rc.chunk.vectorDocId,
          content: rc.chunk.content,
          score: rc.score,
        })),
        { minKeep: input.correctiveMinKeep ?? 1 }
      )
      const keptIds = new Set(kept.map((k) => k.id))
      enriched = enriched.filter((rc) => keptIds.has(rc.chunk.vectorDocId))
    }

    return { chunks: enriched, degraded, degradedReason }
  } catch (err) {
    if (err instanceof EmbeddingDimensionMismatchError) {
      return { chunks: [], degraded: true, degradedReason: `dimension-mismatch: ${err.message}` }
    }
    return {
      chunks: [],
      degraded: true,
      degradedReason: err instanceof Error ? `retrieve-failed: ${err.message}` : "retrieve-failed",
    }
  }
}
