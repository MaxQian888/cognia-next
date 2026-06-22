/**
 * Tests for RAG Pipeline
 */

import { RAGPipeline } from "./rag-pipeline"
import type { RAGPipelineConfig, IndexingOptions } from "./rag-pipeline"
import { chunkDocument, chunkDocumentAsync } from "@cognia/provider-embedding/chunking"
import { generateEmbedding } from "@cognia/vector/embedding"
import { rerank, rerankWithHeuristics } from "./reranker"
import { addContextToChunks } from "./contextual-retrieval"
import { expandQuery, mergeQueryResults, rewriteQuery } from "./query-expansion"
import { gradeRetrievedDocuments, isRetrievalSufficient } from "./retrieval-grader"
import { formatCitations } from "./citation-formatter"

// Mock dependencies
jest.mock("@cognia/provider-embedding/chunking", () => ({
  chunkDocument: jest.fn().mockReturnValue({
    chunks: [
      {
        id: "chunk-1",
        content: "Test content 1",
        index: 0,
        startOffset: 0,
        endOffset: 100,
        metadata: {},
      },
      {
        id: "chunk-2",
        content: "Test content 2",
        index: 1,
        startOffset: 100,
        endOffset: 200,
        metadata: {},
      },
    ],
    metadata: { totalChunks: 2 },
  }),
  chunkDocumentAsync: jest.fn().mockResolvedValue({
    chunks: [
      {
        id: "chunk-1",
        content: "Test content 1",
        index: 0,
        startOffset: 0,
        endOffset: 100,
        metadata: {},
      },
    ],
    metadata: { totalChunks: 1 },
  }),
}))

jest.mock("@cognia/vector/embedding", () => ({
  generateEmbedding: jest.fn().mockResolvedValue({
    embedding: new Array(1536).fill(0.1),
    usage: { promptTokens: 10, totalTokens: 10 },
  }),
  generateEmbeddings: jest.fn().mockResolvedValue({
    embeddings: [new Array(1536).fill(0.1), new Array(1536).fill(0.2)],
    usage: { promptTokens: 20, totalTokens: 20 },
  }),
}))

jest.mock("@cognia/provider-embedding/embedding", () => ({
  cosineSimilarity: jest.fn().mockReturnValue(0.85),
}))

jest.mock("@cognia/provider-embedding/sparse-embedding", () => ({
  generateSparseEmbedding: jest.fn(() => ({ indices: [1], values: [1] })),
  sparseCosineSimilarity: jest.fn(() => 0.72),
}))

jest.mock("@cognia/provider-embedding/late-interaction", () => ({
  scoreLateInteraction: jest.fn(() => 0.66),
}))

jest.mock("./embedding-batcher", () => ({
  batchGenerateEmbeddings: jest.fn(
    async (texts: string[], _config: unknown, _apiKey: string, opts) => {
      opts?.onProgress?.({ current: texts.length, total: texts.length })
      return {
        embeddings: texts.map((_, index) => new Array(1536).fill(0.1 + index / 10)),
        usage: { promptTokens: texts.length * 5, totalTokens: texts.length * 5 },
      }
    }
  ),
}))

jest.mock("./hybrid-search", () => ({
  HybridSearchEngine: jest.fn().mockImplementation(() => ({
    addDocuments: jest.fn(),
    hybridSearch: jest.fn().mockReturnValue([
      {
        id: "chunk-1",
        content: "Test content",
        score: 0.9,
        combinedScore: 0.9,
      },
    ]),
    clear: jest.fn(),
    removeDocuments: jest.fn(),
    updateConfig: jest.fn(),
  })),
}))

jest.mock("./reranker", () => ({
  rerank: jest
    .fn()
    .mockResolvedValue([
      { document: { id: "chunk-1", content: "Test content" }, score: 0.95, originalRank: 0 },
    ]),
  rerankWithHeuristics: jest
    .fn()
    .mockReturnValue([
      { document: { id: "chunk-1", content: "Test content" }, score: 0.9, originalRank: 0 },
    ]),
}))

