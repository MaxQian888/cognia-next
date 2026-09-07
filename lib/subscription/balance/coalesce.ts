// Single-flight, throttle and block gate in front of `queryAccountBalance`.
//
// The limits path has had a coalescer since the Anthropic usage endpoint
// started returning 429s under uncoordinated refreshes. The balance path never
// got one, so it kept the behavior the limits path was fixed for: every mount
// of a balance card, and every `subscription-changed` event, issued its own
// request, with nothing shared between them and nothing remembered when one
// failed. A provider that answered 429 was asked again on the next mount.
//
// This is the limits coalescer's contract applied to balance readings, keyed by
// (provider, accountId) and sharing the SAME credential ledger. That sharing is
// the point: quota and balance are two reads against one credential, and a
// block earned by either has to stop both.

import { getSubscriptionBreaker, type SubscriptionBreaker } from "@/lib/subscription/retry/breaker"
import { limitsBreakerKey } from "@/lib/subscription/limits/coalesce-record"
import { classifyThrownFailure } from "@/lib/subscription/retry/failure-class"

import { queryAccountBalance } from "./runner"

import type { BalanceSnapshot, ProviderId } from "@/types/subscription"

/** Minimum spacing between automatic balance queries for one account. */
export const BALANCE_QUERY_MIN_INTERVAL_MS = 5 * 60_000

/** Explicit refreshes may skip the normal throttle, but never this click floor. */
export const BALANCE_QUERY_FORCE_MIN_INTERVAL_MS = 30_000

interface BalanceEntry {
  inflight: Promise<BalanceSnapshot | null> | null
  lastAttemptAt: number
  lastResult: BalanceSnapshot | null
  lastSuccessfulResult: BalanceSnapshot | null
}

const entries = new Map<string, BalanceEntry>()

function keyOf(provider: ProviderId, accountId: string): string {
  return `${provider} ${accountId}`
}

export interface CoalesceBalanceOptions {
  /** Bypass the normal throttle after the hard cooldown. Still coalesces in-flight. */
  force?: boolean
  now?: () => number
  run?: (provider: ProviderId, accountId: string) => Promise<BalanceSnapshot | null>
  breaker?: SubscriptionBreaker
  random?: () => number
}

/**
 * Coalesced, throttled, block-aware drop-in for `queryAccountBalance`. Same
 * contract: `null` means nothing resolved (no preset, token or adapter), a
 * snapshot with `error` means the query failed, anything else is a reading.
 */
export function queryAccountBalanceCoalesced(
  provider: ProviderId,
  accountId: string,
  options: CoalesceBalanceOptions = {}
): Promise<BalanceSnapshot | null> {
  const now = options.now ?? Date.now
  const run = options.run ?? queryAccountBalance
  const breaker = options.breaker ?? getSubscriptionBreaker()
  const key = keyOf(provider, accountId)
  const entry = entries.get(key) ?? {
    inflight: null,
    lastAttemptAt: 0,
    lastResult: null,
    lastSuccessfulResult: null,
  }
  entries.set(key, entry)

  if (entry.inflight) return entry.inflight

  const currentTime = now()
  const ledgerKey = limitsBreakerKey(provider, accountId)

  // The shared block outranks everything, an explicit refresh included.
  if (!breaker.shouldAttempt(ledgerKey, currentTime).allowed) {
    return Promise.resolve(entry.lastResult)
  }

  const minimumInterval = options.force
    ? BALANCE_QUERY_FORCE_MIN_INTERVAL_MS
    : BALANCE_QUERY_MIN_INTERVAL_MS
  if (entry.lastAttemptAt > 0 && currentTime - entry.lastAttemptAt < minimumInterval) {
    return Promise.resolve(entry.lastResult)
  }

  const request = (async () => {
    try {
      const result = await run(provider, accountId)
      if (result && !result.error) {
        entry.lastSuccessfulResult = result
        breaker.recordSuccess(ledgerKey)
      } else if (result?.error) {
        breaker.recordFailure(
          ledgerKey,
          classifyThrownFailure(result.error, now()),
          now(),
          options.random
        )
      }
      // Carry the last good figures forward onto a later error, the same way
      // `applyCoalescedResult` carries meters on the limits path. Without it a
      // card that had a reading and then hit a 429 renders the error with no
      // number at all, even though the figures are sitting right here.
      const display =
        result?.error && entry.lastSuccessfulResult
          ? {
              ...entry.lastSuccessfulResult,
              fetchedAt: result.fetchedAt,
              error: result.error,
            }
          : result
      entry.lastResult = display
      return display
    } catch (error) {
      breaker.recordFailure(ledgerKey, classifyThrownFailure(error, now()), now(), options.random)
      throw error
    } finally {
      entry.lastAttemptAt = now()
      entry.inflight = null
    }
  })()
  entry.inflight = request
  return request
}

/** Test-only: clear the coalescer state between cases. */
export function __resetBalanceCoalescerForTesting(): void {
  entries.clear()
}
