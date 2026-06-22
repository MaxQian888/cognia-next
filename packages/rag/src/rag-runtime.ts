/**
 * Unified RAG runtime
 *
 * Centralizes RAG configuration, runtime lifecycle, and pipeline access so
 * chat, tools, workflow steps, and project knowledge all share one model.
 */

import type { RAGPipelineConfig, RAGPipelineContext, IndexingOptions } from "./rag-pipeline"
import { createRAGPipeline, type RAGPipeline } from "./rag-pipeline"
import type { VectorStoreConfig, VectorStoreProvider } from "@cognia/vector"
import type { EmbeddingProvider } from "@cognia/vector/embedding"
import type { CitationStyle } from "./citation-formatter"
import type { StorageBackendId, StorageBackendReadinessRecord } from "./runtime-adapters"
import { getStorageBackendReadiness } from "./runtime-adapters"

export interface RAGRuntimeConfig {
  vectorStore: VectorStoreConfig
  defaultCollectionName?: string
  topK?: number
  similarityThreshold?: number
  maxContextLength?: number
  hybridSearch?: RAGPipelineConfig["hybridSearch"]
  queryExpansion?: RAGPipelineConfig["queryExpansion"]
  reranking?: RAGPipelineConfig["reranking"]
  contextualRetrieval?: RAGPipelineConfig["contextualRetrieval"]
  citations?: RAGPipelineConfig["citations"]
  cache?: RAGPipelineConfig["cache"]
  dynamicContext?: RAGPipelineConfig["dynamicContext"]
  adaptiveReranking?: RAGPipelineConfig["adaptiveReranking"]
  correctiveRAG?: RAGPipelineConfig["correctiveRAG"]
  iterativeRetrieval?: RAGPipelineConfig["iterativeRetrieval"]
  parentChildChunking?: RAGPipelineConfig["parentChildChunking"]
  deduplication?: RAGPipelineConfig["deduplication"]
}

export interface VectorSettingsLike {
  provider?: VectorStoreProvider
  mode?: "embedded" | "server"
  serverUrl?: string
  pineconeApiKey?: string
  pineconeIndexName?: string
  pineconeNamespace?: string
  weaviateUrl?: string
  weaviateApiKey?: string
  qdrantUrl?: string
  qdrantApiKey?: string
  milvusAddress?: string
  milvusToken?: string
  milvusUsername?: string
  milvusPassword?: string
  milvusSsl?: boolean
  embeddingProvider: EmbeddingProvider
  embeddingModel: string
  defaultCollectionName?: string
  ragTopK?: number
  ragSimilarityThreshold?: number
  ragMaxContextLength?: number
  enableHybridSearch?: boolean
  vectorWeight?: number
  keywordWeight?: number
  enableReranking?: boolean
  enableQueryExpansion?: boolean
  enableCitations?: boolean
  citationStyle?: CitationStyle
}

export interface SharedRAGRuntimeSelection {
  usable: boolean
  provider: VectorStoreProvider
  degradeReason: "none" | "not_configured" | "runtime_error"
  runtimeConfig?: RAGRuntimeConfig
  readiness?: StorageBackendReadinessRecord
}

const VECTOR_BACKEND_IDS: Record<VectorStoreProvider, StorageBackendId> = {
  native: "vector-native",
  chroma: "vector-chroma",
  pinecone: "vector-pinecone",
  weaviate: "vector-weaviate",
  qdrant: "vector-qdrant",
  milvus: "vector-milvus",
}

function hasProviderRuntimeConfig(
  provider: VectorStoreProvider,
  settings: VectorSettingsLike
): boolean {
  switch (provider) {
    case "native":
      return true
    case "chroma":
      return settings.mode !== "server" || Boolean(settings.serverUrl?.trim())
    case "pinecone":
      return Boolean(settings.pineconeApiKey?.trim() && settings.pineconeIndexName?.trim())
    case "weaviate":
      return Boolean(settings.weaviateUrl?.trim())
    case "qdrant":
      return Boolean(settings.qdrantUrl?.trim())
    case "milvus":
      return Boolean(settings.milvusAddress?.trim())
    default:
      return false
  }
}

function mapReadinessToDegradeReason(
  readiness: StorageBackendReadinessRecord
): SharedRAGRuntimeSelection["degradeReason"] {
  if (
    readiness.state === "unconfigured" ||
    readiness.diagnostic?.code === "configuration-missing"
  ) {
    return "not_configured"
  }

  return "runtime_error"
}

function toPipelineConfig(config: RAGRuntimeConfig): RAGPipelineConfig {
  return {
    embeddingConfig: config.vectorStore.embeddingConfig,
    embeddingApiKey: config.vectorStore.embeddingApiKey,
    vectorStoreConfig: config.vectorStore,
    topK: config.topK,
    similarityThreshold: config.similarityThreshold,
    maxContextLength: config.maxContextLength,
    hybridSearch: config.hybridSearch,
    queryExpansion: config.queryExpansion,
    reranking: config.reranking,
    contextualRetrieval: config.contextualRetrieval,
    citations: config.citations,
    cache: config.cache,
    dynamicContext: config.dynamicContext,
    adaptiveReranking: config.adaptiveReranking,
    correctiveRAG: config.correctiveRAG,
    iterativeRetrieval: config.iterativeRetrieval,
    parentChildChunking: config.parentChildChunking,
    deduplication: config.deduplication,
  }
}

