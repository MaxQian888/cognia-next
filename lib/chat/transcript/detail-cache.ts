/** Byte-weighted cache for lazily fetched completed-turn details. */

export const TRANSCRIPT_DETAIL_CACHE_SOFT_BYTES = 24 * 1024 * 1024
export const TRANSCRIPT_DETAIL_CACHE_HARD_BYTES = 48 * 1024 * 1024

interface DetailEntry<T> {
  value: T
  bytes: number
  sessionId: string
  pinned: boolean
  touchedAt: number
}

export class TranscriptDetailCache<T> {
  private readonly entries = new Map<string, DetailEntry<T>>()
  private totalBytes = 0
  private clock = 0

  constructor(
    private readonly budget: {
      softBytes?: number
      hardBytes?: number
    } = {}
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    entry.touchedAt = this.clock++
    return entry.value
  }

  set(key: string, value: T, bytes: number, sessionId = key.split(":", 1)[0] ?? ""): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("transcript detail cache bytes must be a non-negative safe integer")
    }
    const previous = this.entries.get(key)
    if (previous) this.totalBytes -= previous.bytes
    const entry: DetailEntry<T> = {
      value,
      bytes,
      sessionId,
      pinned: previous?.pinned ?? false,
      touchedAt: this.clock++,
    }
    this.entries.set(key, entry)
    this.totalBytes += bytes
    this.evict()
  }

  pin(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.pinned = true
    entry.touchedAt = this.clock++
  }

  unpin(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.pinned = false
    entry.touchedAt = this.clock++
    this.evict()
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.totalBytes -= entry.bytes
    return true
  }

  clearSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  stats(): { entries: number; bytes: number; pinned: number } {
    let pinned = 0
    for (const entry of this.entries.values()) {
      if (entry.pinned) pinned += 1
    }
    return { entries: this.entries.size, bytes: this.totalBytes, pinned }
  }

  private evict(): void {
    const softBytes = this.budget.softBytes ?? TRANSCRIPT_DETAIL_CACHE_SOFT_BYTES
    const hardBytes = Math.max(
      softBytes,
      this.budget.hardBytes ?? TRANSCRIPT_DETAIL_CACHE_HARD_BYTES
    )

    while (this.totalBytes > softBytes) {
      const candidate = this.oldest((entry) => !entry.pinned)
      if (!candidate) break
      this.delete(candidate)
    }
    while (this.totalBytes > hardBytes) {
      const candidate = this.oldest(() => true)
      if (!candidate) break
      this.delete(candidate)
    }
  }

  private oldest(predicate: (entry: DetailEntry<T>) => boolean): string | null {
    let oldestKey: string | null = null
    let oldestTouch = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries) {
      if (!predicate(entry) || entry.touchedAt >= oldestTouch) continue
      oldestKey = key
      oldestTouch = entry.touchedAt
    }
    return oldestKey
  }
}
