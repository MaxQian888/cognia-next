/**
 * Web-fetch result cache.
 *
 * A small TTL + LRU store so repeated GETs of the same URL within a short
 * window don't re-bill the model (and don't re-hit the network). Mirrors
 * `lib/search/search-cache.ts` but kept separate because a fetch is keyed by
 * `method+url+format+cap+prompt` (not a search query) and stores the final
 * tool-result object verbatim.
 *
 * The cache is injected into `webFetch` via `deps.cache` rather than read from a
 * module global inside the core, so the pure core stays test-isolated; the
 * renderer/CLI host pass {@link getFetchCache}.
 */

export interface FetchCacheKeyInput {
  url: string
  method?: string
  format?: string
  /** The effective byte/char cap (so a larger re-fetch isn't served a smaller cached body). */
  maxBytes?: number
  /** Query-focused extraction prompt — a different prompt yields a different summary. */
  prompt?: string
  /** Read window start — a different offset returns a different page segment. */
  offset?: number
}

/** Stable cache key for a fetch request. */
export function fetchCacheKey(input: FetchCacheKeyInput): string {
  return [
    (input.method ?? "GET").toUpperCase(),
    input.url.trim(),
    input.format ?? "auto",
    input.maxBytes != null ? String(input.maxBytes) : "",
    input.prompt?.trim() ?? "",
    input.offset != null ? String(input.offset) : "",
  ].join("|")
}

/** Minimal shape `webFetch` depends on — lets tests inject a stub. */
export interface FetchCacheLike {
  get(key: string): unknown | null
  set(key: string, value: unknown): void
}

interface FetchCacheEntry {
  value: unknown
  timestamp: number
}

export interface FetchCacheOptions {
  maxSize?: number
  ttl?: number
  /** Injectable clock for deterministic TTL tests; defaults to `Date.now`. */
  now?: () => number
}

/** TTL + LRU cache for web-fetch results. */
export class FetchCache implements FetchCacheLike {
  private cache = new Map<string, FetchCacheEntry>()
  private maxSize: number
  private ttl: number
  private now: () => number

  constructor(options: FetchCacheOptions = {}) {
    this.maxSize = options.maxSize ?? 100
    this.ttl = options.ttl ?? 5 * 60 * 1000 // 5 minutes
    this.now = options.now ?? (() => Date.now())
  }

  get(key: string): unknown | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (this.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key)
      return null
    }
    // LRU bump — re-insert so it becomes the most-recently-used.
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  set(key: string, value: unknown): void {
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.cache.set(key, { value, timestamp: this.now() })
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

let globalFetchCache: FetchCache | null = null

/** Shared singleton used by the renderer/CLI host. */
export function getFetchCache(): FetchCache {
  if (!globalFetchCache) globalFetchCache = new FetchCache()
  return globalFetchCache
}

/** Drop the shared cache (tests / cache invalidation). */
export function resetFetchCache(): void {
  globalFetchCache?.clear()
  globalFetchCache = null
}
