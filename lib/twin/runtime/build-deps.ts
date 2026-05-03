import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { createVectorStore } from "@/lib/vector/store"
import type { resolveSendOptions } from "@/lib/claude/build-options"

export type TwinDepsForBuild = NonNullable<Parameters<typeof resolveSendOptions>[0]["twinDeps"]>

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
    if (!settings.embedding.apiKey) return undefined

    const storage = settings.storage
    const embedding = {
      provider: settings.embedding.provider,
      model: settings.embedding.model,
      dimensions: undefined as number | undefined,
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
    return {
      store,
      embedding: settings.embedding,
      vectorBackend: settings.storage.vectorBackend,
    }
  } catch {
    return undefined
  }
}
