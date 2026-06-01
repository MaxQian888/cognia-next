/**
 * Autocomplete controller — the React-free orchestration brain behind the
 * terminal's inline ghost text.
 *
 * It consumes the keystroke stream (via `feed`), maintains the local line
 * model (`line-buffer`), debounces a fan-out query to the completion
 * registry, and tracks the active suggestion. The view (`getView`) exposes
 * the ghost suffix to render. Acceptance (`accept`) returns the suffix the
 * caller should write into the PTY and advances the line model.
 *
 * Kept out of React so the debounce / cancellation / staleness logic is
 * unit-testable with an injected scheduler + query.
 */

import { feedInput, isSuggestible, resetLine, type LineState } from "./line-buffer"
import { ghostSuffix } from "./prompt"
import { getCompletions } from "./registry"
import type { TerminalCompletionContext, TerminalCompletionSuggestion } from "./types"

export interface AutocompleteScheduler {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realScheduler: AutocompleteScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface AutocompleteControllerOptions {
  debounceMs?: number
  /** Build the query context from the current input; null → skip the query. */
  getContext: (input: string) => TerminalCompletionContext | null
  /** Notified (zero-arg) whenever the rendered view may have changed. */
  onChange: () => void
  /** Provider fan-out. Defaults to the shared completion registry. */
  query?: (
    ctx: TerminalCompletionContext,
    signal: AbortSignal
  ) => Promise<TerminalCompletionSuggestion[]>
  scheduler?: AutocompleteScheduler
}

export interface AutocompleteView {
  /** Dim text rendered after the cursor (empty when nothing to show). */
  ghost: string
  /** The active suggestion, or null. */
  suggestion: TerminalCompletionSuggestion | null
}

export class AutocompleteController {
  private line: LineState = resetLine()
  private suggestion: TerminalCompletionSuggestion | null = null
  private timer: unknown = null
  private ac: AbortController | null = null

  private readonly debounceMs: number
  private readonly getContext: AutocompleteControllerOptions["getContext"]
  private readonly onChange: () => void
  private readonly query: NonNullable<AutocompleteControllerOptions["query"]>
  private readonly scheduler: AutocompleteScheduler

  constructor(opts: AutocompleteControllerOptions) {
    this.debounceMs = opts.debounceMs ?? 350
    this.getContext = opts.getContext
    this.onChange = opts.onChange
    this.query = opts.query ?? ((ctx, signal) => getCompletions(ctx, signal))
    this.scheduler = opts.scheduler ?? realScheduler
  }

  /** Feed one input chunk (the string xterm's `onData` emitted). */
  feed(chunk: string): void {
    this.line = feedInput(this.line, chunk)

    if (!isSuggestible(this.line)) {
      // Submit/cancel/cursor-move/untracked — nothing to suggest.
      this.clearSuggestion()
      this.cancelQuery()
      this.cancelTimer()
      this.onChange()
      return
    }

    // Keep an existing suggestion that still extends the (longer) input.
    if (
      this.suggestion &&
      this.suggestion.text.startsWith(this.line.text) &&
      this.suggestion.text.length > this.line.text.length
    ) {
      this.onChange()
      return
    }

    // Otherwise drop the stale suggestion and (re)schedule a fresh query.
    this.clearSuggestion()
    this.scheduleQuery()
    this.onChange()
  }

  /** Prompt boundary (OSC 633 command_start / cwd reset). */
  reset(): void {
    this.line = resetLine()
    this.clearSuggestion()
    this.cancelQuery()
    this.cancelTimer()
    this.onChange()
  }

  /**
   * Accept the active suggestion. Returns the ghost suffix the caller must
   * write into the PTY (it never auto-submits), or null when there's
   * nothing to accept.
   */
  accept(): string | null {
    if (!this.suggestion || !isSuggestible(this.line)) return null
    const suffix = ghostSuffix(this.suggestion.text, this.line.text)
    if (!suffix) return null
    this.line = {
      text: this.suggestion.text,
      cursor: this.suggestion.text.length,
      tracked: true,
    }
    this.clearSuggestion()
    this.cancelQuery()
    this.cancelTimer()
    this.onChange()
    return suffix
  }

  /** Dismiss the current suggestion (Esc). */
  dismiss(): void {
    this.clearSuggestion()
    this.cancelQuery()
    this.cancelTimer()
    this.onChange()
  }

  getView(): AutocompleteView {
    if (
      this.suggestion &&
      isSuggestible(this.line) &&
      this.suggestion.text.startsWith(this.line.text)
    ) {
      return {
        ghost: this.suggestion.text.slice(this.line.text.length),
        suggestion: this.suggestion,
      }
    }
    return { ghost: "", suggestion: null }
  }

  /** The current tracked input line (for diagnostics / tests). */
  get input(): string {
    return this.line.text
  }

  dispose(): void {
    this.cancelQuery()
    this.cancelTimer()
  }

  // --- internals ---------------------------------------------------------

  private scheduleQuery(): void {
    this.cancelTimer()
    this.timer = this.scheduler.set(() => this.runQuery(), this.debounceMs)
  }

  /** Returns the in-flight promise so tests can await it after flushing. */
  private runQuery(): Promise<void> {
    this.timer = null
    this.cancelQuery()
    const input = this.line.text
    const ctx = this.getContext(input)
    if (!ctx) return Promise.resolve()

    const ac = new AbortController()
    this.ac = ac
    return (async () => {
      let results: TerminalCompletionSuggestion[]
      try {
        results = await this.query(ctx, ac.signal)
      } catch {
        results = []
      }
      if (ac.signal.aborted) return
      // Staleness guard: ignore if the input moved on while we waited.
      if (this.line.text !== input || !isSuggestible(this.line)) return
      const best =
        results.find((s) => s.text.startsWith(input) && s.text.length > input.length) ?? null
      this.suggestion = best
      this.onChange()
    })()
  }

  private clearSuggestion(): void {
    this.suggestion = null
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
}
