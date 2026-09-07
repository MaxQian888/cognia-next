// Per-credential block state shared by every surface that talks to a provider
// on the user's behalf.
//
// The desktop reads subscription quota from at least five places at once (the
// status bar chip, the tray feed, the Subscription overview and usage tabs,
// every per-provider panel, the /limits slash command). They each refresh on
// mount and on every `subscription-changed` event, with no coordination. The
// existing coalescer in `limits/coalesce.ts` keeps them from issuing five
// simultaneous REQUESTS, but it holds only one flat 15 minute block and only
// for a 429, so a 403 account cap or a revoked refresh token still gets probed
// forever at the throttle interval.
//
// This module is the memory for "this credential is not worth touching yet".
// Two behaviors are load-bearing:
//
//  * Blocks merge with MAX. A later, shorter block never shortens a longer one
//    that is already in force. Two surfaces observing the same 429 must not
//    talk each other down to the shorter of two waits.
//
//  * A revoked credential latches. `invalid_grant` does not heal on its own, so
//    it is held until the user re-authenticates. Re-POSTing a dead refresh
//    token every five minutes is the single most reliable way to get a
//    subscription account flagged, and before this module that is exactly what
//    a stale account did.
//
// The state is in-memory and per-process by design. It is a rate-limit memory,
// not a fact about the account, and a restart is a legitimate reason to try
// once more.

import { backoffDelayMs } from "./backoff"

import type { SubscriptionFailure, SubscriptionFailureReason } from "./failure-class"

/** Hard cap on attempts for one logical operation, mirroring the auth-retry cap in `oh-my-pi`. */
export const MAX_ATTEMPTS_PER_OPERATION = 8

export interface CredentialBlockState {
  /** Epoch ms this credential becomes eligible again. `0` means not blocked. */
  blockedUntil: number
  /** Consecutive failures since the last success. */
  consecutiveFailures: number
  /** Reason for the most recent failure, kept so the UI can explain the block. */
  lastReason?: SubscriptionFailureReason
  /** Set when only user action clears the block. */
  permanent: boolean
  /** Epoch ms of the last recorded failure. */
  lastFailureAt: number
}

export interface AttemptDecision {
  allowed: boolean
  /** Present when blocked. Epoch ms the block lifts, or `Infinity` when permanent. */
  blockedUntil?: number
  reason?: SubscriptionFailureReason
  permanent?: boolean
}

const ALLOWED: AttemptDecision = { allowed: true }

function emptyState(): CredentialBlockState {
  return { blockedUntil: 0, consecutiveFailures: 0, permanent: false, lastFailureAt: 0 }
}

/**
 * Block ledger keyed by an opaque credential key. Callers build the key with
 * {@link credentialKey} so the quota path, the balance path and the refresh
 * path all block the same credential together. A quota exhaustion observed by
 * the limits runner must also stop the balance poller from touching it.
 */
export class SubscriptionBreaker {
  private readonly states = new Map<string, CredentialBlockState>()

  /** Current state for a key, or a fresh zeroed one. Never returns a live reference. */
  peek(key: string): CredentialBlockState {
    const state = this.states.get(key)
    return state ? { ...state } : emptyState()
  }

  /** Whether this credential may be touched right now. */
  shouldAttempt(key: string, now: number): AttemptDecision {
    const state = this.states.get(key)
    if (!state) return ALLOWED
    if (state.permanent) {
      return {
        allowed: false,
        blockedUntil: Number.POSITIVE_INFINITY,
        reason: state.lastReason,
        permanent: true,
      }
    }
    if (state.blockedUntil > now) {
      return { allowed: false, blockedUntil: state.blockedUntil, reason: state.lastReason }
    }
    return ALLOWED
  }

  /**
   * Fold one failure into the ledger and return the epoch ms the credential
   * becomes eligible again.
   *
   * `random` is injected so the jitter is deterministic under test.
   */
  recordFailure(
    key: string,
    failure: SubscriptionFailure,
    now: number,
    random?: () => number
  ): number {
    const state = this.states.get(key) ?? emptyState()
    state.consecutiveFailures += 1
    state.lastReason = failure.reason
    state.lastFailureAt = now

    if (failure.permanent) {
      state.permanent = true
      state.blockedUntil = Number.POSITIVE_INFINITY
      this.states.set(key, state)
      return Number.POSITIVE_INFINITY
    }

    const delay = backoffDelayMs({
      reason: failure.reason,
      consecutiveFailures: state.consecutiveFailures,
      retryAfterMs: failure.retryAfterMs,
      random,
    })
    // MAX merge. A second observer of the same failure must not be able to
    // shorten a block another surface already armed.
    state.blockedUntil = Math.max(state.blockedUntil, now + delay)
    this.states.set(key, state)
    return state.blockedUntil
  }

  /**
   * Clear a credential's block after a call succeeds.
   *
   * A `permanent` latch survives. Otherwise the latch's guarantee would rest
   * entirely on every caller checking {@link shouldAttempt} first: one path
   * that reaches the endpoint without asking, and gets a cached or partial
   * success, would silently unlatch a revoked credential and the app would go
   * back to re-POSTing a dead refresh token. Only {@link clear} lifts it, and
   * only the user's own re-authentication calls that.
   */
  recordSuccess(key: string): void {
    if (this.states.get(key)?.permanent) return
    this.states.delete(key)
  }

  /**
   * Drop a block because the user acted, such as re-authenticating an account
   * or hitting an explicit Refresh on a permanently latched credential. This is
   * the ONLY way a `permanent` latch lifts.
   */
  clear(key: string): void {
    this.states.delete(key)
  }

  /** Test-only: drop every entry. */
  resetAll(): void {
    this.states.clear()
  }
}

/**
 * Ledger key for one credential. `scope` separates independent budgets on the
 * same credential, such as the quota endpoint and the token endpoint. A block
 * on one must not silently gate the other, because they have different limits.
 */
export function credentialKey(provider: string, accountId: string, scope = "default"): string {
  return `${provider} ${accountId} ${scope}`
}

/** Scope names in use, kept together so a typo cannot silently split a budget. */
export const BREAKER_SCOPES = {
  /** Quota and balance reads. */
  usage: "usage",
  /** OAuth token endpoint. Its limits are much tighter than the usage endpoint. */
  refresh: "refresh",
  /** The paid `/v1/messages` probe, which spends real quota on every call. */
  probe: "probe",
} as const

const sharedBreaker = new SubscriptionBreaker()

/** The process-wide ledger every subscription surface shares. */
export function getSubscriptionBreaker(): SubscriptionBreaker {
  return sharedBreaker
}

/** Test-only: clear the shared ledger between cases. */
export function __resetSubscriptionBreakerForTesting(): void {
  sharedBreaker.resetAll()
}
