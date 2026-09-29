/**
 * Best-effort builders for the memory runtime's vector/embedding dependencies.
 * Mirrors `lib/twin/runtime/build-deps.ts`.
 *
 * Reuse: the embedding + vector-store backend is taken straight from
 * `tryBuildTwinDeps` (so a user who configured Twin embeddings gets memory
 * recall for free, with zero duplicated store-config switch). The Dexie
 * candidate/procedural/touch functions come from `lib/db/memories`.
 *
 * Privacy gate (applied once in `resolveMemoryBackend`): embeddings are only
 * used when the configured provider is local (`transformersjs`) OR the user has
 * explicitly opted into cloud embedding (`memory.allowCloudEmbedding`).
 * Otherwise the runtime degrades to BM25-only and personal facts never leave
 * the machine. `memory.hybridEnabled === false` is a user-facing override that
 * forces the same BM25-only degradation even when a compliant backend exists
 * (it also disables the write-path vector sink).
 */

import type { Memory, MemoryConfig } from "@/types/memory/memory"
import type { ApplyMemoryContextDeps } from "./apply-memory-context"
import { createProviderEmbeddingAdapter } from "@cognia/memory/runtime/provider-embedding-adapter"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import {
  listActiveForReader,
  listActiveProcedural,
  listHistoricalForReader,
  touchMemories,
} from "@/lib/db/memories"
import { createBedrockSidecarEmbeddingModel } from "@/lib/claude/feature-call"
import type { EmbeddingConfig } from "@cognia/provider-embedding/embedding"
import { isLocalEmbeddingProvider } from "@cognia/rag"
import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import { hasNoLeakingPii } from "@cognia/redact"

/** Single global collection for memory vectors. */
export const MEMORY_VECTOR_COLLECTION = "cognia_memory"
const VECTOR_READ_BATCH_SIZE = 256

/** The (non-undefined) shape returned by `tryBuildTwinDeps`. */
type PrebuiltTwinDeps = NonNullable<Awaited<ReturnType<typeof tryBuildTwinDeps>>>

interface MemoryBackend {
  store: PrebuiltTwinDeps["store"]
  embedding: PrebuiltTwinDeps["embedding"]
}

/** Why recall fell back to keyword-only search. */
export type MemoryRetrievalDegradeReason =
  /** The user turned `hybridEnabled` off — the only reason the old UI could show. */
  | "hybrid_disabled"
  /** No Twin embedding/vector backend is configured at all. */
  | "no_backend"
  /** A vector store exists but exposes no `searchByEmbedding`. */
  | "store_unsupported"
  /** A cloud embedder is configured but `allowCloudEmbedding` is off (the default). */
  | "cloud_blocked"

/**
 * What memory recall will *actually* do right now — as opposed to what the
 * config claims. `hybridEnabled: true` is not enough: three further conditions
 * silently degrade recall to BM25-only, and `cloud_blocked` is the default
 * state for anyone whose embedder is not local.
 */
export type MemoryRetrievalMode =
  | { kind: "hybrid"; provider: string }
  | { kind: "bm25"; reason: MemoryRetrievalDegradeReason; provider?: string }
  | { kind: "off"; reason: "disabled" | "temporary" }

/**
 * Single source of truth for the privacy/capability gate: returns both the
 * usable backend (absent → BM25-only) and the reason, so the runtime and the
 * settings probe can never disagree about why recall degraded.
 *
 * `prebuiltTwinDeps`: when the caller already built twin deps this turn, pass
 * them to skip the second `tryBuildTwinDeps()` (a Dexie read + vector-client
 * construction). Falls back to building them when omitted.
 */
async function resolveMemoryBackendOutcome(
  config: MemoryConfig,
  prebuiltTwinDeps?: PrebuiltTwinDeps
): Promise<{ backend?: MemoryBackend; mode: MemoryRetrievalMode }> {
  if (!config.hybridEnabled) return { mode: { kind: "bm25", reason: "hybrid_disabled" } }
  const twinDeps = prebuiltTwinDeps ?? (await tryBuildTwinDeps())
  const store = twinDeps?.store
  const embedding = twinDeps?.embedding
  if (!store || !embedding) return { mode: { kind: "bm25", reason: "no_backend" } }
  const provider = String(embedding.provider)
  if (typeof store.searchByEmbedding !== "function") {
    return { mode: { kind: "bm25", reason: "store_unsupported", provider } }
  }
  if (!config.allowCloudEmbedding && !isLocalEmbeddingProvider(embedding.provider)) {
    return { mode: { kind: "bm25", reason: "cloud_blocked", provider } }
  }
  return { backend: { store, embedding }, mode: { kind: "hybrid", provider } }
}

