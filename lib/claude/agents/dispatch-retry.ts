/**
 * Bounded-retry policy for `dispatch_agent` runs. Pure and host-agnostic
 * (no Dexie, no store imports) so the renderer handler and — later — the CLI
 * host can share one implementation.
 *
 * Conventions follow the Agent-Team retry (`resolveRetryPolicy` +
 * `computeBackoffMs` in the workflow engine, which are private to it):
 * attempts = retries + 1, exponential backoff, provider Retry-After honored.
 */

import type { PluginDispatchErrorEnvelope } from "@/types/plugin/plugin-agent-sdk"

export interface DispatchRetryPolicy {
  /** Retries AFTER the first attempt. 0 disables retrying entirely. */
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_DISPATCH_RETRY: DispatchRetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
}

/**
 * Backoff before retry N (1-based attempt that just failed): the provider's
 * Retry-After hint when present, else exponential from `baseDelayMs`; capped at
 * `maxDelayMs`, plus ≤10% jitter to de-synchronize parallel siblings.
 */
export function retryDelayMs(
  policy: DispatchRetryPolicy,
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random
): number {
  const base =
    retryAfterMs !== undefined && retryAfterMs > 0
      ? retryAfterMs
      : policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(policy.maxDelayMs, base)
  return Math.round(capped * (1 + random() * 0.1))
}

export interface ShouldRetryContext {
  /** 1-based attempt that just produced the envelope. */
  attempt: number
  policy: DispatchRetryPolicy
  signal: AbortSignal
  /** Absolute epoch-ms subtree deadline; a retry that can't fit is pointless. */
  deadlineMs?: number
  /** The backoff that WOULD be taken (from {@link retryDelayMs}). */
  nextDelayMs: number
  /** Fresh subtree-budget check, evaluated before every retry. */
  budgetExhausted: () => boolean
  now?: () => number
}

/**
 * Whether the failed attempt should be retried. False when the envelope is not
 * retryable (permission/auth/invalid-request/guard rejections/abort), the
 * retry allowance is spent, the caller aborted, the subtree deadline can't fit
 * the backoff, or the token budget is exhausted.
 */
export function shouldRetryDispatch(
  envelope: PluginDispatchErrorEnvelope,
  ctx: ShouldRetryContext
): boolean {
  if (!envelope.retryable) return false
  if (ctx.attempt > ctx.policy.maxRetries) return false
  if (ctx.signal.aborted) return false
  const now = ctx.now ?? Date.now
  if (ctx.deadlineMs !== undefined && now() + ctx.nextDelayMs >= ctx.deadlineMs) return false
  if (ctx.budgetExhausted()) return false
  return true
}

/**
 * Abort-aware sleep: resolves after `ms`, or immediately when the signal
 * aborts (never rejects — the caller re-checks `signal.aborted` after).
 */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
