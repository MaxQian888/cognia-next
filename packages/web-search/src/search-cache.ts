/**
 * Search Result Cache
 * LRU cache for search results with TTL support
 */

import type { SearchResponse, SearchOptions, SearchProviderType } from "./types"
import { log } from "./log"

export interface SearchCacheOptions {
  maxSize?: number
  defaultTTL?: number
  newsTTL?: number
}

export interface CacheEntry {
  response: SearchResponse
  /** Provider that produced the cached response, independent of the hashed request key. */
  provider: SearchProviderType
  timestamp: number
  ttl: number
}

/** Search policy fields that affect cache identity but are not provider request options. */
export interface SearchCacheKeyOptions extends SearchOptions {
  preferredProviders?: SearchProviderType[]
}

export interface CacheStats {
  size: number
  maxSize: number
  hits: number
  misses: number
  hitRate: number
}

/**
 * Generate a cache key from search parameters
 */
export function generateSearchCacheKey(
  query: string,
  provider?: SearchProviderType,
  options?: SearchCacheKeyOptions
): string {
  const includeRawContent =
    options?.includeRawContent === true ? "text" : options?.includeRawContent

  const keyParts = [
    query.toLowerCase().trim(),
    provider || "auto",
    options?.maxResults?.toString() || "10",
    options?.searchType || "general",
    options?.searchDepth || "basic",
    options?.recency || "any",
    options?.includeAnswer === true ? "1" : "0",
    includeRawContent ? String(includeRawContent) : "",
    options?.language || "en",
    options?.country || "",
    options?.includeDomains ? [...options.includeDomains].sort().join(",") : "",
    options?.excludeDomains ? [...options.excludeDomains].sort().join(",") : "",
    options?.safeSearch || "moderate",
    options?.preferredProviders?.join(",") || "",
  ]

  const keyString = keyParts.join("|")

  let hash = 0
  for (let i = 0; i < keyString.length; i++) {
    const char = keyString.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }

  return `search:${Math.abs(hash).toString(36)}`
}

/**
 * Search Result Cache using LRU eviction
 */
export class SearchCache {
  private cache: Map<string, CacheEntry> = new Map()
  private maxSize: number
  private defaultTTL: number
  private newsTTL: number
  private hits = 0
  private misses = 0

  constructor(options: SearchCacheOptions = {}) {
    this.maxSize = options.maxSize ?? 500
    this.defaultTTL = options.defaultTTL ?? 10 * 60 * 1000 // 10 minutes
    this.newsTTL = options.newsTTL ?? 5 * 60 * 1000 // 5 minutes for news
  }

  get(
    query: string,
    provider?: SearchProviderType,
    options?: SearchCacheKeyOptions
  ): SearchResponse | null {
    const key = generateSearchCacheKey(query, provider, options)
    const entry = this.cache.get(key)

    if (!entry) {
      this.misses++
      return null
    }

    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      this.misses++
      return null
    }

    this.cache.delete(key)
    this.cache.set(key, entry)

    this.hits++
    log.debug(`Cache hit for query: "${query}" (key: ${key})`)

    return entry.response
  }

  set(
    query: string,
    response: SearchResponse,
    provider?: SearchProviderType,
    options?: SearchCacheKeyOptions
  ): void {
    const key = generateSearchCacheKey(query, provider, options)

    const ttl = options?.searchType === "news" ? this.newsTTL : this.defaultTTL

    while (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
        log.debug(`Evicted cache entry: ${firstKey}`)
      }
    }

    this.cache.set(key, {
      response,
      provider: response.provider,
      timestamp: Date.now(),
      ttl,
    })

    log.debug(`Cached search response for query: "${query}" (key: ${key}, ttl: ${ttl}ms)`)
  }

  invalidate(pattern?: string): number {
    if (!pattern) {
      const count = this.cache.size
      this.cache.clear()
      log.debug(`Cleared all ${count} cache entries`)
      return count
    }

    let count = 0
    const regex = new RegExp(pattern)

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key)
        count++
      }
    }

    log.debug(`Invalidated ${count} cache entries matching pattern: ${pattern}`)
    return count
  }

  /** Remove every entry produced by a provider without relying on opaque hashed keys. */
  invalidateProvider(provider: SearchProviderType): number {
    let count = 0
    for (const [key, entry] of this.cache.entries()) {
      if (entry.provider === provider) {
        this.cache.delete(key)
        count++
      }
    }
    log.debug(`Invalidated ${count} cache entries for provider: ${provider}`)
    return count
  }

  has(query: string, provider?: SearchProviderType, options?: SearchCacheKeyOptions): boolean {
    const key = generateSearchCacheKey(query, provider, options)
    const entry = this.cache.get(key)

    if (!entry) return false

    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    }
  }

  setConfig(config: { maxSize?: number; defaultTTL?: number }): void {
    if (config.maxSize !== undefined && config.maxSize > 0) {
      this.maxSize = config.maxSize
    }
    if (config.defaultTTL !== undefined && config.defaultTTL > 0) {
      this.defaultTTL = config.defaultTTL
    }
  }

  resetStats(): void {
    this.hits = 0
    this.misses = 0
  }

  clear(): void {
    this.cache.clear()
    log.debug("Search cache cleared")
  }

  cleanup(): number {
    const now = Date.now()
    let count = 0

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
        count++
      }
    }

    if (count > 0) {
      log.debug(`Cleaned up ${count} expired cache entries`)
    }

    return count
  }
}

let globalSearchCache: SearchCache | null = null

export function getSearchCache(options?: SearchCacheOptions): SearchCache {
  if (!globalSearchCache) {
    globalSearchCache = new SearchCache(options)
  }
  return globalSearchCache
}

export function resetSearchCache(): void {
  globalSearchCache?.clear()
  globalSearchCache = null
}
