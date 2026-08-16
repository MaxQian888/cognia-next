/**
 * The inline-completion engine — React-free, Ink-free orchestration shared by
 * the desktop composer and the CLI TUI composer.
 *
 * Generalises the original single-query `GhostController` in two ways that
 * together define the feature:
 *
 * ## 1. Two tiers, so the ghost is never gated on the network
 *
 * Providers declare themselves `sync` (pure computation over the context —
 * history, slash commands) or async (a model call). Sync providers run on EVERY
 * keystroke with no debounce; async providers are debounced, cached and
 * cancellable. The practical effect is that a completion appears immediately
 * from local sources and is then *upgraded* in place when the model answers —
 * instead of the old behaviour, where the composer showed nothing at all until
 * a model round-trip returned, and showed nothing ever if no model was
 * configured.
 *
 * ## 2. A candidate list, not a single answer
 *
 * Merged results are ranked (`rank.ts`) into a bounded candidate list the user
 * can cycle through, so a mediocre top hit no longer means "retype it
 * yourself". A cycled-to choice is pinned by text, so a late-arriving model
 * suggestion re-ranks the list without yanking the ghost out from under the
 * user's selection.
 *
 * Debounce/staleness/caching are unchanged in spirit from the controller this
 * replaces, including the live-narrow path: typing forward INTO the visible
 * ghost shaves the consumed prefix instead of re-querying, so tracking the
 * caret never re-bills the model.
 *
 * The scheduler and clock are injected so every timing rule is unit-testable
 * without real timers or a model.
 */

import { extendsDraft, ghostSuffix, rankInlineSuggestions } from "./rank"
import {
  DEFAULT_INLINE_MAX_CANDIDATES,
  type InlineCompletionContext,
  type InlineCompletionProvider,
  type InlineSuggestion,
} from "./types"

export interface InlineScheduler {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realScheduler: InlineScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Async providers are abandoned after this long so one hang can't wedge the ghost. */
const DEFAULT_PROVIDER_TIMEOUT_MS = 6_000
const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_CACHE_TTL_MS = 30_000
const CACHE_MAX = 32

export interface InlineEngineOptions {
  /** The completion sources. Order breaks ranking ties, so keep it stable. */
  providers: readonly InlineCompletionProvider[]
  /**
   * Build the full context for a draft. Called per query, so the surface can
   * read live state (history ring, command registry, recent messages) without
   * the engine holding stale copies.
   */
  buildContext: (draft: string) => InlineCompletionContext
  /** Notified whenever {@link InlineCompletionEngine.getView} may have changed. */
  onChange: () => void
  /** Debounce before querying async providers, ms. Default 500. */
  debounceMs?: number
  /**
   * Minimum trimmed draft length before ANY provider runs. Default 1 — local
   * sources are free, so they should fire early; expensive providers enforce
   * their own higher floor (see `ai-provider.ts`).
   */
  minChars?: number
  /** Max candidates kept for cycling. Defaults to {@link DEFAULT_INLINE_MAX_CANDIDATES}. */
  maxCandidates?: number
  /** TTL for the async-result cache, ms. Default 30_000. */
  cacheTtlMs?: number
  /** Per-provider timeout for async providers, ms. Default 6_000. */
  providerTimeoutMs?: number
  scheduler?: InlineScheduler
  now?: () => number
}

export interface InlineEngineView {
  /** Dim text to render after the caret. Empty when nothing is suggested. */
  ghost: string
  /** The active suggestion, or null. Carries the source badge + description. */
  suggestion: InlineSuggestion | null
  /** All ranked candidates (the active one included). */
  candidates: readonly InlineSuggestion[]
  /** Index of the active candidate within {@link candidates}. */
  index: number
  /** True while an async provider query is in flight for the current draft. */
  pending: boolean
}

const EMPTY_VIEW: InlineEngineView = {
  ghost: "",
  suggestion: null,
  candidates: [],
  index: 0,
  pending: false,
}

interface CacheEntry {
  suggestions: InlineSuggestion[]
  at: number
}

export class InlineCompletionEngine {
  private draft = ""
  private syncSuggestions: InlineSuggestion[] = []
  private asyncSuggestions: InlineSuggestion[] = []
  private candidates: InlineSuggestion[] = []
  private index = 0
  /** Text of a candidate the user explicitly cycled to, so re-ranks respect it. */
  private pinnedText: string | null = null
  private pending = false
  private timer: unknown = null
  private asyncAbort: AbortController | null = null
  private syncRun = 0
  private disposed = false
  private readonly cache = new Map<string, CacheEntry>()

