/**
 * Tests for RAG (Retrieval Augmented Generation) Service
 */

import {
  indexDocument,
  indexDocuments,
  retrieveContext,
  createRAGPrompt,
  createRAGConfig,
  SimpleRAG,
  type RAGDocument,
  type RAGConfig,
  type RAGContext,
} from "./rag"

// Mock dependencies
import * as chunkingModule from "../embedding/chunking"
import * as chromaModule from "@/lib/vector/chroma-client"

jest.mock("../embedding/chunking", () => ({
  chunkDocument: jest.fn((content, _options, docId) => ({
    chunks: content
      ? [
          {
            id: `${docId || "chunk"}-0`,
            content: content.slice(0, 500),
            index: 0,
            startOffset: 0,
            endOffset: Math.min(content.length, 500),
          },
        ]
      : [],
    totalChunks: content ? 1 : 0,
    originalLength: content?.length || 0,
    strategy: "sentence",
  })),
}))

jest.mock("@/lib/vector/embedding", () => ({
  generateEmbedding: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
  generateEmbeddings: jest.fn().mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]],
  }),
  findMostSimilar: jest.fn((_, items, topK) =>
    items.slice(0, topK).map((item: { id: string }) => ({ id: item.id, similarity: 0.9 }))
  ),
}))

jest.mock("@/lib/vector/chroma-client", () => ({
  getChromaClient: jest.fn(() => ({})),
  getOrCreateCollection: jest.fn().mockResolvedValue({
    name: "test-collection",
    add: jest.fn(),
    query: jest.fn(),
  }),
  addDocuments: jest.fn().mockResolvedValue(undefined),
  queryCollection: jest.fn().mockResolvedValue([
    {
      id: "chunk-1",
      content: "Test content from knowledge base",
      similarity: 0.85,
      metadata: { source: "test.txt", title: "Test Document" },
    },
  ]),
}))

describe("indexDocument", () => {
  const mockConfig: RAGConfig = {
    chromaConfig: {
      mode: "embedded",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      apiKey: "test-key",
    },
    chunkingOptions: { strategy: "sentence", chunkSize: 500 },
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("indexes document successfully", async () => {
    const document: RAGDocument = {
      id: "doc-1",
      content: "This is test content for indexing.",
      title: "Test Document",
      source: "test.txt",
    }

    const result = await indexDocument("test-collection", document, mockConfig)

    expect(result.success).toBe(true)
    expect(result.documentId).toBe("doc-1")
    expect(result.chunksCreated).toBeGreaterThan(0)
  })

  it("handles empty content", async () => {
    const mockChunkDocument = chunkingModule.chunkDocument as jest.Mock
    mockChunkDocument.mockReturnValueOnce({
      chunks: [],
      totalChunks: 0,
      originalLength: 0,
      strategy: "sentence",
    })

    const document: RAGDocument = {
      id: "doc-empty",
      content: "",
    }

    const result = await indexDocument("test-collection", document, mockConfig)

    expect(result.success).toBe(false)
    expect(result.error).toBe("No chunks created from document")
    expect(result.chunksCreated).toBe(0)
  })

  it("includes document metadata in chunks", async () => {
    const mockAddDocuments = chromaModule.addDocuments as jest.Mock

    const document: RAGDocument = {
      id: "doc-meta",
      content: "Content with metadata",
      title: "Metadata Test",
      source: "meta.txt",
      metadata: { author: "Test Author", category: "test" },
    }

    await indexDocument("test-collection", document, mockConfig)

    expect(mockAddDocuments).toHaveBeenCalled()
    const addedDocs = mockAddDocuments.mock.calls[0][1]
    expect(addedDocs[0].metadata).toMatchObject({
      documentId: "doc-meta",
      title: "Metadata Test",
      source: "meta.txt",
    })
  })

  it("handles indexing errors gracefully", async () => {
    const mockAddDocuments = chromaModule.addDocuments as jest.Mock
    mockAddDocuments.mockRejectedValueOnce(new Error("Database error"))

    const document: RAGDocument = {
      id: "doc-error",
      content: "Test content",
    }

    const result = await indexDocument("test-collection", document, mockConfig)

    expect(result.success).toBe(false)
    expect(result.error).toBe("Database error")
  })
})

describe("indexDocuments", () => {
  const mockConfig: RAGConfig = {
    chromaConfig: {
      mode: "embedded",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      apiKey: "test-key",
    },
  }

  it("indexes multiple documents", async () => {
    const documents: RAGDocument[] = [
      { id: "doc-1", content: "First document content" },
      { id: "doc-2", content: "Second document content" },
      { id: "doc-3", content: "Third document content" },
    ]

    const results = await indexDocuments("test-collection", documents, mockConfig)

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.success)).toBe(true)
  })

  it("handles empty documents array", async () => {
    const results = await indexDocuments("test-collection", [], mockConfig)

    expect(results).toHaveLength(0)
  })
})

