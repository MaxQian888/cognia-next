/**
 * Tests for Vector Plugin API
 */

import { createVectorAPI } from "./vector-api"

// Mock stores and vector utilities
const mockCollections = new Map<string, { name: string; documents: Map<string, unknown> }>()

jest.mock("@/stores", () => ({
  useVectorStore: {
    getState: jest.fn(() => ({
      settings: {
        provider: "native",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
      },
    })),
  },
  useSettingsStore: {
    getState: jest.fn(() => ({
      providerSettings: {
        openai: {
          apiKey: "test-api-key",
        },
      },
    })),
  },
}))

jest.mock("@/lib/vector", () => ({
  createVectorStore: jest.fn(() => ({
    createCollection: jest.fn(async (name) => {
      mockCollections.set(name, { name, documents: new Map() })
    }),
    deleteCollection: jest.fn(async (name) => {
      mockCollections.delete(name)
    }),
    listCollections: jest.fn(async () => {
      return Array.from(mockCollections.values()).map((c) => ({ name: c.name }))
    }),
    getCollectionInfo: jest.fn(async (name) => {
      const col = mockCollections.get(name)
      return {
        name,
        documentCount: col ? col.documents.size : 0,
        dimension: 1536,
      }
    }),
    addDocuments: jest.fn(async (collection, docs) => {
      const col = mockCollections.get(collection)
      if (col) {
        for (const doc of docs) {
          col.documents.set(doc.id, doc)
        }
      }
    }),
    updateDocuments: jest.fn(async (collection, docs) => {
      const col = mockCollections.get(collection)
      if (col) {
        for (const doc of docs) {
          col.documents.set(doc.id, doc)
        }
      }
    }),
    deleteDocuments: jest.fn(async (collection, ids) => {
      const col = mockCollections.get(collection)
      if (col) {
        for (const id of ids) {
          col.documents.delete(id)
        }
      }
    }),
    searchDocuments: jest.fn(async (_collection, _query, _options) => {
      return [
        { id: "doc-1", content: "Result 1", metadata: {}, score: 0.95 },
        { id: "doc-2", content: "Result 2", metadata: {}, score: 0.85 },
      ]
    }),
    searchByEmbedding: jest.fn(async (_collection, _embedding, _options) => {
      return [{ id: "doc-1", content: "Result 1", metadata: {}, score: 0.91 }]
    }),
    countDocuments: jest.fn(async (collection) => {
      const col = mockCollections.get(collection)
      return col ? col.documents.size : 0
    }),
    deleteAllDocuments: jest.fn(async (collection) => {
      const col = mockCollections.get(collection)
      if (col) {
        col.documents.clear()
      }
    }),
  })),
}))

jest.mock("@/lib/vector/embedding", () => ({
  DEFAULT_EMBEDDING_MODELS: {
    openai: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    google: { provider: "google", model: "text-embedding-004", dimensions: 768 },
    cohere: { provider: "cohere", model: "embed-english-v3.0", dimensions: 1024 },
    mistral: { provider: "mistral", model: "mistral-embed", dimensions: 1024 },
    transformersjs: {
      provider: "transformersjs",
      model: "Xenova/all-MiniLM-L6-v2",
      dimensions: 384,
    },
  },
  generateEmbedding: jest.fn(async (_text, _config, _apiKey) => ({
    embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
  })),
  generateEmbeddings: jest.fn(async (texts, _config, _apiKey) => ({
    embeddings: texts.map(() => [0.1, 0.2, 0.3, 0.4, 0.5]),
  })),
  resolveEmbeddingApiKey: jest.fn(
    (_provider: string, providerSettings: Record<string, { apiKey?: string }>) => {
      return providerSettings?.openai?.apiKey || ""
    }
  ),
}))

