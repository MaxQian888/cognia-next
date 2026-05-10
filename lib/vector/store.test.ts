import {
  createVectorStore,
  NativeVectorStore,
  type VectorStoreConfig,
  type VectorDocument,
  type PayloadFilter,
  type CollectionImport,
} from "./store"

const mockEmbeddingConfig = {
  provider: "openai" as const,
  model: "text-embedding-3-small",
  dimensions: 1536,
}

const mockConfig: VectorStoreConfig = {
  provider: "native",
  embeddingConfig: mockEmbeddingConfig,
  embeddingApiKey: "test-api-key",
  native: {},
}

// Mock Tauri invoke function
const mockInvoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}))

// Mock window.__TAURI_INTERNALS__ to simulate Tauri environment
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {},
  writable: true,
  configurable: true, // Allow deletion
})

// Extend Window interface for TypeScript
declare global {
  interface Window {
    __TAURI_INTERNALS__?: Record<string, unknown>
  }
}

// Mock embedding functions
jest.mock("./embedding", () => ({
  generateEmbedding: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3],
    model: "text-embedding-3-small",
    provider: "openai",
  }),
  generateEmbeddings: jest.fn().mockResolvedValue({
    embeddings: [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ],
    model: "text-embedding-3-small",
    provider: "openai",
  }),
}))

// Get the mocked functions after the module is mocked
import * as embeddingModule from "./embedding"
const mockGenerateEmbedding = jest.mocked(embeddingModule.generateEmbedding)
const mockGenerateEmbeddings = jest.mocked(embeddingModule.generateEmbeddings)

describe("createVectorStore factory", () => {
  it("creates native vector store when provider is native", () => {
    const store = createVectorStore(mockConfig)
    expect(store.provider).toBe("native")
    expect(store).toBeInstanceOf(NativeVectorStore)
  })

  it("throws on unsupported provider", () => {
    // @ts-expect-error - testing invalid provider
    expect(() => createVectorStore({ ...mockConfig, provider: "unknown" })).toThrow(
      "Unsupported vector store provider: unknown"
    )
  })
})

describe("createVectorStore plugin-event proxy", () => {
  it("dispatches onDocumentsIndexed after addDocuments resolves", async () => {
    mockInvoke.mockResolvedValue(true)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPluginEventHooks } = require("@/lib/plugin/messaging/hooks-system") as {
      getPluginEventHooks: () => {
        dispatchDocumentsIndexed: (collection: string, count: number) => void
        dispatchVectorSearch: (collection: string, query: string, count: number) => void
      }
    }
    const indexedSpy = jest
      .spyOn(getPluginEventHooks(), "dispatchDocumentsIndexed")
      .mockImplementation(() => {})

    const store = createVectorStore(mockConfig)
    const docs: VectorDocument[] = [
      { id: "a", content: "hello", embedding: [0.1, 0.2, 0.3] },
      { id: "b", content: "world", embedding: [0.4, 0.5, 0.6] },
    ]
    await store.addDocuments("plugins-test", docs)
    expect(indexedSpy).toHaveBeenCalledWith("plugins-test", 2)
  })

  it("dispatches onVectorSearch after searchDocuments resolves", async () => {
    mockInvoke.mockResolvedValue({ results: [], total: 0 })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPluginEventHooks } = require("@/lib/plugin/messaging/hooks-system") as {
      getPluginEventHooks: () => {
        dispatchDocumentsIndexed: (collection: string, count: number) => void
        dispatchVectorSearch: (collection: string, query: string, count: number) => void
      }
    }
    const searchSpy = jest
      .spyOn(getPluginEventHooks(), "dispatchVectorSearch")
      .mockImplementation(() => {})

    const store = createVectorStore(mockConfig)
    const results = await store.searchDocuments("plugins-test", "hello")
    expect(searchSpy).toHaveBeenCalledWith("plugins-test", "hello", results.length)
  })
})