describe("retrieveContext", () => {
  const mockConfig: RAGConfig = {
    chromaConfig: {
      mode: "embedded",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      apiKey: "test-key",
    },
    topK: 5,
    similarityThreshold: 0.5,
    maxContextLength: 4000,
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("retrieves relevant context for query", async () => {
    const result = await retrieveContext("test-collection", "test query", mockConfig)

    expect(result.query).toBe("test query")
    expect(result.documents).toBeDefined()
    expect(result.formattedContext).toBeDefined()
    expect(result.totalTokensEstimate).toBeGreaterThanOrEqual(0)
  })

  it("returns empty context when no results", async () => {
    const mockQueryCollection = chromaModule.queryCollection as jest.Mock
    mockQueryCollection.mockResolvedValueOnce([])

    const result = await retrieveContext("test-collection", "no results query", mockConfig)

    expect(result.documents).toHaveLength(0)
    expect(result.formattedContext).toBe("")
  })

  it("filters results by similarity threshold", async () => {
    const mockQueryCollection = chromaModule.queryCollection as jest.Mock
    mockQueryCollection.mockResolvedValueOnce([
      { id: "1", content: "High similarity", similarity: 0.9, distance: 0.1, metadata: {} },
      { id: "2", content: "Low similarity", similarity: 0.3, distance: 0.7, metadata: {} },
    ])

    const result = await retrieveContext("test-collection", "query", {
      ...mockConfig,
      similarityThreshold: 0.5,
    })

    expect(result.documents).toHaveLength(1)
    expect(result.documents[0].similarity).toBeGreaterThanOrEqual(0.5)
  })

  it("limits results to topK", async () => {
    const mockQueryCollection = chromaModule.queryCollection as jest.Mock
    mockQueryCollection.mockResolvedValueOnce([
      { id: "1", content: "Result 1", similarity: 0.9, distance: 0.1, metadata: {} },
      { id: "2", content: "Result 2", similarity: 0.85, distance: 0.15, metadata: {} },
      { id: "3", content: "Result 3", similarity: 0.8, distance: 0.2, metadata: {} },
      { id: "4", content: "Result 4", similarity: 0.75, distance: 0.25, metadata: {} },
    ])

    const result = await retrieveContext("test-collection", "query", {
      ...mockConfig,
      topK: 2,
    })

    expect(result.documents.length).toBeLessThanOrEqual(2)
  })

  it("handles retrieval errors gracefully", async () => {
    const mockQueryCollection = chromaModule.queryCollection as jest.Mock
    mockQueryCollection.mockRejectedValueOnce(new Error("Query failed"))

    const result = await retrieveContext("test-collection", "query", mockConfig)

    expect(result.documents).toHaveLength(0)
    expect(result.formattedContext).toBe("")
  })
})

describe("createRAGPrompt", () => {
  it("creates prompt without context", () => {
    const context: RAGContext = {
      documents: [],
      query: "test query",
      formattedContext: "",
      totalTokensEstimate: 0,
    }

    const prompt = createRAGPrompt("What is AI?", context)

    expect(prompt).toContain("What is AI?")
    expect(prompt).not.toContain("## Context")
  })

  it("creates prompt with context", () => {
    const context: RAGContext = {
      documents: [
        {
          id: "1",
          content: "AI is artificial intelligence",
          similarity: 0.9,
          distance: 0.1,
          metadata: {},
        },
      ],
      query: "test query",
      formattedContext: "AI is artificial intelligence",
      totalTokensEstimate: 10,
    }

    const prompt = createRAGPrompt("What is AI?", context)

    expect(prompt).toContain("What is AI?")
    expect(prompt).toContain("## Context")
    expect(prompt).toContain("AI is artificial intelligence")
  })

  it("uses custom system prompt", () => {
    const context: RAGContext = {
      documents: [],
      query: "test",
      formattedContext: "",
      totalTokensEstimate: 0,
    }

    const prompt = createRAGPrompt("Question", context, "You are a coding assistant.")

    expect(prompt).toContain("You are a coding assistant.")
  })

  it("includes instructions for context usage", () => {
    const context: RAGContext = {
      documents: [
        { id: "1", content: "Context text", similarity: 0.9, distance: 0.1, metadata: {} },
      ],
      query: "query",
      formattedContext: "Context text",
      totalTokensEstimate: 5,
    }

    const prompt = createRAGPrompt("Question", context)

    expect(prompt).toContain("## Instructions")
    expect(prompt).toContain("context")
  })
})

describe("SimpleRAG", () => {
  const embeddingConfig = { provider: "openai" as const, model: "text-embedding-3-small" }

  it("creates instance with config", () => {
    const rag = new SimpleRAG(embeddingConfig, "test-key")

    expect(rag).toBeDefined()
    expect(rag.getDocumentCount()).toBe(0)
    expect(rag.getTotalChunks()).toBe(0)
  })

  it("adds document and creates chunks", async () => {
    const rag = new SimpleRAG(embeddingConfig, "test-key")

    const chunkCount = await rag.addDocument("doc-1", "Test document content")

    expect(chunkCount).toBeGreaterThan(0)
    expect(rag.getDocumentCount()).toBe(1)
    expect(rag.getTotalChunks()).toBeGreaterThan(0)
  })

  it("handles empty document", async () => {
    const mockChunkDocument = chunkingModule.chunkDocument as jest.Mock
    mockChunkDocument.mockReturnValueOnce({
      chunks: [],
      totalChunks: 0,
      originalLength: 0,
      strategy: "sentence",
    })

    const rag = new SimpleRAG(embeddingConfig, "test-key")
    const chunkCount = await rag.addDocument("doc-empty", "")

    expect(chunkCount).toBe(0)
    expect(rag.getDocumentCount()).toBe(0)
  })

  it("searches for similar content", async () => {
    const rag = new SimpleRAG(embeddingConfig, "test-key")
    await rag.addDocument("doc-1", "Test document about AI")

    const results = await rag.search("artificial intelligence", 5)

    expect(results).toBeDefined()
    expect(Array.isArray(results)).toBe(true)
  })

  it("clears all documents", async () => {
    const rag = new SimpleRAG(embeddingConfig, "test-key")
    await rag.addDocument("doc-1", "First document")
    await rag.addDocument("doc-2", "Second document")

    expect(rag.getDocumentCount()).toBe(2)

    rag.clear()

    expect(rag.getDocumentCount()).toBe(0)
    expect(rag.getTotalChunks()).toBe(0)
  })
})

describe("createRAGConfig", () => {
  it("creates config with OpenAI defaults", () => {
    const config = createRAGConfig("test-key", "openai")

    expect(config.chromaConfig.apiKey).toBe("test-key")
    expect(config.chromaConfig.embeddingConfig.provider).toBe("openai")
    expect(config.chromaConfig.embeddingConfig.model).toBe("text-embedding-3-small")
    expect(config.topK).toBe(5)
    expect(config.similarityThreshold).toBe(0.5)
  })

  it("creates config with Google provider", () => {
    const config = createRAGConfig("test-key", "google")

    expect(config.chromaConfig.embeddingConfig.provider).toBe("google")
    expect(config.chromaConfig.embeddingConfig.model).toBe("text-embedding-004")
  })

  it("allows custom options override", () => {
    const config = createRAGConfig("test-key", "openai", {
      topK: 10,
      similarityThreshold: 0.7,
      maxContextLength: 8000,
    })

    expect(config.topK).toBe(10)
    expect(config.similarityThreshold).toBe(0.7)
    expect(config.maxContextLength).toBe(8000)
  })

  it("uses default chunking options", () => {
    const config = createRAGConfig("test-key")

    expect(config.chunkingOptions?.strategy).toBe("sentence")
    expect(config.chunkingOptions?.chunkSize).toBe(1000)
    expect(config.chunkingOptions?.chunkOverlap).toBe(200)
  })
})