/**
 * Resolve the shared embedding + vector backend, applying the privacy gate
 * once. Returns `undefined` (→ BM25-only) when no usable, privacy-compliant
 * backend is available.
 */
async function resolveMemoryBackend(
  config: MemoryConfig,
  prebuiltTwinDeps?: PrebuiltTwinDeps
): Promise<MemoryBackend | undefined> {
  return (await resolveMemoryBackendOutcome(config, prebuiltTwinDeps)).backend
}

/**
 * Read-only probe for the settings UI: what recall does today, and why.
 *
 * Does no network I/O — `tryBuildTwinDeps` reads settings and constructs a
 * client object, and the capability check is a `typeof` test. Never throws;
 * a failure to even build twin deps reads as `no_backend`.
 */
export async function describeMemoryRetrievalMode(
  config: MemoryConfig
): Promise<MemoryRetrievalMode> {
  if (!config.enabled) return { kind: "off", reason: "disabled" }
  if (config.temporary) return { kind: "off", reason: "temporary" }
  try {
    return (await resolveMemoryBackendOutcome(config)).mode
  } catch {
    return { kind: "bm25", reason: "no_backend" }
  }
}

export async function tryBuildMemoryDeps(
  config: MemoryConfig,
  prebuiltTwinDeps?: PrebuiltTwinDeps
): Promise<ApplyMemoryContextDeps | undefined> {
  // useMemory is resolved per session by resolveMemoryTurnPolicy. Building the
  // local dependency layer must not make a chat-level opt-in impossible.
  if (!config.enabled || config.temporary) return undefined

  const deps: ApplyMemoryContextDeps = {
    loadCandidates: (reader) => listActiveForReader(reader),
    loadProcedural: (reader) => listActiveProcedural(reader),
    loadHistoricalCandidates: (reader) => listHistoricalForReader(reader),
    touch: (ids) => touchMemories(ids),
    defaults: {
      sessionRecallRouting: config.sessionRecallRouting === true,
      beliefRankingWeight: Math.max(0, config.beliefRankingWeight ?? 0),
      rerank: config.llmRerank === true,
    },
  }

  if (config.llmRerank) {
    // The reranker sends the (redacted) query and recalled texts to the
    // utility model, so it exists only when the user turned it on. A missing
    // utility model leaves recall on its local order.
    try {
      const [{ getSettings }, { buildUtilityLlmClient }, { createMemoryLlmReranker }] =
        await Promise.all([
          import("@/lib/db/settings"),
          import("@/lib/ai/generation/utility-client"),
          import("@cognia/memory/retrieve/llm-rerank"),
        ])
      const client = buildUtilityLlmClient({
        session: null,
        appSettings: (await getSettings().catch(() => undefined)) ?? null,
        featureId: "memory-rerank",
      })
      if (client) deps.rerank = createMemoryLlmReranker(client)
    } catch {
      // No reranker — recall keeps its local order.
    }
  }

  try {
    const backend = await resolveMemoryBackend(config, prebuiltTwinDeps)
    if (backend) {
      const baseEmbedConfig = backend.embedding as unknown as EmbeddingConfig
      const embedConfig: EmbeddingConfig = { ...baseEmbedConfig }
      if (
        embedConfig.provider === "amazon-bedrock" &&
        embedConfig.bedrock?.authMode === "default-chain"
      ) {
        embedConfig.bedrockModel = createBedrockSidecarEmbeddingModel({
          modelId: embedConfig.model || "amazon.titan-embed-text-v2:0",
          providerId: "bedrock",
          credentials: {
            protocol: "bedrock",
            bedrockAuthMode: "default-chain",
            region: embedConfig.bedrock.region,
            baseURL: embedConfig.bedrock.baseURL,
            profile: embedConfig.bedrock.profile,
            roleArn: embedConfig.bedrock.roleArn,
            roleSessionName: embedConfig.bedrock.roleSessionName,
          },
        })
      }
      const embeddingTransport = createProviderEmbeddingAdapter(embedConfig)
      deps.embed = async (text, options) => {
        options?.signal?.throwIfAborted()
        const result = await generateSafeEmbedding(text, {
          profileId: "memory",
          purpose: "query",
          embedding: embedConfig as EmbeddingConfig & {
            provider: PrebuiltTwinDeps["embedding"]["provider"]
          },
          vectorBackend: prebuiltTwinDeps?.vectorBackend ?? "native",
          transport: options?.signal
            ? createProviderEmbeddingAdapter({ ...embedConfig, abortSignal: options.signal })
            : embeddingTransport,
        })
        options?.signal?.throwIfAborted()
        return result.embedding
      }
      deps.vectorSearch = async (vector, topK, plan) => {
        plan?.signal?.throwIfAborted()
        const scopedIds = plan?.vectorDocIds
        if (scopedIds === undefined) {
          // No plan: a legacy caller that did not compute an eligible corpus.
          // Global search is the documented behaviour for that shape — the
          // scoped path below is what the retriever uses.
          const hits = await backend.store.searchByEmbedding!(MEMORY_VECTOR_COLLECTION, vector, {
            limit: topK,
          })
          return hits.map((h) => ({ id: h.id, score: h.score }))
        }
        if (scopedIds.length === 0) return []
        // The plan is an allowlist of doc ids, but `PayloadFilter` matches on
        // payload metadata and the doc id is not a payload field — no
        // provider-side filter can express "only these ids". So the scoped
        // path fetches exactly the authorized vectors and scores them locally
        // rather than querying the global collection and post-filtering (the
        // starvation bug this replaces: unauthorized rows crowded the top-K
        // before the filter could run).
        const { cosineSimilarity } = await import("@cognia/provider-embedding/embedding-utils")
        // Read the whole eligible corpus without retaining its entire embedding
        // matrix. Keep only the best K scores between bounded backend requests.
        const best: { id: string; score: number }[] = []
        const ids = [...new Set(scopedIds)]
        for (let offset = 0; offset < ids.length; offset += VECTOR_READ_BATCH_SIZE) {
          plan?.signal?.throwIfAborted()
          const batch = ids.slice(offset, offset + VECTOR_READ_BATCH_SIZE)
          const allowed = new Set(batch)
          const docs = await backend.store.getDocuments(MEMORY_VECTOR_COLLECTION, batch)
          plan?.signal?.throwIfAborted()
          for (const doc of docs) {
            if (
              !allowed.delete(doc.id) ||
              !Array.isArray(doc.embedding) ||
              doc.embedding.length !== vector.length ||
              !doc.embedding.every(Number.isFinite)
            )
              continue
            const score = cosineSimilarity(vector, doc.embedding)
            if (Number.isFinite(score)) best.push({ id: doc.id, score })
          }
          best.sort((left, right) => right.score - left.score)
          best.splice(topK)
        }
        return best
      }
    }
  } catch {
    // Any backend failure → BM25-only (base deps already set).
  }

  return deps
}