  private readonly providers: readonly InlineCompletionProvider[]
  private readonly syncProviders: readonly InlineCompletionProvider[]
  private readonly asyncProviders: readonly InlineCompletionProvider[]
  private readonly buildContext: (draft: string) => InlineCompletionContext
  private readonly onChange: () => void
  private readonly debounceMs: number
  private readonly minChars: number
  private readonly maxCandidates: number
  private readonly cacheTtlMs: number
  private readonly providerTimeoutMs: number
  private readonly scheduler: InlineScheduler
  private readonly clock: () => number

  constructor(options: InlineEngineOptions) {
    // Sort once by priority so ranking ties resolve in a documented order
    // rather than in whatever order the surface happened to build the array.
    this.providers = [...options.providers].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
    )
    this.syncProviders = this.providers.filter((p) => p.sync === true)
    this.asyncProviders = this.providers.filter((p) => p.sync !== true)
    this.buildContext = options.buildContext
    this.onChange = options.onChange
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.minChars = options.minChars ?? 1
    this.maxCandidates = options.maxCandidates ?? DEFAULT_INLINE_MAX_CANDIDATES
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
    this.scheduler = options.scheduler ?? realScheduler
    this.clock = options.now ?? Date.now
  }

  /**
   * Feed the composer's latest draft.
   *
   * Pass `suppress: true` when the surface's own gating says nothing should be
   * suggested right now — the caret is not at the end, a `/@!#` popup owns the
   * input, a turn is streaming, or the feature is off.
   */
  feed(draft: string, opts?: { suppress?: boolean }): void {
    if (this.disposed) return
    const prevDraft = this.draft
    const prevCandidates = this.candidates
    this.draft = draft

    if (opts?.suppress || draft.trim().length < this.minChars) {
      this.reset()
      this.onChange()
      return
    }

    // Live-narrow: the user typed forward, exactly into what was already
    // suggested. Shave the consumed prefix off the surviving candidates rather
    // than re-running anything — this is the path that keeps a model
    // suggestion stable (and unbilled) while the user types along it.
    if (
      prevCandidates.length > 0 &&
      draft.length > prevDraft.length &&
      draft.startsWith(prevDraft)
    ) {
      const survivors = prevCandidates.filter((c) => extendsDraft(c.text, draft))
      if (survivors.length > 0) {
        this.cancelAsync()
        this.cancelTimer()
        this.pending = false
        // Keep the tiers coherent with the narrowed view so a later re-merge
        // (e.g. an async arrival) doesn't resurrect candidates that no longer
        // match the draft.
        this.syncSuggestions = this.syncSuggestions.filter((s) => extendsDraft(s.text, draft))
        this.asyncSuggestions = this.asyncSuggestions.filter((s) => extendsDraft(s.text, draft))
        this.setCandidates(survivors)
        this.onChange()
        return
      }
    }

    // The draft moved somewhere the current candidates don't cover. Drop them
    // (so no stale ghost is painted), then rebuild both tiers.
    this.syncSuggestions = []
    this.asyncSuggestions = []
    this.pinnedText = null
    this.setCandidates([])
    this.cancelAsync()
    this.cancelTimer()

    void this.runSyncProviders(draft)

    if (this.asyncProviders.length > 0) {
      const cached = this.readCache(draft)
      if (cached !== undefined) {
        this.asyncSuggestions = cached
        this.pending = false
        this.merge()
      } else {
        this.pending = true
        this.timer = this.scheduler.set(() => void this.runAsyncProviders(draft), this.debounceMs)
      }
    } else {
      this.pending = false
    }

    this.onChange()
  }

