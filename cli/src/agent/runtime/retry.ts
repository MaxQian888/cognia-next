/**
 * Safe automatic retries for a headless turn.
 *
 * The rule that makes this safe is not the backoff — it is the SIDE-EFFECT
 * BOUNDARY. A turn may be replayed only while it has done nothing the world can
 * observe: no tool call, no byte of assistant output, no external mutation.
 * Once any of those has happened, replaying the turn would run the tool twice
 * or print the answer twice, so the failure becomes terminal and is reported
 * as-is. `markSideEffect()` is how the runtime moves that boundary, and it is
 * one-way.
 *
 * Only transient provider/transport failures qualify. A 400, an auth failure,
 * or a permission denial is a fact about the request, and retrying it just
 * spends the user's money to be told the same thing three times.
 */

import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"

/** Spec default: at most two retries (three attempts total). */
export const DEFAULT_MAX_RETRIES = 2

/** First backoff step. Doubles per attempt, jittered, capped. */
export const BASE_BACKOFF_MS = 500

/** Never sleep longer than this between attempts, whatever the exponent says. */
export const MAX_BACKOFF_MS = 30_000

/**
 * Cap on an honored `Retry-After`. A server asking us to wait ten minutes is
 * asking for something a headless turn cannot give it — we surface the failure
 * instead of hanging past every sensible CI timeout.
 */
export const MAX_RETRY_AFTER_MS = 60_000

export interface RetryPolicy {
  /** 0 disables retries entirely (`--no-retry`). */
  maxRetries: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  /** Deterministic jitter source in tests; defaults to `Math.random`. */
  random?: () => number
}

export function resolveRetryPolicy(
  policy?: Partial<RetryPolicy>
): Required<Omit<RetryPolicy, "random">> & { random: () => number } {
  const maxRetries = policy?.maxRetries ?? DEFAULT_MAX_RETRIES
  return {
    maxRetries: Math.max(0, Math.floor(maxRetries)),
    baseBackoffMs: policy?.baseBackoffMs ?? BASE_BACKOFF_MS,
    maxBackoffMs: policy?.maxBackoffMs ?? MAX_BACKOFF_MS,
    random: policy?.random ?? Math.random,
  }
}

/**
 * Error codes that describe a TRANSIENT condition — the same request may
 * succeed later. Everything else is a fact about the request itself.
 */
const RETRYABLE_CODES = new Set<AgentStructuredError["code"]>(["provider_error", "transport_error"])

/** HTTP statuses worth another attempt. 429 and the 5xx family, minus 501. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false
  if (status === 429) return true
  return status >= 500 && status !== 501
}

export interface FailureSignal {
  code: AgentStructuredError["code"]
  message: string
  /** HTTP status, when the failure came from an HTTP boundary. */
  status?: number
  /** Server-advertised `Retry-After`, in seconds or as an HTTP-date. */
  retryAfter?: string | number
  /** Explicit override from the provider adapter; wins over the code table. */
  retryable?: boolean
}

/**
 * Parse `Retry-After` (delta-seconds or HTTP-date) into milliseconds.
 * Returns null when absent or unparsable — never a guess.
 */
export function parseRetryAfter(
  value: string | number | undefined,
  now: number = Date.now()
): number | null {
  if (value === undefined) return null
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const asDate = Date.parse(trimmed)
  if (Number.isNaN(asDate)) return null
  // A date in the past means "you may retry now", not "travel backwards".
  return Math.max(0, asDate - now)
}

export type RetryDecision =
  | { retry: false; reason: "side-effect" | "not-retryable" | "exhausted" }
  | { retry: true; delayMs: number; retryAfterMs?: number }

export interface RetryDecisionInput {
  failure: FailureSignal
  /** Retries already performed (0 on the first failure). */
  attempt: number
  /** True once the turn has produced output, called a tool, or mutated state. */
  sideEffectPerformed: boolean
  policy: RetryPolicy
  now?: number
}

/**
 * Decide whether to retry, and for how long to wait.
 *
 * The order of the checks is the point: the side-effect boundary is tested
 * FIRST, before retryability and before the attempt budget, so no future edit
 * to the code tables can accidentally re-enable replay after a tool has run.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  if (input.sideEffectPerformed) return { retry: false, reason: "side-effect" }

  const retryable =
    input.failure.retryable ??
    (RETRYABLE_CODES.has(input.failure.code) || isRetryableStatus(input.failure.status))
  if (!retryable) return { retry: false, reason: "not-retryable" }

  const policy = resolveRetryPolicy(input.policy)
  if (input.attempt >= policy.maxRetries) return { retry: false, reason: "exhausted" }

  const retryAfterMs = parseRetryAfter(input.failure.retryAfter, input.now)
  if (retryAfterMs !== null) {
    // An unreasonably long Retry-After is not honored silently — it fails the
    // turn rather than parking a headless process past its own deadline.
    if (retryAfterMs > MAX_RETRY_AFTER_MS) return { retry: false, reason: "not-retryable" }
    return { retry: true, delayMs: retryAfterMs, retryAfterMs }
  }

  // Full jitter over an exponentially growing window: the deterministic part
  // spreads load, the random part keeps a thundering herd from re-synchronizing.
  const window = Math.min(policy.baseBackoffMs * 2 ** input.attempt, policy.maxBackoffMs)
  return { retry: true, delayMs: Math.round(window * policy.random()) }
}

export interface SideEffectTracker {
  /** True once anything observable has happened this attempt. */
  readonly performed: boolean
  /** Record an irreversible step. One-way — there is no `unmark`. */
  mark(reason: string): void
  /** What first crossed the boundary, for the failure detail. */
  readonly reason: string | null
}

export function createSideEffectTracker(): SideEffectTracker {
  let reason: string | null = null
  return {
    get performed() {
      return reason !== null
    },
    get reason() {
      return reason
    },
    mark(next) {
      if (reason === null) reason = next
    },
  }
}

/**
 * Sleep that resolves early — and rejects — when the signal aborts.
 *
 * A backoff that ignores cancellation is why `^C` during a retry appears to
 * hang: the process sits in a timer nobody can interrupt. The timer is cleared
 * on both paths so no handle outlives the wait.
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(newAbortError(signal))
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(newAbortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function newAbortError(signal?: AbortSignal): Error {
  const error = new Error(
    typeof signal?.reason === "string" ? signal.reason : "the turn was cancelled"
  )
  error.name = "AbortError"
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
