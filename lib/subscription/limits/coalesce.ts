// Single-flight, throttle and block gate in front of `queryAccountLimits`.
//
// The desktop surfaces that read unified limits (the status-bar usage chip in
// `components/desktop/status-bar-usage.tsx`, the tray usage feed in
// `lib/tray/usage.ts`, the Subscription overview and usage tabs, every
// per-provider quota panel, the /limits slash command) each call `refresh()` on
// mount AND on every `subscription-changed` bus event, with no coordination
// between them. Anthropic's free `GET /api/oauth/usage` endpoint serves an
// aggressively rate-limited bucket, so those uncoordinated bursts pile up into
// `429 Too Many Requests`, which then renders as a broken quota panel.
//
// This wraps the runner with three guarantees, keyed by (provider, accountId):
//   * in-flight coalescing, so N concurrent callers share ONE network query,
//   * a minimum interval between real queries, with repeat triggers inside the
//     window replaying the last result instead of hitting the endpoint again,
//   * a provider-driven block, held in the shared credential ledger, that
//     outranks both of the above.
//
// The third one is the new part and it is the reason this file exists at all.
// The old code held a single flat fifteen minute block, armed only when the
// error string contained a literal `429`. Every other way a provider says stop
// (a 403 account cap, a 402 billing cap, a revoked token, a 5xx outage) armed
// nothing, so those were re-polled every five minutes, per account, forever.
// Now the wait comes from what the provider actually said, escalates while the
// failure persists, and a revoked credential latches until the user acts.
//
// A `force` call (an explicit user "Refresh") skips the normal throttle after a
// short hard cooldown. It still joins a live request and still cannot bypass a
// provider-imposed block, so double-clicks and impatient retries cannot
// amplify provider load.

import { getSubscriptionBreaker, type SubscriptionBreaker } from "@/lib/subscription/retry/breaker"

import { applyCoalescedResult, limitsBreakerKey, recordCoalescedThrow } from "./coalesce-record"
import { runQuotaFailover } from "./quota-failover"
import { queryAccountLimits } from "./runner"

import type { ProviderId, ProviderLimits } from "@/types/subscription"

/**
 * Minimum spacing between automatic network queries for one account. Five
 * minutes matches the UI staleness budget and CCSwitch's mature default, while
 * still letting an explicit refresh run after its shorter hard cooldown.
 */
export const LIMITS_QUERY_MIN_INTERVAL_MS = 5 * 60_000

/** Explicit refreshes may skip the normal throttle, but never this click floor. */
export const LIMITS_QUERY_FORCE_MIN_INTERVAL_MS = 30_000

interface CoalesceEntry {
  /** Shared promise while a query is in flight, `null` when idle. */
  inflight: Promise<ProviderLimits | null> | null
  /** Wall-clock ms of the last completed attempt, `0` meaning never queried. */
  lastAttemptAt: number
  /** Result of the last completed attempt, replayed while throttled. */
  lastResult: ProviderLimits | null
  /** Last snapshot that carried meters without an error. */
  lastSuccessfulResult: ProviderLimits | null
}

const entries = new Map<string, CoalesceEntry>()

function keyOf(provider: ProviderId, providerAccountId: string): string {
  return `${provider} ${providerAccountId}`
}

export interface CoalesceLimitsOptions {
  /** Bypass the normal throttle after the hard cooldown. Still coalesces in-flight. */
  force?: boolean
  /** Injected clock for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Injected runner for tests. Defaults to the real `queryAccountLimits`. */
  run?: (provider: ProviderId, providerAccountId: string) => Promise<ProviderLimits | null>
  /** Injected credential ledger for tests. Defaults to the shared one. */
  breaker?: SubscriptionBreaker
  /** Deterministic jitter source for the recorded backoff. */
  random?: () => number
  /**
   * Failover hook, run after a failed reading. Defaults to the real
   * account-rotation path, which is itself a no-op unless the user opted in.
   */
  failover?: typeof runQuotaFailover
}

/**
 * Coalesced, throttled, block-aware drop-in for `queryAccountLimits`. Returns
 * the same `ProviderLimits | null` contract: `null` means no source applied, a
 * snapshot (even one carrying only an `error`) means a real reading. Between
 * real queries it replays the last result so callers keep rendering the
 * freshest data without a network hit.
 */
export function queryAccountLimitsCoalesced(
  provider: ProviderId,
  providerAccountId: string,
  options: CoalesceLimitsOptions = {}
): Promise<ProviderLimits | null> {
  const now = options.now ?? Date.now
  const run = options.run ?? queryAccountLimits
  const breaker = options.breaker ?? getSubscriptionBreaker()
  const failover = options.failover ?? runQuotaFailover
  const key = keyOf(provider, providerAccountId)
  const entry = entries.get(key) ?? {
    inflight: null,
    lastAttemptAt: 0,
    lastResult: null,
    lastSuccessfulResult: null,
  }
  entries.set(key, entry)

  // Coalesce: a concurrent caller (forced or not) joins the live request.
  if (entry.inflight) return entry.inflight

  const currentTime = now()

  // A provider-imposed block outranks everything, including an explicit user
  // refresh. This is the gate that a `force` click must not be able to open:
  // the whole point is that the server told us to stop.
  const decision = breaker.shouldAttempt(limitsBreakerKey(provider, providerAccountId), currentTime)
  if (!decision.allowed) return Promise.resolve(entry.lastResult)

  // Throttle: within the floor, replay the last result with no network hit.
  const minimumInterval = options.force
    ? LIMITS_QUERY_FORCE_MIN_INTERVAL_MS
    : LIMITS_QUERY_MIN_INTERVAL_MS
  if (entry.lastAttemptAt > 0 && currentTime - entry.lastAttemptAt < minimumInterval) {
    return Promise.resolve(entry.lastResult)
  }

  const recordOptions = { provider, providerAccountId, now, breaker, random: options.random }
  const request = (async () => {
    try {
      const result = await run(provider, providerAccountId)
      const display = applyCoalescedResult(entry, result, recordOptions)
      if (result?.error) {
        await failover({ provider, providerAccountId, error: result.error, now: now() })
      }
      return display
    } catch (error) {
      // A rejected query used to vanish, leaving only the attempt timestamp, so
      // a hard-failing endpoint was retried at the throttle interval forever.
      // The rejection still propagates: callers have always been able to tell a
      // transport failure from a `null` "no source applied", and quietly
      // collapsing the two would hide an outage behind an empty panel.
      recordCoalescedThrow(error, recordOptions)
      await failover({ provider, providerAccountId, error, now: now() })
      throw error
    } finally {
      // Stamp the attempt even on failure so a throwing query still waits out
      // the interval instead of hammering the endpoint.
      entry.lastAttemptAt = now()
      entry.inflight = null
    }
  })()
  entry.inflight = request
  return request
}

/** Test-only: clear the coalescer state between cases. */
export function __resetLimitsCoalescerForTesting(): void {
  entries.clear()
}
