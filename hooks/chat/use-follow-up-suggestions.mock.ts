// Storybook-only mock for `useFollowUpSuggestions`. The real hook calls a
// utility LLM (gated by `hasNoLeakingPii`) to generate follow-up chips, which
// must never fire in an isolated preview. `.storybook/main.ts` aliases the real
// module to this file; the story drives the returned value via `__setFollowUps`.
import type { UseFollowUpSuggestionsResult } from "./use-follow-up-suggestions"

let value: UseFollowUpSuggestionsResult = {
  suggestions: [],
  loading: false,
  dismiss: () => {},
}

/** Set the value the mocked hook returns (call in a story decorator). */
export function __setFollowUps(next: UseFollowUpSuggestionsResult): void {
  value = next
}

export function useFollowUpSuggestions(): UseFollowUpSuggestionsResult {
  return value
}
