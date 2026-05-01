/**
 * RAG Query Cache
 *
 * LRU cache for query results with TTL support.
 * Improves performance by caching frequently asked questions.
 *
 * Features:
 * - LRU (Least Recently Used) eviction
 * - TTL (Time To Live) expiration
 * - Collection-level invalidation
 * - IndexedDB persistence (optional)
 * - Cache hit/miss statistics
 */

import type { RAGPipelineContext } from "./rag-pipeline"
import { loggers } from "@/lib/logger"

const log = loggers.ai

export interface RAGCacheConfig {
  maxSize: number
  ttl: number // TTL in milliseconds
  enabled: boolean
  persistToIndexedDB?: boolean
  dbName?: string
  storeName?: string
}

export interface CacheEntry<T> {
  key: string
  value: T
  timestamp: number
  expiresAt: number
  collectionName: string
  accessCount: number
}

export interface CacheStats {
  hits: number
  misses: number
  size: number
  maxSize: number
  hitRate: number
  evictions: number
}

const DEFAULT_CONFIG: RAGCacheConfig = {
  maxSize: 100,
  ttl: 5 * 60 * 1000, // 5 minutes
  enabled: true,
  persistToIndexedDB: false,
  dbName: "cognia-rag-cache",
  storeName: "query-cache",
}

/**
 * LRU Cache implementation with TTL support
 */
export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map()
  private maxSize: number
  private ttl: number
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  }

  constructor(maxSize: number = 100, ttl: number = 5 * 60 * 1000) {
    this.maxSize = maxSize
    this.ttl = ttl
  }

  /**
   * Generate cache key from query and collection
   */
  static generateKey(query: string, collectionName: string): string {
    const normalizedQuery = query.toLowerCase().trim()
    return `${collectionName}:${normalizedQuery}`
  }

  /**
   * Get an item from cache
   */
  get(key: string): T | null {
    const entry = this.cache.get(key)

    if (!entry) {
      this.stats.misses++
      return null
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      this.stats.misses++
      return null
    }

    // Update access count and move to end (most recently used)
    entry.accessCount++
    this.cache.delete(key)
    this.cache.set(key, entry)

    this.stats.hits++
    return entry.value
  }

  /**
   * Set an item in cache
   */
  set(key: string, value: T, collectionName: string, customTtl?: number): void {
    // Remove if already exists
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // Evict oldest if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) {
        this.cache.delete(oldestKey)
        this.stats.evictions++
      }
    }

    const now = Date.now()
    const entry: CacheEntry<T> = {
      key,
      value,
      timestamp: now,
      expiresAt: now + (customTtl ?? this.ttl),
      collectionName,
      accessCount: 1,
    }

    this.cache.set(key, entry)
  }

  /**
   * Delete a specific key
   */
  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  /**
   * Invalidate all entries for a collection
   */
  invalidateCollection(collectionName: string): number {
    let count = 0
    for (const [key, entry] of this.cache.entries()) {
      if (entry.collectionName === collectionName) {
        this.cache.delete(key)
        count++
      }
    }
    return count
  }

  /**
   * Clear all expired entries
   */
  clearExpired(): number {
    const now = Date.now()
    let count = 0
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        count++
      }
    }
    return count
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear()
    this.stats = { hits: 0, misses: 0, evictions: 0 }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      evictions: this.stats.evictions,
    }
  }

  /**
   * Get all entries (for persistence)
   */
  entries(): CacheEntry<T>[] {
    return Array.from(this.cache.values())
  }

  /**
   * Load entries (from persistence)
   */
  load(entries: CacheEntry<T>[]): void {
    const now = Date.now()
    for (const entry of entries) {
      // Skip expired entries
      if (now > entry.expiresAt) continue
      // Skip if over capacity
      if (this.cache.size >= this.maxSize) break
      this.cache.set(entry.key, entry)
    }
  }

  /**
   * Get current size
   */
  size(): number {
    return this.cache.size
  }

  /**
   * Check if key exists and is valid
   */
  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return false
    }
    return true
  }
}

/**
 * RAG Query Cache with persistence support
 */
export class RAGQueryCache {
  private cache: LRUCache<RAGPipelineContext>
  private config: RAGCacheConfig
  private db: IDBDatabase | null = null
  private initialized = false

  constructor(config: Partial<RAGCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.cache = new LRUCache<RAGPipelineContext>(this.config.maxSize, this.config.ttl)
  }

