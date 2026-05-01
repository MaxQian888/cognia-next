import {
  createVectorStore,
  NativeVectorStore,
  type VectorStoreConfig,
  type VectorDocument,
  type PayloadFilter,
  type CollectionExport,
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
        payload: {
          name: "test-collection",
          dimension: 1536,
          metadata: undefined,
          description: undefined,
          embedding_model: "text-embedding-3-small",
          embedding_provider: "openai",
        },
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
        payload: {
          name: "test-collection",
          dimension: 768,
          metadata: { type: "test" },
          description: "Test collection",
          embedding_model: "custom-model",
          embedding_provider: "custom-provider",
        },
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

  describe("renameCollection", () => {
    it("renames collection", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.renameCollection("old-name", "new-name")

      expect(mockInvoke).toHaveBeenCalledWith("vector_rename_collection", {
        old_name: "old-name",
        new_name: "new-name",
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

  describe("exportCollection", () => {
    it("exports collection", async () => {
      const mockExportData: CollectionExport = {
        meta: {
          name: "test-collection",
          documentCount: 2,
          dimension: 1536,
          description: "Test collection",
          embeddingModel: "test-model",
          embeddingProvider: "test-provider",
          createdAt: 1640995200,
          updatedAt: 1640995300,
        },
        points: [
          {
            id: "point1",
            vector: [0.1, 0.2, 0.3],
            payload: { content: "test content 1" },
          },
          {
            id: "point2",
            vector: [0.4, 0.5, 0.6],
            payload: { content: "test content 2" },
          },
        ],
      }

      mockInvoke.mockResolvedValue(mockExportData)

      const result = await store.exportCollection("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_export_collection", {
        name: "test-collection",
      })
      expect(result).toEqual(mockExportData)
    })
  })

  describe("importCollection", () => {
    it("imports collection", async () => {
      const mockImportData: CollectionImport = {
        meta: {
          name: "imported-collection",
          documentCount: 1,
          dimension: 768,
        },
        points: [
          {
            id: "imported1",
            vector: [0.7, 0.8],
            payload: { imported: true },
          },
        ],
      }

      mockInvoke.mockResolvedValue(true)

      await store.importCollection(mockImportData, true)

      expect(mockInvoke).toHaveBeenCalledWith("vector_import_collection", {
        import_data: mockImportData,
        overwrite: true,
      })
    })

    it("imports collection with default overwrite false", async () => {
      const mockImportData: CollectionImport = {
        meta: { name: "test", documentCount: 0 },
        points: [],
      }

      mockInvoke.mockResolvedValue(true)

      await store.importCollection(mockImportData)

      expect(mockInvoke).toHaveBeenCalledWith("vector_import_collection", {
        import_data: mockImportData,
        overwrite: false,
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
        payload: {
          collection: "test-collection",
          vector: [0.1, 0.2, 0.3],
          top_k: 5,
          score_threshold: undefined,
          offset: undefined,
          limit: undefined,
          filters: undefined,
        },
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
        payload: {
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
        },
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
          created_at: 1640995200,
          updated_at: 1640995300,
          description: "Test collection 1",
          embedding_model: "model1",
          embedding_provider: "provider1",
        },
        {
          name: "collection2",
          dimension: 768,
          document_count: 3,
          created_at: 1640995400,
          updated_at: 1640995500,
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
          createdAt: 1640995200,
          updatedAt: 1640995300,
          description: "Test collection 1",
          embeddingModel: "model1",
          embeddingProvider: "provider1",
        },
        {
          name: "collection2",
          documentCount: 3,
          dimension: 768,
          metadata: undefined,
          createdAt: 1640995400,
          updatedAt: 1640995500,
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
        created_at: 1640995200,
        updated_at: 1640995300,
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
        createdAt: 1640995200,
        updatedAt: 1640995300,
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
})