jest.mock("./contextual-retrieval", () => ({
  addContextToChunks: jest.fn().mockResolvedValue([
    {
      id: "chunk-1",
      content: "Test content",
      contextualContent: "Contextual test content",
      index: 0,
    },
  ]),
  addLightweightContext: jest.fn().mockReturnValue([
    {
      id: "chunk-1",
      content: "Test content",
      contextualContent: "Lightweight context",
      index: 0,
    },
  ]),
  createContextCache: jest.fn().mockReturnValue({
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
  }),
}))

jest.mock("./query-expansion", () => ({
  expandQuery: jest.fn().mockResolvedValue({
    original: "test query",
    variants: ["test query variant 1", "test query variant 2"],
    hypotheticalDocument: null,
  }),
  mergeQueryResults: jest
    .fn()
    .mockReturnValue([{ id: "chunk-1", content: "Test content", score: 0.9 }]),
  rewriteQuery: jest.fn(async (query: string) => `${query} refined`),
}))

jest.mock("./retrieval-grader", () => ({
  gradeRetrievedDocuments: jest.fn(async (_query: string, docs) => ({
    relevantDocuments: docs,
    stats: {
      totalFiltered: 0,
      totalRelevant: docs.length,
      averageGrade: 0.9,
    },
  })),
  isRetrievalSufficient: jest.fn(() => false),
}))

jest.mock("./citation-formatter", () => ({
  formatCitations: jest.fn(() => ({
    context: "citation context",
    citations: [{ id: "chunk-1", label: "Source 1" }],
  })),
}))

const mockSelectOptimalChunks = jest.fn(() => ({
  formattedContext: "dynamic context",
  selectedChunks: [],
  totalTokens: 3,
}))
const mockCalculateOptimalContextLength = jest.fn(() => 512)

jest.mock("./context-manager", () => ({
  createContextManager: jest.fn(() => ({
    calculateOptimalContextLength: mockCalculateOptimalContextLength,
    selectOptimalChunks: mockSelectOptimalChunks,
  })),
}))

const mockRecordFeedback = jest.fn()

jest.mock("./adaptive-reranker", () => ({
  createAdaptiveReranker: jest.fn(() => ({
    recordFeedback: mockRecordFeedback,
  })),
}))