// Mock logger
jest.mock("../core/logger", () => ({
  createPluginSystemLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

jest.mock("nanoid", () => ({
  nanoid: jest.fn(() => `id-${Date.now()}`),
}))

describe("Vector API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    mockCollections.clear()
  })

  describe("createVectorAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createVectorAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.createCollection).toBe("function")
      expect(typeof api.deleteCollection).toBe("function")
      expect(typeof api.listCollections).toBe("function")
      expect(typeof api.getCollectionInfo).toBe("function")
      expect(typeof api.addDocuments).toBe("function")
      expect(typeof api.updateDocuments).toBe("function")
      expect(typeof api.deleteDocuments).toBe("function")
      expect(typeof api.search).toBe("function")
      expect(typeof api.searchByEmbedding).toBe("function")
      expect(typeof api.embed).toBe("function")
      expect(typeof api.embedBatch).toBe("function")
      expect(typeof api.getDocumentCount).toBe("function")
      expect(typeof api.clearCollection).toBe("function")
    })
  })

  describe("Collection management", () => {
    it("should create a collection", async () => {
      const api = createVectorAPI(testPluginId)

      const id = await api.createCollection("my-collection")

      expect(id).toBeDefined()
      expect(id).toContain(`plugin_${testPluginId}_my-collection`)
    })

    it("should prefix collection name with plugin ID", async () => {
      const api = createVectorAPI(testPluginId)

      await api.createCollection("test")

      expect(mockCollections.has(`plugin_${testPluginId}_test`)).toBe(true)
    })

    it("should delete a collection", async () => {
      const api = createVectorAPI(testPluginId)

      await api.createCollection("to-delete")
      expect(mockCollections.size).toBe(1)

      await api.deleteCollection("to-delete")
      expect(mockCollections.size).toBe(0)
    })

    it("should list collections for this plugin only", async () => {
      const api1 = createVectorAPI("plugin-1")
      const api2 = createVectorAPI("plugin-2")

      await api1.createCollection("col-a")
      await api1.createCollection("col-b")
      await api2.createCollection("col-c")

      const list1 = await api1.listCollections()
      expect(list1).toContain("col-a")
      expect(list1).toContain("col-b")
      expect(list1).not.toContain("col-c")

      const list2 = await api2.listCollections()
      expect(list2).toContain("col-c")
      expect(list2).not.toContain("col-a")
    })
  })

  describe("getCollectionInfo", () => {
    it("should return collection info", async () => {
      const api = createVectorAPI(testPluginId)

      const info = await api.getCollectionInfo("my-collection")

      expect(info).toBeDefined()
      expect(info.name).toBe("my-collection")
      expect(info.dimensions).toBeDefined()
    })
  })

  describe("Document operations", () => {
    beforeEach(async () => {
      const api = createVectorAPI(testPluginId)
      await api.createCollection("docs-collection")
    })

    it("should add documents", async () => {
      const api = createVectorAPI(testPluginId)

      const ids = await api.addDocuments("docs-collection", [
        { content: "Document 1", metadata: { source: "test" } },
        { content: "Document 2", metadata: { source: "test" } },
      ])

      expect(ids.length).toBe(2)
    })

    it("should add documents with IDs", async () => {
      const api = createVectorAPI(testPluginId)

      const ids = await api.addDocuments("docs-collection", [
        { id: "custom-id-1", content: "Document 1" },
        { id: "custom-id-2", content: "Document 2" },
      ])

      expect(ids).toContain("custom-id-1")
      expect(ids).toContain("custom-id-2")
    })

    it("should update documents", async () => {
      const api = createVectorAPI(testPluginId)

      await api.addDocuments("docs-collection", [{ id: "update-doc", content: "Original" }])

      await api.updateDocuments("docs-collection", [{ id: "update-doc", content: "Updated" }])

      // Check that update was called (no error thrown)
    })

    it("should delete documents", async () => {
      const api = createVectorAPI(testPluginId)

      await api.addDocuments("docs-collection", [{ id: "delete-doc", content: "To delete" }])

      await api.deleteDocuments("docs-collection", ["delete-doc"])

      // Check that delete was called (no error thrown)
    })
  })

  describe("Search operations", () => {
    it("should search documents", async () => {
      const api = createVectorAPI(testPluginId)
      await api.createCollection("search-collection")

      const results = await api.search("search-collection", "test query")

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBeDefined()
      expect(results[0].content).toBeDefined()
      expect(results[0].score).toBeDefined()
    })

    it("should search with options", async () => {
      const api = createVectorAPI(testPluginId)
      await api.createCollection("search-options")

      const results = await api.search("search-options", "test", {
        topK: 10,
        threshold: 0.5,
      })

      expect(Array.isArray(results)).toBe(true)
    })

    it("should search by embedding", async () => {
      const api = createVectorAPI(testPluginId)
      await api.createCollection("embed-search")

      const results = await api.searchByEmbedding("embed-search", [0.1, 0.2, 0.3], { topK: 5 })

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe("Embedding operations", () => {
    it("should embed single text", async () => {
      const api = createVectorAPI(testPluginId)

      const embedding = await api.embed("Hello world")

      expect(Array.isArray(embedding)).toBe(true)
      expect(embedding.length).toBeGreaterThan(0)
    })

    it("should embed batch of texts", async () => {
      const api = createVectorAPI(testPluginId)

      const embeddings = await api.embedBatch(["Text 1", "Text 2", "Text 3"])

      expect(Array.isArray(embeddings)).toBe(true)
      expect(embeddings.length).toBe(3)
      expect(embeddings[0].length).toBeGreaterThan(0)
    })
  })

  describe("Collection utilities", () => {
    it("should get document count", async () => {
      const api = createVectorAPI(testPluginId)
      await api.createCollection("any-collection")
      await api.addDocuments("any-collection", [{ content: "Count me" }])

      const count = await api.getDocumentCount("any-collection")

      expect(count).toBe(1)
    })

    it("should clear collection", async () => {
      const api = createVectorAPI(testPluginId)
      await api.createCollection("clear-collection")
      await api.addDocuments("clear-collection", [{ content: "Doc 1" }, { content: "Doc 2" }])

      await api.clearCollection("clear-collection")

      // Should not throw
    })
  })

  describe("Plugin isolation", () => {
    it("should isolate collections between plugins", async () => {
      const api1 = createVectorAPI("plugin-a")
      const api2 = createVectorAPI("plugin-b")

      await api1.createCollection("shared-name")
      await api2.createCollection("shared-name")

      // Both should exist with different prefixes
      expect(mockCollections.has("plugin_plugin-a_shared-name")).toBe(true)
      expect(mockCollections.has("plugin_plugin-b_shared-name")).toBe(true)
    })
  })
})
