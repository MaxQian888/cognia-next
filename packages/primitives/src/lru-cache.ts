/**
 * Tiny generic LRU cache backed by a `Map` (insertion order = recency).
 *
 * Used to memoize the results of expensive, deterministic render passes that
 * the virtualized chat list recomputes every time a row scrolls back into view
 * (Shiki highlighting, Mermaid SVG). The KaTeX path already has its own bespoke
 * cache (`lib/latex/cache.ts`); this is the shared primitive for the rest.
 *
 * Semantics:
 *   - `get` returns the value and marks the key most-recently-used.
 *   - `set` inserts/refreshes the key; when the cache exceeds `maxSize` the
 *     least-recently-used entry (the first key in the Map) is evicted.
 *
 * Keys are strings; values are deterministic by key, so there is no TTL — a
 * cached entry never goes stale for the same input.
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>()
  private readonly maxSize: number

  constructor(maxSize = 200) {
    // A non-positive size would make `set` evict the entry it just inserted,
    // turning the cache into a no-op. Clamp to at least 1.
    this.maxSize = Math.max(1, Math.floor(maxSize))
  }

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // Refresh recency: delete + re-insert moves the key to the end.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
