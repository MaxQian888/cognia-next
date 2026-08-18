/**
 * Agent-facing native vector service.
 *
 * Backs the three host-routed vector agent tools. Three deliberate properties:
 *
 *   1. **Native only.** It constructs `NativeVectorStore` explicitly rather
 *      than going through `createVectorStore(settings.provider)`, so enabling
 *      the agent tools can never start issuing calls against the user's
 *      configured *cloud* vector provider. Off the Tauri desktop shell the
 *      service refuses with {@link VectorServiceError} `unsupported-platform`.
 *   2. **Project-scoped.** Every method takes an already-resolved native
 *      collection name from `agent-collections`; this module never sees a
 *      logical name and never derives a project id.
 *   3. **Lazily created collections.** `addDocument` creates a missing
 *      collection at the configured embedding dimensions; `search` and
 *      `deleteDocument` treat a missing collection as empty rather than as an
 *      error, so a fresh project's first tool call is not a failure.
 *
 * Embedding settings are read from the same place the rest of the app reads
 * them (`useVectorStore` + provider settings) via an injected resolver, so the
 * agent tools cannot drift from Settings → Vector.
 */

import { NativeVectorStore, type IVectorStore, type PayloadFilter } from "@cognia/vector/store"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import type { EmbeddingModelConfig } from "@cognia/vector/embedding"

import { instrumentSpan } from "@/lib/agent-trace/instrument"

/** Machine-readable failure modes the tool layer maps onto typed tool errors. */
export type VectorServiceErrorCode =
  | "unsupported-platform"
  | "embedding-not-configured"
  | "dimension-mismatch"
  | "cancelled"
  | "store-error"

export class VectorServiceError extends Error {
  readonly code: VectorServiceErrorCode

  constructor(code: VectorServiceErrorCode, message: string) {
    super(message)
    this.name = "VectorServiceError"
    this.code = code
  }
}

/** Embedding configuration snapshot, resolved from app settings. */
export interface AgentVectorEmbeddingConfig {
  embeddingConfig: EmbeddingModelConfig
  embeddingApiKey: string
}

export interface AgentVectorServiceDeps {
  /** Desktop-shell probe. The service is unavailable when this returns false. */
  isTauri: () => boolean
  /**
   * Resolve the user's configured embedding provider/model/dimensions and the
   * key for it. Returning `null` means "not configured" and every operation
   * fails with `embedding-not-configured` before any store call.
   */
  resolveEmbedding: () => AgentVectorEmbeddingConfig | null
  /**
   * Store factory. Defaults to a real `NativeVectorStore`; tests inject a fake.
   * Called once per service instance and memoised.
   */
  createStore?: (config: {
    embeddingConfig: EmbeddingModelConfig
    embeddingApiKey: string
  }) => IVectorStore
}

export interface AgentVectorSearchOptions {
  topK?: number
  threshold?: number
  filters?: PayloadFilter[]
  signal?: AbortSignal
}

export interface AgentVectorSearchHit {
  id: string
  content: string
  score: number
  metadata?: Record<string, unknown>
}

