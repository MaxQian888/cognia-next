export interface ReceiptCacheOptions {
  /** Maximum live entries. Oldest insertion is evicted first. */
  maxEntries: number
  /** Entries older than this are treated as absent. */
  ttlMs: number
  /** Injected in tests. */
  now?: () => number
}

interface Entry<T> {
  value: T
  storedAt: number
}

/**
 * Bounded, expiring memo for in-flight callback invocations.
 *
 * The host may re-deliver a `client/tool/invoke` or `client/hook/invoke`
 * request — delivery is at-least-once — and the handler must run once, not
 * twice. The previous implementation memoised that in a plain `Map` that was
 * never pruned, so a long-lived client accumulated one entry per tool call for
 * the life of the process.
 *
 * Eviction is by insertion order rather than by last read: an entry exists to
 * absorb a redelivery, which arrives near in time to the original, so age is
 * the property that matters and refreshing on read would keep a hot entry alive
 * long after any duplicate could still arrive.
 */
export class ReceiptCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly now: () => number

  constructor(private readonly options: ReceiptCacheOptions) {
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.now() - entry.storedAt >= this.options.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): T {
    this.prune()
    this.entries.set(key, { value, storedAt: this.now() })
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
    return value
  }

  /** Memoise `factory` under `key`, reusing a live entry when one exists. */
  remember(key: string, factory: () => T): T {
    const existing = this.get(key)
    if (existing !== undefined) return existing
    return this.set(key, factory())
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  private prune(): void {
    const cutoff = this.now() - this.options.ttlMs
    for (const [key, entry] of this.entries) {
      // Insertion-ordered: the first entry that is still live ends the sweep.
      if (entry.storedAt > cutoff) break
      this.entries.delete(key)
    }
  }
}
