/**
 * Plugin Vector API Implementation
 *
 * Provides vector/RAG capabilities to plugins.
 */

import { useVectorStore } from "@/stores"
import { useSettingsStore } from "@/stores"
import {
  createVectorStore,
  type IVectorStore,
  type VectorDocument as LibVectorDocument,
} from "@/lib/vector"
import {
  generateEmbedding,
  generateEmbeddings,
  DEFAULT_EMBEDDING_MODELS,
  resolveEmbeddingApiKey,
  type EmbeddingProvider,
} from "@/lib/vector/embedding"
import { createPluginSystemLogger } from "../core/logger"
import type {
  PluginVectorAPI,
  VectorDocument,
  VectorFilter,
  VectorSearchOptions,
  VectorSearchResult,
  CollectionOptions,
  CollectionStats,
} from "@/types/plugin/plugin-extended"
import { nanoid } from "nanoid"

/**
 * Create the Vector API for a plugin
 */
export function createVectorAPI(pluginId: string): PluginVectorAPI {
  const logger = createPluginSystemLogger(pluginId)
  let store: IVectorStore | null = null

  const getStore = async (): Promise<IVectorStore> => {
    if (store) return store

    const settings = useSettingsStore.getState()
    const vectorSettings = useVectorStore.getState().settings
    const embeddingProvider = (vectorSettings.embeddingProvider || "openai") as EmbeddingProvider
    const embeddingApiKey = resolveEmbeddingApiKey(
      embeddingProvider,
      (settings.providerSettings || {}) as Record<string, { apiKey?: string }>
    )
    const embeddingDefaults = DEFAULT_EMBEDDING_MODELS[embeddingProvider]

    store = createVectorStore({
      provider: vectorSettings.provider || "native",
      embeddingConfig: {
        provider: embeddingProvider,
        model: vectorSettings.embeddingModel || embeddingDefaults.model,
        dimensions: embeddingDefaults.dimensions,
      },
      embeddingApiKey,
      chromaMode: vectorSettings.mode,
      chromaServerUrl: vectorSettings.serverUrl,
      pineconeApiKey: vectorSettings.pineconeApiKey,
      pineconeIndexName: vectorSettings.pineconeIndexName,
      pineconeNamespace: vectorSettings.pineconeNamespace,
      weaviateUrl: vectorSettings.weaviateUrl,
      weaviateApiKey: vectorSettings.weaviateApiKey,
      qdrantUrl: vectorSettings.qdrantUrl,
      qdrantApiKey: vectorSettings.qdrantApiKey,
      milvusAddress: vectorSettings.milvusAddress,
      milvusToken: vectorSettings.milvusToken,
      milvusUsername: vectorSettings.milvusUsername,
      milvusPassword: vectorSettings.milvusPassword,
      milvusSsl: vectorSettings.milvusSsl,
      native: {},
    })

    return store
  }

  const getEmbeddingConfig = () => {
    const vectorSettings = useVectorStore.getState().settings
    const embeddingProvider = (vectorSettings.embeddingProvider || "openai") as EmbeddingProvider
    const embeddingDefaults = DEFAULT_EMBEDDING_MODELS[embeddingProvider]
    return {
      provider: embeddingProvider,
      model: vectorSettings.embeddingModel || embeddingDefaults.model,
      dimensions: embeddingDefaults.dimensions,
    }
  }

  const getApiKey = (provider: EmbeddingProvider) => {
    const settings = useSettingsStore.getState()
    return resolveEmbeddingApiKey(
      provider,
      (settings.providerSettings || {}) as Record<string, { apiKey?: string }>
    )
  }

  // Prefix collection names with plugin ID to avoid conflicts
  const prefixCollection = (name: string) => `plugin_${pluginId}_${name}`
  const mapVectorFilters = (filters?: VectorFilter[]) =>
    filters?.map((filter) => ({
      key: filter.key,
      value: filter.value,
      operation: (() => {
        switch (filter.operation) {
          case "eq":
            return "equals" as const
          case "ne":
            return "not_equals" as const
          case "gt":
            return "greater_than" as const
          case "gte":
            return "greater_than_or_equals" as const
          case "lt":
            return "less_than" as const
          case "lte":
            return "less_than_or_equals" as const
          case "contains":
            return "contains" as const
          case "in":
            return "in" as const
          default:
            return "equals" as const
        }
      })(),
    }))

  return {
    createCollection: async (name: string, _options?: CollectionOptions) => {
      const vs = await getStore()
      const prefixedName = prefixCollection(name)
      await vs.createCollection(prefixedName)
      logger.info(`Created collection: ${name}`)
      return prefixedName
    },

    deleteCollection: async (name: string) => {
      const vs = await getStore()
      const prefixedName = prefixCollection(name)
      await vs.deleteCollection(prefixedName)
      logger.info(`Deleted collection: ${name}`)
    },

    listCollections: async () => {
      const vs = await getStore()
      if (vs.listCollections) {
        const all = await vs.listCollections()
        // Filter to only this plugin's collections
        const prefix = `plugin_${pluginId}_`
        return all.filter((c) => c.name.startsWith(prefix)).map((c) => c.name.slice(prefix.length))
      }
      return []
    },

    getCollectionInfo: async (name: string): Promise<CollectionStats> => {
      const vs = await getStore()
      const prefixedName = prefixCollection(name)
      const info = await vs.getCollectionInfo(prefixedName)
      return {
        name,
        documentCount: info.documentCount,
        dimensions: info.dimension || getEmbeddingConfig().dimensions || 0,
        createdAt: info.createdAt ? new Date(info.createdAt) : new Date(),
        lastUpdated: info.updatedAt ? new Date(info.updatedAt) : new Date(),
      }
    },

    addDocuments: async (collection: string, docs: VectorDocument[]) => {
      const vs = await getStore()
      const prefixedCollection = prefixCollection(collection)

      const libDocs: LibVectorDocument[] = docs.map((doc) => ({
        id: doc.id || nanoid(),
        content: doc.content,
        metadata: doc.metadata as Record<string, unknown>,
        embedding: doc.embedding,
      }))

      await vs.addDocuments(prefixedCollection, libDocs)
      logger.info(`Added ${docs.length} documents to ${collection}`)

      return libDocs.map((d) => d.id)
    },

    updateDocuments: async (collection: string, docs: VectorDocument[]) => {
      const vs = await getStore()
      const prefixedCollection = prefixCollection(collection)

      const libDocs: LibVectorDocument[] = docs.map((doc) => ({
        id: doc.id || nanoid(),
        content: doc.content,
        metadata: doc.metadata as Record<string, unknown>,
        embedding: doc.embedding,
      }))

      if (vs.updateDocuments) {
        await vs.updateDocuments(prefixedCollection, libDocs)
      } else {
        // Fallback: delete and re-add
        const ids = libDocs.map((d) => d.id)
        await vs.deleteDocuments(prefixedCollection, ids)
        await vs.addDocuments(prefixedCollection, libDocs)
      }

      logger.info(`Updated ${docs.length} documents in ${collection}`)
    },

    deleteDocuments: async (collection: string, ids: string[]) => {
      const vs = await getStore()
      const prefixedCollection = prefixCollection(collection)
      await vs.deleteDocuments(prefixedCollection, ids)
      logger.info(`Deleted ${ids.length} documents from ${collection}`)
    },

    search: async (
      collection: string,
      query: string,
      options?: VectorSearchOptions
    ): Promise<VectorSearchResult[]> => {
      const vs = await getStore()
      const prefixedCollection = prefixCollection(collection)
      const mappedFilters = mapVectorFilters(options?.filters)

      const results = await vs.searchDocuments(prefixedCollection, query, {
        topK: options?.topK || 5,
        threshold: options?.threshold,
        filters: mappedFilters,
        filterMode: options?.filterMode,
      })

      return results.map((r) => ({
        id: r.id,
        content: r.content,
        metadata: r.metadata as Record<string, unknown>,
        score: r.score,
      }))
    },

    searchByEmbedding: async (
      collection: string,
      embedding: number[],
      options?: VectorSearchOptions
    ): Promise<VectorSearchResult[]> => {
      const vs = await getStore()
      const prefixedCollection = prefixCollection(collection)
      if (!vs.searchByEmbedding) {
        logger.warn("searchByEmbedding not supported by current vector store")
        return []
      }
      const mappedFilters = mapVectorFilters(options?.filters)
      const results = await vs.searchByEmbedding(prefixedCollection, embedding, {
        topK: options?.topK || 5,
        threshold: options?.threshold,
        filters: mappedFilters,
        filterMode: options?.filterMode,
      })

      return results.map((r) => ({
        id: r.id,
        content: r.content,
        metadata: r.metadata as Record<string, unknown>,
        score: r.score,
      }))
    },

    embed: async (text: string): Promise<number[]> => {
      const config = getEmbeddingConfig()
      const apiKey = getApiKey(config.provider)
      const result = await generateEmbedding(text, config, apiKey)
      return result.embedding
    },

    embedBatch: async (texts: string[]): Promise<number[][]> => {
      const config = getEmbeddingConfig()
      const apiKey = getApiKey(config.provider)
      const result = await generateEmbeddings(texts, config, apiKey)
      return result.embeddings
    },

    getDocumentCount: async (collection: string): Promise<number> => {
      const vs = await getStore()
      const prefixedCollection = prefixCollection(collection)
      if (vs.countDocuments) {
        return vs.countDocuments(prefixedCollection)
      }
      const info = await vs.getCollectionInfo(prefixedCollection)
      return info.documentCount
    },

    clearCollection: async (collection: string) => {
      const vs = await getStore()
      const prefixedCollection = prefixCollection(collection)

      if (vs.deleteAllDocuments) {
        await vs.deleteAllDocuments(prefixedCollection)
      }

      logger.info(`Cleared collection: ${collection}`)
    },
  }
}