export function createRAGRuntimeConfigFromVectorSettings(
  vectorSettings: VectorSettingsLike,
  embeddingApiKey: string
): RAGRuntimeConfig {
  return {
    vectorStore: {
      provider: vectorSettings.provider ?? "chroma",
      embeddingConfig: {
        provider: vectorSettings.embeddingProvider,
        model: vectorSettings.embeddingModel,
      },
      embeddingApiKey,
      chromaMode: vectorSettings.mode ?? "embedded",
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
    },
    defaultCollectionName: vectorSettings.defaultCollectionName || "default",
    topK: vectorSettings.ragTopK ?? 5,
    similarityThreshold: vectorSettings.ragSimilarityThreshold ?? 0.3,
    maxContextLength: vectorSettings.ragMaxContextLength ?? 4000,
    hybridSearch: {
      enabled: vectorSettings.enableHybridSearch ?? false,
      vectorWeight: vectorSettings.vectorWeight ?? 0.7,
      keywordWeight: vectorSettings.keywordWeight ?? 0.3,
    },
    reranking: {
      enabled: vectorSettings.enableReranking ?? false,
    },
    queryExpansion: {
      enabled: vectorSettings.enableQueryExpansion ?? false,
    },
    citations: {
      enabled: vectorSettings.enableCitations ?? false,
      style: vectorSettings.citationStyle ?? "simple",
    },
  }
}

export function resolveSharedRAGRuntimeSelection(
  vectorSettings: VectorSettingsLike,
  embeddingApiKey: string
): SharedRAGRuntimeSelection {
  const provider = vectorSettings.provider ?? "chroma"
  const runtimeConfig = createRAGRuntimeConfigFromVectorSettings(vectorSettings, embeddingApiKey)

  if (!embeddingApiKey.trim() || !hasProviderRuntimeConfig(provider, vectorSettings)) {
    return {
      usable: false,
      provider,
      degradeReason: "not_configured",
      runtimeConfig,
    }
  }

  const readiness = getStorageBackendReadiness(VECTOR_BACKEND_IDS[provider])
  if (readiness?.lastCheckedAt) {
    if (readiness.state === "operational") {
      return {
        usable: true,
        provider,
        degradeReason: "none",
        runtimeConfig,
        readiness,
      }
    }

    return {
      usable: false,
      provider,
      degradeReason: mapReadinessToDegradeReason(readiness),
      runtimeConfig,
      readiness,
    }
  }

  return {
    usable: true,
    provider,
    degradeReason: "none",
    runtimeConfig,
  }
}

export class RAGRuntime {
  private config: RAGRuntimeConfig
  private pipeline: RAGPipeline

  constructor(config: RAGRuntimeConfig) {
    this.config = config
    this.pipeline = createRAGPipeline(toPipelineConfig(config))
  }

  getConfig(): RAGRuntimeConfig {
    return this.config
  }

  updateConfig(config: Partial<RAGRuntimeConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      vectorStore: {
        ...this.config.vectorStore,
        ...config.vectorStore,
      },
    }
    this.pipeline = createRAGPipeline(toPipelineConfig(this.config))
  }

  async indexDocument(
    content: string,
    options: IndexingOptions
  ): Promise<{ chunksCreated: number; success: boolean; error?: string }> {
    return this.pipeline.indexDocument(content, options)
  }

  async retrieve(collectionName: string, query: string): Promise<RAGPipelineContext> {
    return this.pipeline.retrieve(collectionName, query)
  }

  async retrieveDefault(query: string): Promise<RAGPipelineContext> {
    return this.pipeline.retrieve(this.config.defaultCollectionName || "default", query)
  }

  async deleteDocuments(collectionName: string, documentIds: string[]): Promise<number> {
    return this.pipeline.deleteDocuments(collectionName, documentIds)
  }

  async deleteByDocumentId(collectionName: string, documentId: string): Promise<number> {
    return this.pipeline.deleteByDocumentId(collectionName, documentId)
  }

  async clearCollection(collectionName: string): Promise<void> {
    return this.pipeline.clearCollection(collectionName)
  }

  async getCollectionStats(
    collectionName: string
  ): Promise<{ documentCount: number; exists: boolean }> {
    return this.pipeline.getCollectionStats(collectionName)
  }

  getPipeline(): RAGPipeline {
    return this.pipeline
  }
}

export function createRAGRuntime(config: RAGRuntimeConfig): RAGRuntime {
  return new RAGRuntime(config)
}

const sharedRuntimes = new Map<string, { runtime: RAGRuntime; configHash: string }>()

export function getSharedRAGRuntime(key: string, config: RAGRuntimeConfig): RAGRuntime {
  const configHash = JSON.stringify(config)
  const existing = sharedRuntimes.get(key)
  if (!existing || existing.configHash !== configHash) {
    const runtime = createRAGRuntime(config)
    sharedRuntimes.set(key, { runtime, configHash })
    return runtime
  }
  return existing.runtime
}

export function resetSharedRAGRuntimes(): void {
  sharedRuntimes.clear()
}
