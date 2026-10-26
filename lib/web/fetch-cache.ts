/**
 * Reader (web-fetch) result cache.
 *
 * Stores the normalized document representation a read produced — after any
 * distillation, BEFORE read-window slicing — so successive `offset` pages of
 * the same document are served without another network or model call.
 *
 * Authority is never cached: the caller re-evaluates the target guard,
 * capability and current policy before every lookup, and identity includes
 * everything that changes what may be returned —
 *   runtime/account scope · URL · reader-policy revision · format · prompt ·
 *   distillation mode · policy-contract version.
 * Offset and window cap do not participate. Requests with caller headers,
 * bodies, non-GET methods or private targets never reach this cache.
 *
 * Bounds (in memory only, never on disk): 5-minute TTL, 100 entries, 256 Ki
 * characters per entry and 4 Mi characters in aggregate, LRU eviction. An
 * oversized representation is not stored; the caller reports a bypass.
 *
 * The cache is injected into the Reader via deps rather than read from a
 * module global, so the pure core stays test-isolated; hosts pass
 * {@link getFetchCache}.
 */

import {
  READ_CACHE_ENTRY_MAX_CHARS,
  READ_CACHE_MAX_ENTRIES,
  READ_CACHE_TOTAL_MAX_CHARS,
  READ_CACHE_TTL_MS,
} from "@cognia/web-search/operation-policy"

/**
 * Bumped whenever what a cached representation may contain changes; entries
 * keyed under an older contract can never be hit.
 */
export const READER_CACHE_CONTRACT_VERSION = 2

export interface FetchCacheKeyInput {
  /** Runtime/account scope (opaque). */
  scope?: string
  url: string
  /** Reader-policy revision plus the effective reader selection. */
  readerRevision?: string
  format?: string
  /** Query-focused extraction prompt — a different prompt yields a different summary. */
  prompt?: string
  /** Effective distillation mode. */
  distillation?: string
}

/** Stable cache key for a read request. */
export function fetchCacheKey(input: FetchCacheKeyInput): string {
  return [
    `v${READER_CACHE_CONTRACT_VERSION}`,
    input.scope ?? "",
    input.url.trim(),
    input.readerRevision ?? "",
    input.format ?? "auto",
    input.prompt?.trim() ?? "",
    input.distillation ?? "off",
  ].join("\u0000")
}

/** Minimal shape the Reader depends on — lets tests inject a stub. */
export interface FetchCacheLike {
  get(key: string): unknown | null
  /** Returns false when the value was too large to keep. */
  set(key: string, value: unknown, size?: number): boolean | void
  /** Drop every entry of one scope (account/profile/credential change). */
  clearScope?(scope: string): void
}

interface FetchCacheEntry {
  value: unknown
  timestamp: number
  size: number
  scope: string
}

export interface FetchCacheOptions {
  maxSize?: number
  ttl?: number
  maxEntryChars?: number
  maxTotalChars?: number
  /** Injectable clock for deterministic TTL tests; defaults to `Date.now`. */
  now?: () => number
}

/** Character weight of a cached value: the strings it would hand back. */
export function representationSize(value: unknown): number {
  if (typeof value === "string") return value.length
  if (Array.isArray(value)) return value.reduce((sum: number, v) => sum + representationSize(v), 0)
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce(
      (sum: number, v) => sum + representationSize(v),
      0
    )
  }
  return 0
}

/** TTL + LRU cache bounded by entries AND characters. */
export class FetchCache implements FetchCacheLike {
  private cache = new Map<string, FetchCacheEntry>()
  private totalChars = 0
  private readonly maxSize: number
  private readonly ttl: number
  private readonly maxEntryChars: number
  private readonly maxTotalChars: number
  private readonly now: () => number

  constructor(options: FetchCacheOptions = {}) {
    this.maxSize = options.maxSize ?? READ_CACHE_MAX_ENTRIES
    this.ttl = options.ttl ?? READ_CACHE_TTL_MS
    this.maxEntryChars = options.maxEntryChars ?? READ_CACHE_ENTRY_MAX_CHARS
    this.maxTotalChars = options.maxTotalChars ?? READ_CACHE_TOTAL_MAX_CHARS
    this.now = options.now ?? (() => Date.now())
  }

  get(key: string): unknown | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (this.now() - entry.timestamp > this.ttl) {
      this.delete(key, entry)
      return null
    }
    // LRU bump — re-insert so it becomes the most-recently-used.
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  set(key: string, value: unknown, size: number = representationSize(value)): boolean {
    if (size > this.maxEntryChars) return false
    const existing = this.cache.get(key)
    if (existing) this.delete(key, existing)
    while (
      this.cache.size > 0 &&
      (this.cache.size >= this.maxSize || this.totalChars + size > this.maxTotalChars)
    ) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey === undefined) break
      this.delete(oldestKey, this.cache.get(oldestKey)!)
    }
    const scope = key.split("\u0000")[1] ?? ""
    this.cache.set(key, { value, timestamp: this.now(), size, scope })
    this.totalChars += size
    return true
  }

  clearScope(scope: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.scope === scope) this.delete(key, entry)
    }
  }

  clear(): void {
    this.cache.clear()
    this.totalChars = 0
  }

  get size(): number {
    return this.cache.size
  }

  get characters(): number {
    return this.totalChars
  }

  private delete(key: string, entry: FetchCacheEntry): void {
    this.cache.delete(key)
    this.totalChars = Math.max(0, this.totalChars - entry.size)
  }
}

let globalFetchCache: FetchCache | null = null

/** Shared singleton used by the renderer/CLI host. */
export function getFetchCache(): FetchCache {
  if (!globalFetchCache) globalFetchCache = new FetchCache()
  return globalFetchCache
}

/** Drop the shared cache (tests / cache invalidation / policy-contract activation). */
export function resetFetchCache(): void {
  globalFetchCache?.clear()
  globalFetchCache = null
}
