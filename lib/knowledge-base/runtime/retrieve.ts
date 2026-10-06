import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import {
  EmbeddingDimensionMismatchError,
  ensureCollectionDimensionCompatible,
} from "@cognia/vector/dimension-guard"
import type { IVectorStore } from "@cognia/vector/store"
import {
  getKnowledgeBaseChunksByVectorDocIds,
  listKnowledgeBaseRevisionChunks,
} from "@/lib/db/knowledge-bases"
import type { VectorBackend } from "@/types/twin"
import type { AgentKnowledgeLibraryResult } from "./apply-agent-knowledge-context"
import { BM25Index } from "@cognia/rag/hybrid-search"
import { createRetrievalKernel } from "@cognia/rag/retrieval-kernel"
import {
  createRetrievalProfile,
  fingerprintRetrievalProfile,
  sha256Hex,
} from "@cognia/rag/retrieval-profile"
import { isRetrievalKillSwitchEngaged } from "@/lib/db/retrieval-control"
import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import type { KnowledgeBaseChunk } from "@/types/knowledge-base"

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
  generationIds?: readonly string[]
  /** Opt-in candidate selection; existing callers retain vector ranking. */
  strategy?: "vector" | "hybrid" | "keyword"
  tokenBudget?: number
  /** Host-owned authorization, evaluated before either lane scores content. */
  authorizeChunk?: (chunk: KnowledgeBaseChunk) => boolean | Promise<boolean>
  deps?: KnowledgeBaseRuntimeDeps
}

export function knowledgeBaseVectorCollectionName(knowledgeBaseId: string): string {
  return `cognia_kb_${knowledgeBaseId}`
}

