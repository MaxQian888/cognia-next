/**
 * History-backed inline completion — the local, zero-latency, zero-cost source
 * that makes both composers feel instant regardless of whether an LLM provider
 * is configured.
 *
 * This replaces the TUI's original "first history entry that starts with the
 * buffer wins" scan (`cli/src/tui/input/autosuggest.ts`), which had three
 * problems worth naming, because they are exactly what the scoring below fixes:
 *
 *   1. *No frequency signal.* A one-off typo typed 2 minutes ago beat a prompt
 *      the user has sent twenty times, purely because it was newer.
 *   2. *Case-rigid.* Typing `fix ` never completed from `Fix the build`, even
 *      though that is plainly the intended entry.
 *   3. *No dedupe.* The same repeated prompt occupied every candidate slot, so
 *      there was nothing to cycle to.
 *
 * Ranking blends recency and frequency (the two signals shells actually use)
 * into a single [0,1] score, so the engine can compare a history hit against an
 * LLM hit on one axis. Pure and deterministic — no clock, no I/O.
 */

import {
  DEFAULT_INLINE_MAX_CANDIDATES,
  type InlineCompletionContext,
  type InlineCompletionProvider,
  type InlineSuggestion,
} from "./types"
import { extendsDraft } from "./rank"

/** Provider id for the built-in history source. */
export const HISTORY_PROVIDER_ID = "builtin:history"

/** Weight of the recency signal in the blended score (frequency takes the rest). */
const RECENCY_WEIGHT = 0.6
/** Repeat count at which the frequency signal saturates. */
const FREQUENCY_SATURATION = 4
/**
 * Exact-case and case-folded hits are separate TIERS, not a scaled score: an
 * exact-case hit always outranks a folded one, and recency/frequency only order
 * candidates *within* a tier.
 *
 * A multiplier was tried first and behaved badly on short histories, where one
 * slot of recency is worth a large fraction of the range and could drag a
 * folded hit above an exact one. Tiering makes the rule statable —
 * "what you typed verbatim wins" — instead of dependent on history length.
 */
const EXACT_CASE_FLOOR = 0.5

export interface HistoryMatchOptions {
  /** Maximum matches returned. Defaults to {@link DEFAULT_INLINE_MAX_CANDIDATES}. */
  limit?: number
  /**
   * Permit completions whose tail spans multiple lines. The TUI composer keeps
   * this off (a multi-line ghost would break its single-row inline render);
   * the desktop textarea can afford it. Default false.
   */
  allowMultiline?: boolean
  /** Minimum trimmed draft length before anything is suggested. Default 1. */
  minChars?: number
}

/**
 * Rank the history entries that complete `draft`, best first.
 *
 * `history` is NEWEST FIRST (index 0 is the most recent submission), matching
 * both the reducer ring the TUI keeps and the order the desktop composer
 * stores. Returns full completed drafts — each is `draft` plus the historical
 * tail, so the caller can render `result.slice(draft.length)` as the ghost.
 */
export function rankHistoryMatches(
  draft: string,
  history: readonly string[],
  options: HistoryMatchOptions = {}
): InlineSuggestion[] {
  const limit = options.limit ?? DEFAULT_INLINE_MAX_CANDIDATES
  const minChars = options.minChars ?? 1
  if (draft.trim().length < minChars) return []

  // Source separation, inherited from the autosuggest this replaced: a command
  // draft is completed from command names, never from history. Every submitted
  // line lands in the history ring, slash lines included, so without this a
  // draft like `/add-dir /u` ghost-completes `/add-dir /usr/old-project` from a
  // previous session — and Tab-then-Enter runs a command the user did not
  // write. The command palette stops suppressing the moment a slash line gains
  // arguments, which is exactly when the stale tail is longest and the accepted
  // text is executable, so the guard has to live here.
  if (draft.startsWith("/")) return []

  const lowerDraft = draft.toLowerCase()

  // Collapse duplicates first: an entry repeated N times contributes ONE
  // candidate carrying its best (newest) position and its total count, so the
  // frequency signal exists at all and repeats don't crowd out alternatives.
  interface Entry {
    /** The completed draft this entry yields (always extends `draft`). */
    text: string
    /** Newest index in `history` — the recency signal. */
    firstIndex: number
    /** How many times the entry appears — the frequency signal. */
    count: number
    /** False when the entry only matched after lower-casing. */
    exactCase: boolean
  }
  const byText = new Map<string, Entry>()

  history.forEach((entry, index) => {
    if (entry.length <= draft.length) return

    const exactCase = entry.startsWith(draft)
    // A case-insensitive hit still has to preserve what the user typed, so the
    // suggestion keeps THEIR prefix and borrows only the historical tail.
    const text = exactCase
      ? entry
      : entry.toLowerCase().startsWith(lowerDraft)
        ? draft + entry.slice(draft.length)
        : null
    if (text === null) return
    if (!extendsDraft(text, draft)) return
    if (!options.allowMultiline && text.slice(draft.length).includes("\n")) return

    const existing = byText.get(text)
    if (existing) {
      existing.count += 1
      // `history` is newest-first, so a later loop index is strictly older;
      // the first sighting is already the newest and stays the recency anchor.
      existing.exactCase = existing.exactCase || exactCase
      return
    }
    byText.set(text, { text, firstIndex: index, count: 1, exactCase })
  })

  const span = Math.max(history.length, 1)
  const scored = Array.from(byText.values()).map((entry) => {
    const recency = 1 - entry.firstIndex / span
    const frequency = Math.min(1, (entry.count - 1) / FREQUENCY_SATURATION)
    const blended = RECENCY_WEIGHT * recency + (1 - RECENCY_WEIGHT) * frequency
    // Map the blended signal into this entry's tier: exact-case occupies the
    // upper half of the range, case-folded the lower half.
    const score = entry.exactCase
      ? EXACT_CASE_FLOOR + blended * (1 - EXACT_CASE_FLOOR)
      : blended * EXACT_CASE_FLOOR
    return { entry, score }
  })

  // Best score first; ties fall back to recency so the ordering is total and
  // deterministic (candidate cycling depends on a stable sequence).
  scored.sort((a, b) => b.score - a.score || a.entry.firstIndex - b.entry.firstIndex)

  return scored.slice(0, limit).map(({ entry, score }): InlineSuggestion => ({
    text: entry.text,
    source: "history",
    providerId: HISTORY_PROVIDER_ID,
    detail: "history",
    score,
  }))
}

/**
 * Build the built-in history provider. Synchronous (no I/O), so the engine runs
 * it on every keystroke without debouncing.
 */
export function createHistoryProvider(options: HistoryMatchOptions = {}): InlineCompletionProvider {
  return {
    id: HISTORY_PROVIDER_ID,
    label: "History",
    priority: 10,
    sync: true,
    async getCompletions(context: InlineCompletionContext): Promise<InlineSuggestion[]> {
      return rankHistoryMatches(context.draft, context.history, options)
    },
  }
}
