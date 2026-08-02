import type { ObservabilityEventV1 } from "../observability-event"
import {
  MemoryObservabilitySpoolStore,
  type ObservabilitySpoolEnqueueResult,
  type ObservabilitySpoolLimits,
  type ObservabilitySpoolRecord,
  type ObservabilitySpoolStats,
  type ObservabilitySpoolStore,
} from "../spool"
import { LEVEL_PRIORITY } from "../types"

const DEFAULT_DB_NAME = "cognia-observability-spool-v1"
const DB_VERSION = 1
const RECORDS_STORE = "records"
const META_STORE = "meta"
const META_ID = "state"

interface StoredSpoolRecord extends ObservabilitySpoolRecord {
  priority: number
}

interface StoredSpoolMeta extends ObservabilitySpoolStats {
  id: typeof META_ID
}

export interface IndexedDBObservabilitySpoolStoreOptions {
  dbName?: string
}

function initialMeta(): StoredSpoolMeta {
  return {
    id: META_ID,
    eventCount: 0,
    totalBytes: 0,
    lastSequence: 0,
    flushWatermark: 0,
    droppedLowSeverityEvents: 0,
    rejectedProtectedEvents: 0,
  }
}

function stats(meta: StoredSpoolMeta): ObservabilitySpoolStats {
  const { id: _id, ...snapshot } = meta
  return { ...snapshot }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
  })
}

function cloneEvent(event: ObservabilityEventV1): ObservabilityEventV1 {
  return JSON.parse(JSON.stringify(event)) as ObservabilityEventV1
}

function eventBytes(event: ObservabilityEventV1): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength
}

function isProtected(event: ObservabilityEventV1): boolean {
  return LEVEL_PRIORITY[event.severity] >= LEVEL_PRIORITY.warn
}

function publicRecord(record: StoredSpoolRecord): ObservabilitySpoolRecord {
  return {
    sequence: record.sequence,
    bytes: record.bytes,
    event: cloneEvent(record.event),
  }
}

export class IndexedDBObservabilitySpoolStore implements ObservabilitySpoolStore {
  private readonly dbName: string
  private readonly fallback = new MemoryObservabilitySpoolStore()
  private db: IDBDatabase | null = null
  private readonly initPromise: Promise<void>
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(options: IndexedDBObservabilitySpoolStoreOptions = {}) {
    this.dbName = options.dbName ?? DEFAULT_DB_NAME
    this.initPromise = this.init()
  }

