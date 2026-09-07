// One entry point for "a subscription call just failed": record the block, and
// when the failure is account-local and the user opted in, move the active
// pointer to a healthy sibling.
//
// Splitting record-then-maybe-rotate across call sites is how a breaker ends up
// counting the same failure twice (each count doubles the backoff) or not at
// all. So every caller funnels through {@link handleSubscriptionFailure}, and
// the two halves are decided here.
//
// Failover only ever moves the pointer for the ACTIVE account. A background
// poll discovering that some other vault account is out of quota is
// information, not a reason to change which credential the user is running on.
//
// All I/O is injected. Nothing in this module imports the vault transport
// directly, so the policy runs offline in tests and never touches a real
// account by accident.

import {
  BREAKER_SCOPES,
  credentialKey,
  getSubscriptionBreaker,
  type SubscriptionBreaker,
} from "./breaker"
import {
  createRotationState,
  selectNextAccount,
  type AccountRotationState,
  type NoSelectionReason,
} from "./account-pool"

import type { SubscriptionFailure } from "./failure-class"
import type { AccountSummary, ProviderId } from "@/types/subscription"

export interface FailoverDeps {
  listAccounts: (provider: ProviderId) => Promise<AccountSummary[]>
  setActiveAccount: (provider: ProviderId, accountId: string) => Promise<void>
  /** Active account id for the provider, or `null` when none is pinned. */
  getActiveAccountId: (provider: ProviderId) => Promise<string | null>
  breaker?: SubscriptionBreaker
  now?: () => number
  /** Deterministic jitter source for the recorded backoff. */
  random?: () => number
  /** Told after the pointer moves so the chat header and badges re-read auth. */
  onSwitched?: (provider: ProviderId, accountId: string) => void
}

/**
 * What the failure handler did. Every branch is named so the caller can log or
 * surface it without re-deriving the decision.
 */
export type FailoverOutcome =
  /** Blocked the credential and moved the active pointer to `toAccountId`. */
  | { kind: "switched"; fromAccountId: string; toAccountId: string; remaining: number }
  /** Blocked the credential. The failure was not account-local, so no rotation. */
  | { kind: "blocked-only"; blockedUntil: number }
  /** Blocked the credential. The user has not opted into automatic failover. */
  | { kind: "failover-disabled"; blockedUntil: number }
  /** Blocked the credential. It was not the active account, so nothing moved. */
  | { kind: "not-active"; blockedUntil: number }
  /** Blocked the credential, but no sibling could take over. */
  | { kind: "no-candidate"; blockedUntil: number; reason: NoSelectionReason }

export interface HandleFailureInput {
  provider: ProviderId
  accountId: string
  failure: SubscriptionFailure
  /** The per-provider opt-in. Failover never happens without an explicit yes. */
  failoverEnabled: boolean
  /**
   * Rotation bookkeeping when the caller is running a bounded retry loop.
   * Omitted for a one-shot failure, which starts a fresh single-attempt state.
   */
  rotationState?: AccountRotationState
  /**
   * Set `false` when the caller already folded this exact failure into the
   * ledger, so only the rotation half runs. Recording twice would count one
   * failure as two and double every subsequent backoff, which is the reverse of
   * what a backoff is for.
   */
  recordBlock?: boolean
  deps: FailoverDeps
}

/**
 * Record one failure and, when it warrants it, fail over to a sibling account.
 *
 * The credential is blocked in every branch, including the ones that do not
 * rotate. That is the point: the old behavior of swallowing a failure and
 * re-polling on the next tick is what produced the repeat requests against an
 * account the provider had already cut off.
 */
export async function handleSubscriptionFailure(
  input: HandleFailureInput
): Promise<FailoverOutcome> {
  const { provider, accountId, failure, failoverEnabled, deps } = input
  const breaker = deps.breaker ?? getSubscriptionBreaker()
  const now = deps.now ?? Date.now
  const at = now()

  const key = credentialKey(provider, accountId, BREAKER_SCOPES.usage)
  const blockedUntil =
    input.recordBlock === false
      ? breaker.peek(key).blockedUntil
      : breaker.recordFailure(key, failure, at, deps.random)

  if (!failure.rotatable) return { kind: "blocked-only", blockedUntil }
  if (!failoverEnabled) return { kind: "failover-disabled", blockedUntil }

  const activeId = await deps.getActiveAccountId(provider)
  if (activeId !== accountId) return { kind: "not-active", blockedUntil }

  const candidates = await deps.listAccounts(provider)
  const state = input.rotationState ?? createRotationState(accountId)
  // A caller-supplied state may not have seen this account yet, and selecting
  // the account that just failed would be an immediate loop.
  state.attempted.add(accountId)

  const selected = selectNextAccount({
    provider,
    candidates,
    state,
    breaker,
    now: at,
    scope: BREAKER_SCOPES.usage,
  })
  if (!selected.ok) return { kind: "no-candidate", blockedUntil, reason: selected.reason }

  const target = selected.selection.account
  await deps.setActiveAccount(provider, target.id)
  deps.onSwitched?.(provider, target.id)
  return {
    kind: "switched",
    fromAccountId: accountId,
    toAccountId: target.id,
    remaining: selected.selection.remaining,
  }
}

/** Clear every block on a credential after the user re-authenticates it. */
export function clearCredentialBlocks(
  provider: string,
  accountId: string,
  breaker: SubscriptionBreaker = getSubscriptionBreaker()
): void {
  for (const scope of Object.values(BREAKER_SCOPES)) {
    breaker.clear(credentialKey(provider, accountId, scope))
  }
}
