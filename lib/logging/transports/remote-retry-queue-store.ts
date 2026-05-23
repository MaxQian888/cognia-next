import type { StructuredLogEntry } from "@/types/logging"

const DEFAULT_DB_NAME = "cognia-remote-log-queue"
const DEFAULT_DB_VERSION = 1
const DEFAULT_STORE_NAME = "retry-batches"

export interface RemoteRetryQueueLimits {
  maxEntries: number
  maxBytes: number
}

export interface RemoteRetryQueueBatch {
  id: number
  createdAt: string
  entries: StructuredLogEntry[]
  bytes: number
}

export interface RemoteRetryQueueStats {
  batchCount: number
  entryCount: number
  totalBytes: number
}

export interface RemoteRetryQueueEnqueueResult {
  droppedEntries: number
  droppedBatches: number
  stats: RemoteRetryQueueStats
}

export interface RemoteRetryQueueStore {
  enqueueBatch(entries: StructuredLogEntry[]): Promise<RemoteRetryQueueEnqueueResult>
  listBatches(): Promise<RemoteRetryQueueBatch[]>
  deleteBatch(id: number): Promise<void>
  getStats(): Promise<RemoteRetryQueueStats>
  clear(): Promise<void>
  updateLimits(limits: Partial<RemoteRetryQueueLimits>): void
  close(): Promise<void>
}

interface PersistedBatchRecord {
  id?: number
  createdAt: string
  entries: StructuredLogEntry[]
  bytes: number
}

interface IndexedDBRemoteRetryQueueStoreOptions extends Partial<RemoteRetryQueueLimits> {
  dbName?: string
  dbVersion?: number
  storeName?: string
}

const DEFAULT_LIMITS: RemoteRetryQueueLimits = {
  maxEntries: 5_000,
  maxBytes: 10 * 1024 * 1024,
}

export class IndexedDBRemoteRetryQueueStore implements RemoteRetryQueueStore {
  private db: IDBDatabase | null = null
  private readonly dbName: string
  private readonly dbVersion: number
  private readonly storeName: string
  private limits: RemoteRetryQueueLimits
  private readonly initPromise: Promise<void>
  private fallbackRecords: PersistedBatchRecord[] = []
  private fallbackNextId = 1

  constructor(options: IndexedDBRemoteRetryQueueStoreOptions = {}) {
    this.dbName = options.dbName || DEFAULT_DB_NAME
    this.dbVersion = options.dbVersion || DEFAULT_DB_VERSION
    this.storeName = options.storeName || DEFAULT_STORE_NAME
    this.limits = {
      maxEntries: options.maxEntries ?? DEFAULT_LIMITS.maxEntries,
      maxBytes: options.maxBytes ?? DEFAULT_LIMITS.maxBytes,
    }
    this.initPromise = this.init()
  }

  updateLimits(limits: Partial<RemoteRetryQueueLimits>): void {
    this.limits = {
      maxEntries: limits.maxEntries ?? this.limits.maxEntries,
      maxBytes: limits.maxBytes ?? this.limits.maxBytes,
    }
  }

  async enqueueBatch(entries: StructuredLogEntry[]): Promise<RemoteRetryQueueEnqueueResult> {
    await this.initPromise

    if (!entries.length) {
      return {
        droppedEntries: 0,
        droppedBatches: 0,
        stats: await this.getStats(),
      }
    }

    const record: PersistedBatchRecord = {
      createdAt: new Date().toISOString(),
      entries: [...entries],
      bytes: JSON.stringify(entries).length,
    }

    if (this.db) {
      await this.addRecord(record)
    } else {
      record.id = this.fallbackNextId++
      this.fallbackRecords.push(record)
    }

    return this.enforceLimits()
  }

