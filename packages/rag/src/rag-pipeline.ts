/**
 * RAG Pipeline
 *
 * Unified RAG pipeline that combines all advanced features:
 * - Hybrid search (BM25 + Vector)
 * - Contextual retrieval
 * - Query expansion
 * - Reranking
 * - Result deduplication
 */

import type { LanguageModel } from "ai"
import type { DocumentChunk, ChunkingOptions } from "@cognia/provider-embedding/chunking"
import { chunkDocument } from "@cognia/provider-embedding/chunking"
import { chunkDocumentAsync } from "@cognia/provider-embedding/chunking"
import type { EmbeddingModelConfig } from "@cognia/vector/embedding"
import { generateEmbedding } from "@cognia/vector/embedding"
import { cosineSimilarity } from "@cognia/provider-embedding/embedding"
import {
  generateSparseEmbedding,
  sparseCosineSimilarity,
  type SparseVector,
} from "@cognia/provider-embedding/sparse-embedding"
import { scoreLateInteraction } from "@cognia/provider-embedding/late-interaction"

import { HybridSearchEngine, type HybridSearchConfig } from "./hybrid-search"
import { loggers } from "@/lib/logging"
import {
  createVectorStore,
  type IVectorStore,
  type VectorStoreConfig,
  type VectorSearchResult,
  type VectorDocument,
} from "@cognia/vector"
import {
  createPersistentStorage,
  isIndexedDBAvailable,
  type PersistentRAGStorage,
} from "./persistent-storage"

const log = loggers.ai
import { rerank, rerankWithHeuristics, type RerankConfig, type RerankResult } from "./reranker"
import {
  addContextToChunks,
  addLightweightContext,
  createContextCache,
  type ContextualChunk,
  type ContextGenerationConfig,
  type ContextCache,
} from "./contextual-retrieval"
import { expandQuery, mergeQueryResults, type ExpandedQuery } from "./query-expansion"
import { RAGQueryCache, createRAGQueryCache, type RAGCacheConfig } from "./cache"
import { DynamicContextManager, createContextManager } from "./context-manager"
import { AdaptiveReranker, createAdaptiveReranker } from "./adaptive-reranker"
import { batchGenerateEmbeddings } from "./embedding-batcher"
import { formatCitations, type CitationStyle, type FormattedCitation } from "./citation-formatter"
import { gradeRetrievedDocuments, isRetrievalSufficient } from "./retrieval-grader"
import { rewriteQuery } from "./query-expansion"
import { sanitizeQuery, validateRetrievalInput } from "./rag-guardrails"

/**
 * Extract enriched metadata from a chunk's content.
 * Lightweight heuristic analysis — no LLM calls.
 */