export interface MemoryVectorReader {
  /**
   * Stored vectors for the given memories, keyed by MEMORY id. Rows without a
   * vector, or whose vector is empty / non-finite / of a different dimension
   * than the rest, are simply absent from the map.
   */
  getEmbeddings: (
    memories: readonly Pick<Memory, "id" | "vectorDocId">[]
  ) => Promise<Map<string, number[]>>
}

/**
 * Read-only access to stored memory vectors, for the maintenance passes that
 * compare memories with each other (lifecycle-sweep dedup, lint's suspected
 * contradictions). Same privacy gate as recall — `undefined` when embeddings
 * are unavailable or not allowed — and it never embeds anything: it reads what
 * the write path already stored, so it adds no provider traffic.
 */
export async function tryBuildMemoryVectorReader(
  config: MemoryConfig
): Promise<MemoryVectorReader | undefined> {
  if (!config.enabled || config.temporary) return undefined
  try {
    const backend = await resolveMemoryBackend(config)
    if (!backend || typeof backend.store.getDocuments !== "function") return undefined
    return {
      getEmbeddings: async (memories) => {
        const byDocId = new Map<string, string>()
        for (const memory of memories) {
          if (memory.vectorDocId) byDocId.set(memory.vectorDocId, memory.id)
        }
        const valid: { memoryId: string; embedding: number[] }[] = []
        const docIds = [...byDocId.keys()]
        for (let offset = 0; offset < docIds.length; offset += VECTOR_READ_BATCH_SIZE) {
          const batch = docIds.slice(offset, offset + VECTOR_READ_BATCH_SIZE)
          const docs = await backend.store.getDocuments(MEMORY_VECTOR_COLLECTION, batch)
          for (const doc of docs) {
            const memoryId = byDocId.get(doc.id)
            const embedding = doc.embedding
            if (
              !memoryId ||
              !Array.isArray(embedding) ||
              embedding.length === 0 ||
              !embedding.every(Number.isFinite)
            )
              continue
            valid.push({ memoryId, embedding })
          }
        }
        // Vectors of a different dimension come from a different embedding
        // model (a provider switch mid-corpus) and cannot be compared. Keep the
        // majority dimension, so one stale vector cannot evict the rest by
        // happening to be read first.
        const counts = new Map<number, number>()
        for (const { embedding } of valid) {
          counts.set(embedding.length, (counts.get(embedding.length) ?? 0) + 1)
        }
        let dimension: number | undefined
        for (const [length, count] of counts) {
          if (dimension === undefined || count > counts.get(dimension)!) dimension = length
        }
        const out = new Map<string, number[]>()
        for (const { memoryId, embedding } of valid) {
          if (embedding.length === dimension) out.set(memoryId, embedding)
        }
        return out
      },
    }
  } catch {
    return undefined
  }
}

