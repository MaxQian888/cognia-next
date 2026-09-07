// Shared result-recording block for the two limits coalescers (the built-in
// account path in `coalesce.ts` and the user-defined custom sources in
// `custom/runner.ts`). Both fold a completed query the same way: remember the
// last good meters, carry them forward on a later error, arm the backoff, and
// stamp the replayable snapshot.
//
// The backoff is no longer a flat interval armed only on a 429. It now runs
// through `lib/subscription/retry`, which means the block length comes from
// what the provider actually said. Three behaviors changed here, and each one
// closes a way the old code kept talking to a credential the server had already
// cut off:
//
//  * A 403 account cap, a 402 billing cap and a 5xx outage all arm a block now.
//    Previously only a literal 429 did, so everything else was re-polled at the
//    five minute throttle forever.
//  * A server-supplied reset window is honored, including one longer than our
//    own ceiling. The old flat fifteen minutes turned a two hour reset into
//    eight rejected requests.
//  * A revoked credential latches instead of being retried on the next tick.

import {
  BREAKER_SCOPES,
  credentialKey,
  getSubscriptionBreaker,
  type SubscriptionBreaker,
} from "@/lib/subscription/retry/breaker"
import { classifyThrownFailure } from "@/lib/subscription/retry/failure-class"

import type { SubscriptionFailure } from "@/lib/subscription/retry/failure-class"
import type { ProviderLimits } from "@/types/subscription"

/** Mutable coalescer fields both runner entries share. */
export interface CoalesceResultState {
  /** Result of the last completed attempt, replayed while throttled. */
  lastResult: ProviderLimits | null
  /** Last snapshot that carried meters without an error. */
  lastSuccessfulResult: ProviderLimits | null
}

export interface RecordCoalescedOptions {
  /** Provider id, or `custom` for a user-defined source. */
  provider: string
  /** Vault account id, or the custom source id. */
  accountId: string
  now: () => number
  /** Defaults to the process-wide ledger. Injected in tests. */
  breaker?: SubscriptionBreaker
  /** Deterministic jitter source for the recorded backoff. */
  random?: () => number
}

/** Ledger key one limits entry blocks under. */
export function limitsBreakerKey(provider: string, accountId: string): string {
  return credentialKey(provider, accountId, BREAKER_SCOPES.usage)
}

/**
 * Fold a completed query result into the coalescer state and return the
 * snapshot the caller should surface: keep the freshest good meters, carry them
 * forward when a later attempt only has an error (so the panel keeps rendering
 * data), arm the classified backoff, and record `lastResult` for replay.
 */
export function applyCoalescedResult(
  state: CoalesceResultState,
  result: ProviderLimits | null,
  options: RecordCoalescedOptions
): ProviderLimits | null {
  const breaker = options.breaker ?? getSubscriptionBreaker()
  const key = limitsBreakerKey(options.provider, options.accountId)

  let displayResult = result
  if (result && !result.error) {
    state.lastSuccessfulResult = result
    // A reading that came back clean is the only thing that clears a block.
    breaker.recordSuccess(key)
  } else if (result?.error && state.lastSuccessfulResult) {
    displayResult = { ...result, meters: state.lastSuccessfulResult.meters }
  }

  if (result?.error) {
    const failure = classifyThrownFailure(result.error, options.now())
    breaker.recordFailure(key, failure, options.now(), options.random)
  }

  state.lastResult = displayResult
  return displayResult
}

/**
 * Arm a block for a query that threw instead of returning a snapshot. A
 * rejected `authedGet` used to leave no trace beyond the attempt timestamp, so
 * a hard-failing endpoint was retried at the plain throttle interval forever.
 */
export function recordCoalescedThrow(
  error: unknown,
  options: RecordCoalescedOptions
): SubscriptionFailure {
  const breaker = options.breaker ?? getSubscriptionBreaker()
  const failure = classifyThrownFailure(error, options.now())
  breaker.recordFailure(
    limitsBreakerKey(options.provider, options.accountId),
    failure,
    options.now(),
    options.random
  )
  return failure
}