describe("rag-pipeline", () => {
  let pipeline: RAGPipeline

  const defaultConfig: RAGPipelineConfig = {
    embeddingConfig: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    embeddingApiKey: "test-api-key",
    // Native (sqlite-vec) backend doesn't require a credential configId
    // and is the only provider that can be exercised under jsdom without
    // a live cloud endpoint. Cloud providers (Chroma/Pinecone/Qdrant/...)
    // now require config.configId per the credential-form refactor.
    vectorStoreConfig: { provider: "native" },
  }
  const mockModel = { modelId: "test-model" } as unknown as RAGPipelineConfig["model"]

  const makeResult = (id: string, content = "Test content", score = 0.9) => ({
    id,
    content,
    metadata: { source: `${id}.md`, title: `Title ${id}` },
    originalScore: score,
    rerankScore: score,
  })

  const withInternals = (p: RAGPipeline) =>
    p as unknown as {
      vectorStore: {
        searchDocuments: jest.Mock
        addDocuments: jest.Mock
        deleteDocuments: jest.Mock
        deleteAllDocuments?: jest.Mock
        listCollections: jest.Mock
      }
      queryCache: {
        get: jest.Mock
        set: jest.Mock
        getStats: jest.Mock
        invalidateCollection: jest.Mock
      }
      mirrorCollections: Map<
        string,
        Array<{
          id: string
          content: string
          embedding: number[]
          metadata?: Record<string, unknown>
          sparseEmbedding?: { indices: number[]; values: number[] }
        }>
      >
      searchSingle: jest.Mock
      formatContext: (documents: ReturnType<typeof makeResult>[]) => string
    }

  beforeEach(() => {
    jest.clearAllMocks()
    pipeline = new RAGPipeline(defaultConfig)
  })

  describe("constructor", () => {
    it("should create pipeline with default config", () => {
      const p = new RAGPipeline(defaultConfig)
      expect(p).toBeDefined()
    })

    it("should create pipeline with custom hybrid search config", () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        hybridSearch: {
          enabled: true,
          vectorWeight: 0.7,
          keywordWeight: 0.3,
        },
      })
      expect(p).toBeDefined()
    })

    it("should create pipeline with contextual retrieval enabled", () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        contextualRetrieval: {
          enabled: true,
          useLLM: false,
          cacheEnabled: true,
        },
      })
      expect(p).toBeDefined()
    })

    it("should create pipeline with query expansion enabled", () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        queryExpansion: {
          enabled: true,
          maxVariants: 5,
          useHyDE: false,
        },
      })
      expect(p).toBeDefined()
    })

    it("should create pipeline with reranking enabled", () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        reranking: {
          enabled: true,
          useLLM: false,
        },
      })
      expect(p).toBeDefined()
    })

    it("should create pipeline with every optional feature configured", () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        model: mockModel,
        hybridSearch: {
          enabled: false,
          vectorWeight: 0.8,
          keywordWeight: 0.1,
          sparseWeight: 0.05,
          lateInteractionWeight: 0.05,
          enableSparseSearch: true,
          enableLateInteraction: true,
        },
        contextualRetrieval: {
          enabled: true,
          useLLM: true,
          cacheEnabled: false,
        },
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          useHyDE: true,
        },
        reranking: {
          enabled: true,
          useLLM: true,
          cohereApiKey: "cohere-key",
        },
        topK: 7,
        similarityThreshold: 0.25,
        maxContextLength: 1200,
        chunkingOptions: { strategy: "fixed", chunkSize: 128, chunkOverlap: 16 },
        cache: {
          enabled: false,
          maxSize: 3,
          ttl: 1000,
          persistToIndexedDB: true,
        },
        dynamicContext: {
          enabled: true,
          maxTokens: 2048,
        },
        adaptiveReranking: {
          enabled: true,
          feedbackWeight: 0.8,
        },
        citations: {
          enabled: true,
          style: "apa",
        },
        correctiveRAG: {
          enabled: true,
          relevanceThreshold: 0.7,
          useLLM: true,
          fallbackStrategy: "relax_threshold",
        },
        iterativeRetrieval: {
          enabled: true,
          maxIterations: 4,
          sufficiencyThreshold: 0.8,
        },
        parentChildChunking: {
          enabled: true,
          parentChunkSize: 1024,
        },
        deduplication: {
          enabled: true,
          mode: "upsert",
        },
        vectorStoreConfig: {
          provider: "native",
          chromaMode: "server",
          chromaServerUrl: "http://localhost:8000",
          pineconeApiKey: "pinecone-key",
          pineconeIndexName: "pinecone-index",
          pineconeNamespace: "pinecone-namespace",
          weaviateUrl: "http://weaviate",
          weaviateApiKey: "weaviate-key",
          qdrantUrl: "http://qdrant",
          qdrantApiKey: "qdrant-key",
          qdrantCollectionName: "qdrant-collection",
          milvusAddress: "localhost:19530",
          milvusToken: "milvus-token",
          milvusUsername: "milvus-user",
          milvusPassword: "milvus-password",
          milvusSsl: true,
          milvusCollectionName: "milvus-collection",
        },
      })

      expect(p).toBeDefined()
    })
  })

  describe("indexDocument", () => {
    it("should index a document successfully", async () => {
      const options: IndexingOptions = {
        collectionName: "test-collection",
        documentId: "doc-1",
        documentTitle: "Test Document",
      }

      const result = await pipeline.indexDocument("This is test content for indexing.", options)

      expect(result.success).toBe(true)
      expect(result.chunksCreated).toBeGreaterThan(0)
    })

    it("should index with metadata", async () => {
      const options: IndexingOptions = {
        collectionName: "test-collection",
        documentId: "doc-2",
        metadata: { author: "Test Author", category: "test" },
      }

      const result = await pipeline.indexDocument("Document with metadata.", options)

      expect(result.success).toBe(true)
    })

    it("should call progress callback", async () => {
      const onProgress = jest.fn()
      const options: IndexingOptions = {
        collectionName: "test-collection",
        documentId: "doc-3",
        onProgress,
      }

      await pipeline.indexDocument("Document for progress tracking.", options)

      expect(onProgress).toHaveBeenCalled()
    })

    it("should handle contextual retrieval option", async () => {
      const options: IndexingOptions = {
        collectionName: "test-collection",
        documentId: "doc-4",
        useContextualRetrieval: true,
      }

      // Enable contextual retrieval in config
      const p = new RAGPipeline({
        ...defaultConfig,
        contextualRetrieval: { enabled: true },
      })

      const result = await p.indexDocument("Contextual document.", options)

      expect(result.success).toBe(true)
    })

    it("uses async semantic chunking, LLM context, parent chunks, and sparse metadata when enabled", async () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        model: mockModel,
        chunkingOptions: { strategy: "semantic", chunkSize: 128 },
        contextualRetrieval: { enabled: true, useLLM: true, cacheEnabled: false },
        parentChildChunking: { enabled: true, parentChunkSize: 64 },
        hybridSearch: { enableSparseSearch: true },
      })
      const onProgress = jest.fn()

      const result = await p.indexDocument(
        "# Heading\n\nA moderately complex sentence with enough words to analyze.\n\n```ts\nconst x = 1\n```",
        {
          collectionName: "advanced-index",
          documentId: "doc-advanced",
          documentTitle: "Advanced",
          useContextualRetrieval: true,
          onProgress,
        }
      )

      expect(result).toEqual({ chunksCreated: 1, success: true })
      expect(chunkDocumentAsync).toHaveBeenCalled()
      expect(addContextToChunks).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ model: mockModel }),
        undefined,
        "doc-advanced"
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "context_generation" })
      )
    })

    it("skips duplicate documents when deduplication skip mode is enabled", async () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        deduplication: { enabled: true, mode: "skip" },
      })
      const options: IndexingOptions = {
        collectionName: "dedupe-skip",
        documentId: "doc-dedupe",
      }

      await expect(p.indexDocument("same content", options)).resolves.toMatchObject({
        success: true,
        chunksCreated: 2,
      })
      await expect(
        p.indexDocument("same content", { ...options, documentId: "doc-dedupe-2" })
      ).resolves.toEqual({ success: true, chunksCreated: 0 })
    })

    it("replaces duplicate chunks when deduplication upsert mode is enabled", async () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        deduplication: { enabled: true, mode: "upsert" },
      })
      const internals = withInternals(p)
      const deleteDocuments = jest.fn().mockResolvedValue(undefined)
      internals.vectorStore = {
        addDocuments: jest.fn().mockResolvedValue(undefined),
        deleteDocuments,
        listCollections: jest.fn().mockResolvedValue([]),
        searchDocuments: jest.fn().mockResolvedValue([]),
      }
      const options: IndexingOptions = {
        collectionName: "dedupe-upsert",
        documentId: "doc-dedupe",
      }

      await p.indexDocument("same upsert content", options)
      const result = await p.indexDocument("same upsert content", {
        ...options,
        documentId: "doc-dedupe-2",
      })

      expect(result.success).toBe(true)
      expect(deleteDocuments).toHaveBeenCalled()
    })

    it("returns a structured failure when chunking creates no chunks or throws", async () => {
      jest.mocked(chunkDocument).mockReturnValueOnce({
        chunks: [],
        metadata: { totalChunks: 0 },
      } as never)
      await expect(
        pipeline.indexDocument("empty", {
          collectionName: "empty-chunks",
          documentId: "doc-empty",
        })
      ).resolves.toEqual({
        chunksCreated: 0,
        success: false,
        error: "No chunks created from document",
      })

      jest.mocked(chunkDocument).mockImplementationOnce(() => {
        throw new Error("chunk failed")
      })
      await expect(
        pipeline.indexDocument("bad", {
          collectionName: "bad-chunks",
          documentId: "doc-bad",
        })
      ).resolves.toEqual({
        chunksCreated: 0,
        success: false,
        error: "chunk failed",
      })
    })
  })

  describe("retrieve", () => {
    beforeEach(async () => {
      // Index some documents first
      await pipeline.indexDocument("First test document about machine learning.", {
        collectionName: "test",
        documentId: "doc-1",
      })
      await pipeline.indexDocument("Second test document about deep learning.", {
        collectionName: "test",
        documentId: "doc-2",
      })
    })

    it("should retrieve relevant documents", async () => {
      const result = await pipeline.retrieve("machine learning", "test")

      expect(result).toBeDefined()
      expect(result.documents).toBeDefined()
      expect(result.formattedContext).toBeDefined()
    })

    it("should include search metadata", async () => {
      const result = await pipeline.retrieve("test query", "test")

      expect(result.searchMetadata).toBeDefined()
      expect(result.searchMetadata.finalResultCount).toBeGreaterThanOrEqual(0)
    })

    it("should respect topK parameter", async () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        topK: 3,
      })

      await p.indexDocument("Test document.", {
        collectionName: "limited",
        documentId: "doc-1",
      })

      const result = await p.retrieve("test", "limited")

      expect(result.documents.length).toBeLessThanOrEqual(3)
    })

    it("returns cached contexts with cacheHit metadata", async () => {
      const p = new RAGPipeline(defaultConfig)
      const cached = {
        documents: [makeResult("cached")],
        query: "cached query",
        formattedContext: "cached context",
        totalTokensEstimate: 3,
        searchMetadata: {
          hybridSearchUsed: false,
          queryExpansionUsed: false,
          rerankingUsed: false,
          originalResultCount: 1,
          finalResultCount: 1,
        },
      }
      const internals = withInternals(p)
      internals.queryCache = {
        get: jest.fn().mockResolvedValue(cached),
        set: jest.fn(),
        getStats: jest.fn(),
        invalidateCollection: jest.fn(),
      }
      internals.searchSingle = jest.fn()

      const result = await p.retrieve("cached-collection", "cached query")

      expect(result.searchMetadata.cacheHit).toBe(true)
      expect(internals.searchSingle).not.toHaveBeenCalled()
    })

    it("uses query expansion, LLM reranking, CRAG, dynamic context, citations, and cache writes", async () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        model: mockModel,
        queryExpansion: { enabled: true, maxVariants: 3, useHyDE: true },
        reranking: { enabled: true, useLLM: true, cohereApiKey: "cohere-key" },
        correctiveRAG: { enabled: true, relevanceThreshold: 0.6, useLLM: true },
        dynamicContext: { enabled: true, maxTokens: 1024 },
        citations: { enabled: true, style: "simple" },
        cache: { enabled: true },
        similarityThreshold: 0.1,
      })
      const internals = withInternals(p)
      internals.queryCache = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn(),
        invalidateCollection: jest.fn(),
      }
      internals.searchSingle = jest
        .fn()
        .mockResolvedValueOnce([makeResult("chunk-1", "alpha beta", 0.8)])
        .mockResolvedValueOnce([makeResult("chunk-1", "alpha beta", 0.7)])
        .mockResolvedValueOnce([makeResult("chunk-2", "gamma delta", 0.6)])
      jest.mocked(mergeQueryResults).mockReturnValueOnce([
        { id: "chunk-1", score: 0.8 },
        { id: "chunk-2", score: 0.6 },
      ])
      jest
        .mocked(rerank)
        .mockResolvedValueOnce([
          makeResult("chunk-1", "alpha beta", 0.95),
          makeResult("chunk-2", "gamma delta", 0.65),
        ])
      jest.mocked(gradeRetrievedDocuments).mockResolvedValueOnce({
        allDocuments: [
          {
            document: makeResult("chunk-1", "alpha beta", 0.95),
            grade: 0.95,
            relevant: true,
            method: "llm",
          },
          {
            document: makeResult("chunk-2", "gamma delta", 0.65),
            grade: 0.65,
            relevant: false,
            method: "llm",
          },
        ],
        relevantDocuments: [makeResult("chunk-1", "alpha beta", 0.95)],
        stats: {
          totalGraded: 2,
          totalFiltered: 1,
          totalRelevant: 1,
          averageGrade: 0.95,
          fallbackUsed: false,
          method: "llm",
        },
      })

      const result = await p.retrieve("advanced-retrieve", "  test query  ")

      expect(expandQuery).toHaveBeenCalledWith(
        "test query",
        expect.objectContaining({ model: mockModel })
      )
      expect(internals.searchSingle).toHaveBeenCalledTimes(3)
      expect(rerank).toHaveBeenCalled()
      expect(gradeRetrievedDocuments).toHaveBeenCalled()
      expect(mockCalculateOptimalContextLength).toHaveBeenCalled()
      expect(mockSelectOptimalChunks).toHaveBeenCalled()
      expect(formatCitations).toHaveBeenCalled()
      expect(internals.queryCache.set).toHaveBeenCalled()
      expect(result.formattedContext).toBe("dynamic context")
      expect(result.citations).toBeDefined()
      expect(result.searchMetadata).toMatchObject({
        queryExpansionUsed: true,
        rerankingUsed: true,
        finalResultCount: 1,
      })
    })

    it("returns an empty context for invalid input and retrieval errors", async () => {
      const invalid = await pipeline.retrieve("", "")
      expect(invalid.documents).toEqual([])
      expect(invalid.formattedContext).toBe("")

      const p = new RAGPipeline({ ...defaultConfig, cache: { enabled: false } })
      const internals = withInternals(p)
      internals.searchSingle = jest.fn().mockRejectedValue(new Error("search failed"))
      const failed = await p.retrieve("collection", "valid query")
      expect(failed.documents).toEqual([])
      expect(failed.query).toBe("valid query")
    })

    it("searches without hybrid search and falls back to mirror vector search when the vector store fails", async () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        hybridSearch: { enabled: false },
        reranking: { enabled: false },
        cache: { enabled: false },
        similarityThreshold: 0,
      })
      const internals = withInternals(p)
      internals.vectorStore.searchDocuments = jest
        .fn()
        .mockResolvedValueOnce([
          { id: "vector-1", content: "Vector content", metadata: { source: "v.md" }, score: 0.77 },
        ])

      const direct = await internals.searchSingle("vector-only", "query")
      expect(direct).toEqual([expect.objectContaining({ id: "vector-1", rerankScore: 0.77 })])

      internals.mirrorCollections.set("fallback", [
        {
          id: "mirror-1",
          content: "Mirror content",
          embedding: new Array(1536).fill(0.1),
          metadata: { source: "mirror.md" },
        },
      ])
      internals.vectorStore.searchDocuments = jest.fn().mockRejectedValueOnce(new Error("down"))
      const fallback = await internals.searchSingle("fallback", "query")

      expect(generateEmbedding).toHaveBeenCalled()
      expect(fallback[0]).toMatchObject({ id: "mirror-1", rerankScore: 0.85 })
    })

    it("runs sparse and late-interaction hybrid search branches", async () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        hybridSearch: {
          enabled: true,
          enableSparseSearch: true,
          enableLateInteraction: true,
        },
        cache: { enabled: false },
      })
      const internals = withInternals(p)
      internals.mirrorCollections.set("hybrid-extra", [
        {
          id: "chunk-1",
          content: "Sparse and late content",
          embedding: new Array(1536).fill(0.1),
          metadata: { source: "hybrid.md" },
        },
      ])
      internals.vectorStore.searchDocuments = jest
        .fn()
        .mockResolvedValueOnce([
          { id: "chunk-1", content: "Sparse and late content", metadata: {}, score: 0.8 },
        ])

      const results = await internals.searchSingle("hybrid-extra", "sparse query")

      expect(results).toEqual([expect.objectContaining({ id: "chunk-1" })])
    })
  })

  describe("retrieveIterative", () => {
    it("refines insufficient results with the lightweight fallback and merges new documents", async () => {
      const p = new RAGPipeline({ ...defaultConfig, topK: 3 })
      const first = {
        documents: [makeResult("first", "first result terms")],
        query: "initial",
        formattedContext: "first",
        totalTokensEstimate: 2,
        searchMetadata: {
          hybridSearchUsed: false,
          queryExpansionUsed: false,
          rerankingUsed: false,
          originalResultCount: 1,
          finalResultCount: 1,
        },
      }
      const second = {
        ...first,
        documents: [makeResult("first"), makeResult("second", "second result terms")],
      }
      jest.spyOn(p, "retrieve").mockResolvedValueOnce(first).mockResolvedValueOnce(second)
      jest.mocked(isRetrievalSufficient).mockReturnValueOnce(false)

      const result = await p.retrieveIterative("iterative", "initial", { maxIterations: 2 })

      expect(result.documents.map((doc) => doc.id)).toEqual(["first", "second"])
      expect(isRetrievalSufficient).toHaveBeenCalled()
    })

    it("uses the model rewrite path when a model is configured", async () => {
      const p = new RAGPipeline({ ...defaultConfig, model: mockModel })
      const first = {
        documents: [makeResult("first", "first result terms")],
        query: "initial",
        formattedContext: "first",
        totalTokensEstimate: 2,
        searchMetadata: {
          hybridSearchUsed: false,
          queryExpansionUsed: false,
          rerankingUsed: false,
          originalResultCount: 1,
          finalResultCount: 1,
        },
      }
      jest.spyOn(p, "retrieve").mockResolvedValue(first)
      jest.mocked(isRetrievalSufficient).mockReturnValueOnce(false)

      await p.retrieveIterative("iterative-model", "initial", { maxIterations: 2 })

      expect(rewriteQuery).toHaveBeenCalledWith("initial", mockModel)
    })

    it("returns the first pass immediately when no documents are retrieved", async () => {
      const p = new RAGPipeline(defaultConfig)
      const empty = {
        documents: [],
        query: "empty",
        formattedContext: "",
        totalTokensEstimate: 0,
        searchMetadata: {
          hybridSearchUsed: false,
          queryExpansionUsed: false,
          rerankingUsed: false,
          originalResultCount: 0,
          finalResultCount: 0,
        },
      }
      jest.spyOn(p, "retrieve").mockResolvedValueOnce(empty)

      await expect(p.retrieveIterative("iterative-empty", "empty")).resolves.toBe(empty)
    })
  })

  describe("clearCollection", () => {
    it("should clear a collection", async () => {
      await pipeline.indexDocument("Test doc.", {
        collectionName: "to-clear",
        documentId: "doc-1",
      })

      await pipeline.clearCollection("to-clear")

      const result = await pipeline.retrieve("test", "to-clear")
      expect(result.documents).toHaveLength(0)
    })

    it("falls back to deleteDocuments when deleteAllDocuments is unavailable", async () => {
      await pipeline.indexDocument("Test doc.", {
        collectionName: "clear-fallback",
        documentId: "doc-1",
      })
      const internals = withInternals(pipeline)
      const deleteDocuments = jest.fn().mockResolvedValue(undefined)
      internals.vectorStore = {
        addDocuments: jest.fn().mockResolvedValue(undefined),
        deleteDocuments,
        listCollections: jest.fn().mockResolvedValue([]),
        searchDocuments: jest.fn().mockResolvedValue([]),
      }

      await pipeline.clearCollection("clear-fallback")

      expect(deleteDocuments).toHaveBeenCalled()
    })
  })

  describe("getCollectionStats", () => {
    it("should return collection statistics", async () => {
      await pipeline.indexDocument("Stats test doc.", {
        collectionName: "stats-test",
        documentId: "doc-1",
      })

      const stats = await pipeline.getCollectionStats("stats-test")

      expect(stats).toBeDefined()
      expect(stats?.documentCount).toBeGreaterThan(0)
    })

    it("should return undefined for non-existent collection", async () => {
      const stats = await pipeline.getCollectionStats("non-existent")

      expect(stats?.exists).toBe(false)
    })
  })

  describe("management helpers", () => {
    it("deletes explicit document ids and source document ids", async () => {
      await pipeline.indexDocument("Delete target", {
        collectionName: "delete-test",
        documentId: "source-doc",
      })
      const statsBefore = await pipeline.getCollectionStats("delete-test")
      expect(statsBefore.documentCount).toBeGreaterThan(0)

      const missing = await pipeline.deleteByDocumentId("delete-test", "missing")
      expect(missing).toBe(0)

      const deleted = await pipeline.deleteByDocumentId("delete-test", "source-doc")
      expect(deleted).toBeGreaterThan(0)
      expect(await pipeline.deleteDocuments("delete-test", [])).toBe(0)
    })

    it("lists collections from vector store and falls back to mirror keys on failure", async () => {
      const internals = withInternals(pipeline)
      internals.vectorStore.listCollections = jest
        .fn()
        .mockResolvedValueOnce([{ name: "from-vector" }])
      await expect(pipeline.listCollections()).resolves.toEqual(["from-vector"])

      internals.mirrorCollections.set("from-mirror", [])
      internals.vectorStore.listCollections = jest.fn().mockRejectedValueOnce(new Error("down"))
      await expect(pipeline.listCollections()).resolves.toContain("from-mirror")
    })

    it("exposes cache helpers, adaptive feedback, private context formatting, updateConfig, and factory creation", () => {
      const p = new RAGPipeline({
        ...defaultConfig,
        adaptiveReranking: { enabled: true },
        maxContextLength: 130,
      })
      const internals = withInternals(p)
      internals.queryCache = {
        get: jest.fn(),
        set: jest.fn(),
        getStats: jest.fn(() => ({ hits: 1, misses: 2, hitRate: 1 / 3, size: 3 })),
        invalidateCollection: jest.fn(() => 2),
      }

      p.recordFeedback("query", "result", 0.9, "click")
      expect(mockRecordFeedback).toHaveBeenCalledWith("query", "result", 0.9, "click")
      expect(p.getCacheStats()).toMatchObject({ hits: 1, size: 3 })
      expect(p.invalidateCache("collection")).toBe(2)

      const truncated = internals.formatContext([makeResult("long", "x".repeat(220))])
      expect(truncated).toContain("...")

      p.updateConfig({
        hybridSearch: { enabled: false },
        contextualRetrieval: { enabled: true },
        queryExpansion: { enabled: true },
        reranking: { enabled: false },
        topK: 2,
        similarityThreshold: 0.2,
        maxContextLength: 80,
      })
      expect(new RAGPipeline(defaultConfig)).toBeDefined()
    })

    it("does not record adaptive feedback when adaptive reranking is disabled", () => {
      const p = new RAGPipeline(defaultConfig)
      mockRecordFeedback.mockClear()

      p.recordFeedback("query", "result", 0.9)

      expect(mockRecordFeedback).not.toHaveBeenCalled()
    })
  })
})