  /**
   * Accept the active suggestion. Returns the new full draft the caller writes
   * back to its composer, or null when there is nothing to accept. Never
   * submits — that is always the surface's decision.
   */
  accept(): string | null {
    const active = this.candidates[this.index]
    if (!active) return null
    const next = active.text
    this.draft = next
    this.reset()
    this.onChange()
    return next
  }

  /** Move to the next candidate (wraps). No-op with fewer than two candidates. */
  cycleNext(): void {
    this.cycleBy(1)
  }

  /** Move to the previous candidate (wraps). No-op with fewer than two candidates. */
  cyclePrev(): void {
    this.cycleBy(-1)
  }

  /** Dismiss the suggestion (Esc / blur), keeping the draft. */
  dismiss(): void {
    this.reset()
    this.onChange()
  }

  getView(): InlineEngineView {
    const suggestion = this.candidates[this.index] ?? null
    if (!suggestion) {
      return this.pending ? { ...EMPTY_VIEW, pending: true } : EMPTY_VIEW
    }
    return {
      ghost: ghostSuffix(suggestion.text, this.draft),
      suggestion,
      candidates: this.candidates,
      index: this.index,
      pending: this.pending,
    }
  }

  /** The draft the engine currently believes is in the composer. */
  get currentDraft(): string {
    return this.draft
  }

  dispose(): void {
    this.disposed = true
    this.cancelAsync()
    this.cancelTimer()
    this.cache.clear()
  }

  // --- internals ---------------------------------------------------------

  private cycleBy(delta: number): void {
    if (this.candidates.length < 2) return
    const size = this.candidates.length
    this.index = (this.index + delta + size) % size
    this.pinnedText = this.candidates[this.index]?.text ?? null
    this.onChange()
  }

  /**
   * Run the cheap providers for `draft`. Still async (the provider contract
   * returns a promise), but un-debounced and un-cached: the results land in a
   * microtask, which is imperceptible, and a staleness token drops them if the
   * draft moved on in the meantime.
   */
  private async runSyncProviders(draft: string): Promise<void> {
    if (this.syncProviders.length === 0) return
    const token = ++this.syncRun
    const context = this.buildContext(draft)
    const controller = new AbortController()
    const results = await Promise.all(
      this.syncProviders.map((p) => this.callProvider(p, context, controller.signal, false))
    )
    if (this.disposed || token !== this.syncRun || this.draft !== draft) return
    this.syncSuggestions = results.flatMap((r) => r.suggestions)
    this.merge()
    this.onChange()
  }

  /** Run the expensive providers for `draft` after the debounce elapsed. */
  private async runAsyncProviders(draft: string): Promise<void> {
    this.timer = null
    this.cancelAsync()
    const controller = new AbortController()
    this.asyncAbort = controller
    const context = this.buildContext(draft)

    const results = await Promise.all(
      this.asyncProviders.map((p) => this.callProvider(p, context, controller.signal, true))
    )

    if (this.disposed || controller.signal.aborted) return
    // Staleness guard: the draft moved while we waited, so this answer is for
    // a question nobody is asking any more.
    if (this.draft !== draft) return

    const flat = results.flatMap((r) => r.suggestions)
    // Only a completed round is worth remembering. A timeout resolves as `[]`,
    // which is indistinguishable from a genuine "no suggestions" once flattened
    // — caching it would answer the identical draft from a miss for the whole
    // TTL, so a slow provider would look permanently empty rather than slow.
    if (!results.some((r) => r.timedOut)) this.writeCache(draft, flat)
    this.asyncSuggestions = flat
    this.pending = false
    if (this.asyncAbort === controller) this.asyncAbort = null
    this.merge()
    this.onChange()
  }