describe("NativeVectorStore", () => {
  let store: NativeVectorStore

  beforeEach(() => {
    store = new NativeVectorStore(mockConfig)
    mockInvoke.mockClear()
  })

  describe("createCollection", () => {
    it("creates collection with basic options", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.createCollection("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_create_collection", {
        name: "test-collection",
        dimension: 1536,
        metadata: undefined,
        description: undefined,
        embedding_model: "text-embedding-3-small",
        embedding_provider: "openai",
      })
    })

    it("creates collection with all options", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.createCollection("test-collection", {
        dimension: 768,
        metadata: { type: "test" },
        description: "Test collection",
        embeddingModel: "custom-model",
        embeddingProvider: "custom-provider",
      })

      expect(mockInvoke).toHaveBeenCalledWith("vector_create_collection", {
        name: "test-collection",
        dimension: 768,
        metadata: { type: "test" },
        description: "Test collection",
        embedding_model: "custom-model",
        embedding_provider: "custom-provider",
      })
    })

    it("throws error when not in Tauri environment", async () => {
      const originalTauri = window.__TAURI_INTERNALS__

      // Completely remove __TAURI_INTERNALS__ property
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

      // Verify __TAURI_INTERNALS__ is actually removed
      expect("__TAURI_INTERNALS__" in window).toBe(false)

      const store = new NativeVectorStore(mockConfig)

      await expect(store.createCollection("test")).rejects.toThrow(
        "Native vector store is only available in Tauri environment"
      )

      // Restore for other tests
      if (originalTauri !== undefined) {
        window.__TAURI_INTERNALS__ = originalTauri
      } else {
        window.__TAURI_INTERNALS__ = {}
      }
    })
  })

  describe("deleteCollection", () => {
    it("deletes collection", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.deleteCollection("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_delete_collection", {
        name: "test-collection",
      })
    })
  })

  describe("truncateCollection", () => {
    it("truncates collection", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.truncateCollection("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_truncate_collection", {
        name: "test-collection",
      })
    })
  })

  describe("addDocuments", () => {
    it("adds documents with embeddings", async () => {
      const documents: VectorDocument[] = [
        {
          id: "doc1",
          content: "test content 1",
          metadata: { type: "test" },
          embedding: [0.1, 0.2, 0.3],
        },
        {
          id: "doc2",
          content: "test content 2",
          embedding: [0.4, 0.5, 0.6],
        },
      ]

      mockInvoke.mockResolvedValue(true)

      await store.addDocuments("test-collection", documents)

      expect(mockInvoke).toHaveBeenCalledWith("vector_upsert_points", {
        collection: "test-collection",
        points: [
          {
            id: "doc1",
            vector: [0.1, 0.2, 0.3],
            payload: { content: "test content 1", type: "test" },
          },
          {
            id: "doc2",
            vector: [0.4, 0.5, 0.6],
            payload: { content: "test content 2" },
          },
        ],
      })
    })

    it("generates embeddings for documents without them", async () => {
      const documents: VectorDocument[] = [
        {
          id: "doc1",
          content: "test content 1",
          // No embedding - should be generated
        },
        {
          id: "doc2",
          content: "test content 2",
          embedding: [0.4, 0.5, 0.6], // Has embedding
        },
      ]

      mockInvoke.mockResolvedValue(true)
      mockGenerateEmbeddings.mockResolvedValue({
        embeddings: [[0.7, 0.8, 0.9]], // Only one embedding for doc1
        model: "test-model",
        provider: "openai",
      })

      await store.addDocuments("test-collection", documents)

      expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
        ["test content 1"], // Only doc1's content
        mockEmbeddingConfig,
        "test-api-key"
      )

      expect(mockInvoke).toHaveBeenCalledWith("vector_upsert_points", {
        collection: "test-collection",
        points: [
          {
            id: "doc1",
            vector: [0.7, 0.8, 0.9], // Generated embedding
            payload: { content: "test content 1" },
          },
          {
            id: "doc2",
            vector: [0.4, 0.5, 0.6], // Original embedding
            payload: { content: "test content 2" },
          },
        ],
      })
    })
  })

  describe("deleteDocuments", () => {
    it("deletes documents", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.deleteDocuments("test-collection", ["doc1", "doc2"])

      expect(mockInvoke).toHaveBeenCalledWith("vector_delete_points", {
        collection: "test-collection",
        ids: ["doc1", "doc2"],
      })
    })
  })

  describe("searchDocuments", () => {
    beforeEach(() => {
      mockGenerateEmbedding.mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
        model: "test-model",
        provider: "openai",
      })
    })

    it("searches with basic options", async () => {
      const mockResults = [
        {
          id: "doc1",
          score: 0.95,
          payload: { content: "test content 1", type: "test" },
        },
        {
          id: "doc2",
          score: 0.87,
          payload: { content: "test content 2" },
        },
      ]

      mockInvoke.mockResolvedValue(mockResults)

      const results = await store.searchDocuments("test-collection", "search query")

      expect(mockGenerateEmbedding).toHaveBeenCalledWith(
        "search query",
        mockEmbeddingConfig,
        "test-api-key"
      )

      expect(mockInvoke).toHaveBeenCalledWith("vector_search_points", {
        collection: "test-collection",
        vector: [0.1, 0.2, 0.3],
        top_k: 5,
        score_threshold: undefined,
        offset: undefined,
        limit: undefined,
        filters: undefined,
        filter_mode: undefined,
      })

      expect(results).toEqual([
        {
          id: "doc1",
          content: "test content 1",
          metadata: { content: "test content 1", type: "test" },
          score: 0.95,
        },
        {
          id: "doc2",
          content: "test content 2",
          metadata: { content: "test content 2" },
          score: 0.87,
        },
      ])
    })

    it("searches with advanced options", async () => {
      const filters: PayloadFilter[] = [
        {
          key: "type",
          value: "document",
          operation: "equals",
        },
        {
          key: "score",
          value: 90,
          operation: "greater_than",
        },
      ]

      mockInvoke.mockResolvedValue([])

      await store.searchDocuments("test-collection", "search query", {
        topK: 10,
        threshold: 0.8,
        offset: 5,
        limit: 3,
        filters,
      })

      expect(mockInvoke).toHaveBeenCalledWith("vector_search_points", {
        collection: "test-collection",
        vector: [0.1, 0.2, 0.3],
        top_k: 10,
        score_threshold: 0.8,
        offset: 5,
        limit: 3,
        filters: [
          {
            key: "type",
            value: "document",
            operation: "equals",
          },
          {
            key: "score",
            value: 90,
            operation: "greater_than",
          },
        ],
        filter_mode: undefined,
      })
    })

    it("handles empty results", async () => {
      mockInvoke.mockResolvedValue([])

      const results = await store.searchDocuments("test-collection", "no matches")

      expect(results).toEqual([])
    })

    it("handles null results", async () => {
      mockInvoke.mockResolvedValue(null)

      const results = await store.searchDocuments("test-collection", "null results")

      expect(results).toEqual([])
    })
  })

  describe("getDocuments", () => {
    it("gets documents by IDs", async () => {
      const mockResults = [
        {
          id: "doc1",
          vector: [0.1, 0.2, 0.3],
          payload: { content: "test content 1", type: "test" },
        },
      ]

      mockInvoke.mockResolvedValue(mockResults)

      const results = await store.getDocuments("test-collection", ["doc1"])

      expect(mockInvoke).toHaveBeenCalledWith("vector_get_points", {
        collection: "test-collection",
        ids: ["doc1"],
      })

      expect(results).toEqual([
        {
          id: "doc1",
          content: "test content 1",
          metadata: { content: "test content 1", type: "test" },
          embedding: [0.1, 0.2, 0.3],
        },
      ])
    })
  })

  describe("listCollections", () => {
    it("lists all collections", async () => {
      const mockCollections = [
        {
          name: "collection1",
          dimension: 1536,
          metadata: { type: "test" },
          document_count: 5,
          created_at: "2022-01-01T00:00:00.000Z",
          updated_at: "2022-01-01T00:01:40.000Z",
          description: "Test collection 1",
          embedding_model: "model1",
          embedding_provider: "provider1",
        },
        {
          name: "collection2",
          dimension: 768,
          document_count: 3,
          created_at: "2022-01-01T00:03:20.000Z",
          updated_at: "2022-01-01T00:05:00.000Z",
        },
      ]

      mockInvoke.mockResolvedValue(mockCollections)

      const results = await store.listCollections()

      expect(mockInvoke).toHaveBeenCalledWith("vector_list_collections", undefined)

      expect(results).toEqual([
        {
          name: "collection1",
          documentCount: 5,
          dimension: 1536,
          metadata: { type: "test" },
          createdAt: 1640995200000,
          updatedAt: 1640995300000,
          description: "Test collection 1",
          embeddingModel: "model1",
          embeddingProvider: "provider1",
        },
        {
          name: "collection2",
          documentCount: 3,
          dimension: 768,
          metadata: undefined,
          createdAt: 1640995400000,
          updatedAt: 1640995500000,
          description: undefined,
          embeddingModel: undefined,
          embeddingProvider: undefined,
        },
      ])
    })

    it("handles empty collection list", async () => {
      mockInvoke.mockResolvedValue([])

      const results = await store.listCollections()

      expect(results).toEqual([])
    })
  })

  describe("getCollectionInfo", () => {
    it("gets collection info", async () => {
      const mockInfo = {
        name: "test-collection",
        dimension: 1536,
        metadata: { type: "test" },
        document_count: 10,
        created_at: "2022-01-01T00:00:00.000Z",
        updated_at: "2022-01-01T00:01:40.000Z",
        description: "Test collection",
        embedding_model: "test-model",
        embedding_provider: "test-provider",
      }

      mockInvoke.mockResolvedValue(mockInfo)

      const result = await store.getCollectionInfo("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_get_collection", {
        name: "test-collection",
      })

      expect(result).toEqual({
        name: "test-collection",
        documentCount: 10,
        dimension: 1536,
        metadata: { type: "test" },
        createdAt: 1640995200000,
        updatedAt: 1640995300000,
        description: "Test collection",
        embeddingModel: "test-model",
        embeddingProvider: "test-provider",
      })
    })
  })

  describe("updateDocuments", () => {
    it("updates documents using upsert semantics", async () => {
      const documents: VectorDocument[] = [
        {
          id: "doc1",
          content: "updated content",
          embedding: [0.7, 0.8, 0.9],
        },
      ]

      mockInvoke.mockResolvedValue(true)

      await store.updateDocuments("test-collection", documents)

      // Should call the same method as addDocuments
      expect(mockInvoke).toHaveBeenCalledWith("vector_upsert_points", {
        collection: "test-collection",
        points: [
          {
            id: "doc1",
            vector: [0.7, 0.8, 0.9],
            payload: { content: "updated content" },
          },
        ],
      })
    })
  })

  describe("web-mode rejection", () => {
    let storeNoTauri: NativeVectorStore

    beforeEach(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
      storeNoTauri = new NativeVectorStore(mockConfig)
    })

    afterEach(() => {
      window.__TAURI_INTERNALS__ = {}
    })

    const webModeError = "Native vector store is only available in Tauri environment"

    it("rejects addDocuments", async () => {
      await expect(
        storeNoTauri.addDocuments("col", [{ id: "1", content: "x", embedding: [0.1] }])
      ).rejects.toThrow(webModeError)
    })

    it("rejects updateDocuments", async () => {
      await expect(
        storeNoTauri.updateDocuments("col", [{ id: "1", content: "x", embedding: [0.1] }])
      ).rejects.toThrow(webModeError)
    })

    it("rejects deleteDocuments", async () => {
      await expect(storeNoTauri.deleteDocuments("col", ["1"])).rejects.toThrow(webModeError)
    })

    it("rejects deleteAllDocuments", async () => {
      await expect(storeNoTauri.deleteAllDocuments("col")).rejects.toThrow(webModeError)
    })

    it("rejects searchDocuments", async () => {
      await expect(storeNoTauri.searchDocuments("col", "query")).rejects.toThrow(webModeError)
    })

    it("rejects searchByEmbedding", async () => {
      await expect(storeNoTauri.searchByEmbedding!("col", [0.1, 0.2])).rejects.toThrow(webModeError)
    })

    it("rejects searchDocumentsWithTotal", async () => {
      await expect(storeNoTauri.searchDocumentsWithTotal!("col", "query")).rejects.toThrow(
        webModeError
      )
    })

    it("rejects getDocuments", async () => {
      await expect(storeNoTauri.getDocuments("col", ["1"])).rejects.toThrow(webModeError)
    })

    it("rejects createCollection", async () => {
      await expect(storeNoTauri.createCollection("col")).rejects.toThrow(webModeError)
    })

    it("rejects deleteCollection", async () => {
      await expect(storeNoTauri.deleteCollection("col")).rejects.toThrow(webModeError)
    })

    it("rejects truncateCollection", async () => {
      await expect(storeNoTauri.truncateCollection!("col")).rejects.toThrow(webModeError)
    })

    it("rejects listCollections", async () => {
      await expect(storeNoTauri.listCollections()).rejects.toThrow(webModeError)
    })

    it("rejects getCollectionInfo", async () => {
      await expect(storeNoTauri.getCollectionInfo("col")).rejects.toThrow(webModeError)
    })
  })

  describe("addDocuments payload shape", () => {
    it("sends flat collection+points payload with content in payload field", async () => {
      mockInvoke.mockResolvedValue(undefined)

      const docs: VectorDocument[] = [
        { id: "p1", content: "hello world", metadata: { tag: "a" }, embedding: [0.1, 0.2, 0.3] },
      ]

      await store.addDocuments("my-col", docs)

      expect(mockInvoke).toHaveBeenCalledWith("vector_upsert_points", {
        collection: "my-col",
        points: [
          {
            id: "p1",
            vector: [0.1, 0.2, 0.3],
            payload: { content: "hello world", tag: "a" },
          },
        ],
      })
    })
  })

  describe("score pass-through (Rust returns final score)", () => {
    it("does not re-convert score — passes through directly", async () => {
      mockGenerateEmbedding.mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
        model: "test-model",
        provider: "openai",
      })

      mockInvoke.mockResolvedValue({
        results: [{ id: "p1", score: 0.85, content: "some text", payload: { x: 1 } }],
        total: 1,
        offset: 0,
        limit: 10,
      })

      const results = await store.searchDocuments("col", "query", { topK: 10 })

      expect(results).toHaveLength(1)
      expect(results[0].score).toBe(0.85)
      expect(results[0].id).toBe("p1")
      expect(results[0].content).toBe("some text")
    })
  })

  describe("searchByEmbeddingWithTotal back-compat branches", () => {
    it("legacy array response: back-compat branch reconstructs SearchResponse", async () => {
      mockInvoke.mockResolvedValue([
        { id: "r1", score: 0.9, payload: { content: "legacy content", meta: "v" } },
        { id: "r2", score: 0.7, payload: { content: "legacy 2" } },
      ])

      const result = await store.searchDocumentsWithTotal!("col", "q")

      expect(result.results).toHaveLength(2)
      expect(result.results[0]).toMatchObject({ id: "r1", score: 0.9, content: "legacy content" })
      expect(result.results[1]).toMatchObject({ id: "r2", score: 0.7, content: "legacy 2" })
      // total/offset/limit populated by applyThresholdAndPagination helper
      expect(typeof result.total).toBe("number")
    })

    it("tagged response: passes through results, total, offset, limit", async () => {
      mockInvoke.mockResolvedValue({
        results: [{ id: "t1", score: 0.75, content: "tagged", payload: { k: "v" } }],
        total: 42,
        offset: 10,
        limit: 5,
      })

      const result = await store.searchDocumentsWithTotal!("col", "q")

      expect(result.results[0]).toMatchObject({ id: "t1", score: 0.75, content: "tagged" })
      expect(result.total).toBe(42)
      expect(result.offset).toBe(10)
      expect(result.limit).toBe(5)
    })
  })

  describe("filter pass-through", () => {
    it("passes filter array unmodified in flat search payload", async () => {
      mockGenerateEmbedding.mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
        model: "test-model",
        provider: "openai",
      })
      mockInvoke.mockResolvedValue({ results: [], total: 0, offset: 0, limit: 5 })

      const filters: PayloadFilter[] = [{ key: "category", value: "x", operation: "equals" }]
      await store.searchDocuments("col", "q", { filters, filterMode: "and" })

      expect(mockInvoke).toHaveBeenCalledWith(
        "vector_search_points",
        expect.objectContaining({
          filters: [{ key: "category", value: "x", operation: "equals" }],
          filter_mode: "and",
        })
      )
    })
  })

  describe("stub methods throw not-yet-supported", () => {
    it("scrollDocuments throws", async () => {
      await expect(store.scrollDocuments!("col")).rejects.toThrow(
        "scrollDocuments is not yet supported on the native backend"
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("renameCollection throws", async () => {
      await expect(store.renameCollection!("a", "b")).rejects.toThrow(
        "renameCollection is not yet supported on the native backend"
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("exportCollection throws", async () => {
      await expect(store.exportCollection!("col")).rejects.toThrow(
        "exportCollection is not yet supported on the native backend"
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("importCollection throws", async () => {
      const data: CollectionImport = { meta: { name: "x", documentCount: 0 }, points: [] }
      await expect(store.importCollection!(data)).rejects.toThrow(
        "importCollection is not yet supported on the native backend"
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("getStats throws", async () => {
      await expect(store.getStats!()).rejects.toThrow(
        "getStats is not yet supported on the native backend"
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("countDocuments throws", async () => {
      await expect(store.countDocuments!("col")).rejects.toThrow(
        "countDocuments is not yet supported on the native backend"
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })
})