  private async init(): Promise<void> {
    if (typeof indexedDB === "undefined") return

    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.dbName, DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(RECORDS_STORE)) {
            const records = db.createObjectStore(RECORDS_STORE, { keyPath: "sequence" })
            records.createIndex("prioritySequence", ["priority", "sequence"], {
              unique: false,
            })
          }
          if (!db.objectStoreNames.contains(META_STORE)) {
            const meta = db.createObjectStore(META_STORE, { keyPath: "id" })
            meta.put(initialMeta())
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error("Unable to open spool database"))
      })
    } catch {
      this.db = null
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async evictLowSeverity(
    store: IDBObjectStore,
    meta: StoredSpoolMeta,
    incomingBytes: number,
    limits: ObservabilitySpoolLimits
  ): Promise<ObservabilitySpoolRecord[]> {
    const evicted: ObservabilitySpoolRecord[] = []
    const index = store.index("prioritySequence")
    const range = IDBKeyRange.bound([0, 0], [LEVEL_PRIORITY.info, Number.MAX_SAFE_INTEGER])

    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor(range, "next")
      request.onerror = () => reject(request.error ?? new Error("Unable to scan spool capacity"))
      request.onsuccess = () => {
        const fits =
          meta.eventCount + 1 <= limits.maxEvents &&
          meta.totalBytes + incomingBytes <= limits.maxBytes
        const cursor = request.result
        if (fits || !cursor) {
          resolve()
          return
        }

        const record = cursor.value as StoredSpoolRecord
        cursor.delete()
        meta.eventCount -= 1
        meta.totalBytes -= record.bytes
        meta.droppedLowSeverityEvents += 1
        evicted.push(publicRecord(record))
        cursor.continue()
      }
    })

    return evicted
  }

  async enqueue(
    sourceEvent: ObservabilityEventV1,
    limits: ObservabilitySpoolLimits
  ): Promise<ObservabilitySpoolEnqueueResult> {
    await this.initPromise
    if (!this.db) return this.fallback.enqueue(sourceEvent, limits)

    return this.exclusive(async () => {
      const transaction = this.db!.transaction([RECORDS_STORE, META_STORE], "readwrite")
      const completion = transactionCompletion(transaction)
      const records = transaction.objectStore(RECORDS_STORE)
      const metaStore = transaction.objectStore(META_STORE)
      const meta =
        (await requestResult(metaStore.get(META_ID) as IDBRequest<StoredSpoolMeta | undefined>)) ??
        initialMeta()
      const sequence = meta.lastSequence + 1
      const event = cloneEvent({
        ...sourceEvent,
        delivery: { spoolSequence: sequence, flushWatermark: meta.flushWatermark },
      })
      const bytes = eventBytes(event)

      if (bytes > limits.maxBytes || limits.maxEvents < 1) {
        if (isProtected(event)) meta.rejectedProtectedEvents += 1
        metaStore.put(meta)
        await completion
        return {
          status: "capacity-exhausted",
          reason: "event-too-large",
          evicted: [],
          stats: stats(meta),
        }
      }

      const evicted = await this.evictLowSeverity(records, meta, bytes, limits)
      const fits =
        meta.eventCount + 1 <= limits.maxEvents && meta.totalBytes + bytes <= limits.maxBytes
      if (!fits) {
        if (isProtected(event)) meta.rejectedProtectedEvents += 1
        else meta.droppedLowSeverityEvents += 1
        metaStore.put(meta)
        await completion
        return {
          status: "capacity-exhausted",
          reason: isProtected(event) ? "protected-severity-capacity" : "low-severity-capacity",
          evicted,
          stats: stats(meta),
        }
      }

      const record: StoredSpoolRecord = {
        sequence,
        bytes,
        event,
        priority: LEVEL_PRIORITY[event.severity],
      }
      records.add(record)
      meta.eventCount += 1
      meta.totalBytes += bytes
      meta.lastSequence = sequence
      metaStore.put(meta)
      await completion
      return {
        status: "stored",
        record: publicRecord(record),
        evicted,
        stats: stats(meta),
      }
    })
  }

  async list(options: {
    afterSequence?: number
    limit: number
  }): Promise<ObservabilitySpoolRecord[]> {
    await this.initPromise
    if (!this.db) return this.fallback.list(options)
    await this.mutationTail

    const transaction = this.db.transaction(RECORDS_STORE, "readonly")
    const completion = transactionCompletion(transaction)
    const store = transaction.objectStore(RECORDS_STORE)
    const range = IDBKeyRange.lowerBound((options.afterSequence ?? 0) + 1)
    const records = await new Promise<ObservabilitySpoolRecord[]>((resolve, reject) => {
      const found: ObservabilitySpoolRecord[] = []
      const request = store.openCursor(range, "next")
      request.onerror = () => reject(request.error ?? new Error("Unable to list spool records"))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || found.length >= Math.max(0, options.limit)) {
          resolve(found)
          return
        }
        found.push(publicRecord(cursor.value as StoredSpoolRecord))
        cursor.continue()
      }
    })
    await completion
    return records
  }

  async ackThrough(sequence: number): Promise<ObservabilitySpoolStats> {
    await this.initPromise
    if (!this.db) return this.fallback.ackThrough(sequence)

    return this.exclusive(async () => {
      const transaction = this.db!.transaction([RECORDS_STORE, META_STORE], "readwrite")
      const completion = transactionCompletion(transaction)
      const records = transaction.objectStore(RECORDS_STORE)
      const metaStore = transaction.objectStore(META_STORE)
      const meta =
        (await requestResult(metaStore.get(META_ID) as IDBRequest<StoredSpoolMeta | undefined>)) ??
        initialMeta()
      let removedCount = 0
      let removedBytes = 0

      await new Promise<void>((resolve, reject) => {
        const request = records.openCursor(IDBKeyRange.upperBound(sequence), "next")
        request.onerror = () => reject(request.error ?? new Error("Unable to acknowledge spool"))
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) {
            resolve()
            return
          }
          const record = cursor.value as StoredSpoolRecord
          removedCount += 1
          removedBytes += record.bytes
          cursor.delete()
          cursor.continue()
        }
      })

      meta.eventCount = Math.max(0, meta.eventCount - removedCount)
      meta.totalBytes = Math.max(0, meta.totalBytes - removedBytes)
      meta.flushWatermark = Math.max(meta.flushWatermark, sequence)
      metaStore.put(meta)
      await completion
      return stats(meta)
    })
  }

  async getStats(): Promise<ObservabilitySpoolStats> {
    await this.initPromise
    if (!this.db) return this.fallback.getStats()
    await this.mutationTail
    const transaction = this.db.transaction(META_STORE, "readonly")
    const completion = transactionCompletion(transaction)
    const meta =
      (await requestResult(
        transaction.objectStore(META_STORE).get(META_ID) as IDBRequest<StoredSpoolMeta | undefined>
      )) ?? initialMeta()
    await completion
    return stats(meta)
  }

  async clear(): Promise<void> {
    await this.initPromise
    if (!this.db) return this.fallback.clear()
    await this.exclusive(async () => {
      const transaction = this.db!.transaction([RECORDS_STORE, META_STORE], "readwrite")
      const completion = transactionCompletion(transaction)
      transaction.objectStore(RECORDS_STORE).clear()
      transaction.objectStore(META_STORE).put(initialMeta())
      await completion
    })
  }

  async close(): Promise<void> {
    await this.initPromise
    await this.mutationTail
    this.db?.close()
    this.db = null
  }
}
