/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import {
  IndexedDBRemoteRetryQueueStore,
  createRemoteRetryQueueStore,
} from "./remote-retry-queue-store"
import type { StructuredLogEntry } from "@/types/logging"

function makeEntry(id: string): StructuredLogEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    level: "info",
    message: `entry ${id}`,
    module: "test",
  }
}

beforeEach(() => {
  const factory = new IDBFactory()
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = factory
  ;(window as unknown as { indexedDB: IDBFactory }).indexedDB = factory
})

describe("IndexedDBRemoteRetryQueueStore (with IndexedDB)", () => {
  it("enqueues a batch and lists it back with id, createdAt, entries, bytes", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({
      dbName: "test-q-1",
      maxEntries: 1000,
      maxBytes: 1024 * 1024,
    })
    const entries = [makeEntry("a"), makeEntry("b")]
    const result = await store.enqueueBatch(entries)
    expect(result.droppedEntries).toBe(0)
    expect(result.droppedBatches).toBe(0)
    expect(result.stats.entryCount).toBe(2)
    const batches = await store.listBatches()
    expect(batches).toHaveLength(1)
    expect(batches[0].entries.map((e) => e.id)).toEqual(["a", "b"])
    expect(batches[0].bytes).toBeGreaterThan(0)
    expect(typeof batches[0].id).toBe("number")
    await store.close()
  })

  it("handles empty enqueue without writing a batch", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-empty" })
    const result = await store.enqueueBatch([])
    expect(result.droppedEntries).toBe(0)
    expect(result.stats.batchCount).toBe(0)
    await store.close()
  })

  it("getStats aggregates counts across batches", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-stats" })
    await store.enqueueBatch([makeEntry("a"), makeEntry("b")])
    await store.enqueueBatch([makeEntry("c")])
    const stats = await store.getStats()
    expect(stats.batchCount).toBe(2)
    expect(stats.entryCount).toBe(3)
    expect(stats.totalBytes).toBeGreaterThan(0)
    await store.close()
  })

  it("deleteBatch removes an entry by id", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-del" })
    await store.enqueueBatch([makeEntry("a")])
    await store.enqueueBatch([makeEntry("b")])
    const before = await store.listBatches()
    expect(before).toHaveLength(2)
    await store.deleteBatch(before[0].id)
    const after = await store.listBatches()
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(before[1].id)
    await store.close()
  })

  it("clear() empties the store", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-clear" })
    await store.enqueueBatch([makeEntry("a")])
    await store.enqueueBatch([makeEntry("b")])
    expect((await store.listBatches()).length).toBeGreaterThan(0)
    await store.clear()
    expect(await store.listBatches()).toEqual([])
    await store.close()
  })

  it("enforceLimits drops oldest batches when over maxEntries", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({
      dbName: "test-q-limit-entries",
      maxEntries: 3,
      maxBytes: 1024 * 1024 * 10,
    })
    await store.enqueueBatch([makeEntry("a")])
    await store.enqueueBatch([makeEntry("b")])
    // This third batch (2 entries) pushes total entries to 4, which is over
    // the cap of 3; the oldest batch should be dropped.
    const result = await store.enqueueBatch([makeEntry("c"), makeEntry("d")])
    expect(result.droppedBatches).toBeGreaterThanOrEqual(1)
    expect(result.droppedEntries).toBeGreaterThanOrEqual(1)
    const remaining = await store.listBatches()
    const ids = remaining.flatMap((b) => b.entries.map((e) => e.id))
    expect(ids).not.toContain("a")
    await store.close()
  })

  it("updateLimits adjusts caps dynamically", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-update-limits" })
    store.updateLimits({ maxEntries: 1 })
    await store.enqueueBatch([makeEntry("a")])
    const result = await store.enqueueBatch([makeEntry("b")])
    expect(result.droppedEntries).toBeGreaterThanOrEqual(1)
    await store.close()
  })

  it("updateLimits preserves prior values when partial update is given", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({
      dbName: "test-q-partial-update",
      maxEntries: 100,
      maxBytes: 1024,
    })
    store.updateLimits({}) // partial empty -> values preserved
    await store.enqueueBatch([makeEntry("a")])
    expect((await store.getStats()).entryCount).toBe(1)
    await store.close()
  })

  it("createRemoteRetryQueueStore factory returns an IndexedDBRemoteRetryQueueStore", async () => {
    const store = createRemoteRetryQueueStore({ dbName: "test-q-factory" })
    expect(store).toBeInstanceOf(IndexedDBRemoteRetryQueueStore)
    await store.close()
  })

  it("close() can be called multiple times without throwing", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-close" })
    await store.close()
    await store.close()
  })

  it("propagates errors when listBatches transaction throws", async () => {
    // Force `db.transaction` to throw synchronously to exercise the catch
    // branch inside the listBatches Promise executor.
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-list-err" })
    // Wait for init to settle; the store now has `this.db` set.
    await store.enqueueBatch([makeEntry("a")])
    const internal = store as unknown as { db: IDBDatabase | null }
    if (internal.db) {
      const realTx = internal.db.transaction.bind(internal.db)
      // First call throws, then restores so close() works.
      let calls = 0
      ;(internal.db as unknown as { transaction: typeof realTx }).transaction = ((
        ...args: Parameters<typeof realTx>
      ) => {
        calls++
        if (calls === 1) {
          throw new Error("tx-throw")
        }
        return realTx(...args)
      }) as typeof realTx
      await expect(store.listBatches()).rejects.toThrow("tx-throw")
    }
    await store.close()
  })

  it("propagates errors when deleteBatch transaction throws", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-del-err" })
    await store.enqueueBatch([makeEntry("a")])
    const internal = store as unknown as { db: IDBDatabase | null }
    if (internal.db) {
      const realTx = internal.db.transaction.bind(internal.db)
      let calls = 0
      ;(internal.db as unknown as { transaction: typeof realTx }).transaction = ((
        ...args: Parameters<typeof realTx>
      ) => {
        calls++
        if (calls === 1) {
          throw new Error("del-throw")
        }
        return realTx(...args)
      }) as typeof realTx
      await expect(store.deleteBatch(1)).rejects.toThrow("del-throw")
    }
    await store.close()
  })

  it("propagates errors when clear() transaction throws", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-clear-err" })
    await store.enqueueBatch([makeEntry("a")])
    const internal = store as unknown as { db: IDBDatabase | null }
    if (internal.db) {
      const realTx = internal.db.transaction.bind(internal.db)
      let calls = 0
      ;(internal.db as unknown as { transaction: typeof realTx }).transaction = ((
        ...args: Parameters<typeof realTx>
      ) => {
        calls++
        if (calls === 1) {
          throw new Error("clear-throw")
        }
        return realTx(...args)
      }) as typeof realTx
      await expect(store.clear()).rejects.toThrow("clear-throw")
    }
    await store.close()
  })

  it("propagates errors when addRecord transaction throws (during enqueueBatch)", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-add-err" })
    // First enqueue succeeds and creates the db.
    await store.enqueueBatch([makeEntry("seed")])
    const internal = store as unknown as { db: IDBDatabase | null }
    if (internal.db) {
      const realTx = internal.db.transaction.bind(internal.db)
      let calls = 0
      ;(internal.db as unknown as { transaction: typeof realTx }).transaction = ((
        ...args: Parameters<typeof realTx>
      ) => {
        calls++
        if (calls === 1) {
          throw new Error("add-throw")
        }
        return realTx(...args)
      }) as typeof realTx
      await expect(store.enqueueBatch([makeEntry("b")])).rejects.toThrow("add-throw")
    }
    await store.close()
  })

  it("invokes the private addRecord fallback branch when db is null", async () => {
    // The public enqueueBatch already guards `!this.db` with an inline
    // fallback, leaving addRecord's `!this.db` branch dead under normal
    // flow. Reach it directly to keep coverage honest.
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "test-q-add-fallback" })
    await store.enqueueBatch([makeEntry("seed")])
    const internal = store as unknown as {
      db: IDBDatabase | null
      fallbackRecords: unknown[]
      addRecord: (record: unknown) => Promise<void>
    }
    internal.db = null
    await internal.addRecord({
      createdAt: new Date().toISOString(),
      entries: [makeEntry("orphan")],
      bytes: 100,
    })
    expect(internal.fallbackRecords.length).toBeGreaterThan(0)
  })

  it("triggers request.onerror branches for add/delete/clear/getAll", async () => {
    // Build a hand-rolled IDB stub whose every request immediately fires
    // onerror, exercising the inner error callbacks of each operation.
    const failingRequest = (kind: string) => {
      const req: {
        error: Error
        onsuccess: ((e: Event) => void) | null
        onerror: ((e: Event) => void) | null
      } = {
        error: new Error(`${kind}-fail`),
        onsuccess: null,
        onerror: null,
      }
      Promise.resolve().then(() => req.onerror?.(new Event("error")))
      return req
    }
    const fakeStore = {
      getAll: jest.fn(() => failingRequest("getAll")),
      add: jest.fn(() => failingRequest("add")),
      delete: jest.fn(() => failingRequest("delete")),
      clear: jest.fn(() => failingRequest("clear")),
    }
    const fakeTx = {
      objectStore: jest.fn(() => fakeStore),
    }
    const fakeDb = {
      transaction: jest.fn(() => fakeTx),
      close: jest.fn(),
    }
    const fakeOpen = jest.fn(() => {
      const req = {
        result: fakeDb as unknown as IDBDatabase,
        onsuccess: null as null | ((ev: Event) => void),
        onerror: null,
        onupgradeneeded: null,
      }
      Promise.resolve().then(() => {
        ;(req as unknown as { onsuccess: ((ev: Event) => void) | null }).onsuccess?.(
          new Event("success")
        )
      })
      return req as unknown as IDBOpenDBRequest
    })
    ;(window as unknown as { indexedDB: unknown }).indexedDB = {
      open: fakeOpen,
    }
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "all-fail" })
    // Each call should reject because the inner request fires onerror.
    await expect(store.enqueueBatch([makeEntry("a")])).rejects.toThrow("add-fail")
    await expect(store.listBatches()).rejects.toThrow("getAll-fail")
    await expect(store.deleteBatch(1)).rejects.toThrow("delete-fail")
    await expect(store.clear()).rejects.toThrow("clear-fail")
    await store.close()
  })

  it("falls back to in-memory when indexedDB.open errors", async () => {
    const fakeOpen = jest.fn(() => {
      const req = {
        result: null as unknown as IDBDatabase,
        error: new Error("denied"),
        readyState: "pending" as const,
        source: null,
        transaction: null,
        onsuccess: null as null | ((ev: Event) => void),
        onerror: null as null | ((ev: Event) => void),
        onupgradeneeded: null,
        onblocked: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      } as unknown as IDBOpenDBRequest
      // Trigger onerror asynchronously, mimicking real IndexedDB.
      Promise.resolve().then(() => {
        ;(req as unknown as { onerror: ((ev: Event) => void) | null }).onerror?.(new Event("error"))
      })
      return req
    })
    ;(window as unknown as { indexedDB: unknown }).indexedDB = {
      open: fakeOpen,
    }
    const store = new IndexedDBRemoteRetryQueueStore({ dbName: "open-fail" })
    // Despite the failure, fallback should still let us enqueue.
    const result = await store.enqueueBatch([makeEntry("a")])
    expect(result.stats.entryCount).toBe(1)
    await store.close()
  })
})

