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
 * ## 1b. A third, explicitly-requested tier
 *
 * A provider may also declare itself `manual`. Those are never queried by
 * `feed()` at all — only by {@link InlineCompletionEngine.requestManual},
 * which a surface binds to a key. This is what lets the expensive
 * "run a real agent turn" source (the only one that works without a
 * renderer-visible API key — see `InlineCompletionProvider.manual`) participate
 * in the same ranking and cycling as the cheap ones, without ever being put on
 * a debounce it cannot afford.
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
  /**
   * True when a `manual` provider is registered, i.e. there is something for
   * {@link InlineCompletionEngine.requestManual} to run. Surfaces use this to
   * decide whether to advertise the "ask the model" affordance at all.
   */
  manualAvailable: boolean
  /** True while a manual query is in flight. */
  manualPending: boolean
}

const EMPTY_VIEW: InlineEngineView = {
  ghost: "",
  suggestion: null,
  candidates: [],
  index: 0,
  pending: false,
  manualAvailable: false,
  manualPending: false,
}

interface CacheEntry {
  suggestions: InlineSuggestion[]
  at: number
}

export class InlineCompletionEngine {
  private draft = ""
  private syncSuggestions: InlineSuggestion[] = []
  private asyncSuggestions: InlineSuggestion[] = []
  private manualSuggestions: InlineSuggestion[] = []
  private candidates: InlineSuggestion[] = []
  private index = 0
  /** Text of a candidate the user explicitly cycled to, so re-ranks respect it. */
  private pinnedText: string | null = null
  private pending = false
  private manualPending = false
  private timer: unknown = null
  private asyncAbort: AbortController | null = null
  private manualAbort: AbortController | null = null
  /**
   * The draft an in-flight manual run was issued for. `feed` needs it to tell
   * "the user is typing forward along the sentence they asked about" (keep the
   * turn — its answer will still apply) from "the user changed their mind"
   * (cancel it). The visible-candidate narrow path cannot answer that, because
   * a turn that has not returned yet has produced no candidates to narrow.
   */
  private manualDraft: string | null = null
  /** Last no-suggestion view, reused while its flags hold. See {@link getView}. */
  private emptyView: InlineEngineView | null = null
  private syncRun = 0
  private disposed = false
  private readonly cache = new Map<string, CacheEntry>()
  /**
   * Manual results are cached separately from the debounced ones. Sharing one
   * map would let an auto-tier round for the same draft (which never ran the
   * manual providers) answer a later `requestManual` from cache — the user
   * would press the key and get the auto-tier's answer back, having asked
   * precisely because that answer was unsatisfying or absent.
   */
  private readonly manualCache = new Map<string, CacheEntry>()

