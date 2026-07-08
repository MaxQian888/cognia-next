/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import {
  PersistentRAGStorage,
  createPersistentStorage,
  getStorageEstimate,
  isIndexedDBAvailable,
  type ExportData,
} from "./persistent-storage"

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve()
  })
}

function doc(id: string, content = id) {
  return {
    id,
    content,
    embedding: [0.1, 0.2, 0.3],
    metadata: { source: "test" },
  }
}

describe("PersistentRAGStorage", () => {
  const dbNames: string[] = []

  function makeStorage() {
    const dbName = `persistent-rag-storage-${Date.now()}-${dbNames.length}`
    dbNames.push(dbName)
    return createPersistentStorage({ dbName })
  }

  afterEach(async () => {
    await Promise.all(dbNames.splice(0).map((name) => deleteDb(name)))
  })

  it("requires initialization before operations", async () => {
    const storage = makeStorage()
    await expect(storage.loadDocuments("docs")).rejects.toThrow("Storage not initialized")
  })

  it("saves, loads, updates, and clears collection documents", async () => {
    const storage = makeStorage()
    await storage.initialize()

    await storage.saveDocuments("docs", [doc("a", "Alpha"), doc("b", "Beta")])
    expect(await storage.loadDocuments("docs")).toHaveLength(2)
    expect(await storage.getCollectionInfo("docs")).toMatchObject({
      name: "docs",
      documentCount: 2,
      totalChunks: 2,
    })

    await expect(storage.updateDocument("docs", "a", { content: "Alpha updated" })).resolves.toBe(
      true
    )
    const updated = await storage.loadDocuments("docs")
    expect(updated.find((item) => item.id === "a")).toMatchObject({
      content: "Alpha updated",
      version: 2,
    })

    await expect(storage.deleteDocuments("docs", ["b"])).resolves.toBe(1)
    await expect(storage.clearCollection("docs")).resolves.toBeUndefined()
    expect(await storage.listCollections()).toEqual([])
    storage.close()
  })

  it("exports, imports, and summarizes stored data", async () => {
    const source = makeStorage()
    await source.initialize()
    await source.saveDocuments("kb", [doc("one")])

    const exported = await source.exportAll()
    expect(exported.collections).toHaveLength(1)
    expect(exported.documents.get("kb")).toHaveLength(1)

    const target = makeStorage()
    await target.initialize()
    const imported = await target.importData(exported as ExportData)
    expect(imported).toEqual({ collections: 1, documents: 1 })
    expect(await target.getStorageStats()).toMatchObject({
      collections: 1,
      totalDocuments: 1,
      estimatedSize: 1024,
    })

    source.close()
    target.close()
  })

  it("reports IndexedDB availability and navigator storage estimates", async () => {
    expect(isIndexedDBAvailable()).toBe(true)

    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: jest.fn(async () => ({ usage: 25, quota: 100 })) },
    })

    await expect(getStorageEstimate()).resolves.toEqual({
      usage: 25,
      quota: 100,
      usagePercent: 25,
    })
  })

  it("can delete its backing database", async () => {
    const storage = new PersistentRAGStorage({ dbName: `persistent-rag-delete-${Date.now()}` })
    await storage.initialize()
    await storage.saveCollectionConfig({
      name: "docs",
      documentCount: 0,
      totalChunks: 0,
      createdAt: 1,
      updatedAt: 1,
    })

    await expect(storage.deleteDatabase()).resolves.toBeUndefined()
  })
})
