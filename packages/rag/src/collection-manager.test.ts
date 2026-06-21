/**
 * RAG Collection Manager Tests
 */

import {
  RAGCollectionManager,
  createCollectionManager,
  resetGlobalCollectionManager,
} from "./collection-manager"

jest.mock("./persistent-storage", () => ({
  createPersistentStorage: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    listCollections: jest.fn().mockResolvedValue([]),
    clearCollection: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  })),
  PersistentRAGStorage: jest.fn(),
}))

describe("RAGCollectionManager", () => {
  let manager: RAGCollectionManager

  beforeEach(async () => {
    manager = new RAGCollectionManager({ enablePersistence: false })
    await manager.initialize()
  })

  afterEach(async () => {
    await manager.destroy()
    await resetGlobalCollectionManager()
  })

  describe("constructor", () => {
    it("should create manager with default config", () => {
      const m = new RAGCollectionManager()
      expect(m).toBeDefined()
    })

    it("should create manager with custom config", () => {
      const m = new RAGCollectionManager({
        enablePersistence: false,
        autoSave: false,
        saveInterval: 10000,
      })
      expect(m).toBeDefined()
    })
  })

  describe("initialize", () => {
    it("should initialize successfully", async () => {
      const m = new RAGCollectionManager({ enablePersistence: false })
      await expect(m.initialize()).resolves.not.toThrow()
    })

    it("should be idempotent", async () => {
      const m = new RAGCollectionManager({ enablePersistence: false })
      await m.initialize()
      await expect(m.initialize()).resolves.not.toThrow()
    })
  })

  describe("createCollection", () => {
    it("should create a new collection", async () => {
      const result = await manager.createCollection("test-collection")

      expect(result.exists).toBe(true)
      expect(result.config.name).toBe("test-collection")
      expect(result.stats.documentCount).toBe(0)
      expect(result.stats.chunkCount).toBe(0)
    })

    it("should create collection with custom config", async () => {
      const result = await manager.createCollection("custom-collection", {
        description: "Test description",
        chunkSize: 500,
        chunkOverlap: 100,
      })

      expect(result.config.description).toBe("Test description")
      expect(result.config.chunkSize).toBe(500)
      expect(result.config.chunkOverlap).toBe(100)
    })

    it("should throw error for duplicate collection name", async () => {
      await manager.createCollection("duplicate")

      await expect(manager.createCollection("duplicate")).rejects.toThrow(
        'Collection "duplicate" already exists'
      )
    })

    it("should set default chunking strategy", async () => {
      const result = await manager.createCollection("default-config")

      expect(result.config.chunkingStrategy).toBe("semantic")
      expect(result.config.embeddingModel).toBe("text-embedding-3-small")
    })
  })

  describe("deleteCollection", () => {
    it("should delete existing collection", async () => {
      await manager.createCollection("to-delete")

      const deleted = await manager.deleteCollection("to-delete")

      expect(deleted).toBe(true)
      expect(manager.hasCollection("to-delete")).toBe(false)
    })

    it("should return false for non-existent collection", async () => {
      const deleted = await manager.deleteCollection("nonexistent")

      expect(deleted).toBe(false)
    })
  })

  describe("updateCollection", () => {
    it("should update collection config", async () => {
      await manager.createCollection("to-update")

      const updated = await manager.updateCollection("to-update", {
        description: "Updated description",
        chunkSize: 750,
      })

      expect(updated).not.toBeNull()
      expect(updated!.description).toBe("Updated description")
      expect(updated!.chunkSize).toBe(750)
    })

    it("should not change collection name", async () => {
      await manager.createCollection("original-name")

      const updated = await manager.updateCollection("original-name", {
        description: "New description",
      })

      expect(updated!.name).toBe("original-name")
    })

    it("should return null for non-existent collection", async () => {
      const updated = await manager.updateCollection("nonexistent", {
        description: "Test",
      })

      expect(updated).toBeNull()
    })

    it("should update lastUpdated timestamp", async () => {
      await manager.createCollection("timestamp-test")
      const beforeStats = await manager.getCollectionStats("timestamp-test")
      const beforeTimestamp = beforeStats!.lastUpdated

      await new Promise((resolve) => setTimeout(resolve, 10))
      await manager.updateCollection("timestamp-test", { description: "Updated" })

      const afterStats = await manager.getCollectionStats("timestamp-test")
      expect(afterStats!.lastUpdated).toBeGreaterThan(beforeTimestamp)
    })
  })

  describe("getCollectionInfo", () => {
    it("should return collection info", async () => {
      await manager.createCollection("info-test", {
        description: "Info test collection",
      })

      const info = await manager.getCollectionInfo("info-test")

      expect(info).not.toBeNull()
      expect(info!.config.name).toBe("info-test")
      expect(info!.config.description).toBe("Info test collection")
      expect(info!.exists).toBe(true)
    })

    it("should return null for non-existent collection", async () => {
      const info = await manager.getCollectionInfo("nonexistent")

      expect(info).toBeNull()
    })
  })

  describe("getCollectionStats", () => {
    it("should return collection stats", async () => {
      await manager.createCollection("stats-test")

      const stats = await manager.getCollectionStats("stats-test")

      expect(stats).not.toBeNull()
      expect(stats!.name).toBe("stats-test")
      expect(stats!.documentCount).toBe(0)
      expect(stats!.chunkCount).toBe(0)
    })

    it("should return null for non-existent collection", async () => {
      const stats = await manager.getCollectionStats("nonexistent")

      expect(stats).toBeNull()
    })
  })

  describe("listCollections", () => {
    it("should return empty list initially", async () => {
      const collections = await manager.listCollections()

      expect(collections).toEqual([])
    })

    it("should return all collections", async () => {
      await manager.createCollection("collection1")
      await manager.createCollection("collection2")
      await manager.createCollection("collection3")

      const collections = await manager.listCollections()

      expect(collections.length).toBe(3)
    })
  })

  describe("hasCollection", () => {
    it("should return true for existing collection", async () => {
      await manager.createCollection("exists")

      expect(manager.hasCollection("exists")).toBe(true)
    })

    it("should return false for non-existent collection", () => {
      expect(manager.hasCollection("nonexistent")).toBe(false)
    })
  })

  describe("updateStats", () => {
    it("should update document count", async () => {
      await manager.createCollection("stats-update")

      manager.updateStats("stats-update", { documentCount: 10 })

      const stats = await manager.getCollectionStats("stats-update")
      expect(stats!.documentCount).toBe(10)
    })

    it("should update chunk count", async () => {
      await manager.createCollection("chunk-stats")

      manager.updateStats("chunk-stats", { chunkCount: 50 })

      const stats = await manager.getCollectionStats("chunk-stats")
      expect(stats!.chunkCount).toBe(50)
    })

    it("should update storage size", async () => {
      await manager.createCollection("storage-stats")

      manager.updateStats("storage-stats", { storageSize: 1024 })

      const stats = await manager.getCollectionStats("storage-stats")
      expect(stats!.storageSize).toBe(1024)
    })

    it("should do nothing for non-existent collection", () => {
      expect(() => {
        manager.updateStats("nonexistent", { documentCount: 10 })
      }).not.toThrow()
    })
  })

  describe("incrementDocumentCount", () => {
    it("should increment by 1 by default", async () => {
      await manager.createCollection("increment-test")

      manager.incrementDocumentCount("increment-test")

      const stats = await manager.getCollectionStats("increment-test")
      expect(stats!.documentCount).toBe(1)
    })

    it("should increment by specified amount", async () => {
      await manager.createCollection("increment-custom")

      manager.incrementDocumentCount("increment-custom", 5)

      const stats = await manager.getCollectionStats("increment-custom")
      expect(stats!.documentCount).toBe(5)
    })
  })

  describe("incrementChunkCount", () => {
    it("should increment chunk count", async () => {
      await manager.createCollection("chunk-increment")

      manager.incrementChunkCount("chunk-increment", 10)

      const stats = await manager.getCollectionStats("chunk-increment")
      expect(stats!.chunkCount).toBe(10)
    })
  })

  describe("getAggregateStats", () => {
    it("should return aggregate stats for all collections", async () => {
      await manager.createCollection("agg1")
      await manager.createCollection("agg2")

      manager.updateStats("agg1", { documentCount: 10, chunkCount: 50, storageSize: 1000 })
      manager.updateStats("agg2", { documentCount: 20, chunkCount: 100, storageSize: 2000 })

      const aggregate = await manager.getAggregateStats()

      expect(aggregate.totalCollections).toBe(2)
      expect(aggregate.totalDocuments).toBe(30)
      expect(aggregate.totalChunks).toBe(150)
      expect(aggregate.totalStorageSize).toBe(3000)
    })
  })

  describe("exportConfig", () => {
    it("should export collection config", async () => {
      await manager.createCollection("export-test", {
        description: "Export test",
        chunkSize: 500,
      })

      const config = manager.exportConfig("export-test")

      expect(config).not.toBeNull()
      expect(config!.name).toBe("export-test")
      expect(config!.description).toBe("Export test")
      expect(config!.chunkSize).toBe(500)
    })

    it("should return null for non-existent collection", () => {
      const config = manager.exportConfig("nonexistent")

      expect(config).toBeNull()
    })
  })

  describe("exportAllConfigs", () => {
    it("should export all collection configs", async () => {
      await manager.createCollection("export1")
      await manager.createCollection("export2")

      const configs = manager.exportAllConfigs()

      expect(configs.length).toBe(2)
    })
  })

  describe("importConfig", () => {
    it("should import collection config", async () => {
      await manager.importConfig({
        name: "imported",
        description: "Imported collection",
        chunkingStrategy: "semantic",
        chunkSize: 1000,
        chunkOverlap: 200,
        embeddingModel: "text-embedding-3-small",
      })

      expect(manager.hasCollection("imported")).toBe(true)

      const info = await manager.getCollectionInfo("imported")
      expect(info!.config.description).toBe("Imported collection")
    })
  })

  describe("renameCollection", () => {
    it("should rename existing collection", async () => {
      await manager.createCollection("old-name")

      const renamed = await manager.renameCollection("old-name", "new-name")

      expect(renamed).toBe(true)
      expect(manager.hasCollection("old-name")).toBe(false)
      expect(manager.hasCollection("new-name")).toBe(true)
    })

    it("should return false for non-existent collection", async () => {
      const renamed = await manager.renameCollection("nonexistent", "new-name")

      expect(renamed).toBe(false)
    })

    it("should return false if new name already exists", async () => {
      await manager.createCollection("source")
      await manager.createCollection("target")

      const renamed = await manager.renameCollection("source", "target")

      expect(renamed).toBe(false)
    })

    it("should preserve stats after rename", async () => {
      await manager.createCollection("rename-stats")
      manager.updateStats("rename-stats", { documentCount: 10, chunkCount: 50 })

      await manager.renameCollection("rename-stats", "renamed-stats")

      const stats = await manager.getCollectionStats("renamed-stats")
      expect(stats!.documentCount).toBe(10)
      expect(stats!.chunkCount).toBe(50)
    })
  })

  describe("destroy", () => {
    it("should clean up resources", async () => {
      const m = new RAGCollectionManager({ enablePersistence: false })
      await m.initialize()
      await m.createCollection("test")

      await m.destroy()

      expect(m.hasCollection("test")).toBe(false)
    })
  })

  describe("createCollectionManager", () => {
    it("should create manager instance", () => {
      const m = createCollectionManager()
      expect(m).toBeInstanceOf(RAGCollectionManager)
    })

    it("should accept custom config", () => {
      const m = createCollectionManager({
        enablePersistence: false,
        saveInterval: 10000,
      })
      expect(m).toBeInstanceOf(RAGCollectionManager)
    })
  })
})
