/**
 * Post-stream finish-reason policy for the standalone BYOK engine, modeled on
 * opencode v1.18.20/.21: a provider that ends the stream on `network_error`,
 * `error`, or a finish reason the SDK cannot map (`other`/`unknown`, which is
 * where novel vendor values land) has not given a definitive answer. Such a
 * turn may be retried — but only while nothing was committed to the
 * transcript. Once any text/tool output has streamed, accepting the partial
 * answer is the safe end: re-sending would duplicate visible content.
 *
 * Same-provider retries reuse the shared backoff (jittered, capped). This is
 * deliberately a different mechanism from `RoutingAttemptController`'s
 * cross-provider fallback: a transport-level retry does not consume a
 * routing candidate.
 */

import { backoffDelayMs } from "@/lib/queue/retry-policy"

/** Retries after the first attempt, not counting it. */
export const FINISH_RETRY_MAX_ATTEMPTS = 2

const RETRYABLE_FINISH_REASONS: ReadonlySet<string> = new Set([
  "network_error",
  "error",
  "other",
  "unknown",
])

/**
 * True when `reason` names a non-answer finish worth one more attempt. Vendor
 * spellings vary (`network_error` vs `network-error`), so compare
 * case-insensitively with `-`/`_` folded together.
 */
export function isRetryableFinishReason(reason: string | null | undefined): boolean {
  if (reason == null) return false
  return RETRYABLE_FINISH_REASONS.has(reason.toLowerCase().replace(/-/g, "_"))
}

/** Jittered delay before the `retryIndex`-th retry (1-based). */
export function finishRetryDelayMs(retryIndex: number, random?: () => number): number {
  return backoffDelayMs(retryIndex, random)
}
