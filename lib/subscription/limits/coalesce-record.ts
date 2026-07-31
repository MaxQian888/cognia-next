// Shared result-recording block for the two limits coalescers (the built-in
// account path in `coalesce.ts` and the user-defined custom sources in
// `custom/runner.ts`). Both fold a completed query the same way — remember the
// last good meters, carry them forward on a later error, arm the 429 backoff,
// and stamp the replayable snapshot — so the logic (and the 429 matcher) lives
// here once instead of drifting between two near-identical copies.

import type { ProviderLimits } from "@/types/subscription"

/** Mutable coalescer fields both runner entries share. */
export interface CoalesceResultState {
  /** Hard block after a provider rate-limit response. */
  blockedUntil: number
  /** Result of the last completed attempt, replayed while throttled. */
  lastResult: ProviderLimits | null
  /** Last snapshot that carried meters without an error. */
  lastSuccessfulResult: ProviderLimits | null
}

/**
 * True when a limits query's error string denotes an HTTP 429. Matches `429`
 * as a standalone token — preceded by start-of-string or whitespace and
 * followed by whitespace, a colon, or end-of-string — so both
 * "429 Too Many Requests" and a trailing "HTTP 429" arm the backoff, while a
 * lookalike such as "4290" or "not429" does not.
 */
export function isRateLimitError(error: string): boolean {
  return /(^|\s)429(\s|:|$)/.test(error)
}

/**
 * Fold a completed query result into the coalescer state and return the
 * snapshot the caller should surface: keep the freshest good meters, carry them
 * forward when a later attempt only has an error (so the panel keeps rendering
 * data), arm the 429 backoff, and record `lastResult` for throttled replay.
 */
export function applyCoalescedResult(
  state: CoalesceResultState,
  result: ProviderLimits | null,
  now: () => number,
  backoffMs: number
): ProviderLimits | null {
  let displayResult = result
  if (result && !result.error) {
    state.lastSuccessfulResult = result
  } else if (result?.error && state.lastSuccessfulResult) {
    displayResult = { ...result, meters: state.lastSuccessfulResult.meters }
  }
  if (result?.error && isRateLimitError(result.error)) {
    state.blockedUntil = now() + backoffMs
  }
  state.lastResult = displayResult
  return displayResult
}
