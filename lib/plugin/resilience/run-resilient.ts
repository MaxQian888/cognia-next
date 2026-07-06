/**
 * The plugin resilience composition primitive: timeout → retry(backoff) →
 * circuit breaker, built entirely from REUSED parts:
 *   - timeout bound:   `lib/utils/with-timeout.ts:withTimeout`
 *   - abort linking:   `lib/connectivity/capacitor-http.ts:combineAbortSignals`
 *                      + native `AbortSignal.timeout` (guarded for jsdom)
 *   - backoff math:    `lib/queue/retry-policy.ts:backoffDelayMs`
 *   - classification:  `./error-classify`
 *   - breaker:         injected `CircuitBreaker` (the reused connector impl)
 *
 * No breaker, timeout, or abort logic is reimplemented here — only the glue.
 */

import { combineAbortSignals } from "@/lib/connectivity/capacitor-http"
import type { CircuitBreaker } from "@/lib/connectors/circuit-breaker"
import { backoffDelayMs } from "@/lib/queue/retry-policy"
import { withTimeout } from "@cognia/primitives"

import { classifyResilienceError, isRetryableKind } from "./error-classify"

/** Thrown when the breaker is open and the call is rejected without running. */
export class CircuitOpenError extends Error {
  constructor(public readonly key: string) {
    super(`circuit breaker open: ${key}`)
    this.name = "CircuitOpenError"
  }
}

export interface RunResilientOptions {
  /** Per-attempt wall-clock budget (ms). */
  timeoutMs: number
  /** Extra attempts after the first. Ignored (forced 0) when `retryable` is false. */
  maxRetries: number
  /** Master retry opt-in — false ⇒ single attempt (non-idempotency guard). */
  retryable: boolean
  /** The breaker gating this call (from the registry). */
  breaker: CircuitBreaker
  /** Human label used for TimeoutError + CircuitOpenError messages. */
  label: string
  /** Caller abort signal — forwarded to the work and honored between retries. */
  signal?: AbortSignal
  /** Injected RNG for deterministic backoff in tests. */
  random?: () => number
  /** Injected sleep for deterministic backoff in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Telemetry breadcrumb fired before each attempt (1-based). */
  onAttempt?: (attempt: number) => void
  /**
   * Optional domain override for retryability of non-timeout/non-abort errors.
   * Returns false to force an error to be treated as fatal (no retry). Used by
   * plugin LOAD to skip retrying permanent errors ("does not export", "unknown
   * plugin type", signature) that the generic classifier would treat as
   * transient.
   */
  isRetryable?: (err: unknown) => boolean
}

function makeAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new DOMException("The operation was aborted.", "AbortError")
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(makeAbortError(signal))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Build the signal handed to the work: caller abort ∪ a timeout-driven abort. */
function buildAttemptSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const ctor = AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }
  const hasTimeout =
    typeof ctor.timeout === "function" && Number.isFinite(timeoutMs) && timeoutMs > 0
  const timeoutSignal = hasTimeout ? ctor.timeout!(timeoutMs) : undefined
  if (callerSignal && timeoutSignal) return combineAbortSignals(callerSignal, timeoutSignal)
  if (callerSignal) return callerSignal
  if (timeoutSignal) return timeoutSignal
  // Neither available → a never-aborting signal so the work still gets one.
  return new AbortController().signal
}

export async function runResilient<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RunResilientOptions
): Promise<T> {
  if (opts.signal?.aborted) throw makeAbortError(opts.signal)

  // Checked once, before any attempt — an open breaker rejects fast.
  if (!opts.breaker.canPass()) throw new CircuitOpenError(opts.label)

  const sleep = opts.sleep ?? defaultSleep
  const extraRetries = opts.retryable ? Math.max(0, opts.maxRetries) : 0

  let lastError: unknown
  for (let attempt = 0; attempt <= extraRetries; attempt++) {
    if (opts.signal?.aborted) throw makeAbortError(opts.signal)
    opts.onAttempt?.(attempt + 1)

    const attemptSignal = buildAttemptSignal(opts.signal, opts.timeoutMs)
    const work = fn(attemptSignal)
    // Swallow a late rejection from the work that loses the timeout race, so
    // it never surfaces as an unhandled rejection.
    void work.catch(() => {})

    try {
      const result = await withTimeout(work, opts.timeoutMs, opts.label)
      opts.breaker.recordSuccess()
      return result
    } catch (err) {
      lastError = err
      let kind = classifyResilienceError(err)
      // A timeout-driven abort (our own signal) surfaces as AbortError but is
      // NOT a caller abort — reclassify so it counts as a retryable timeout.
      if (kind === "aborted" && !opts.signal?.aborted) kind = "timeout"
      // Domain override: let the caller force a transient-looking error fatal.
      if ((kind === "retryable" || kind === "fatal") && opts.isRetryable) {
        kind = opts.isRetryable(err) ? "retryable" : "fatal"
      }

      if (kind === "aborted") throw err // genuine caller abort — never our fault, never retried

      opts.breaker.recordFailure()

      if (!isRetryableKind(kind) || attempt >= extraRetries) throw err

      await sleep(backoffDelayMs(attempt + 1, opts.random), opts.signal)
    }
  }
  // Unreachable in practice (loop either returns or throws), but keeps TS happy.
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
