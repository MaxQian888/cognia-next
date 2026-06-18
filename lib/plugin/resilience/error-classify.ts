/**
 * Plugin-failure classifier for the resilience layer.
 *
 * Thin domain-specific mapping layered on the reused
 * `lib/queue/retry-policy.ts:isRetryable` (sentinel 4xx/validation patterns).
 * It distinguishes the four outcomes the retry loop cares about:
 *
 *   - "timeout"   — our own `TimeoutError` fired; the wait gave up. Retryable.
 *   - "aborted"   — the caller's AbortSignal fired (DOMException AbortError /
 *                   a thrown abort). Never the plugin's fault → never retried.
 *   - "fatal"     — permission/validation/4xx-class; retrying can't help.
 *   - "retryable" — transient (network/5xx/unknown) → eligible for retry.
 *
 * Imports only `TimeoutError` + `isRetryable` — no dependency on
 * `invoke-plugin-tool` (which consumes this module), so there is no cycle.
 */

import { isRetryable } from "@/lib/queue/retry-policy"
import { TimeoutError } from "@/lib/utils/with-timeout"

export type ResilienceErrorKind = "retryable" | "fatal" | "timeout" | "aborted"

/** True when the error represents a caller-initiated abort. */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (err instanceof Error && err.name === "AbortError") return true
  return false
}

export function classifyResilienceError(err: unknown): ResilienceErrorKind {
  if (err instanceof TimeoutError) return "timeout"
  if (isAbortError(err)) return "aborted"
  // Fall through to the shared sentinel classifier: unauthorized/4xx/
  // validation/schema → not retryable (fatal); everything else transient.
  return isRetryable(err) ? "retryable" : "fatal"
}

/** Convenience: the loop should re-attempt only on these kinds. */
export function isRetryableKind(kind: ResilienceErrorKind): boolean {
  return kind === "retryable" || kind === "timeout"
}