  /**
   * Invoke one provider with error isolation and (for async providers) a
   * timeout. A provider that throws, rejects, or hangs contributes `[]` rather
   * than taking the whole query down — the same contract the terminal
   * completion registry enforces.
   *
   * `timedOut` is reported rather than folded into the empty result because the
   * caller must not cache a timeout, and because the provider's own request has
   * to be aborted: losing the race does not stop the work behind it, so an
   * un-aborted call keeps running (and, for a model-backed provider, keeps
   * billing) long after nothing is listening.
   */
  private async callProvider(
    provider: InlineCompletionProvider,
    context: InlineCompletionContext,
    signal: AbortSignal,
    withTimeout: boolean
  ): Promise<{ suggestions: InlineSuggestion[]; timedOut: boolean }> {
    try {
      if (!withTimeout) {
        return {
          suggestions: (await provider.getCompletions(context, signal)) ?? [],
          timedOut: false,
        }
      }
      // A controller per provider, chained to the run's signal: aborting the
      // run still cancels every provider, but one provider timing out must not
      // cancel its siblings, which may still answer in time.
      const own = new AbortController()
      const onAbort = () => own.abort()
      if (signal.aborted) own.abort()
      else signal.addEventListener("abort", onAbort, { once: true })

      const call = provider.getCompletions(context, own.signal)
      let timedOut = false
      let timeoutHandle: unknown = null
      const timeout = new Promise<InlineSuggestion[]>((resolve) => {
        timeoutHandle = this.scheduler.set(() => {
          timedOut = true
          resolve([])
        }, this.providerTimeoutMs)
      })
      try {
        const suggestions = (await Promise.race([call, timeout])) ?? []
        if (timedOut) own.abort()
        return { suggestions: timedOut ? [] : suggestions, timedOut }
      } finally {
        if (timeoutHandle !== null) this.scheduler.clear(timeoutHandle)
        signal.removeEventListener("abort", onAbort)
      }
    } catch {
      return { suggestions: [], timedOut: false }
    }
  }

  /** Re-rank both tiers into the candidate list, preserving any pinned choice. */
  private merge(): void {
    this.setCandidates(
      rankInlineSuggestions([...this.syncSuggestions, ...this.asyncSuggestions], this.draft, {
        limit: this.maxCandidates,
      })
    )
  }

  private setCandidates(next: InlineSuggestion[]): void {
    this.candidates = next
    // Honour an explicit cycle: if the user picked a candidate and it survived
    // the re-rank, keep showing it. Otherwise fall back to the best one.
    const pinnedIndex = this.pinnedText ? next.findIndex((c) => c.text === this.pinnedText) : -1
    if (pinnedIndex >= 0) {
      this.index = pinnedIndex
    } else {
      this.index = 0
      if (next.length === 0) this.pinnedText = null
    }
  }

  private reset(): void {
    this.syncSuggestions = []
    this.asyncSuggestions = []
    this.candidates = []
    this.index = 0
    this.pinnedText = null
    this.pending = false
    this.syncRun++
    this.cancelAsync()
    this.cancelTimer()
  }

  private cancelAsync(): void {
    if (this.asyncAbort) {
      this.asyncAbort.abort()
      this.asyncAbort = null
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clear(this.timer)
      this.timer = null
    }
  }

  private readCache(draft: string): InlineSuggestion[] | undefined {
    const hit = this.cache.get(draft)
    if (!hit) return undefined
    if (this.clock() - hit.at > this.cacheTtlMs) {
      this.cache.delete(draft)
      return undefined
    }
    return hit.suggestions
  }

  private writeCache(draft: string, suggestions: InlineSuggestion[]): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(draft, { suggestions, at: this.clock() })
  }
}
