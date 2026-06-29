/**
 * Generic bounded FIFO buffer — keeps at most `capacity` of the most
 * recent items, evicting the oldest on overflow.
 *
 * Why this exists: several subsystems hand-roll the same 256-cap
 * "push-then-splice" ring inline (e.g. the plugin hook-error buffer in
 * `lib/plugin/messaging/hooks-system.ts`). The plugin resilience layer
 * needs the same shape for activation-failure history, so this promotes
 * the pattern to one tested utility instead of copying it again.
 *
 * Pure utility — no clock, no logger. `toArray()` returns oldest→newest.
 */

export interface BoundedBuffer<T> {
  /** Append an item, evicting the oldest if at capacity. */
  push(item: T): void
  /** Snapshot in insertion order (oldest first). Pure read — copies. */
  toArray(): T[]
  /** Current item count (≤ capacity). */
  readonly size: number
  /** Drop every item. */
  clear(): void
}

export function createBoundedBuffer<T>(capacity: number): BoundedBuffer<T> {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(`createBoundedBuffer: capacity must be a positive integer, got ${capacity}`)
  }
  const items: T[] = []

  return {
    push(item: T): void {
      items.push(item)
      if (items.length > capacity) {
        // Evict the overflow from the front in one splice (handles the
        // common +1 case and any larger overshoot defensively).
        items.splice(0, items.length - capacity)
      }
    },
    toArray(): T[] {
      return items.slice()
    },
    get size(): number {
      return items.length
    },
    clear(): void {
      items.length = 0
    },
  }
}
