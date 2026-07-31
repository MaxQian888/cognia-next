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

import type { MemoryConfig } from "@/types/memory/memory"
import type { ApplyMemoryContextDeps } from "./apply-memory-context"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { createProviderEmbeddingAdapter } from "@cognia/memory/runtime/provider-embedding-adapter"
import { listActiveForReader, listActiveProcedural, touchMemories } from "@/lib/db/memories"
import { createBedrockSidecarEmbeddingModel } from "@/lib/claude/feature-call"
import type { EmbeddingConfig } from "@cognia/provider-embedding/embedding"

/** Single global collection for memory vectors. */
export const MEMORY_VECTOR_COLLECTION = "cognia_memory"

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
  if (!config.allowCloudEmbedding && provider !== "transformersjs") {
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
    touch: (ids) => touchMemories(ids),
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
      deps.embed = createProviderEmbeddingAdapter(embedConfig)
      deps.vectorSearch = async (vector, topK) => {
        const hits = await backend.store.searchByEmbedding!(MEMORY_VECTOR_COLLECTION, vector, {
          limit: topK,
        })
        return hits.map((h) => ({ id: h.id, score: h.score }))
      }
    }
  } catch {
    // Any backend failure → BM25-only (base deps already set).
  }

  return deps
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