  async listBatches(): Promise<RemoteRetryQueueBatch[]> {
    await this.initPromise

    if (!this.db) {
      return this.fallbackRecords
        .map((record, index) => ({
          id: record.id ?? index + 1,
          createdAt: record.createdAt,
          entries: [...record.entries],
          bytes: record.bytes,
        }))
        .sort((a, b) => a.id - b.id)
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db!.transaction(this.storeName, "readonly")
        const store = tx.objectStore(this.storeName)
        const request = store.getAll()

        request.onsuccess = () => {
          const rows = (request.result as PersistedBatchRecord[])
            .map((row, idx) => ({
              id: row.id ?? idx + 1,
              createdAt: row.createdAt,
              entries: row.entries,
              bytes: row.bytes,
            }))
            .sort((a, b) => a.id - b.id)
          resolve(rows)
        }
        request.onerror = () => reject(request.error)
      } catch (error) {
        reject(error)
      }
    })
  }

  async deleteBatch(id: number): Promise<void> {
    await this.initPromise

    if (!this.db) {
      this.fallbackRecords = this.fallbackRecords.filter((record) => record.id !== id)
      return
    }

    await new Promise<void>((resolve, reject) => {
      try {
        const tx = this.db!.transaction(this.storeName, "readwrite")
        const store = tx.objectStore(this.storeName)
        const req = store.delete(id)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      } catch (error) {
        reject(error)
      }
    })
  }

  async getStats(): Promise<RemoteRetryQueueStats> {
    const batches = await this.listBatches()
    return computeStats(batches)
  }

  async clear(): Promise<void> {
    await this.initPromise

    if (!this.db) {
      this.fallbackRecords = []
      this.fallbackNextId = 1
      return
    }

    await new Promise<void>((resolve, reject) => {
      try {
        const tx = this.db!.transaction(this.storeName, "readwrite")
        const store = tx.objectStore(this.storeName)
        const req = store.clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      } catch (error) {
        reject(error)
      }
    })
  }

  async close(): Promise<void> {
    await this.initPromise
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private async init(): Promise<void> {
    if (typeof window === "undefined" || !window.indexedDB) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion)

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, {
            keyPath: "id",
            autoIncrement: true,
          })
          store.createIndex("createdAt", "createdAt", { unique: false })
        }
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }

      request.onerror = () => {
        reject(request.error)
      }
    }).catch(() => {
      this.db = null
    })
  }

  private async addRecord(record: PersistedBatchRecord): Promise<void> {
    if (!this.db) {
      this.fallbackRecords.push(record)
      return
    }

    await new Promise<void>((resolve, reject) => {
      try {
        const tx = this.db!.transaction(this.storeName, "readwrite")
        const store = tx.objectStore(this.storeName)
        const req = store.add(record)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      } catch (error) {
        reject(error)
      }
    })
  }

  private async enforceLimits(): Promise<RemoteRetryQueueEnqueueResult> {
    const batches = await this.listBatches()
    const mutable = [...batches]

    let droppedEntries = 0
    let droppedBatches = 0

    let stats = computeStats(mutable)
    while (
      mutable.length > 0 &&
      (stats.entryCount > this.limits.maxEntries || stats.totalBytes > this.limits.maxBytes)
    ) {
      const oldest = mutable.shift()
      if (!oldest) {
        break
      }

      droppedEntries += oldest.entries.length
      droppedBatches += 1
      await this.deleteBatch(oldest.id)
      stats = computeStats(mutable)
    }

    return {
      droppedEntries,
      droppedBatches,
      stats,
    }
  }
}

function computeStats(batches: RemoteRetryQueueBatch[]): RemoteRetryQueueStats {
  return batches.reduce<RemoteRetryQueueStats>(
    (acc, batch) => {
      acc.batchCount += 1
      acc.entryCount += batch.entries.length
      acc.totalBytes += batch.bytes
      return acc
    },
    {
      batchCount: 0,
      entryCount: 0,
      totalBytes: 0,
    }
  )
}

export function createRemoteRetryQueueStore(
  options?: IndexedDBRemoteRetryQueueStoreOptions
): RemoteRetryQueueStore {
  return new IndexedDBRemoteRetryQueueStore(options)
}