/** Retrieve one reusable library. All failures are scoped to this library. */
export async function retrieveKnowledgeBaseChunks(
  input: RetrieveKnowledgeBaseChunksInput
): Promise<AgentKnowledgeLibraryResult> {
  const query = input.userMessage.trim()
  const deps = input.deps
  const search = deps?.store.searchByEmbedding
  if (!query || !Number.isFinite(input.topK) || input.topK <= 0) {
    return { chunks: [], degraded: false }
  }
  if (
    input.tokenBudget !== undefined &&
    (!Number.isFinite(input.tokenBudget) || input.tokenBudget <= 0)
  ) {
    return { chunks: [], degraded: false }
  }
  if (input.strategy === "hybrid" || input.strategy === "keyword") {
    try {
      return await retrieveHybridKnowledgeBaseChunks(input)
    } catch {
      return { chunks: [], degraded: true, degradedReason: "retrieve-failed" }
    }
  }
  if (!deps || typeof search !== "function") return { chunks: [], degraded: false }

  try {
    if (await isRetrievalKillSwitchEngaged()) {
      const lexical = await retrieveHybridKnowledgeBaseChunks({ ...input, strategy: "keyword" })
      return { ...lexical, degraded: true, degradedReason: "kill_switch_active" }
    }
    const topK = Math.min(100, Math.max(1, Math.floor(input.topK)))
    const queryEmbedding =
      input.precomputedQueryEmbedding ??
      (
        await generateSafeEmbedding(query, {
          profileId: `kb:${input.knowledgeBaseId}`,
          purpose: "query",
          embedding: deps.embedding,
          vectorBackend: deps.vectorBackend,
        })
      ).embedding
    const revisionRows = await eligibleRevisionRows(input)
    const collections = [...new Set(revisionRows.map((row) => row.vectorCollection))]
    if (collections.length === 0) return { chunks: [], degraded: false }
    const allowedVectorIds = new Set(revisionRows.map((row) => row.vectorDocId))
    const hits: Array<{ id: string; content: string; score: number }> = []
    let incompatibleCollections = 0
    for (const collection of collections) {
      try {
        await ensureCollectionDimensionCompatible(deps.store, collection, queryEmbedding.length, {
          provider: deps.embedding.provider,
          model: deps.embedding.model,
        })
      } catch (error) {
        if (error instanceof EmbeddingDimensionMismatchError) {
          incompatibleCollections += 1
          continue
        }
        throw error
      }
      hits.push(...(await search(collection, queryEmbedding, { limit: topK })))
    }
    if (incompatibleCollections === collections.length) {
      return { chunks: [], degraded: true, degradedReason: "dimension-mismatch" }
    }
    hits.sort((left, right) => right.score - left.score)
    const limitedHits = hits.filter((hit) => allowedVectorIds.has(hit.id)).slice(0, topK)
    const rows = await getKnowledgeBaseChunksByVectorDocIds(
      input.knowledgeBaseId,
      limitedHits.map((hit) => hit.id)
    )
    const rowByVectorId = new Map(rows.map((row) => [row.vectorDocId, row]))
    const chunks: AgentKnowledgeLibraryResult["chunks"] = []
    let remaining = input.tokenBudget ?? Number.MAX_SAFE_INTEGER
    for (const hit of limitedHits) {
      const chunk = rowByVectorId.get(hit.id)
      if (
        !chunk ||
        chunk.knowledgeBaseId !== input.knowledgeBaseId ||
        !allowedVectorIds.has(chunk.vectorDocId)
      )
        continue
      if (input.authorizeChunk && !(await input.authorizeChunk(chunk))) continue
      const tokens = Number.isFinite(chunk.tokenCount)
        ? Math.max(1, Math.ceil(chunk.tokenCount))
        : Math.max(1, Math.ceil(chunk.content.length / 4))
      if (tokens > remaining) continue
      remaining -= tokens
      chunks.push({ chunk, score: hit.score })
    }
    return {
      chunks,
      degraded: incompatibleCollections > 0,
      ...(incompatibleCollections > 0 ? { degradedReason: "incompatible-generation" } : {}),
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

async function eligibleRevisionRows(
  input: RetrieveKnowledgeBaseChunksInput
): Promise<KnowledgeBaseChunk[]> {
  const rows = await listKnowledgeBaseRevisionChunks(input.knowledgeBaseId, input.generationIds)
  const eligible: KnowledgeBaseChunk[] = []
  for (const row of rows) {
    if (row.knowledgeBaseId !== input.knowledgeBaseId) continue
    if (input.authorizeChunk && !(await input.authorizeChunk(row))) continue
    eligible.push(row)
  }
  return eligible
}

/** A KB adapter over the shared retrieval kernel; no second fusion or tokenizer. */
async function retrieveHybridKnowledgeBaseChunks(
  input: RetrieveKnowledgeBaseChunksInput
): Promise<AgentKnowledgeLibraryResult> {
  const rows = await eligibleRevisionRows(input)
  if (rows.length === 0) return { chunks: [], degraded: false }
  const rowById = new Map(rows.map((row) => [row.vectorDocId, row]))
  const keyword = new BM25Index()
  for (const row of rows) keyword.addDocument(row.vectorDocId, row.contentRedacted || row.content)
  const topK = Math.min(100, Math.max(1, Math.floor(input.topK)))
  const deps = input.deps
  const configured = deps ? undefined : await getTwinRuntimeSettings()
  const embeddingConfig = deps?.embedding ?? configured!.embedding
  const tokenBudget =
    input.tokenBudget === undefined
      ? Number.MAX_SAFE_INTEGER
      : Number.isFinite(input.tokenBudget)
        ? Math.max(0, Math.floor(input.tokenBudget))
        : 0
  const profile = createRetrievalProfile({
    id: `kb:${input.knowledgeBaseId}`,
    embedding: { provider: embeddingConfig.provider, model: embeddingConfig.model },
    vector: { backend: deps?.vectorBackend ?? configured!.storage.vectorBackend },
    budgets: { topK, tokenBudget },
  })
  const search = deps?.store.searchByEmbedding
  const vectorEnabled = input.strategy !== "keyword"
  let vectorFailure: string | undefined
  const candidate = (id: string, score: number) => ({
    id,
    score,
    sourceId: rowById.get(id)!.sourceId,
    domain: "kb" as const,
  })
  const kernel = createRetrievalKernel({
    profile,
    profileFingerprint: await fingerprintRetrievalProfile(profile),
    killSwitchEngaged: isRetrievalKillSwitchEngaged,
    generationId: [...new Set(rows.map((row) => row.generationId ?? "legacy"))].sort().join(","),
    lexicalSearch: async (query, _request, limit) =>
      keyword.search(query, limit).map((hit) => candidate(hit.id, hit.score)),
    ...(vectorEnabled && deps
      ? {
          embedQuery: async (query: string) => {
            const result = await generateSafeEmbedding(query, {
              profileId: profile.id,
              purpose: "query",
              embedding: deps.embedding,
              vectorBackend: deps.vectorBackend,
            })
            return { embedding: result.embedding, safeTextHash: result.safeTextHash }
          },
          ...(search
            ? {
                vectorSearch: async (embedding: number[], _request: unknown, limit: number) => {
                  const hits: Array<{ id: string; score: number }> = []
                  for (const collection of new Set(rows.map((row) => row.vectorCollection))) {
                    try {
                      await ensureCollectionDimensionCompatible(
                        deps.store,
                        collection,
                        embedding.length,
                        {
                          provider: deps.embedding.provider,
                          model: deps.embedding.model,
                        }
                      )
                      hits.push(
                        ...(await search(collection, embedding, { limit })).filter((hit) =>
                          rowById.has(hit.id)
                        )
                      )
                    } catch (error) {
                      vectorFailure =
                        error instanceof EmbeddingDimensionMismatchError
                          ? "dimension-mismatch"
                          : "retrieve-failed"
                    }
                  }
                  return hits
                    .sort((a, b) => b.score - a.score)
                    .map((hit) => candidate(hit.id, hit.score))
                },
              }
            : {}),
        }
      : {}),
    checkEligibility: async ({ id }) => {
      const row = rowById.get(id)
      return { eligible: !!row && (!input.authorizeChunk || (await input.authorizeChunk(row))) }
    },
    resolveContent: async (candidates) =>
      candidates.flatMap(({ id }) => {
        const row = rowById.get(id)
        return row
          ? [
              {
                id,
                sourceId: row.sourceId,
                domain: "kb" as const,
                content: row.content,
                tokenCount: Number.isFinite(row.tokenCount)
                  ? Math.max(1, Math.ceil(row.tokenCount))
                  : Math.max(1, Math.ceil(row.content.length / 4)),
                trust: "untrusted" as const,
                citation: {
                  sourceRevision: row.generationId ?? row.contentHash,
                  startOffset: row.charStart,
                  endOffset: row.charEnd,
                },
              },
            ]
          : []
      }),
  })
  const result = await kernel.retrieve({
    query: input.userMessage,
    reader: {},
    domains: ["kb"],
    topK,
    tokenBudget,
    ...(vectorEnabled && input.precomputedQueryEmbedding
      ? {
          precomputedEmbedding: {
            embedding: input.precomputedQueryEmbedding,
            safeTextHash: await sha256Hex(input.userMessage),
          },
        }
      : {}),
  })
  const reasons = result.reasons.filter(
    (reason) => vectorEnabled || reason.code !== "vector_not_configured"
  )
  const degraded = !!vectorFailure || (vectorEnabled && result.degraded)
  return {
    chunks: result.hits.map((hit) => ({ chunk: rowById.get(hit.id)!, score: hit.score })),
    degraded,
    ...(degraded ? { degradedReason: vectorFailure ?? reasons[0]?.code ?? "retrieve-failed" } : {}),
  }
}
