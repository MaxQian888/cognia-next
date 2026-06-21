/**
 * Embedding Cache — LRU Cache for Embedding Vectors
 *
 * Caches embedding vectors keyed by content hash to avoid
 * redundant API calls for identical or repeated text.
 *
 * Features:
 * - LRU eviction with configurable max entries
 * - Content-hash based keying (FNV-1a)
 * - Memory-efficient: only stores hash → vector mapping
 * - Stats tracking (hits, misses, evictions)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingCacheConfig {
  /** Maximum number of cached embeddings */
  maxEntries: number
  /** Whether the cache is enabled */
  enabled: boolean
}

export interface EmbeddingCacheStats {
  hits: number
  misses: number
  evictions: number
  size: number
  maxEntries: number
  hitRate: number
}

const DEFAULT_CONFIG: EmbeddingCacheConfig = {
  maxEntries: 5000,
  enabled: true,
}

// ---------------------------------------------------------------------------
// Hash Function
// ---------------------------------------------------------------------------

/**
 * FNV-1a hash for content-based cache keying.
 */
function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(36)
}

// ---------------------------------------------------------------------------
// EmbeddingCache Class
// ---------------------------------------------------------------------------

/**
 * LRU cache for embedding vectors.
 * Key: content hash, Value: embedding vector.
 */
export class EmbeddingCache {
  private cache: Map<string, number[]> = new Map()
  private config: EmbeddingCacheConfig
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  }

  constructor(config: Partial<EmbeddingCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Get a cached embedding for the given text.
   * Returns null if not found or cache is disabled.
   */
  get(text: string): number[] | null {
    if (!this.config.enabled) return null

    const key = fnv1aHash(text)
    const cached = this.cache.get(key)

    if (!cached) {
      this.stats.misses++
      return null
    }

    // Move to end (most recently used) for LRU
    this.cache.delete(key)
    this.cache.set(key, cached)

    this.stats.hits++
    return cached
  }

  /**
   * Cache an embedding for the given text.
   */
  set(text: string, embedding: number[]): void {
    if (!this.config.enabled) return

    const key = fnv1aHash(text)

    // Remove if already exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // Evict oldest if at capacity
    while (this.cache.size >= this.config.maxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) {
        this.cache.delete(oldestKey)
        this.stats.evictions++
      }
    }

    this.cache.set(key, embedding)
  }

  /**
   * Check if an embedding is cached for the given text.
   */
  has(text: string): boolean {
    if (!this.config.enabled) return false
    return this.cache.has(fnv1aHash(text))
  }

  /**
   * Remove a cached embedding.
   */
  delete(text: string): boolean {
    return this.cache.delete(fnv1aHash(text))
  }

  /**
   * Clear all cached embeddings.
   */
  clear(): void {
    this.cache.clear()
    this.stats = { hits: 0, misses: 0, evictions: 0 }
  }

  /**
   * Get cache statistics.
   */
  getStats(): EmbeddingCacheStats {
    const total = this.stats.hits + this.stats.misses
    return {
      ...this.stats,
      size: this.cache.size,
      maxEntries: this.config.maxEntries,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    }
  }

  /**
   * Get current cache size.
   */
  size(): number {
    return this.cache.size
  }

  /**
   * Enable or disable the cache.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
  }

  /**
   * Check if the cache is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled
  }
}

/**
 * Create an embedding cache instance.
 */
export function createEmbeddingCache(config: Partial<EmbeddingCacheConfig> = {}): EmbeddingCache {
  return new EmbeddingCache(config)
}

// ---------------------------------------------------------------------------
// Global Singleton
// ---------------------------------------------------------------------------

let globalEmbeddingCache: EmbeddingCache | null = null

/**
 * Get or create the global embedding cache singleton.
 */
export function getGlobalEmbeddingCache(): EmbeddingCache {
  if (!globalEmbeddingCache) {
    globalEmbeddingCache = new EmbeddingCache()
  }
  return globalEmbeddingCache
}

/**
 * Reset the global embedding cache.
 */
export function resetGlobalEmbeddingCache(): void {
  globalEmbeddingCache?.clear()
  globalEmbeddingCache = null
}