export interface AgentVectorAddInput {
  id: string
  content: string
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

export interface AgentVectorService {
  /** Hits for `query`, or `[]` when the collection does not exist yet. */
  search(
    nativeCollection: string,
    query: string,
    options?: AgentVectorSearchOptions
  ): Promise<AgentVectorSearchHit[]>
  /** Upsert one document, creating the collection on first write. */
  addDocument(
    nativeCollection: string,
    input: AgentVectorAddInput
  ): Promise<{ id: string; createdCollection: boolean }>
  /** Remove one document. `deleted: false` when the collection or id is absent. */
  deleteDocument(
    nativeCollection: string,
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ deleted: boolean }>
}

/** Reject as soon as the caller's signal fires, between awaited steps. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new VectorServiceError("cancelled", "vector operation cancelled")
  }
}

/** Wrap a non-service error as a `store-error`, preserving the message. */
function asServiceError(err: unknown): VectorServiceError {
  if (err instanceof VectorServiceError) return err
  if (err instanceof Error && err.name === "EmbeddingDimensionMismatchError") {
    return new VectorServiceError("dimension-mismatch", err.message)
  }
  return new VectorServiceError("store-error", err instanceof Error ? err.message : String(err))
}

export function createAgentVectorService(deps: AgentVectorServiceDeps): AgentVectorService {
  let cached: { store: IVectorStore; embedding: AgentVectorEmbeddingConfig } | null = null

  const resolve = (): { store: IVectorStore; embedding: AgentVectorEmbeddingConfig } => {
    if (!deps.isTauri()) {
      throw new VectorServiceError(
        "unsupported-platform",
        "The native vector store is only available in the Cognia desktop app."
      )
    }
    if (cached) return cached
    const embedding = deps.resolveEmbedding()
    if (!embedding) {
      throw new VectorServiceError(
        "embedding-not-configured",
        "No embedding provider is configured. Set one in Settings → Vector before using the vector tools."
      )
    }
    const store = deps.createStore
      ? deps.createStore(embedding)
      : new NativeVectorStore({
          provider: "native",
          embeddingConfig: embedding.embeddingConfig,
          embeddingApiKey: embedding.embeddingApiKey,
          native: {},
        })
    cached = { store, embedding }
    return cached
  }

  /** Does the collection exist? `getCollectionInfo` throws when it does not. */
  const collectionExists = async (store: IVectorStore, name: string): Promise<boolean> => {
    try {
      const info = await store.getCollectionInfo(name)
      return info != null
    } catch {
      return false
    }
  }

  return {
    async search(nativeCollection, query, options = {}) {
      const { store } = resolve()
      throwIfAborted(options.signal)
      // `retrieval` is one of the five OTel operation names this app declares,
      // and it had NO producer: a vector query embedded the text, hit the
      // store, and left no trace, so retrieval latency was only ever visible as
      // unexplained time inside the tool that asked for it.
      return instrumentSpan(
        {
          operationName: "retrieval",
          providerName: "cognia.plugin",
          // The collection is the only stable identity here; the service is
          // deliberately blind to project ids and logical names.
          sessionId: nativeCollection,
          surface: "retrieval",
          metadata: {
            collection: nativeCollection,
            topK: options.topK ?? 5,
            ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
            filterCount: options.filters?.length ?? 0,
          },
        },
        async () => {
          try {
            // Probe first: a missing collection is an empty result, and checking
            // before embedding also avoids spending the user's embedding quota on
            // a query that can have no hits.
            if (!(await collectionExists(store, nativeCollection))) return []
            throwIfAborted(options.signal)

            const results = await store.searchDocuments(nativeCollection, query, {
              topK: options.topK ?? 5,
              ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
              ...(options.filters?.length ? { filters: options.filters } : {}),
            })
            throwIfAborted(options.signal)
            return results.map((r) => ({
              id: r.id,
              content: r.content,
              score: r.score,
              ...(r.metadata ? { metadata: r.metadata as Record<string, unknown> } : {}),
            }))
          } catch (err) {
            throw asServiceError(err)
          }
        },
        // Hit count and top score, never the retrieved content — that is user
        // data and the whole point of the `data-only` retrieval policy.
        (results) => ({
          metadata: {
            hitCount: results.length,
            topScore: results[0]?.score ?? 0,
          },
        })
      )
    },

    async addDocument(nativeCollection, input) {
      const { store, embedding } = resolve()
      throwIfAborted(input.signal)
      try {
        let createdCollection = false
        if (!(await collectionExists(store, nativeCollection))) {
          await store.createCollection(nativeCollection, {
            ...(embedding.embeddingConfig.dimensions !== undefined
              ? { dimension: embedding.embeddingConfig.dimensions }
              : {}),
            embeddingProvider: embedding.embeddingConfig.provider,
            embeddingModel: embedding.embeddingConfig.model,
          })
          createdCollection = true
        } else {
          // Existing collection: refuse rather than corrupt it when the user
          // has since switched to a differently-sized embedding model.
          await ensureCollectionDimensionCompatible(
            store,
            nativeCollection,
            embedding.embeddingConfig.dimensions,
            {
              provider: embedding.embeddingConfig.provider,
              model: embedding.embeddingConfig.model,
            }
          )
        }
        throwIfAborted(input.signal)

        await store.addDocuments(nativeCollection, [
          {
            id: input.id,
            content: input.content,
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
        ])
        throwIfAborted(input.signal)
        return { id: input.id, createdCollection }
      } catch (err) {
        throw asServiceError(err)
      }
    },

    async deleteDocument(nativeCollection, id, options = {}) {
      const { store } = resolve()
      throwIfAborted(options.signal)
      try {
        if (!(await collectionExists(store, nativeCollection))) return { deleted: false }
        throwIfAborted(options.signal)

        const existing = await store.getDocuments(nativeCollection, [id])
        if (!existing.some((doc) => doc.id === id)) return { deleted: false }
        throwIfAborted(options.signal)

        await store.deleteDocuments(nativeCollection, [id])
        return { deleted: true }
      } catch (err) {
        throw asServiceError(err)
      }
    },
  }
}
