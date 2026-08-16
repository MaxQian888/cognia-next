/**
 * Per-provider read cache (ADR-0129).
 *
 * Most entity stores only offer `list*()` — a full table read. Wrapping that
 * read in a short-lived memo means a keystroke re-filters an in-memory array
 * instead of re-reading Dexie, and every cache is dropped together when the
 * dialog opens (`invalidateGlobalSearchCaches`) so a fresh session sees fresh
 * data. Concurrent callers share one in-flight promise.
 */

const registry = new Set<{ clear(): void }>()

export interface SearchCache<T> {
  get(): Promise<T>
  /** Synchronous peek: the last resolved value, or `undefined`. */
  peek(): T | undefined
  clear(): void
}

export interface SearchCacheOptions {
  /** Time a resolved value stays fresh. Default 15 s. */
  ttlMs?: number
  now?: () => number
}

export function createSearchCache<T>(
  loader: () => Promise<T>,
  { ttlMs = 15_000, now = Date.now }: SearchCacheOptions = {}
): SearchCache<T> {
  let value: T | undefined
  let resolvedAt = 0
  let inflight: Promise<T> | null = null

  const cache: SearchCache<T> = {
    async get() {
      if (value !== undefined && now() - resolvedAt < ttlMs) return value
      if (inflight) return inflight
      inflight = loader()
        .then((next) => {
          value = next
          resolvedAt = now()
          return next
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
    peek() {
      return value !== undefined && now() - resolvedAt < ttlMs ? value : undefined
    },
    clear() {
      value = undefined
      resolvedAt = 0
      inflight = null
    },
  }
  registry.add(cache)
  return cache
}

/** Drop every provider cache — called when the dialog opens. */
export function invalidateGlobalSearchCaches(): void {
  for (const cache of registry) cache.clear()
}

/** Test-only: forget the caches created so far. */
export function __resetGlobalSearchCachesForTesting(): void {
  for (const cache of registry) cache.clear()
  registry.clear()
}