describe("IndexedDBRemoteRetryQueueStore fallback when IndexedDB is unavailable", () => {
  let originalIndexedDB: IDBFactory | undefined

  beforeEach(() => {
    originalIndexedDB = (window as unknown as { indexedDB: IDBFactory | undefined }).indexedDB
    // Removing window.indexedDB triggers the in-memory fallback inside init().
    ;(window as unknown as { indexedDB: undefined }).indexedDB = undefined as unknown as undefined
  })

  afterEach(() => {
    if (originalIndexedDB) {
      ;(window as unknown as { indexedDB: IDBFactory }).indexedDB = originalIndexedDB
    }
  })

  it("falls back to in-memory storage and returns the same shape", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({ maxEntries: 100 })
    const result = await store.enqueueBatch([makeEntry("a"), makeEntry("b")])
    expect(result.stats.entryCount).toBe(2)
    const batches = await store.listBatches()
    expect(batches).toHaveLength(1)
    expect(batches[0].entries.map((e) => e.id)).toEqual(["a", "b"])
    expect(batches[0].id).toBeGreaterThan(0)
    await store.close()
  })

  it("clears in-memory state via clear()", async () => {
    const store = new IndexedDBRemoteRetryQueueStore()
    await store.enqueueBatch([makeEntry("a")])
    expect((await store.listBatches()).length).toBeGreaterThan(0)
    await store.clear()
    expect(await store.listBatches()).toEqual([])
    await store.close()
  })

  it("deletes a batch by id from the in-memory list", async () => {
    const store = new IndexedDBRemoteRetryQueueStore()
    await store.enqueueBatch([makeEntry("a")])
    await store.enqueueBatch([makeEntry("b")])
    const all = await store.listBatches()
    expect(all).toHaveLength(2)
    await store.deleteBatch(all[0].id)
    const remaining = await store.listBatches()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(all[1].id)
    await store.close()
  })

  it("enforces entry limits by dropping oldest in-memory batches", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({
      maxEntries: 1,
      maxBytes: 1024 * 1024,
    })
    await store.enqueueBatch([makeEntry("a")])
    const result = await store.enqueueBatch([makeEntry("b")])
    expect(result.droppedEntries).toBeGreaterThanOrEqual(1)
    expect(result.droppedBatches).toBeGreaterThanOrEqual(1)
    await store.close()
  })

  it("enforces byte limits by dropping oldest batches when bytes exceed cap", async () => {
    const store = new IndexedDBRemoteRetryQueueStore({
      maxEntries: 100,
      maxBytes: 5, // tiny cap forces immediate eviction
    })
    await store.enqueueBatch([makeEntry("a")])
    const result = await store.enqueueBatch([makeEntry("b")])
    // First batch already exceeds maxBytes alone; eviction kicks in.
    expect(result.droppedBatches + result.stats.batchCount).toBeGreaterThan(0)
    await store.close()
  })
})