export interface MemoryVectorSink {
  /** Embed + upsert a memory's text into the vector collection under `id`. */
  upsert: (id: string, text: string) => Promise<void>
  /** Remove stale vector documents after forget/delete. */
  delete: (ids: string[]) => Promise<void>
  /**
   * Every doc id currently in the memory collection — powers vector-reconcile
   * orphan cleanup. Absent when the backend has no listing API (reconcile then
   * degrades to re-upserting missing docs only).
   */
  listIds?: () => Promise<string[]>
}

/**
 * Write-path vector sink: lets the extraction pipeline make new memories
 * semantically searchable. Returns `undefined` when embeddings are unavailable
 * (or privacy-gated) — the memory still persists to Dexie and is BM25-findable.
 */
export async function tryBuildMemoryVectorSink(
  config: MemoryConfig
): Promise<MemoryVectorSink | undefined> {
  if (!config.enabled || config.temporary) return undefined
  try {
    const backend = await resolveMemoryBackend(config)
    if (!backend) return undefined
    const store = backend.store as unknown as {
      addDocuments?: (collection: string, docs: { id: string; content: string }[]) => Promise<void>
      deleteDocuments?: (collection: string, ids: string[]) => Promise<void>
      scrollDocuments?: (
        collection: string,
        options?: { offset?: number; limit?: number }
      ) => Promise<{ documents: Array<{ id: string }>; hasMore: boolean }>
    }
    if (typeof store.addDocuments !== "function") return undefined
    const sink: MemoryVectorSink = {
      upsert: async (id, text) => {
        if (!hasNoLeakingPii(text)) throw new Error("memory_vector_pii_blocked")
        await store.addDocuments!(MEMORY_VECTOR_COLLECTION, [{ id, content: text }])
      },
      delete: async (ids) => {
        if (ids.length === 0 || typeof store.deleteDocuments !== "function") return
        await store.deleteDocuments(MEMORY_VECTOR_COLLECTION, ids)
      },
    }
    if (typeof store.scrollDocuments === "function") {
      sink.listIds = async () => {
        const ids: string[] = []
        let offset = 0
        const limit = 500
        for (;;) {
          const page = await store.scrollDocuments!(MEMORY_VECTOR_COLLECTION, { offset, limit })
          for (const doc of page.documents) ids.push(doc.id)
          if (!page.hasMore || page.documents.length === 0) break
          offset += page.documents.length
        }
        return ids
      }
    }
    return sink
  } catch {
    return undefined
  }
}
