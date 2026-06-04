/**
 * Autocomplete controller — the React-free orchestration brain behind the
 * terminal's inline ghost text and the multi-candidate popup.
 *
 * It consumes the keystroke stream (via `feed`), maintains the local line
 * model (`line-buffer`), debounces a fan-out query to the completion
 * registry, and tracks the ranked candidate list. The view (`getView`)
 * exposes the ghost suffix plus the popup state to render. Acceptance
 * (`accept` / `acceptSelected`) returns the {@link AcceptEdit} the caller
 * must apply to the PTY (backspaces for a replaced span, then the insert
 * text) and advances the line model.
 *
 * Kept out of React so the debounce / cancellation / staleness / list
 * logic is unit-testable with an injected scheduler + query.
 */

import { feedInput, isSuggestible, resetLine, type LineState } from "./line-buffer"
import { resolveSuggestionEdit } from "./prompt"
import { getCompletions } from "./registry"
import type { AcceptEdit, TerminalCompletionContext, TerminalCompletionSuggestion } from "./types"

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
  /** The suggestion the ghost text comes from, or null. */
  ghostSuggestion: TerminalCompletionSuggestion | null
  /** Whether the candidate popup is open. */
  listOpen: boolean
  /** Ranked candidates for the popup (empty when none resolved). */
  candidates: TerminalCompletionSuggestion[]
  /** Index of the highlighted candidate while the popup is open. */
  selectedIndex: number
}

export class AutocompleteController {
  private line: LineState = resetLine()
  private candidates: TerminalCompletionSuggestion[] = []
  private selected = 0
  private listOpen = false
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
      this.clearCandidates()
      this.listOpen = false
      this.cancelQuery()
      this.cancelTimer()
      this.onChange()
      return
    }

    // Re-resolve the surviving candidates against the (changed) input. A
    // candidate survives when accepting it still yields a valid edit that
    // doesn't drop what the user just typed.
    const survivors = this.candidates.filter(
      (s) => resolveSuggestionEdit(this.line.text, s) !== null
    )
    if (survivors.length !== this.candidates.length) {
      const keep = this.candidates[this.selected]
      this.candidates = survivors
      const idx = keep ? survivors.indexOf(keep) : -1
      this.selected = idx >= 0 ? idx : 0
    }

    if (this.candidates.length > 0) {
      // Something useful is still on screen — keep it, no re-query (the
      // popup narrows live as the user types toward a candidate).
      this.onChange()
      return
    }

    // Otherwise everything went stale: close the popup and re-query.
    this.listOpen = false
    this.scheduleQuery()
    this.onChange()
  }

  /** Prompt boundary (OSC 633 command_start / cwd reset). */
  reset(): void {
    this.line = resetLine()
    this.clearCandidates()
    this.listOpen = false
    this.cancelQuery()
    this.cancelTimer()
    this.onChange()
  }

  /**
   * Accept the ghost suggestion (the top pure-suffix candidate). Returns
   * the edit the caller must apply to the PTY (it never auto-submits), or
   * null when there's nothing to accept.
   */
  accept(): AcceptEdit | null {
    return this.acceptSuggestion(this.ghostCandidate())
  }

  /** Accept the highlighted popup candidate. */
  acceptSelected(): AcceptEdit | null {
    if (!this.listOpen) return null
    return this.acceptSuggestion(this.candidates[this.selected] ?? null)
  }

  /** Open the candidate popup (Ctrl+Space / second Tab). */
  openList(): void {
    if (!isSuggestible(this.line)) return
    if (this.listOpen) return
    this.listOpen = true
    this.selected = 0
    if (this.candidates.length === 0) {
      // Nothing resolved yet — query immediately instead of waiting out
      // the debounce so the popup feels intentional.
      this.cancelTimer()
      void this.runQuery()
    }
    this.onChange()
  }

  /** Close the candidate popup, keeping the ghost suggestion. */
  closeList(): void {
    if (!this.listOpen) return
    this.listOpen = false
    this.selected = 0
    this.onChange()
  }

  /** Move the popup highlight by `delta`, wrapping at both ends. */
  moveSelection(delta: number): void {
    if (!this.listOpen || this.candidates.length === 0) return
    const n = this.candidates.length
    this.selected = (((this.selected + delta) % n) + n) % n
    this.onChange()
  }

  /** Dismiss everything (Esc): popup first, then the ghost suggestion. */
  dismiss(): void {
    this.clearCandidates()
    this.listOpen = false
    this.cancelQuery()
    this.cancelTimer()
    this.onChange()
  }

  getView(): AutocompleteView {
    const ghostCandidate = this.listOpen ? null : this.ghostCandidate()
    const edit = ghostCandidate ? resolveSuggestionEdit(this.line.text, ghostCandidate) : null
    return {
      ghost: edit && edit.from === this.line.text.length ? edit.insert : "",
      ghostSuggestion: ghostCandidate,
      listOpen: this.listOpen && this.candidates.length > 0,
      candidates: this.candidates,
      selectedIndex: this.selected,
    }
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

  /** The top-ranked candidate renderable as inline ghost text. */
  private ghostCandidate(): TerminalCompletionSuggestion | null {
    if (!isSuggestible(this.line)) return null
    for (const s of this.candidates) {
      const edit = resolveSuggestionEdit(this.line.text, s)
      if (edit && edit.from === this.line.text.length) return s
    }
    return null
  }

  private acceptSuggestion(suggestion: TerminalCompletionSuggestion | null): AcceptEdit | null {
    if (!suggestion || !isSuggestible(this.line)) return null
    const edit = resolveSuggestionEdit(this.line.text, suggestion)
    if (!edit) return null
    const backspaces = this.line.text.length - edit.from
    this.line = { text: edit.result, cursor: edit.result.length, tracked: true }
    this.clearCandidates()
    this.listOpen = false
    this.cancelQuery()
    this.cancelTimer()
    this.onChange()
    return { backspaces, write: edit.insert }
  }

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
      this.candidates = results.filter((s) => resolveSuggestionEdit(input, s) !== null)
      this.selected = 0
      if (this.listOpen && this.candidates.length === 0) this.listOpen = false
      this.onChange()
    })()
  }

  private clearCandidates(): void {
    this.candidates = []
    this.selected = 0
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
