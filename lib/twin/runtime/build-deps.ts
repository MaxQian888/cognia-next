import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { createVectorStore } from "@cognia/vector/store"
import { embeddingProviderRequiresApiKey } from "@cognia/provider-embedding/embedding-catalog"
import { createLlmRerankScorer, lexicalRerankScorer } from "./reranker"
import { createLlmClient } from "@/lib/twin/distill/llm"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"

export type TwinDepsForBuild = TwinRuntimeDepsForBuild

/**
 * Best-effort twin deps loader. Pulls runtime settings + builds a vector
 * store client when the config is complete. Returns `undefined` (so the
 * resolver short-circuits) on any incomplete state — callers don't need
 * to know which field is missing.
 */
export async function tryBuildTwinDeps(): Promise<TwinDepsForBuild | undefined> {
  try {
    const settings = await getTwinRuntimeSettings()
    if (!settings.workerEnabled) return undefined
    // Local providers need no API key; only require one when the provider does.
    if (
      embeddingProviderRequiresApiKey(settings.embedding.provider) &&
      !settings.embedding.apiKey
    ) {
      return undefined
    }

    const storage = settings.storage
    const embedding = {
      provider: settings.embedding.provider,
      model: settings.embedding.model,
      dimensions: undefined as number | undefined,
      baseURL: settings.embedding.baseURL,
    }
    const apiKey = settings.embedding.apiKey

    type StoreConfig = Parameters<typeof createVectorStore>[0]
    let storeConfig: StoreConfig | null = null
    switch (storage.vectorBackend) {
      case "qdrant":
        if (storage.qdrant?.url) {
          storeConfig = {
            provider: "qdrant",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            qdrantUrl: storage.qdrant.url,
            qdrantApiKey: storage.qdrant.apiKey,
          }
        }
        break
      case "pinecone":
        if (storage.pinecone?.apiKey && storage.pinecone.indexName) {
          storeConfig = {
            provider: "pinecone",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            pineconeApiKey: storage.pinecone.apiKey,
            pineconeIndexName: storage.pinecone.indexName,
            pineconeNamespace: storage.pinecone.namespace,
          }
        }
        break
      case "weaviate":
        if (storage.weaviate?.url) {
          storeConfig = {
            provider: "weaviate",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            weaviateUrl: storage.weaviate.url,
            weaviateApiKey: storage.weaviate.apiKey,
          }
        }
        break
      case "milvus":
        if (storage.milvus?.address) {
          storeConfig = {
            provider: "milvus",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            milvusAddress: storage.milvus.address,
            milvusToken: storage.milvus.token,
            milvusSsl: storage.milvus.ssl,
          }
        }
        break
      case "chroma":
        if (storage.chroma?.mode === "embedded" || storage.chroma?.serverUrl) {
          storeConfig = {
            provider: "chroma",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            chromaMode: storage.chroma?.mode,
            chromaServerUrl: storage.chroma?.serverUrl,
          }
        }
        break
      case "native":
        storeConfig = {
          provider: "native",
          embeddingConfig: embedding,
          embeddingApiKey: apiKey,
          native: {},
        }
        break
    }
    if (!storeConfig) return undefined

    const store = createVectorStore(storeConfig)
    // Optional reranker: when enabled, attach a re-scorer so applyTwinContext
    // over-fetches + re-scores. When disabled (the default) we leave `reranker`
    // unset, so RAG fetches exactly topK with no over-fetch and no rerank pass.
    //   - "lexical"     → the built-in key-free scorer (no LLM, no over-fetch cost).
    //   - anything else → a model-backed LLM reranker using the twin's own LLM
    //     config (one batched relevance call over a wider pool). Falls back to
    //     the lexical scorer when the LLM is unconfigured (no apiKey / baseURL),
    //     so a half-set model id never silently disables reranking. The LLM
    //     batch call gets a longer timeout than the local lexical path.
    const reranker = buildReranker(settings)
    return {
      store,
      embedding: settings.embedding,
      vectorBackend: settings.storage.vectorBackend,
      ...(reranker ? { reranker } : {}),
    }
  } catch {
    return undefined
  }
}

type TwinSettings = Awaited<ReturnType<typeof getTwinRuntimeSettings>>

/**
 * Build the reranker dep from the twin runtime settings, or `undefined` when
 * reranking is off. See the call site in `tryBuildTwinDeps` for the strategy
 * matrix (lexical vs LLM, with graceful fallback).
 */
function buildReranker(settings: TwinSettings): TwinDepsForBuild["reranker"] {
  const rr = settings.reranker
  if (!rr?.enabled) return undefined

  // Lexical (default): local, key-free, cheap.
  if (rr.model === "lexical") {
    return { model: rr.model, overFetch: 3, scorer: lexicalRerankScorer }
  }

  // Model-backed: reuse the twin's distill LLM config. A cloud provider needs
  // an apiKey; an OpenAI-compatible local endpoint may pass only a baseURL.
  const llm = settings.llm
  const llmReady = Boolean(llm.apiKey || llm.baseURL)
  if (!llmReady) {
    // Half-configured model id — degrade to the lexical scorer rather than
    // silently disabling the rerank pass the user turned on.
    return { model: "lexical", overFetch: 3, scorer: lexicalRerankScorer }
  }

  const client = createLlmClient({
    provider: llm.provider,
    model: llm.model,
    apiKey: llm.apiKey,
    baseURL: llm.baseURL,
  })
  return {
    model: rr.model,
    // Wider pool for the LLM to choose from; one batched call re-ranks it.
    overFetch: 5,
    // LLM makes a network round-trip — allow more than the 1.5 s local default.
    timeoutMs: 8000,
    batchScorer: createLlmRerankScorer(client),
  }
}