  /**
   * Initialize the cache (including IndexedDB if enabled)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    if (this.config.persistToIndexedDB && typeof indexedDB !== "undefined") {
      try {
        this.db = await this.openDatabase()
        await this.loadFromIndexedDB()
      } catch (error) {
        log.warn("Failed to initialize IndexedDB for RAG cache", { error: String(error) })
      }
    }

    this.initialized = true
  }

  /**
   * Open IndexedDB database
   */
  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.config.dbName!, 1)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(this.config.storeName!)) {
          db.createObjectStore(this.config.storeName!, { keyPath: "key" })
        }
      }
    })
  }

  /**
   * Load cache from IndexedDB
   */
  private async loadFromIndexedDB(): Promise<void> {
    if (!this.db) return

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.storeName!, "readonly")
      const store = transaction.objectStore(this.config.storeName!)
      const request = store.getAll()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const entries = request.result as CacheEntry<RAGPipelineContext>[]
        this.cache.load(entries)
        resolve()
      }
    })
  }

  /**
   * Save cache to IndexedDB
   */
  private async saveToIndexedDB(): Promise<void> {
    if (!this.db) return

    const entries = this.cache.entries()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.storeName!, "readwrite")
      const store = transaction.objectStore(this.config.storeName!)

      // Clear existing entries
      store.clear()

      // Add all current entries
      for (const entry of entries) {
        store.put(entry)
      }

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  }

  /**
   * Get cached result for a query (auto-initializes if needed)
   */
  async get(query: string, collectionName: string): Promise<RAGPipelineContext | null> {
    if (!this.config.enabled) return null
    if (!this.initialized) await this.initialize()

    const key = LRUCache.generateKey(query, collectionName)
    return this.cache.get(key)
  }

  /**
   * Cache a query result (auto-initializes if needed)
   */
  async set(query: string, collectionName: string, result: RAGPipelineContext): Promise<void> {
    if (!this.config.enabled) return
    if (!this.initialized) await this.initialize()

    const key = LRUCache.generateKey(query, collectionName)
    this.cache.set(key, result, collectionName)

    // Persist to IndexedDB in background
    if (this.config.persistToIndexedDB && this.db) {
      this.saveToIndexedDB().catch((e) =>
        log.warn("Failed to save to IndexedDB", { error: String(e) })
      )
    }
  }

  /**
   * Invalidate cache for a collection (call when documents are updated)
   */
  invalidateCollection(collectionName: string): number {
    const count = this.cache.invalidateCollection(collectionName)

    if (this.config.persistToIndexedDB && this.db && count > 0) {
      this.saveToIndexedDB().catch((e) => log.warn("Failed to save to IndexedDB", { error: e }))
    }

    return count
  }

  /**
   * Invalidate a specific query
   */
  invalidateQuery(query: string, collectionName: string): boolean {
    const key = LRUCache.generateKey(query, collectionName)
    const deleted = this.cache.delete(key)

    if (this.config.persistToIndexedDB && this.db && deleted) {
      this.saveToIndexedDB().catch((e) => log.warn("Failed to save to IndexedDB", { error: e }))
    }

    return deleted
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    this.cache.clear()

    if (this.db) {
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = this.db!.transaction(this.config.storeName!, "readwrite")
          const store = transaction.objectStore(this.config.storeName!)
          store.clear()
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
        })
      } catch (error) {
        log.warn("Failed to clear IndexedDB cache", { error: String(error) })
      }
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return this.cache.getStats()
  }

  /**
   * Enable or disable caching
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
  }

  /**
   * Check if caching is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled
  }

  /**
   * Update TTL
   */
  setTTL(ttl: number): void {
    this.config.ttl = ttl
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const count = this.cache.clearExpired()

    if (this.config.persistToIndexedDB && this.db && count > 0) {
      this.saveToIndexedDB().catch((e) => log.warn("Failed to save to IndexedDB", { error: e }))
    }

    return count
  }
}

/**
 * Create a RAG query cache instance
 */
export function createRAGQueryCache(config: Partial<RAGCacheConfig> = {}): RAGQueryCache {
  return new RAGQueryCache(config)
}

/**
 * Create a preconfigured cache for high-performance scenarios
 */
export function createHighPerformanceCache(): RAGQueryCache {
  return new RAGQueryCache({
    maxSize: 500,
    ttl: 15 * 60 * 1000, // 15 minutes
    enabled: true,
    persistToIndexedDB: true,
  })
}

/**
 * Create a lightweight cache for memory-constrained scenarios
 */
export function createLightweightCache(): RAGQueryCache {
  return new RAGQueryCache({
    maxSize: 50,
    ttl: 2 * 60 * 1000, // 2 minutes
    enabled: true,
    persistToIndexedDB: false,
  })
}
