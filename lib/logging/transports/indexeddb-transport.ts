/**
 * IndexedDB Transport
 * Persists logs to IndexedDB with async batching and automatic cleanup
 */

import type { StructuredLogEntry, Transport, LogFilter, LogStats, LogLevel } from "@/types/logging"
import { LEVEL_PRIORITY } from "@/types/logging"

const DB_NAME = "cognia-logs"
const DB_VERSION = 1
const STORE_NAME = "logs"
const BROADCAST_CHANNEL_NAME = "cognia-logs-updates"
const consoleApi = globalThis.console

/**
 * IndexedDB transport options
 */
export interface IndexedDBTransportOptions {
  /** Maximum entries to store */
  maxEntries?: number
  /** Buffer size before flush */
  bufferSize?: number
  /** Flush interval in milliseconds */
  flushInterval?: number
  /** Days to keep logs */
  retentionDays?: number
}

const DEFAULT_OPTIONS: IndexedDBTransportOptions = {
  maxEntries: 10000,
  bufferSize: 50,
  flushInterval: 1000,
  retentionDays: 7,
}

/**
 * IndexedDB transport implementation
 */
export class IndexedDBTransport implements Transport {
  name = "indexeddb"
  private options: IndexedDBTransportOptions
  private db: IDBDatabase | null = null
  private buffer: StructuredLogEntry[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private initPromise: Promise<void> | null = null
  private broadcastChannel: BroadcastChannel | null = null

  constructor(options?: IndexedDBTransportOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.initPromise = this.init()
    if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
      try {
        this.broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
      } catch {
        // BroadcastChannel not supported
      }
    }
  }

