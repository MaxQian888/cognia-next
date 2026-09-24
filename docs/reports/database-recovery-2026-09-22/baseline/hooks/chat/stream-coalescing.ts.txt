"use client"

/**
 * Per-session streaming coalescers for the concurrent-chat path.
 *
 * `use-claude-chat` originally held a single rAF-throttled `commit` and a
 * single debounced `persist` at hook scope — fine when only the focused
 * session streamed. With multiple sessions streaming at once each needs its
 * own coalescing state (latest-args-win is per session, not global), so we
 * key a `{ commit, persist }` pair by sessionId.
 *
 * The throttle/debounce primitives in `hooks/workflow/*` are React hooks and
 * cannot be instantiated per-session at call time, so this module provides
 * the same behaviour as plain imperative factories. The handle shapes are
 * identical (`call` / `flush` / `cancel`) so the event-loop call sites read
 * the same regardless of where the handle came from.
 */

import type { UIMessage } from "ai"
import type { RafThrottleHandle } from "@/hooks/workflow/use-raf-throttle"
import type { DebouncedCallbackHandle } from "@/hooks/workflow/use-debounced-callback"

/**
 * Imperative `requestAnimationFrame` coalescer — latest args win, single frame
 * scheduled. Mirrors `useRafThrottle` minus the hook lifecycle; the owner is
 * responsible for calling `cancel()` on teardown (the registry does this).
 */
export function createRafThrottle<TArgs extends readonly unknown[]>(
  fn: (...args: TArgs) => void
): RafThrottleHandle<TArgs> {
  let pending = false
  let frameId: number | null = null
  let args: TArgs | null = null

  const drain = () => {
    pending = false
    frameId = null
    const a = args
    args = null
    if (a !== null) fn(...a)
  }

  const call = (...next: TArgs) => {
    args = next
    if (typeof requestAnimationFrame === "undefined") {
      // SSR / Node without rAF: degrade to synchronous so calls aren't lost.
      args = null
      fn(...next)
      return
    }
    if (pending) return
    pending = true
    const id = requestAnimationFrame(drain)
    if (pending) frameId = id
  }

  const flush = () => {
    if (frameId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameId)
    }
    pending = false
    frameId = null
    const a = args
    args = null
    if (a !== null) fn(...a)
  }

  const cancel = () => {
    if (frameId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameId)
    }
    pending = false
    frameId = null
    args = null
  }

  return { call, flush, cancel }
}

/**
 * Imperative trailing-edge debounce — mirrors `useDebouncedCallback`. A
 * `delayMs <= 0` degrades to synchronous (test / SSR friendliness).
 */
export function createDebouncedCallback<TArgs extends readonly unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number
): DebouncedCallbackHandle<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let args: TArgs | null = null

  const drain = () => {
    timer = null
    const a = args
    args = null
    if (a !== null) fn(...a)
  }

  const call = (...next: TArgs) => {
    args = next
    if (delayMs <= 0) {
      args = null
      fn(...next)
      return
    }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(drain, delayMs)
  }

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const a = args
    args = null
    if (a !== null) fn(...a)
  }

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    args = null
  }

  return { call, flush, cancel }
}

/** Coalescing handles for one session's streaming commit + persist. */
export interface SessionCoalescing {
  /** rAF-throttled React store commit (≤1/frame). `call(msgs)`. */
  commit: RafThrottleHandle<[UIMessage[]]>
  /** Debounced Dexie write. `call(msgs)`. */
  persist: DebouncedCallbackHandle<[UIMessage[]]>
}

export interface SessionCoalescingOptions {
  /** Push the latest message snapshot into the store for `sessionId`. */
  onCommit: (sessionId: string, msgs: UIMessage[]) => void
  /** Durably persist the latest message snapshot for `sessionId`. */
  onPersist: (sessionId: string, msgs: UIMessage[]) => void
  /** Debounce window for the persist write (0 → synchronous, used in tests). */
  persistDelayMs: number
}

/**
 * Lazily-instantiated registry of per-session coalescing handles. Each session
 * gets its own latest-args-win commit/persist pair so concurrent streams never
 * clobber each other's pending snapshot. The owning hook calls `release(id)` at
 * every turn boundary / session close to flush nothing-pending and drop state.
 */
export class SessionCoalescingRegistry {
  private readonly map = new Map<string, SessionCoalescing>()

  constructor(private readonly opts: SessionCoalescingOptions) {}

  /** Get (or lazily create) the coalescing pair for `sessionId`. */
  get(sessionId: string): SessionCoalescing {
    const existing = this.map.get(sessionId)
    if (existing) return existing
    const pair: SessionCoalescing = {
      commit: createRafThrottle<[UIMessage[]]>((msgs) => this.opts.onCommit(sessionId, msgs)),
      persist: createDebouncedCallback<[UIMessage[]]>(
        (msgs) => this.opts.onPersist(sessionId, msgs),
        this.opts.persistDelayMs
      ),
    }
    this.map.set(sessionId, pair)
    return pair
  }

  /** Cancel any pending work for `sessionId` and forget it. */
  release(sessionId: string): void {
    const pair = this.map.get(sessionId)
    if (!pair) return
    pair.commit.cancel()
    pair.persist.cancel()
    this.map.delete(sessionId)
  }

  /** Cancel + drop every session's pending work (hook unmount). */
  clear(): void {
    for (const pair of this.map.values()) {
      pair.commit.cancel()
      pair.persist.cancel()
    }
    this.map.clear()
  }

  /** Flush every session's pending persist immediately (hook unmount safety). */
  flushAllPersist(): void {
    for (const pair of this.map.values()) {
      pair.persist.flush()
    }
  }
}
