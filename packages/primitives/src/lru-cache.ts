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
 *   - An optional weight budget also evicts oldest entries until within budget.
 *     Entries exceeding that entire budget are returned by callers but not cached.
 *
 * Keys are strings; values are deterministic by key, so there is no TTL — a
 * cached entry never goes stale for the same input.
 */
export interface LruCacheWeightBudget<V> {
  maxWeight: number
  weigh: (value: V, key: string) => number
}

export class LruCache<V> {
  private readonly map = new Map<string, { value: V; weight: number }>()
  private readonly maxSize: number
  private totalWeight = 0

  constructor(
    maxSize = 200,
    private readonly weightBudget?: LruCacheWeightBudget<V>
  ) {
    if (weightBudget && (!Number.isFinite(weightBudget.maxWeight) || weightBudget.maxWeight < 0)) {
      throw new RangeError("Cache maxWeight must be finite and non-negative")
    }
    // A non-positive size would make `set` evict the entry it just inserted,
    // turning the cache into a no-op. Clamp to at least 1.
    this.maxSize = Math.max(1, Math.floor(maxSize))
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key)
    if (entry === undefined || entry.value === undefined) return undefined
    // Refresh recency: delete + re-insert moves the key to the end.
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  set(key: string, value: V): void {
    const weight = this.weightBudget?.weigh(value, key) ?? 0
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError("Cache entry weight must be finite and non-negative")
    }
    this.delete(key)
    // Oversized entries must not evict useful smaller entries. A replaced key
    // is still removed, so a skipped write cannot leave a stale value behind.
    if (this.weightBudget && weight > this.weightBudget.maxWeight) return
    this.map.set(key, { value, weight })
    this.totalWeight += weight
    while (
      this.map.size > this.maxSize ||
      (this.weightBudget && this.totalWeight > this.weightBudget.maxWeight)
    ) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  delete(key: string): boolean {
    const entry = this.map.get(key)
    if (!entry) return false
    this.totalWeight -= entry.weight
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
    this.totalWeight = 0
  }

  /** Estimated retained weight in the caller's units; zero when unweighted. */
  get weight(): number {
    return this.totalWeight
  }

  get size(): number {
    return this.map.size
  }
}