  /**
   * Initialize IndexedDB
   */
  private async init(): Promise<void> {
    if (typeof window === "undefined" || !window.indexedDB) {
      return
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        consoleApi.error("Failed to open log database:", request.error)
        reject(request.error)
      }

      request.onsuccess = () => {
        this.db = request.result
        this.startFlushTimer()
        this.cleanup()
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" })
          store.createIndex("timestamp", "timestamp", { unique: false })
          store.createIndex("level", "level", { unique: false })
          store.createIndex("module", "module", { unique: false })
          store.createIndex("traceId", "traceId", { unique: false })
        }
      }
    })
  }

  /**
   * Start flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }
    this.flushTimer = setInterval(() => {
      this.flush()
    }, this.options.flushInterval)
  }

  /**
   * Update transport options (e.g. retention settings) at runtime
   */
  updateOptions(options: Partial<IndexedDBTransportOptions>): void {
    this.options = { ...this.options, ...options }
    if (options.flushInterval) {
      this.startFlushTimer()
    }
    if (options.retentionDays || options.maxEntries) {
      this.cleanup()
    }
  }

  /**
   * Log entry to buffer
   */
  log(entry: StructuredLogEntry): void {
    this.buffer.push(entry)

    if (this.buffer.length >= (this.options.bufferSize || 50)) {
      this.flush()
    }
  }

  /**
   * Flush buffer to IndexedDB
   */
  async flush(): Promise<void> {
    if (!this.db || this.buffer.length === 0) {
      return
    }

    const entries = [...this.buffer]
    this.buffer = []

    try {
      const transaction = this.db.transaction(STORE_NAME, "readwrite")
      const store = transaction.objectStore(STORE_NAME)

      for (const entry of entries) {
        store.add(entry)
      }

      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })

      // Notify listeners about new logs
      if (this.broadcastChannel) {
        try {
          this.broadcastChannel.postMessage({ type: "logs-flushed", count: entries.length })
        } catch {
          // Ignore broadcast errors
        }
      }
    } catch (error) {
      consoleApi.error("Failed to flush logs:", error)
      // Re-add to buffer on failure
      this.buffer.unshift(...entries)
    }
  }

  /**
   * Cleanup old entries
   */
  private async cleanup(): Promise<void> {
    if (!this.db) return

    const cutoff = Date.now() - (this.options.retentionDays || 7) * 24 * 60 * 60 * 1000
    const cutoffDate = new Date(cutoff).toISOString()

    try {
      const transaction = this.db.transaction(STORE_NAME, "readwrite")
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index("timestamp")
      const range = IDBKeyRange.upperBound(cutoffDate)

      const request = index.openCursor(range)
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        }
      }

      // Also enforce max entries
      const countRequest = store.count()
      countRequest.onsuccess = () => {
        const count = countRequest.result
        const maxEntries = this.options.maxEntries || 10000

        if (count > maxEntries) {
          const deleteCount = count - maxEntries
          const oldestRequest = index.openCursor()
          let deleted = 0

          oldestRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest).result
            if (cursor && deleted < deleteCount) {
              cursor.delete()
              deleted++
              cursor.continue()
            }
          }
        }
      }
    } catch (error) {
      consoleApi.error("Failed to cleanup logs:", error)
    }
  }

  /**
   * Get logs with filtering
   */
  async getLogs(filter?: LogFilter): Promise<StructuredLogEntry[]> {
    await this.initPromise
    if (!this.db) return []

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(STORE_NAME, "readonly")
        const store = transaction.objectStore(STORE_NAME)
        const logs: StructuredLogEntry[] = []

        // Use index-based range query when time filters are provided
        const timestampIndex = store.index("timestamp")
        let range: IDBKeyRange | null = null

        if (filter?.since && filter?.until) {
          range = IDBKeyRange.bound(filter.since.toISOString(), filter.until.toISOString())
        } else if (filter?.since) {
          range = IDBKeyRange.lowerBound(filter.since.toISOString())
        } else if (filter?.until) {
          range = IDBKeyRange.upperBound(filter.until.toISOString())
        }

        const request = timestampIndex.openCursor(range, "prev")

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result
          if (cursor) {
            const entry = cursor.value as StructuredLogEntry

            // Apply remaining filters (level, module, traceId, search, tags)
            if (this.matchesFilter(entry, filter)) {
              logs.push(entry)
            }

            // Check limit
            if (filter?.limit && logs.length >= filter.limit) {
              resolve(logs)
              return
            }

            cursor.continue()
          } else {
            resolve(logs)
          }
        }

        request.onerror = () => reject(request.error)
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Check if entry matches filter
   */
  private matchesFilter(entry: StructuredLogEntry, filter?: LogFilter): boolean {
    if (!filter) return true

    if (filter.level && LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[filter.level]) {
      return false
    }

    if (filter.module && entry.module !== filter.module) {
      return false
    }

    if (filter.traceId && entry.traceId !== filter.traceId) {
      return false
    }

    if (filter.since && new Date(entry.timestamp) < filter.since) {
      return false
    }

    if (filter.until && new Date(entry.timestamp) > filter.until) {
      return false
    }

    if (filter.search) {
      const searchLower = filter.search.toLowerCase()
      if (!entry.message.toLowerCase().includes(searchLower)) {
        return false
      }
    }

    if (filter.tags && filter.tags.length > 0) {
      if (!entry.tags || !filter.tags.some((tag) => entry.tags!.includes(tag))) {
        return false
      }
    }

    return true
  }

  /**
   * Get log statistics
   */
  async getStats(): Promise<LogStats> {
    await this.initPromise
    if (!this.db) {
      return { total: 0, byLevel: {} as Record<LogLevel, number>, byModule: {} }
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(STORE_NAME, "readonly")
        const store = transaction.objectStore(STORE_NAME)

        const stats: LogStats = {
          total: 0,
          byLevel: {} as Record<LogLevel, number>,
          byModule: {},
        }

        const request = store.openCursor()

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result
          if (cursor) {
            const entry = cursor.value as StructuredLogEntry
            stats.total++

            stats.byLevel[entry.level] = (stats.byLevel[entry.level] || 0) + 1
            stats.byModule[entry.module] = (stats.byModule[entry.module] || 0) + 1

            const entryDate = new Date(entry.timestamp)
            if (!stats.oldestEntry || entryDate < stats.oldestEntry) {
              stats.oldestEntry = entryDate
            }
            if (!stats.newestEntry || entryDate > stats.newestEntry) {
              stats.newestEntry = entryDate
            }

            cursor.continue()
          } else {
            resolve(stats)
          }
        }

        request.onerror = () => reject(request.error)
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Clear all logs
   */
  async clear(): Promise<void> {
    await this.initPromise
    if (!this.db) return

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(STORE_NAME, "readwrite")
        const store = transaction.objectStore(STORE_NAME)
        const request = store.clear()

        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      } catch (error) {
        reject(error)
      }
    })
  }

  async deleteEntries(ids: string[]): Promise<void> {
    await this.initPromise
    if (!this.db || ids.length === 0) return

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(STORE_NAME, "readwrite")
        const store = transaction.objectStore(STORE_NAME)

        for (const id of ids) {
          store.delete(id)
        }

        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Export logs as JSON
   */
  async export(filter?: LogFilter): Promise<string> {
    const logs = await this.getLogs(filter)
    return JSON.stringify(logs, null, 2)
  }

  /**
   * Close transport
   */
  async close(): Promise<void> {
    await this.flush()

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.close()
      this.broadcastChannel = null
    }

    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  /**
   * Subscribe to log update notifications via BroadcastChannel.
   * Returns an unsubscribe function.
   */
  static onLogsUpdated(callback: (count: number) => void): () => void {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return () => {}
    }
    try {
      const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
      const handler = (event: MessageEvent) => {
        if (event.data?.type === "logs-flushed") {
          callback(event.data.count)
        }
      }
      channel.addEventListener("message", handler)
      return () => {
        channel.removeEventListener("message", handler)
        channel.close()
      }
    } catch {
      return () => {}
    }
  }
}

/**
 * Create IndexedDB transport
 */
export function createIndexedDBTransport(options?: IndexedDBTransportOptions): IndexedDBTransport {
  return new IndexedDBTransport(options)
}