function extractChunkMetadata(content: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {}

  // Detect code blocks
  const hasCode = /```[\s\S]*?```|^\s{4,}\S/m.test(content)
  meta.hasCode = hasCode

  // Detect code language (from fenced blocks)
  if (hasCode) {
    const langMatch = content.match(/```(\w+)/)
    if (langMatch) meta.codeLanguage = langMatch[1]
  }

  // Detect tables (markdown pipe tables)
  meta.hasTable = /\|.+\|/.test(content) && /\|-+\|/.test(content)

  // Detect lists
  meta.hasList = /^[\s]*[-*•]\s/m.test(content) || /^[\s]*\d+\.\s/m.test(content)

  // Extract nearest heading
  const headingMatch = content.match(/^#{1,6}\s+(.+)$/m)
  if (headingMatch) meta.nearestHeading = headingMatch[1].trim()

  // Estimate reading level (simple: average words per sentence)
  const sentences = content.split(/[.!?。！？]+/).filter((s) => s.trim().length > 5)
  if (sentences.length > 0) {
    const totalWords = sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0)
    const avgWordsPerSentence = totalWords / sentences.length
    meta.readingComplexity =
      avgWordsPerSentence > 25 ? "complex" : avgWordsPerSentence > 15 ? "moderate" : "simple"
  }

  return meta
}

/**
 * Compute a simple content fingerprint (FNV-1a hash) for deduplication and incremental indexing.
 */
function computeContentFingerprint(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(36)
}

export interface RAGPipelineConfig {
  // Embedding configuration
  embeddingConfig: EmbeddingModelConfig
  embeddingApiKey: string

  // Optional LLM for advanced features
  model?: LanguageModel

  // Hybrid search settings
  hybridSearch?: {
    enabled?: boolean
    vectorWeight?: number
    keywordWeight?: number
    sparseWeight?: number
    lateInteractionWeight?: number
    enableSparseSearch?: boolean
    enableLateInteraction?: boolean
  }

  // Contextual retrieval settings
  contextualRetrieval?: {
    enabled?: boolean
    useLLM?: boolean
    cacheEnabled?: boolean
  }

  // Query expansion settings
  queryExpansion?: {
    enabled?: boolean
    maxVariants?: number
    useHyDE?: boolean
  }

  // Reranking settings
  reranking?: {
    enabled?: boolean
    useLLM?: boolean
    cohereApiKey?: string
  }

  // Retrieval settings
  topK?: number
  similarityThreshold?: number
  maxContextLength?: number

  // Chunking settings
  chunkingOptions?: Partial<ChunkingOptions>

  // Caching settings
  cache?: {
    enabled?: boolean
    maxSize?: number
    ttl?: number
    persistToIndexedDB?: boolean
  }

  // Context management
  dynamicContext?: {
    enabled?: boolean
    maxTokens?: number
  }

  // Adaptive reranking
  adaptiveReranking?: {
    enabled?: boolean
    feedbackWeight?: number
  }

  // Citation formatting
  citations?: {
    enabled?: boolean
    style?: CitationStyle
  }

  // Corrective RAG (retrieval grading)
  correctiveRAG?: {
    enabled?: boolean
    relevanceThreshold?: number
    useLLM?: boolean
    fallbackStrategy?: "none" | "relax_threshold" | "keep_best"
  }

  // Iterative retrieval (multi-hop)
  iterativeRetrieval?: {
    enabled?: boolean
    maxIterations?: number
    sufficiencyThreshold?: number
  }

  // Parent-child chunking
  parentChildChunking?: {
    enabled?: boolean
    parentChunkSize?: number
  }

  // Document deduplication
  deduplication?: {
    enabled?: boolean
    mode?: "skip" | "upsert"
  }

  // Unified vector store backend configuration
  vectorStoreConfig?: Partial<VectorStoreConfig>
}

export interface RAGPipelineContext {
  documents: RerankResult[]
  query: string
  expandedQuery?: ExpandedQuery
  formattedContext: string
  totalTokensEstimate: number
  citations?: FormattedCitation
  searchMetadata: {
    hybridSearchUsed: boolean
    queryExpansionUsed: boolean
    rerankingUsed: boolean
    originalResultCount: number
    finalResultCount: number
    cacheHit?: boolean
  }
}

export interface IndexingOptions {
  collectionName: string
  documentId: string
  documentTitle?: string
  metadata?: Record<string, unknown>
  useContextualRetrieval?: boolean
  onProgress?: (progress: { stage: string; current: number; total: number }) => void
}

interface IndexedDocument {
  id: string
  content: string
  embedding: number[]
  metadata?: Record<string, unknown>
  sparseEmbedding?: SparseVector
}

/**
 * RAG Pipeline - Unified retrieval pipeline with advanced features
 */
export class RAGPipeline {
  private config: Omit<Required<RAGPipelineConfig>, "model"> & { model?: LanguageModel }
  private contextCache: ContextCache
  private mirrorCollections: Map<string, IndexedDocument[]> = new Map()
  private embeddingCache: Map<string, number[]> = new Map()
  private sparseEmbeddingCache: Map<string, SparseVector> = new Map()
  private vectorStore: IVectorStore
  private persistentStorage: PersistentRAGStorage | null = null
  private persistentStorageReady = false
  private persistentStorageInitPromise: Promise<void>

  // New optimization components
  private queryCache: RAGQueryCache
  private contextManager: DynamicContextManager
  private adaptiveReranker: AdaptiveReranker

  constructor(config: RAGPipelineConfig) {
    this.config = {
      embeddingConfig: config.embeddingConfig,
      embeddingApiKey: config.embeddingApiKey,
      model: config.model,
      hybridSearch: {
        enabled: config.hybridSearch?.enabled ?? true,
        vectorWeight: config.hybridSearch?.vectorWeight ?? 0.5,
        keywordWeight: config.hybridSearch?.keywordWeight ?? 0.5,
        sparseWeight: config.hybridSearch?.sparseWeight ?? 0.3,
        lateInteractionWeight: config.hybridSearch?.lateInteractionWeight ?? 0.2,
        enableSparseSearch: config.hybridSearch?.enableSparseSearch ?? false,
        enableLateInteraction: config.hybridSearch?.enableLateInteraction ?? false,
      },
      contextualRetrieval: {
        enabled: config.contextualRetrieval?.enabled ?? false,
        useLLM: config.contextualRetrieval?.useLLM ?? false,
        cacheEnabled: config.contextualRetrieval?.cacheEnabled ?? true,
      },
      queryExpansion: {
        enabled: config.queryExpansion?.enabled ?? false,
        maxVariants: config.queryExpansion?.maxVariants ?? 3,
        useHyDE: config.queryExpansion?.useHyDE ?? false,
      },
      reranking: {
        enabled: config.reranking?.enabled ?? true,
        useLLM: config.reranking?.useLLM ?? false,
        cohereApiKey: config.reranking?.cohereApiKey,
      },
      topK: config.topK ?? 5,
      similarityThreshold: config.similarityThreshold ?? 0.5,
      maxContextLength: config.maxContextLength ?? 4000,
      chunkingOptions: config.chunkingOptions ?? {
        strategy: "semantic",
        chunkSize: 1000,
        chunkOverlap: 200,
      },
      cache: {
        enabled: config.cache?.enabled ?? true,
        maxSize: config.cache?.maxSize ?? 100,
        ttl: config.cache?.ttl ?? 5 * 60 * 1000,
        persistToIndexedDB: config.cache?.persistToIndexedDB ?? false,
      },
      dynamicContext: {
        enabled: config.dynamicContext?.enabled ?? false,
        maxTokens: config.dynamicContext?.maxTokens ?? 8000,
      },
      adaptiveReranking: {
        enabled: config.adaptiveReranking?.enabled ?? false,
        feedbackWeight: config.adaptiveReranking?.feedbackWeight ?? 0.3,
      },
      citations: {
        enabled: config.citations?.enabled ?? false,
        style: config.citations?.style ?? "simple",
      },
      correctiveRAG: {
        enabled: config.correctiveRAG?.enabled ?? false,
        relevanceThreshold: config.correctiveRAG?.relevanceThreshold ?? 0.4,
        useLLM: config.correctiveRAG?.useLLM ?? false,
        fallbackStrategy: config.correctiveRAG?.fallbackStrategy ?? "keep_best",
      },
      iterativeRetrieval: {
        enabled: config.iterativeRetrieval?.enabled ?? false,
        maxIterations: config.iterativeRetrieval?.maxIterations ?? 2,
        sufficiencyThreshold: config.iterativeRetrieval?.sufficiencyThreshold ?? 0.5,
      },
      parentChildChunking: {
        enabled: config.parentChildChunking?.enabled ?? false,
        parentChunkSize: config.parentChildChunking?.parentChunkSize ?? 2000,
      },
      deduplication: {
        enabled: config.deduplication?.enabled ?? false,
        mode: config.deduplication?.mode ?? "skip",
      },
      vectorStoreConfig: config.vectorStoreConfig ?? {},
    }

    const vectorStoreConfig: VectorStoreConfig = {
      provider: config.vectorStoreConfig?.provider ?? "chroma",
      embeddingConfig: this.config.embeddingConfig,
      embeddingApiKey: this.config.embeddingApiKey,
      chromaMode: config.vectorStoreConfig?.chromaMode ?? "embedded",
      chromaServerUrl: config.vectorStoreConfig?.chromaServerUrl,
      pineconeApiKey: config.vectorStoreConfig?.pineconeApiKey,
      pineconeIndexName: config.vectorStoreConfig?.pineconeIndexName,
      pineconeNamespace: config.vectorStoreConfig?.pineconeNamespace,
      weaviateUrl: config.vectorStoreConfig?.weaviateUrl,
      weaviateApiKey: config.vectorStoreConfig?.weaviateApiKey,
      qdrantUrl: config.vectorStoreConfig?.qdrantUrl,
      qdrantApiKey: config.vectorStoreConfig?.qdrantApiKey,
      qdrantCollectionName: config.vectorStoreConfig?.qdrantCollectionName,
      milvusAddress: config.vectorStoreConfig?.milvusAddress,
      milvusToken: config.vectorStoreConfig?.milvusToken,
      milvusUsername: config.vectorStoreConfig?.milvusUsername,
      milvusPassword: config.vectorStoreConfig?.milvusPassword,
      milvusSsl: config.vectorStoreConfig?.milvusSsl,
      milvusCollectionName: config.vectorStoreConfig?.milvusCollectionName,
      native: {},
    }
    this.vectorStore = createVectorStore(vectorStoreConfig)

    // Initialize context cache
    this.contextCache = createContextCache(10000)

    // Initialize query result cache
    const cacheConfig: Partial<RAGCacheConfig> = {
      enabled: config.cache?.enabled ?? true,
      maxSize: config.cache?.maxSize ?? 100,
      ttl: config.cache?.ttl ?? 5 * 60 * 1000,
      persistToIndexedDB: config.cache?.persistToIndexedDB ?? false,
    }
    this.queryCache = createRAGQueryCache(cacheConfig)

    // Initialize dynamic context manager
    this.contextManager = createContextManager({
      maxTokens: config.dynamicContext?.maxTokens ?? 8000,
    })

    // Initialize adaptive reranker
    this.adaptiveReranker = createAdaptiveReranker({
      enabled: config.adaptiveReranking?.enabled ?? false,
      feedbackWeight: config.adaptiveReranking?.feedbackWeight ?? 0.3,
    })

    this.persistentStorageInitPromise = this.initializePersistentStorage()
  }

  private async initializePersistentStorage(): Promise<void> {
    if (!isIndexedDBAvailable()) {
      return
    }

    try {
      this.persistentStorage = createPersistentStorage()
      await this.persistentStorage.initialize()
      this.persistentStorageReady = true
    } catch (error) {
      this.persistentStorage = null
      this.persistentStorageReady = false
      log.warn("RAG persistent storage unavailable, using in-memory mirror only", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async ensurePersistentStorageReady(): Promise<void> {
    await this.persistentStorageInitPromise
  }

  private async loadMirrorCollection(collectionName: string): Promise<IndexedDocument[]> {
    if (this.mirrorCollections.has(collectionName)) {
      return this.mirrorCollections.get(collectionName) || []
    }

    await this.ensurePersistentStorageReady()
    if (!this.persistentStorageReady || !this.persistentStorage) {
      this.mirrorCollections.set(collectionName, [])
      return []
    }

    try {
      const stored = await this.persistentStorage.loadDocuments(collectionName)
      const mapped: IndexedDocument[] = stored.map((doc) => ({
        id: doc.id,
        content: doc.content,
        embedding: doc.embedding,
        metadata: doc.metadata,
      }))
      this.mirrorCollections.set(collectionName, mapped)
      for (const doc of mapped) {
        this.embeddingCache.set(doc.id, doc.embedding)
      }
      return mapped
    } catch (error) {
      log.warn("Failed to load mirror collection from persistent storage", {
        collectionName,
        error: error instanceof Error ? error.message : String(error),
      })
      this.mirrorCollections.set(collectionName, [])
      return []
    }
  }

  private updateMirrorCollection(
    collectionName: string,
    updater: (current: IndexedDocument[]) => IndexedDocument[]
  ): IndexedDocument[] {
    const current = this.mirrorCollections.get(collectionName) || []
    const next = updater(current)
    this.mirrorCollections.set(collectionName, next)
    return next
  }

  /**
   * Index a document for retrieval
   */
  async indexDocument(
    content: string,
    options: IndexingOptions
  ): Promise<{ chunksCreated: number; success: boolean; error?: string }> {
    const {
      collectionName,
      documentId,
      documentTitle,
      metadata,
      useContextualRetrieval,
      onProgress,
    } = options

    try {
      const mirrorCollection = await this.loadMirrorCollection(collectionName)

      // Document deduplication check
      if (this.config.deduplication.enabled) {
        const fingerprint = computeContentFingerprint(content)
        const duplicate = mirrorCollection.find(
          (doc) => doc.metadata?.contentFingerprint === fingerprint
        )
        if (duplicate) {
          if (this.config.deduplication.mode === "skip") {
            log.debug(`Dedup: skipping duplicate document (fingerprint=${fingerprint})`)
            return { chunksCreated: 0, success: true }
          }
          // upsert mode: remove old documents with same fingerprint, then re-index
          const docsToRemove = mirrorCollection
            .filter((d) => d.metadata?.contentFingerprint === fingerprint)
            .map((d) => d.id)
          if (docsToRemove.length > 0) {
            await this.deleteDocuments(collectionName, docsToRemove)
            log.debug(
              `Dedup: upsert mode — removed ${docsToRemove.length} old chunks before re-indexing`
            )
          }
        }
      }

      onProgress?.({ stage: "chunking", current: 0, total: 1 })

      // Chunk the document
      const strategy = this.config.chunkingOptions.strategy ?? "semantic"
      const chunkResult =
        strategy === "semantic" && this.config.model
          ? await chunkDocumentAsync(
              content,
              { ...this.config.chunkingOptions, strategy, model: this.config.model },
              documentId
            )
          : chunkDocument(content, { ...this.config.chunkingOptions, strategy }, documentId)

      if (chunkResult.chunks.length === 0) {
        return { chunksCreated: 0, success: false, error: "No chunks created from document" }
      }

      onProgress?.({ stage: "chunking", current: 1, total: 1 })

      // Apply contextual retrieval if enabled
      let processedChunks: (DocumentChunk | ContextualChunk)[]

      if (useContextualRetrieval && this.config.contextualRetrieval.enabled) {
        onProgress?.({ stage: "context_generation", current: 0, total: chunkResult.chunks.length })

        if (this.config.contextualRetrieval.useLLM && this.config.model) {
          const contextConfig: ContextGenerationConfig = {
            model: this.config.model,
            onProgress: (p) =>
              onProgress?.({ stage: "context_generation", current: p.current, total: p.total }),
          }
          processedChunks = await addContextToChunks(
            content,
            chunkResult.chunks,
            contextConfig,
            this.config.contextualRetrieval.cacheEnabled ? this.contextCache : undefined,
            documentId
          )
        } else {
          processedChunks = addLightweightContext(content, chunkResult.chunks, {
            documentTitle,
          })
        }
      } else {
        processedChunks = chunkResult.chunks
      }

      // Generate embeddings using batch optimizer for better performance
      onProgress?.({ stage: "embedding", current: 0, total: processedChunks.length })

      const textsToEmbed = processedChunks.map((chunk) =>
        "contextualContent" in chunk ? (chunk as ContextualChunk).contextualContent : chunk.content
      )

      const embeddingResult = await batchGenerateEmbeddings(
        textsToEmbed,
        this.config.embeddingConfig,
        this.config.embeddingApiKey,
        {
          batchSize: 50,
          maxParallelBatches: 3,
          onProgress: (p) =>
            onProgress?.({ stage: "embedding", current: p.current, total: p.total }),
        }
      )

      onProgress?.({
        stage: "embedding",
        current: processedChunks.length,
        total: processedChunks.length,
      })

      // Build parent-child mapping if enabled
      const parentChunks = new Map<string, string>() // childId -> parentContent
      if (this.config.parentChildChunking.enabled) {
        const parentSize = this.config.parentChildChunking.parentChunkSize ?? 2000
        // Create parent chunks by grouping adjacent child chunks
        for (let i = 0; i < processedChunks.length; i++) {
          const chunk = processedChunks[i]
          const start = chunk.startOffset ?? 0
          const parentStart = Math.max(0, start - Math.floor(parentSize / 4))
          const parentEnd = Math.min(content.length, parentStart + parentSize)
          parentChunks.set(chunk.id, content.slice(parentStart, parentEnd))
        }
      }

      // Build chunk-level ids scoped by collection to avoid cross-collection collisions
      const toStoredId = (rawId: string) => `${collectionName}::${rawId}`

      // Store in vector backend and mirror
      const documents: IndexedDocument[] = processedChunks.map((chunk, i) => ({
        id: toStoredId(chunk.id),
        content:
          "contextualContent" in chunk
            ? (chunk as ContextualChunk).contextualContent
            : chunk.content,
        embedding: embeddingResult.embeddings[i],
        sparseEmbedding: this.config.hybridSearch.enableSparseSearch
          ? generateSparseEmbedding(
              "contextualContent" in chunk
                ? (chunk as ContextualChunk).contextualContent
                : chunk.content
            )
          : undefined,
        metadata: {
          ...metadata,
          documentId,
          documentTitle,
          chunkIndex: chunk.index,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          ...chunk.metadata,
          ...extractChunkMetadata(chunk.content),
          ...(parentChunks.has(chunk.id) ? { parentContent: parentChunks.get(chunk.id) } : {}),
          ...(this.config.deduplication.enabled
            ? { contentFingerprint: computeContentFingerprint(content) }
            : {}),
        },
      }))

      const vectorDocuments: VectorDocument[] = documents.map((doc) => ({
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata,
        embedding: doc.embedding,
      }))
      try {
        await this.vectorStore.addDocuments(collectionName, vectorDocuments)
      } catch (error) {
        log.warn("Vector store indexing failed, keeping mirror index only", {
          collectionName,
          error: error instanceof Error ? error.message : String(error),
        })
      }

      this.updateMirrorCollection(collectionName, (existing) => [...existing, ...documents])

      await this.ensurePersistentStorageReady()
      if (this.persistentStorageReady && this.persistentStorage) {
        await this.persistentStorage.saveDocuments(
          collectionName,
          documents.map((doc) => ({
            id: doc.id,
            content: doc.content,
            embedding: doc.embedding,
            metadata: doc.metadata,
          }))
        )
      }

      // Warm embedding caches
      for (const doc of documents) {
        this.embeddingCache.set(doc.id, doc.embedding)
        if (doc.sparseEmbedding) {
          this.sparseEmbeddingCache.set(doc.id, doc.sparseEmbedding)
        }
      }

      onProgress?.({ stage: "complete", current: 1, total: 1 })

      return { chunksCreated: documents.length, success: true }
    } catch (error) {
      return {
        chunksCreated: 0,
        success: false,
        error: error instanceof Error ? error.message : "Indexing failed",
      }
    }
  }

  /**
   * Retrieve relevant context for a query
   */
  async retrieve(collectionName: string, query: string): Promise<RAGPipelineContext> {
    const searchMetadata = {
      hybridSearchUsed: false,
      queryExpansionUsed: false,
      rerankingUsed: false,
      originalResultCount: 0,
      finalResultCount: 0,
      cacheHit: false,
    }

    try {
      // Guardrails: validate and sanitize input
      const validation = validateRetrievalInput(query, collectionName)
      if (!validation.valid) {
        log.warn("RAG retrieval input validation failed", { errors: validation.errors })
        return this.emptyContext(query, searchMetadata)
      }
      const sanitized = sanitizeQuery(query)
      if (sanitized.injectionDetected) {
        log.warn("Potential injection in RAG query detected and stripped")
      }
      query = sanitized.query

      // Check cache first
      if (this.config.cache.enabled) {
        const cached = await this.queryCache.get(query, collectionName)
        if (cached) {
          return {
            ...cached,
            searchMetadata: {
              ...cached.searchMetadata,
              cacheHit: true,
            },
          }
        }
      }

      await this.loadMirrorCollection(collectionName)

      // Query expansion
      let expandedQuery: ExpandedQuery | undefined
      let queriesToSearch = [query]

      if (this.config.queryExpansion.enabled && this.config.model) {
        expandedQuery = await expandQuery(query, {
          model: this.config.model,
          maxVariants: this.config.queryExpansion.maxVariants,
          includeHypotheticalAnswer: this.config.queryExpansion.useHyDE,
        })
        queriesToSearch = [query, ...expandedQuery.variants.slice(0, 2)]
        searchMetadata.queryExpansionUsed = true
      }

      // Perform searches for each query variant
      const allResults: RerankResult[][] = []

      for (const searchQuery of queriesToSearch) {
        const results = await this.searchSingle(collectionName, searchQuery)
        allResults.push(results)
      }
      searchMetadata.hybridSearchUsed = this.config.hybridSearch.enabled ?? false

      // Merge results from all query variants
      const flatResults = allResults.flat()
      const resultSetsForMerge = allResults.map((results) =>
        results.map((r) => ({ id: r.id, score: r.rerankScore }))
      )
      const mergedResultsRaw = mergeQueryResults(resultSetsForMerge, {
        dedup: true,
        maxResults: this.config.topK * 2,
        scoreAggregation: "max",
      })

      // Map back to full results
      const resultMap = new Map(flatResults.map((r) => [r.id, r]))
      let mergedResults: RerankResult[] = mergedResultsRaw
        .map((r) => resultMap.get(r.id))
        .filter((r): r is RerankResult => r !== undefined)

      searchMetadata.originalResultCount = mergedResults.length

      // Apply reranking
      if (this.config.reranking.enabled && mergedResults.length > 0) {
        const rerankConfig: RerankConfig = {
          model: this.config.reranking.useLLM ? this.config.model : undefined,
          cohereApiKey: this.config.reranking.cohereApiKey,
          topN: this.config.topK,
        }

        const rerankDocs = mergedResults.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          score: r.rerankScore,
        }))

        if (rerankConfig.model || rerankConfig.cohereApiKey) {
          mergedResults = await rerank(query, rerankDocs, rerankConfig)
        } else {
          mergedResults = rerankWithHeuristics(query, rerankDocs, {
            topN: this.config.topK,
          })
        }
        searchMetadata.rerankingUsed = true
      }

      // Apply Corrective RAG grading if enabled
      if (this.config.correctiveRAG.enabled && mergedResults.length > 0) {
        const gradingResult = await gradeRetrievedDocuments(query, mergedResults, {
          relevanceThreshold: this.config.correctiveRAG.relevanceThreshold,
          useLLM: this.config.correctiveRAG.useLLM,
          model: this.config.correctiveRAG.useLLM ? this.config.model : undefined,
          fallbackStrategy: this.config.correctiveRAG.fallbackStrategy,
        })
        mergedResults = gradingResult.relevantDocuments
        log.debug(
          `CRAG: ${gradingResult.stats.totalFiltered} chunks filtered, ${gradingResult.stats.totalRelevant} kept (avg grade: ${gradingResult.stats.averageGrade.toFixed(2)})`
        )
      }

      // Filter by similarity threshold
      const filteredResults = mergedResults.filter(
        (r) => r.rerankScore >= this.config.similarityThreshold
      )

      // Take top K
      const topResults = filteredResults.slice(0, this.config.topK)
      searchMetadata.finalResultCount = topResults.length

      // Format context (use dynamic context manager if enabled)
      let formattedContext: string
      if (this.config.dynamicContext.enabled) {
        const optimalLength = this.contextManager.calculateOptimalContextLength(
          query,
          topResults,
          this.config.dynamicContext.maxTokens
        )
        const selection = this.contextManager.selectOptimalChunks(topResults, optimalLength)
        formattedContext = selection.formattedContext
      } else {
        formattedContext = this.formatContext(topResults)
      }

      const totalTokensEstimate = Math.ceil(formattedContext.length / 4)

      // Generate citations if enabled
      let citations: FormattedCitation | undefined
      if (this.config.citations.enabled && topResults.length > 0) {
        citations = formatCitations(topResults, {
          style: this.config.citations.style,
          includeRelevanceScore: true,
        })
      }

      const result: RAGPipelineContext = {
        documents: topResults,
        query,
        expandedQuery,
        formattedContext,
        totalTokensEstimate,
        citations,
        searchMetadata,
      }

      // Store in cache
      if (this.config.cache.enabled) {
        await this.queryCache.set(query, collectionName, result)
      }

      return result
    } catch (error) {
      log.error("Enhanced RAG retrieval error", error as Error)
      return this.emptyContext(query, searchMetadata)
    }
  }

  /**
   * Iterative/Multi-Hop Retrieval
   * Performs multiple retrieval passes, refining the query if initial results are insufficient.
   */
  async retrieveIterative(
    collectionName: string,
    query: string,
    options?: { maxIterations?: number; sufficiencyThreshold?: number }
  ): Promise<RAGPipelineContext> {
    const maxIterations =
      options?.maxIterations ?? this.config.iterativeRetrieval.maxIterations ?? 2
    const sufficiencyThreshold =
      options?.sufficiencyThreshold ?? this.config.iterativeRetrieval.sufficiencyThreshold ?? 0.5

    // First pass — normal retrieve
    let result = await this.retrieve(collectionName, query)

    if (result.documents.length === 0) return result

    // Check sufficiency
    for (let iteration = 1; iteration < maxIterations; iteration++) {
      const sufficient = isRetrievalSufficient(query, result.documents, {
        threshold: sufficiencyThreshold,
        minRelevant: 2,
      })

      if (sufficient) break

      // Refine query
      let refinedQuery: string
      if (this.config.model) {
        refinedQuery = await rewriteQuery(query, this.config.model)
      } else {
        // Lightweight fallback: append context from first pass
        const topTerms = result.documents
          .slice(0, 2)
          .map((d) => d.content.split(/\s+/).slice(0, 5).join(" "))
          .join(" ")
        refinedQuery = `${query} ${topTerms}`.trim()
      }

      log.debug(
        `Iterative retrieval: pass ${iteration + 1} with refined query: "${refinedQuery.slice(0, 100)}..."`
      )

      const nextResult = await this.retrieve(collectionName, refinedQuery)

      // Merge results from both passes, deduplicate by id
      const seenIds = new Set(result.documents.map((d) => d.id))
      const newDocs = nextResult.documents.filter((d) => !seenIds.has(d.id))
      result = {
        ...result,
        documents: [...result.documents, ...newDocs].slice(0, this.config.topK),
        formattedContext: this.formatContext(
          [...result.documents, ...newDocs].slice(0, this.config.topK)
        ),
        totalTokensEstimate: Math.ceil(
          [...result.documents, ...newDocs]
            .slice(0, this.config.topK)
            .reduce((sum, d) => sum + d.content.length, 0) / 4
        ),
      }
    }

    return result
  }

  /**
   * Record feedback for adaptive reranking
   */
  recordFeedback(
    query: string,
    resultId: string,
    relevance: number,
    action: "click" | "use" | "dismiss" | "explicit" = "explicit"
  ): void {
    if (this.config.adaptiveReranking.enabled) {
      this.adaptiveReranker.recordFeedback(query, resultId, relevance, action)
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { hits: number; misses: number; hitRate: number; size: number } {
    return this.queryCache.getStats()
  }

  /**
   * Invalidate cache for a collection
   */
  invalidateCache(collectionName: string): number {
    return this.queryCache.invalidateCollection(collectionName)
  }

  /**
   * Perform a single search operation
   */
  private async searchSingle(collectionName: string, query: string): Promise<RerankResult[]> {
    const collection = await this.loadMirrorCollection(collectionName)

    // Perform vector search from unified vector backend
    const vectorResults = await this.vectorSearch(collectionName, query)
    if (vectorResults.length === 0 && collection.length === 0) {
      return []
    }

    const sparseResults = this.config.hybridSearch.enableSparseSearch
      ? this.sparseSearch(collection, query)
      : []

    const lateResults = this.config.hybridSearch.enableLateInteraction
      ? this.lateInteractionSearch(collection, query, this.config.topK * 2)
      : []

    // If hybrid search enabled, combine with keyword search
    if (this.config.hybridSearch.enabled) {
      const hybridConfig: HybridSearchConfig = {
        vectorWeight: this.config.hybridSearch.vectorWeight,
        keywordWeight: this.config.hybridSearch.keywordWeight,
        sparseWeight: this.config.hybridSearch.sparseWeight,
        lateInteractionWeight: this.config.hybridSearch.lateInteractionWeight,
        deduplicateResults: true,
      }
      const hybridEngine = new HybridSearchEngine(hybridConfig)
      hybridEngine.addDocuments(
        collection.map((doc) => ({
          id: doc.id,
          content: doc.content,
          metadata: doc.metadata as Record<string, unknown>,
        }))
      )

      const hybridResults = hybridEngine.hybridSearch(
        vectorResults.map((r) => ({ id: r.id, score: r.score })),
        query,
        this.config.topK * 2,
        sparseResults,
        lateResults
      )

      return hybridResults.map((r) => ({
        id: r.id,
        content: r.content,
        metadata: r.metadata,
        originalScore: r.vectorScore,
        rerankScore: r.combinedScore,
      }))
    }

    return vectorResults.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata,
      originalScore: r.score,
      rerankScore: r.score,
    }))
  }

  /**
   * Vector similarity search
   */
  private vectorSearch(
    collectionName: string,
    query: string
  ): Promise<{ id: string; content: string; metadata?: Record<string, unknown>; score: number }[]> {
    return this.vectorStore
      .searchDocuments(collectionName, query, {
        topK: this.config.topK * 4,
      })
      .then((results: VectorSearchResult[]) =>
        results.map((result) => ({
          id: result.id,
          content: result.content,
          metadata: result.metadata,
          score: result.score,
        }))
      )
      .catch(async (error) => {
        log.warn("Vector store query failed, falling back to mirror vector search", {
          collectionName,
          error: error instanceof Error ? error.message : String(error),
        })
        const collection = await this.loadMirrorCollection(collectionName)
        if (collection.length === 0) return []
        const queryEmbedding = await generateEmbedding(
          query,
          this.config.embeddingConfig,
          this.config.embeddingApiKey
        )
        return collection
          .map((doc) => ({
            id: doc.id,
            content: doc.content,
            metadata: doc.metadata,
            score: cosineSimilarity(queryEmbedding.embedding, doc.embedding),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, this.config.topK * 4)
      })
  }

  private sparseSearch(
    collection: IndexedDocument[],
    query: string
  ): { id: string; score: number }[] {
    const querySparse = generateSparseEmbedding(query)
    const results = collection
      .map((doc) => {
        const cached = doc.sparseEmbedding ?? this.sparseEmbeddingCache.get(doc.id)
        const sparse = cached ?? generateSparseEmbedding(doc.content)
        if (!cached) {
          this.sparseEmbeddingCache.set(doc.id, sparse)
        }
        return {
          id: doc.id,
          score: sparseCosineSimilarity(querySparse, sparse),
        }
      })
      .filter((item): item is { id: string; score: number } => item !== null)
      .sort((a, b) => b.score - a.score)

    return results.slice(0, this.config.topK * 2)
  }

  private lateInteractionSearch(
    collection: IndexedDocument[],
    query: string,
    topK: number
  ): { id: string; score: number }[] {
    return collection
      .map((doc) => ({
        id: doc.id,
        score: scoreLateInteraction(query, doc.content),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  /**
   * Format retrieved documents into context string
   */
  private formatContext(documents: RerankResult[]): string {
    if (documents.length === 0) return ""

    const parts: string[] = []
    let currentLength = 0

    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i]
      const header = `[Source ${i + 1}]`
      const source = doc.metadata?.source ? ` (${doc.metadata.source})` : ""
      const title = doc.metadata?.title ? `\nTitle: ${doc.metadata.title}` : ""
      const content = `\n${doc.content}`

      const section = `${header}${source}${title}${content}\n`

      if (currentLength + section.length > this.config.maxContextLength) {
        const remaining = this.config.maxContextLength - currentLength
        if (remaining > 100) {
          parts.push(section.slice(0, remaining) + "...")
        }
        break
      }

      parts.push(section)
      currentLength += section.length
    }

    return parts.join("\n")
  }

  /**
   * Create empty context response
   */
  private emptyContext(
    query: string,
    searchMetadata: RAGPipelineContext["searchMetadata"]
  ): RAGPipelineContext {
    return {
      documents: [],
      query,
      formattedContext: "",
      totalTokensEstimate: 0,
      searchMetadata,
    }
  }

  /**
   * Delete documents from a collection
   */
  async deleteDocuments(collectionName: string, documentIds: string[]): Promise<number> {
    const collection = await this.loadMirrorCollection(collectionName)
    if (collection.length === 0 || documentIds.length === 0) return 0

    const idsToDelete = new Set(documentIds)
    const initialLength = collection.length

    const filtered = collection.filter((doc) => !idsToDelete.has(doc.id))
    this.mirrorCollections.set(collectionName, filtered)

    try {
      await this.vectorStore.deleteDocuments(collectionName, documentIds)
    } catch (error) {
      log.warn("Failed to delete documents from vector store", {
        collectionName,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    await this.ensurePersistentStorageReady()
    if (this.persistentStorageReady && this.persistentStorage) {
      try {
        await this.persistentStorage.deleteDocuments(collectionName, documentIds)
      } catch (error) {
        log.warn("Failed to delete documents from persistent mirror", {
          collectionName,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    for (const id of documentIds) {
      this.embeddingCache.delete(id)
      this.sparseEmbeddingCache.delete(id)
    }

    this.queryCache.invalidateCollection(collectionName)
    return initialLength - filtered.length
  }

  /**
   * Delete all chunks indexed for a source document.
   */
  async deleteByDocumentId(collectionName: string, documentId: string): Promise<number> {
    const collection = await this.loadMirrorCollection(collectionName)
    const ids = collection
      .filter((doc) => doc.metadata?.documentId === documentId)
      .map((doc) => doc.id)
    if (ids.length === 0) return 0
    return this.deleteDocuments(collectionName, ids)
  }

  /**
   * Clear a collection
   */
  async clearCollection(collectionName: string): Promise<void> {
    const collection = await this.loadMirrorCollection(collectionName)
    const ids = collection.map((doc) => doc.id)

    if (ids.length > 0) {
      for (const id of ids) {
        this.embeddingCache.delete(id)
        this.sparseEmbeddingCache.delete(id)
      }
    }
    this.mirrorCollections.delete(collectionName)

    try {
      if (this.vectorStore.deleteAllDocuments) {
        await this.vectorStore.deleteAllDocuments(collectionName)
      } else if (ids.length > 0) {
        await this.vectorStore.deleteDocuments(collectionName, ids)
      }
    } catch (error) {
      log.warn("Failed to clear collection in vector store", {
        collectionName,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    await this.ensurePersistentStorageReady()
    if (this.persistentStorageReady && this.persistentStorage) {
      try {
        await this.persistentStorage.clearCollection(collectionName)
      } catch (error) {
        log.warn("Failed to clear collection in persistent mirror", {
          collectionName,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    this.queryCache.invalidateCollection(collectionName)
  }

  /**
   * Get collection statistics
   */
  async getCollectionStats(
    collectionName: string
  ): Promise<{ documentCount: number; exists: boolean }> {
    const collection = await this.loadMirrorCollection(collectionName)
    return {
      documentCount: collection.length,
      exists: collection.length > 0,
    }
  }

  /**
   * List all collections
   */
  async listCollections(): Promise<string[]> {
    try {
      const collections = await this.vectorStore.listCollections()
      return collections.map((collection) => collection.name)
    } catch (error) {
      log.warn("Failed to list collections from vector store, using mirror map", {
        error: error instanceof Error ? error.message : String(error),
      })
      return Array.from(this.mirrorCollections.keys())
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RAGPipelineConfig>): void {
    if (config.hybridSearch) {
      Object.assign(this.config.hybridSearch, config.hybridSearch)
    }
    if (config.contextualRetrieval) {
      Object.assign(this.config.contextualRetrieval, config.contextualRetrieval)
    }
    if (config.queryExpansion) {
      Object.assign(this.config.queryExpansion, config.queryExpansion)
    }
    if (config.reranking) {
      Object.assign(this.config.reranking, config.reranking)
    }
    if (config.topK !== undefined) {
      this.config.topK = config.topK
    }
    if (config.similarityThreshold !== undefined) {
      this.config.similarityThreshold = config.similarityThreshold
    }
    if (config.maxContextLength !== undefined) {
      this.config.maxContextLength = config.maxContextLength
    }
  }
}

/**
 * Create a RAG pipeline with default configuration
 */
export function createRAGPipeline(config: RAGPipelineConfig): RAGPipeline {
  return new RAGPipeline(config)
}
