/**
 * Tests for RAG Pipeline
 */

import { RAGPipeline } from "./rag-pipeline"
import type { RAGPipelineConfig, IndexingOptions } from "./rag-pipeline"

// Mock dependencies
jest.mock("../embedding/chunking", () => ({
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

jest.mock("@/lib/vector/embedding", () => ({
  generateEmbedding: jest.fn().mockResolvedValue({
    embedding: new Array(1536).fill(0.1),
    usage: { promptTokens: 10, totalTokens: 10 },
  }),
  generateEmbeddings: jest.fn().mockResolvedValue({
    embeddings: [new Array(1536).fill(0.1), new Array(1536).fill(0.2)],
    usage: { promptTokens: 20, totalTokens: 20 },
  }),
}))

jest.mock("@/lib/ai/embedding/embedding", () => ({
  cosineSimilarity: jest.fn().mockReturnValue(0.85),
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
  addContextToChunks: jest
    .fn()
    .mockResolvedValue([
      {
        id: "chunk-1",
        content: "Test content",
        contextualContent: "Contextual test content",
        index: 0,
      },
    ]),
  addLightweightContext: jest
    .fn()
    .mockReturnValue([
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
})
