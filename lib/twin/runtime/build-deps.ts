import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { createVectorStore } from "@cognia/vector/store"
import {
  embeddingProviderRequiresApiKey,
  embeddingProviderRequiresBaseURL,
} from "@cognia/provider-embedding/embedding-catalog"
import { createLlmRerankScorer, lexicalRerankScorer } from "./reranker"
import { createLlmClient, createTwinLanguageModel } from "@/lib/twin/distill/llm"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"
import type { TwinRuntimeSettings } from "@/types/twin"
import { getTwinVectorConfigId } from "./vector-credentials"

export type TwinDepsForBuild = TwinRuntimeDepsForBuild

export type TwinRuntimeAdapterUnavailableReason =
  "disabled" | "missing-embedding-credentials" | "incomplete-storage" | "adapter-unavailable"

export type TwinRuntimeAdapterBuildResult =
  | { ready: true; adapters: TwinDepsForBuild }
  | { ready: false; reason: TwinRuntimeAdapterUnavailableReason; error?: string }

type StoreConfig = Parameters<typeof createVectorStore>[0]

function hasRequiredEmbeddingConfiguration(settings: TwinRuntimeSettings): boolean {
  const embedding = settings.embedding
  if (!embedding.model.trim()) return false
  if (embeddingProviderRequiresApiKey(embedding.provider) && !embedding.apiKey.trim()) return false
  if (embeddingProviderRequiresBaseURL(embedding.provider) && !embedding.baseURL?.trim())
    return false
  return true
}

export function deriveTwinVectorStoreConfig(
  settings: TwinRuntimeSettings,
  options: { requireEmbeddingCredentials?: boolean } = {}
): StoreConfig | null {
  if (
    (options.requireEmbeddingCredentials ?? true) &&
    !hasRequiredEmbeddingConfiguration(settings)
  ) {
    return null
  }
  const storage = settings.storage
  const embedding = {
    provider: settings.embedding.provider,
    model: settings.embedding.model,
    dimensions: undefined as number | undefined,
    baseURL: settings.embedding.baseURL,
    bedrock: settings.embedding.bedrock,
  }
  const embeddingApiKey = settings.embedding.apiKey
  switch (storage.vectorBackend) {
    case "qdrant":
      return storage.qdrant?.url
        ? {
            provider: "qdrant",
            configId: getTwinVectorConfigId("qdrant"),
            embeddingConfig: embedding,
            embeddingApiKey,
            qdrantUrl: storage.qdrant.url,
            qdrantApiKey: storage.qdrant.apiKey,
          }
        : null
    case "pinecone":
      return storage.pinecone?.apiKey && storage.pinecone.indexName
        ? {
            provider: "pinecone",
            configId: getTwinVectorConfigId("pinecone"),
            embeddingConfig: embedding,
            embeddingApiKey,
            pineconeApiKey: storage.pinecone.apiKey,
            pineconeIndexName: storage.pinecone.indexName,
            pineconeNamespace: storage.pinecone.namespace,
          }
        : null
    case "weaviate":
      return storage.weaviate?.url
        ? {
            provider: "weaviate",
            configId: getTwinVectorConfigId("weaviate"),
            embeddingConfig: embedding,
            embeddingApiKey,
            weaviateUrl: storage.weaviate.url,
            weaviateApiKey: storage.weaviate.apiKey,
          }
        : null
    case "milvus":
      return storage.milvus?.address
        ? {
            provider: "milvus",
            configId: getTwinVectorConfigId("milvus"),
            embeddingConfig: embedding,
            embeddingApiKey,
            milvusAddress: storage.milvus.address,
            milvusToken: storage.milvus.token,
            milvusSsl: storage.milvus.ssl,
          }
        : null
    case "chroma":
      return storage.chroma?.mode === "server" && storage.chroma.serverUrl
        ? {
            provider: "chroma",
            configId: getTwinVectorConfigId("chroma"),
            embeddingConfig: embedding,
            embeddingApiKey,
            chromaMode: storage.chroma?.mode,
            chromaServerUrl: storage.chroma?.serverUrl,
          }
        : null
    case "native":
      return {
        provider: "native",
        embeddingConfig: embedding,
        embeddingApiKey,
        native: {},
      }
  }
}

/** One adapter builder shared by retrieval, background ingest, and lifecycle cleanup. */
export async function buildTwinRuntimeAdapters(
  settings: TwinRuntimeSettings,
  options: { requireEnabled?: boolean } = {}
): Promise<TwinRuntimeAdapterBuildResult> {
  if ((options.requireEnabled ?? true) && !settings.workerEnabled) {
    return { ready: false, reason: "disabled" }
  }
  if (!hasRequiredEmbeddingConfiguration(settings)) {
    return { ready: false, reason: "missing-embedding-credentials" }
  }
  const storeConfig = deriveTwinVectorStoreConfig(settings)
  if (!storeConfig) return { ready: false, reason: "incomplete-storage" }
  try {
    const store = createVectorStore(storeConfig)
    const reranker = buildReranker(settings)
    const expansion = await buildExpansion(settings)
    return {
      ready: true,
      adapters: {
        store,
        embedding: settings.embedding,
        vectorBackend: settings.storage.vectorBackend,
        ...(reranker ? { reranker } : {}),
        ...(expansion ? { expansion } : {}),
      },
    }
  } catch (error) {
    return {
      ready: false,
      reason: "adapter-unavailable",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Best-effort twin deps loader. Pulls runtime settings + builds a vector
 * store client when the config is complete. Returns `undefined` (so the
 * resolver short-circuits) on any incomplete state — callers don't need
 * to know which field is missing.
 */
export async function tryBuildTwinDeps(): Promise<TwinDepsForBuild | undefined> {
  try {
    const settings = await getTwinRuntimeSettings()
    const result = await buildTwinRuntimeAdapters(settings)
    return result.ready ? result.adapters : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the LLM query-expansion dep from the twin runtime settings, or
 * `undefined` when the global `queryExpansion` block is off or the distill LLM
 * is unconfigured (heuristic synonym expansion still runs per-character without
 * this dep). The per-character `enableQueryExpansion` toggle gates whether the
 * runtime actually uses it.
 */
async function buildExpansion(settings: TwinSettings): Promise<TwinDepsForBuild["expansion"]> {
  const qe = settings.queryExpansion
  if (!qe?.enabled) return undefined
  const llm = settings.llm
  const llmReady = Boolean(llm.apiKey || llm.baseURL)
  if (!llmReady) return undefined
  try {
    const model = await createTwinLanguageModel({
      provider: llm.provider,
      model: llm.model,
      apiKey: llm.apiKey,
      baseURL: llm.baseURL,
    })
    return { model, strategy: qe.strategy }
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
