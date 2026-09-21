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
 *
 * The LLM query expansion is a utility generation, so with Router + Fusion's
 * `utilityLedger` surface on it runs through the ledgered generation seam
 * (`lib/ai/ledgered-generation-seam.ts`, ADR-0188 D27): reserved before it
 * leaves and settled from the provider's usage. Off, the expansion call is
 * exactly what it was.
 */

import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import {
  ensureCollectionDimensionCompatible,
  EmbeddingDimensionMismatchError,
} from "@cognia/vector/dimension-guard"
import { reciprocalRankFusion } from "@cognia/rag/hybrid-search"
import { generateHypotheticalAnswer, generateStepBackQuery } from "@cognia/rag/query-expansion"
import type { GenerationSeam } from "@cognia/provider-embedding/generation-seam"
import type { IVectorStore } from "@cognia/vector/store"
import type { LanguageModel } from "ai"
import { resolveLedgeredGenerationSeam } from "@/lib/ai/ledgered-generation-seam"
import { currentRouterFusionGateSettings } from "@/lib/router-fusion/gate/current-settings"
import { routerFusionGate } from "@/lib/router-fusion/gate/feature-gate"
import { rerank, type RerankCandidate } from "@/lib/twin/runtime/reranker"
import { filterByGrade } from "@/lib/ai/retrieval/corrective-filter"
import { hasNoLeakingPii } from "@cognia/redact"
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
  /**
   * Optional LLM query expansion (HyDE / step-back). `providerId` is the app
   * provider the model was built from, for the ledger's pricing; when a builder
   * does not set it, the twin's distill LLM settings (which the twin deps build
   * this model from) are read — only while the ledger surface is on.
   */
  expansion?: { model: LanguageModel; strategy: "hyde" | "stepback"; providerId?: string }
  /** Override the collection name. Defaults to `cognia_project_{projectId}`. */
  vectorCollection?: string
  vectorBackend?: "qdrant" | "pinecone" | "milvus" | "weaviate" | "chroma" | "native"
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

/** The utility-ledger feature id of the expansion call; the package appends its stage. */
export const PROJECT_KNOWLEDGE_EXPANSION_FEATURE = "project-knowledge-expansion"

/**
 * The ledgered generation seam for this turn's expansion call, or `undefined`
 * while `utilityLedger` is off — then nothing is injected and the call is the
 * one the package always made.
 */
async function expansionGenerationSeam(
  projectId: string,
  expansion: NonNullable<ProjectKnowledgeRuntimeDeps["expansion"]>
): Promise<GenerationSeam | undefined> {
  let settings: Awaited<ReturnType<typeof currentRouterFusionGateSettings>>
  try {
    settings = await currentRouterFusionGateSettings()
  } catch {
    // An unreadable switch never turns Router + Fusion on.
    return undefined
  }
  if (routerFusionGate(settings, "utilityLedger") !== "on") return undefined
  return resolveLedgeredGenerationSeam({
    surface: "utilityLedger",
    settings,
    resolveBinding: async () => ({
      origin: "utility",
      featureId: PROJECT_KNOWLEDGE_EXPANSION_FEATURE,
      providerId: expansion.providerId ?? (await twinDistillProviderId()),
      // The project is the workspace: its data-class policy applies (D30).
      workspaceId: projectId,
    }),
  })
}

/** The twin's distill LLM provider — the one `tryBuildTwinDeps` built the expansion model from. */
async function twinDistillProviderId(): Promise<string> {
  const { getTwinRuntimeSettings } = await import("@/lib/db/twin-runtime-settings")
  return (await getTwinRuntimeSettings()).llm.provider
}

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
      const result = await generateSafeEmbedding(userMessage, {
        profileId: `project:${projectId}`,
        purpose: "query",
        embedding: deps.embedding,
        vectorBackend: deps.vectorBackend ?? "native",
      })
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
          const generate = await expansionGenerationSeam(projectId, deps.expansion)
          const expandedText =
            deps.expansion.strategy === "stepback"
              ? generate
                ? await generateStepBackQuery(userMessage, deps.expansion.model, { generate })
                : await generateStepBackQuery(userMessage, deps.expansion.model)
              : generate
                ? await generateHypotheticalAnswer(userMessage, deps.expansion.model, { generate })
                : await generateHypotheticalAnswer(userMessage, deps.expansion.model)
          if (expandedText.trim().length > 0) {
            const expEmbedding = (
              await generateSafeEmbedding(expandedText, {
                profileId: `project:${projectId}`,
                purpose: "query",
                embedding: deps.embedding,
                vectorBackend: deps.vectorBackend ?? "native",
              })
            ).embedding
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
