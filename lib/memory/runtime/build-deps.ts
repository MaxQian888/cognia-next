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
 * the machine.
 */

import type { MemoryConfig } from "@/types/memory/memory"
import type { ApplyMemoryContextDeps } from "./apply-memory-context"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { generateEmbedding, type EmbeddingConfig } from "@cognia/provider-embedding/embedding"
import { listActiveForReader, listActiveProcedural, touchMemories } from "@/lib/db/memories"

/** Single global collection for memory vectors. */
export const MEMORY_VECTOR_COLLECTION = "cognia_memory"

/** The (non-undefined) shape returned by `tryBuildTwinDeps`. */
type PrebuiltTwinDeps = NonNullable<Awaited<ReturnType<typeof tryBuildTwinDeps>>>

interface MemoryBackend {
  store: PrebuiltTwinDeps["store"]
  embedding: PrebuiltTwinDeps["embedding"]
}

/**
 * Resolve the shared embedding + vector backend, applying the privacy gate
 * once. Returns `undefined` (→ BM25-only) when no usable, privacy-compliant
 * backend is available.
 *
 * `prebuiltTwinDeps`: when the caller already built twin deps this turn, pass
 * them to skip the second `tryBuildTwinDeps()` (a Dexie read + vector-client
 * construction). Falls back to building them when omitted.
 */
async function resolveMemoryBackend(
  config: MemoryConfig,
  prebuiltTwinDeps?: PrebuiltTwinDeps
): Promise<MemoryBackend | undefined> {
  const twinDeps = prebuiltTwinDeps ?? (await tryBuildTwinDeps())
  const store = twinDeps?.store
  const embedding = twinDeps?.embedding
  const canEmbed =
    !!store &&
    !!embedding &&
    typeof store.searchByEmbedding === "function" &&
    (config.allowCloudEmbedding || embedding.provider === "transformersjs")
  if (canEmbed && store && embedding) return { store, embedding }
  return undefined
}

export async function tryBuildMemoryDeps(
  config: MemoryConfig,
  prebuiltTwinDeps?: PrebuiltTwinDeps
): Promise<ApplyMemoryContextDeps | undefined> {
  if (!config.enabled) return undefined

  const deps: ApplyMemoryContextDeps = {
    loadCandidates: (characterId) => listActiveForReader(characterId),
    loadProcedural: (characterId) => listActiveProcedural(characterId),
    touch: (ids) => touchMemories(ids),
  }

  try {
    const backend = await resolveMemoryBackend(config, prebuiltTwinDeps)
    if (backend) {
      const embedConfig = backend.embedding as unknown as EmbeddingConfig
      deps.embed = async (text) => {
        const result = await generateEmbedding(text, embedConfig)
        return result.embedding
      }
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
}

/**
 * Write-path vector sink: lets the extraction pipeline make new memories
 * semantically searchable. Returns `undefined` when embeddings are unavailable
 * (or privacy-gated) — the memory still persists to Dexie and is BM25-findable.
 */
export async function tryBuildMemoryVectorSink(
  config: MemoryConfig
): Promise<MemoryVectorSink | undefined> {
  if (!config.enabled) return undefined
  try {
    const backend = await resolveMemoryBackend(config)
    if (!backend) return undefined
    const store = backend.store as unknown as {
      addDocuments?: (collection: string, docs: { id: string; content: string }[]) => Promise<void>
    }
    if (typeof store.addDocuments !== "function") return undefined
    return {
      upsert: async (id, text) => {
        await store.addDocuments!(MEMORY_VECTOR_COLLECTION, [{ id, content: text }])
      },
    }
  } catch {
    return undefined
  }
}
