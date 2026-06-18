/**
 * Composer ghost-text controller — the React-free orchestration behind the
 * chat composer's inline autocomplete. The textarea cousin of
 * `lib/terminal/completion/controller.ts`, but much simpler: the textarea
 * value is fully known (no PTY line model / OSC parsing), suggestions are
 * append-only (the ghost is always a suffix after the caret), and there is no
 * multi-candidate popup.
 *
 * Responsibilities: debounce a query off the keystroke stream, cancel stale
 * in-flight queries, memoise by input with a short TTL (so backspace/retype
 * doesn't re-bill the model), and narrow the visible ghost live as the user
 * types toward it. The view (`getView`) exposes the suffix to render;
 * `accept()` returns the new full value the caller writes back to the
 * textarea (it never submits).
 *
 * The query, scheduler and clock are injected so the debounce / staleness /
 * cache logic is unit-testable without a model or real timers.
 */

export interface GhostScheduler {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realScheduler: GhostScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface GhostControllerOptions {
  debounceMs?: number
  /** Minimum trimmed input length before a query is worth making. */
  minChars?: number
  /** Resolve the ghost suffix for `input`, or null for "no suggestion". */
  query: (input: string, signal: AbortSignal) => Promise<string | null>
  /** Notified whenever the rendered view may have changed. */
  onChange: () => void
  scheduler?: GhostScheduler
  now?: () => number
  cacheTtlMs?: number
}

export interface GhostView {
  /** Dim text rendered after the caret (empty when nothing to show). */
  ghost: string
}

interface CacheEntry {
  suffix: string | null
  at: number
}

const CACHE_MAX = 32

export class GhostController {
  private input = ""
  private ghost = ""
  private timer: unknown = null
  private ac: AbortController | null = null
  private readonly cache = new Map<string, CacheEntry>()

  private readonly debounceMs: number
  private readonly minChars: number
  private readonly cacheTtlMs: number
  private readonly query: GhostControllerOptions["query"]
  private readonly onChange: () => void
  private readonly scheduler: GhostScheduler
  private readonly clock: () => number

  constructor(opts: GhostControllerOptions) {
    this.debounceMs = opts.debounceMs ?? 500
    this.minChars = opts.minChars ?? 3
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000
    this.query = opts.query
    this.onChange = opts.onChange
    this.scheduler = opts.scheduler ?? realScheduler
    this.clock = opts.now ?? Date.now
  }

  /**
   * Feed the latest textarea value. Pass `suppress: true` when the caller's
   * gating (caret not at end, a `/@!#` trigger active, a turn streaming,
   * feature disabled) means nothing should be suggested right now.
   */
  feed(input: string, opts?: { suppress?: boolean }): void {
    const prevInput = this.input
    const prevGhost = this.ghost
    this.input = input

    if (opts?.suppress || input.trim().length < this.minChars) {
      this.clearGhost()
      this.cancelQuery()
      this.cancelTimer()
      this.onChange()
      return
    }

    // Live-narrow: the user typed forward exactly into the current ghost —
    // shave the consumed prefix instead of re-querying, so the ghost tracks
    // the caret without a model round-trip.
    if (prevGhost && input.length > prevInput.length && input.startsWith(prevInput)) {
      const typed = input.slice(prevInput.length)
      if (prevGhost.startsWith(typed)) {
        this.ghost = prevGhost.slice(typed.length)
        this.cancelQuery()
        this.cancelTimer()
        this.onChange()
        return
      }
    }

    const cached = this.readCache(input)
    if (cached !== undefined) {
      this.ghost = cached ?? ""
      this.cancelQuery()
      this.cancelTimer()
      this.onChange()
      return
    }

    // Stale — drop the old ghost and (debounced) re-query.
    this.clearGhost()
    this.scheduleQuery()
    this.onChange()
  }

  /**
   * Accept the visible ghost. Returns the new full textarea value the caller
   * must write back, or null when there's nothing to accept.
   */
  accept(): string | null {
    if (!this.ghost) return null
    const next = this.input + this.ghost
    this.input = next
    this.clearGhost()
    this.cancelQuery()
    this.cancelTimer()
    this.onChange()
    return next
  }

  /** Dismiss the ghost (Esc / blur), keeping the input. */
  dismiss(): void {
    this.clearGhost()
    this.cancelQuery()
    this.cancelTimer()
    this.onChange()
  }

  getView(): GhostView {
    return { ghost: this.ghost }
  }

  get currentInput(): string {
    return this.input
  }

  dispose(): void {
    this.cancelQuery()
    this.cancelTimer()
  }

  // --- internals ---------------------------------------------------------

  private scheduleQuery(): void {
    this.cancelTimer()
    this.timer = this.scheduler.set(() => void this.runQuery(), this.debounceMs)
  }

  /** Returns the in-flight promise so tests can await it after flushing. */
  private runQuery(): Promise<void> {
    this.timer = null
    this.cancelQuery()
    const input = this.input
    const ac = new AbortController()
    this.ac = ac
    return (async () => {
      let suffix: string | null
      try {
        suffix = await this.query(input, ac.signal)
      } catch {
        suffix = null
      }
      if (ac.signal.aborted) return
      // Staleness guard: ignore if the input moved on while we waited.
      if (this.input !== input) return
      this.writeCache(input, suffix)
      this.ghost = suffix ?? ""
      this.onChange()
    })()
  }

  private clearGhost(): void {
    this.ghost = ""
  }

  private cancelQuery(): void {
    if (this.ac) {
      this.ac.abort()
      this.ac = null
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clear(this.timer)
      this.timer = null
    }
  }

  private readCache(input: string): string | null | undefined {
    const hit = this.cache.get(input)
    if (!hit) return undefined
    if (this.clock() - hit.at > this.cacheTtlMs) {
      this.cache.delete(input)
      return undefined
    }
    return hit.suffix
  }

  private writeCache(input: string, suffix: string | null): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(input, { suffix, at: this.clock() })
  }
}
