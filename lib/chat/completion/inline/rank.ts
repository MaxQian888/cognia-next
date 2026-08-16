/**
 * Pure merge / filter / dedupe / rank for inline suggestions — the chat-composer
 * cousin of `rankSuggestions` in `lib/terminal/completion/registry.ts`.
 *
 * Kept in its own module (rather than inside the engine) so the ordering rules
 * are unit-testable without timers, providers, or a model, exactly as the
 * terminal subsystem does it.
 */

import {
  DEFAULT_INLINE_MAX_CANDIDATES,
  DEFAULT_INLINE_SCORE,
  INLINE_SOURCE_PRIORITY,
  type InlineSuggestion,
} from "./types"

export interface RankInlineOptions {
  /** Maximum candidates kept. Defaults to {@link DEFAULT_INLINE_MAX_CANDIDATES}. */
  limit?: number
}

/**
 * Whether `suggestion` is a usable completion of `draft`: it must extend the
 * draft strictly (so there is a non-empty ghost to render) and preserve every
 * typed character (so accepting never rewrites what the user wrote).
 *
 * Exported because both the engine's live-narrow path and the providers' own
 * self-checks need the identical predicate — a provider that disagrees with the
 * engine about what "extends the draft" means produces suggestions that are
 * silently dropped, which is far harder to debug than a shared helper.
 */
export function extendsDraft(text: string, draft: string): boolean {
  return text.length > draft.length && text.startsWith(draft)
}

/** The dim tail rendered after the caret for `suggestion` against `draft`. */
export function ghostSuffix(text: string, draft: string): string {
  return extendsDraft(text, draft) ? text.slice(draft.length) : ""
}

/**
 * Filter `suggestions` to those that validly extend `draft`, drop duplicates
 * (same resulting text), and order them best-first: source priority, then
 * score, then the original arrival order.
 *
 * The sort is stable with respect to the input array, so a provider listed
 * earlier wins ties — which makes the result deterministic for a fixed provider
 * ordering, a property the engine's candidate cycling relies on.
 */
export function rankInlineSuggestions(
  suggestions: readonly InlineSuggestion[],
  draft: string,
  options: RankInlineOptions = {}
): InlineSuggestion[] {
  const limit = options.limit ?? DEFAULT_INLINE_MAX_CANDIDATES

  const kept: { suggestion: InlineSuggestion; index: number }[] = []
  suggestions.forEach((suggestion, index) => {
    if (!extendsDraft(suggestion.text, draft)) return
    kept.push({ suggestion, index })
  })

  kept.sort((a, b) => {
    const priority =
      INLINE_SOURCE_PRIORITY[b.suggestion.source] - INLINE_SOURCE_PRIORITY[a.suggestion.source]
    if (priority !== 0) return priority
    const score =
      (b.suggestion.score ?? DEFAULT_INLINE_SCORE) - (a.suggestion.score ?? DEFAULT_INLINE_SCORE)
    if (score !== 0) return score
    return a.index - b.index
  })

  const seen = new Set<string>()
  const out: InlineSuggestion[] = []
  for (const { suggestion } of kept) {
    if (seen.has(suggestion.text)) continue
    seen.add(suggestion.text)
    out.push(suggestion)
    if (out.length >= limit) break
  }
  return out
}