  private readonly providers: readonly InlineCompletionProvider[]
  private readonly syncProviders: readonly InlineCompletionProvider[]
  private readonly asyncProviders: readonly InlineCompletionProvider[]
  private readonly manualProviders: readonly InlineCompletionProvider[]
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
    // `manual` is checked first, so a provider that (incorrectly) sets both
    // flags stays off the keystroke path — the safe reading of the ambiguity.
    this.manualProviders = this.providers.filter((p) => p.manual === true)
    this.syncProviders = this.providers.filter((p) => p.manual !== true && p.sync === true)
    this.asyncProviders = this.providers.filter((p) => p.manual !== true && p.sync !== true)
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
        // A manually-requested suggestion is the most expensive thing the
        // engine holds, so it survives typing-along exactly like the others —
        // narrowing must never silently re-bill an agent turn.
        this.manualSuggestions = this.manualSuggestions.filter((s) => extendsDraft(s.text, draft))
        this.setCandidates(survivors)
        this.onChange()
        return
      }
    }

    // The draft moved somewhere the current candidates don't cover. Drop them
    // (so no stale ghost is painted), then rebuild both tiers.
    this.syncSuggestions = []
    this.asyncSuggestions = []
    this.manualSuggestions = []
    this.pinnedText = null
    this.setCandidates([])
    this.cancelAsync()
    // Keep an in-flight manual run whose answer can still apply: the user asked
    // for it and is typing forward while it works, which is the normal thing to
    // do on a slow turn. `merge` drops the answer if it turns out not to extend
    // the draft after all, so keeping it can only help.
    if (this.manualDraft === null || !draft.startsWith(this.manualDraft)) this.cancelManual()
    this.cancelTimer()

    void this.runSyncProviders(draft)

    if (this.asyncProviders.length > 0) {
      const cached = this.readCache(this.cache, draft)
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

  /**
   * Run the `manual` providers for the current draft, right now.
   *
   * This is the explicitly-requested tier: the surface binds it to a key, so
   * the user — not a timer — decides when to spend an agent turn. Results are
   * merged and ranked alongside whatever the cheap tiers already produced, so
   * pressing the key while a history hit is showing adds a candidate to cycle
   * to rather than replacing what is on screen.
   *
   * A no-op when no manual provider is registered, when the draft is below the
   * length floor, or when a manual query for this exact draft is already in
   * flight — the last of which matters because the binding is a key the user
   * can lean on.
   */
  requestManual(): void {
    if (this.disposed) return
    if (this.manualProviders.length === 0) return
    if (this.draft.trim().length < this.minChars) return
    if (this.manualPending) return

    const draft = this.draft
    const cached = this.readCache(this.manualCache, draft)
    if (cached !== undefined) {
      this.manualSuggestions = cached
      this.merge()
      this.onChange()
      return
    }

    this.manualPending = true
    this.manualDraft = draft
    this.onChange()
    void this.runManualProviders(draft)
  }

  getView(): InlineEngineView {
    const manualAvailable = this.manualProviders.length > 0
    const suggestion = this.candidates[this.index] ?? null
    if (!suggestion) {
      // Reuse the last empty view when nothing about it changed. Both surfaces
      // push this straight into `setState`, so allocating a fresh object every
      // call would re-render the composer on every no-op notification — React
      // bails out on identity, and "no suggestion" is by far the common case.
      const cached = this.emptyView
      if (
        cached !== null &&
        cached.pending === this.pending &&
        cached.manualAvailable === manualAvailable &&
        cached.manualPending === this.manualPending
      ) {
        return cached
      }
      const next: InlineEngineView = {
        ...EMPTY_VIEW,
        pending: this.pending,
        manualAvailable,
        manualPending: this.manualPending,
      }
      this.emptyView = next
      return next
    }
    return {
      ghost: ghostSuffix(suggestion.text, this.draft),
      suggestion,
      candidates: this.candidates,
      index: this.index,
      pending: this.pending,
      manualAvailable,
      manualPending: this.manualPending,
    }
  }

  /** The draft the engine currently believes is in the composer. */
  get currentDraft(): string {
    return this.draft
  }

  dispose(): void {
    this.disposed = true
    this.cancelAsync()
    this.cancelManual()
    this.cancelTimer()
    this.cache.clear()
    this.manualCache.clear()
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
    if (!results.some((r) => r.timedOut)) this.writeCache(this.cache, draft, flat)
    this.asyncSuggestions = flat
    this.pending = false
    if (this.asyncAbort === controller) this.asyncAbort = null
    this.merge()
    this.onChange()
  }

  /**
   * Run the manual providers for `draft`. Unlike the async tier there is no
   * debounce (the user already asked) and no shared timer — but the same
   * staleness, timeout, abort and cache discipline applies, because the work
   * behind an abandoned agent turn keeps billing if it is not cancelled.
   */
  private async runManualProviders(draft: string): Promise<void> {
    // No `cancelManual()` here: it clears `manualPending`, which `requestManual`
    // has just set, and there is nothing to cancel anyway — that same method
    // refuses to start a second run while one is in flight.
    const controller = new AbortController()
    this.manualAbort = controller
    const context = this.buildContext(draft)

    const results = await Promise.all(
      this.manualProviders.map((p) => this.callProvider(p, context, controller.signal, true))
    )

    if (this.disposed || controller.signal.aborted) return
    if (this.manualAbort === controller) this.manualAbort = null
    this.manualPending = false
    this.manualDraft = null

    // No `this.draft !== draft` guard here, unlike the async tier.
    //
    // That guard is how the async tier drops a stale answer, and it is right
    // there because `feed` cancels the async run on EVERY path. `feed` does not
    // cancel a manual run on the live-narrow path — typing forward along the
    // suggestion — precisely so the turn the user paid for still lands. Adding
    // the guard back would throw that answer away for typing two more
    // characters while waiting, which is the normal thing to do.
    //
    // A draft that moved somewhere the answer cannot apply is already handled
    // twice over: `feed` aborts this controller (caught above), and `merge`
    // ranks through `extendsDraft`, which drops anything that no longer extends
    // the current draft.
    const flat = results.flatMap((r) => r.suggestions)
    if (!results.some((r) => r.timedOut)) this.writeCache(this.manualCache, draft, flat)
    this.manualSuggestions = flat
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
      rankInlineSuggestions(
        [...this.syncSuggestions, ...this.asyncSuggestions, ...this.manualSuggestions],
        this.draft,
        { limit: this.maxCandidates }
      )
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
    this.manualSuggestions = []
    this.candidates = []
    this.index = 0
    this.pinnedText = null
    this.pending = false
    this.manualPending = false
    this.syncRun++
    this.cancelAsync()
    this.cancelManual()
    this.cancelTimer()
  }

  private cancelAsync(): void {
    if (this.asyncAbort) {
      this.asyncAbort.abort()
      this.asyncAbort = null
    }
  }

  private cancelManual(): void {
    if (this.manualAbort) {
      this.manualAbort.abort()
      this.manualAbort = null
    }
    this.manualPending = false
    this.manualDraft = null
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clear(this.timer)
      this.timer = null
    }
  }

  private readCache(cache: Map<string, CacheEntry>, draft: string): InlineSuggestion[] | undefined {
    const hit = cache.get(draft)
    if (!hit) return undefined
    if (this.clock() - hit.at > this.cacheTtlMs) {
      cache.delete(draft)
      return undefined
    }
    return hit.suggestions
  }

  private writeCache(
    cache: Map<string, CacheEntry>,
    draft: string,
    suggestions: InlineSuggestion[]
  ): void {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(draft, { suggestions, at: this.clock() })
  }
}
