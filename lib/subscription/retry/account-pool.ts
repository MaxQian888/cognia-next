// Sibling-account selection for subscription failover.
//
// When one account's quota window is spent, the useful move is to run on
// another account of the same provider rather than to keep asking the spent one
// whether it has changed its mind. That is what `oh-my-pi` does through its
// credential pool, and it is the piece cognia was missing: the vault has always
// held N accounts per provider, but only ever pointed at one of them, forever.
//
// Everything here is pure. Candidate ordering, the already-tried set, and the
// attempt ceiling are decided without touching the vault, so the policy can be
// tested exhaustively offline and the orchestration in `failover.ts` stays a
// thin shell around it.
//
// The rule that keeps this from becoming its own retry storm is the attempted
// set. A rotation that can revisit an account it already burned will cycle
// through the pool forever, turning one exhausted account into N times the
// request volume. Every candidate is tried at most once per operation, and the
// whole operation is capped.

import { MAX_ATTEMPTS_PER_OPERATION, credentialKey, type SubscriptionBreaker } from "./breaker"

import type { AccountSummary } from "@/types/subscription"

/** Health values that mean the credential cannot serve a request at all. */
const UNUSABLE_HEALTH: ReadonlySet<AccountSummary["health"]> = new Set([
  "reauth_required",
  "source_unavailable",
])

/**
 * Which accounts this logical operation has already burned, and how many
 * attempts it has spent. Mirrors `AuthRetryKeyState` in `oh-my-pi`.
 */
export interface AccountRotationState {
  attempted: Set<string>
  attempts: number
}

export function createRotationState(initialAccountId?: string): AccountRotationState {
  return {
    attempted: new Set(initialAccountId ? [initialAccountId] : []),
    attempts: initialAccountId ? 1 : 0,
  }
}

export interface SelectAccountInput {
  provider: string
  /** Every account the vault holds for this provider. */
  candidates: readonly AccountSummary[]
  state: AccountRotationState
  breaker: SubscriptionBreaker
  now: number
  /** Breaker scope the rotation is happening under. Defaults to usage. */
  scope?: string
}

export interface AccountSelection {
  account: AccountSummary
  /** How many usable siblings remain after this one, for logging and UI. */
  remaining: number
}

/**
 * Why no sibling could be selected. The caller surfaces these differently: an
 * exhausted pool is worth telling the user about, an attempt cap is not.
 */
export type NoSelectionReason =
  /** The provider has no other account configured. */
  | "no-siblings"
  /** Every sibling is itself blocked, unhealthy, or already tried. */
  | "all-blocked"
  /** This operation has spent its attempt budget. */
  | "attempts-exhausted"

export type SelectAccountResult =
  { ok: true; selection: AccountSelection } | { ok: false; reason: NoSelectionReason }

/**
 * Order the usable candidates. Least-recently-used first, so repeated failovers
 * spread load across the pool instead of always landing on whichever account
 * happens to sort first. Ties break on id to keep the order deterministic under
 * test.
 */
export function orderCandidates(candidates: readonly AccountSummary[]): AccountSummary[] {
  return [...candidates].sort((left, right) => {
    if (left.lastUsedAtMs !== right.lastUsedAtMs) return left.lastUsedAtMs - right.lastUsedAtMs
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * Pick the next account to run on, or explain why there is none.
 *
 * A candidate is eligible when it has not been tried in this operation, its
 * health lets it serve a request, and the breaker is not holding it. Selecting
 * marks it attempted, so a caller that loops cannot revisit it.
 */
export function selectNextAccount(input: SelectAccountInput): SelectAccountResult {
  const { provider, candidates, state, breaker, now } = input
  const scope = input.scope ?? "usage"

  if (state.attempts >= MAX_ATTEMPTS_PER_OPERATION) {
    return { ok: false, reason: "attempts-exhausted" }
  }

  const siblings = candidates.filter((account) => !state.attempted.has(account.id))
  if (siblings.length === 0) {
    return { ok: false, reason: candidates.length <= 1 ? "no-siblings" : "all-blocked" }
  }

  const eligible = orderCandidates(siblings).filter((account) => {
    if (UNUSABLE_HEALTH.has(account.health)) return false
    return breaker.shouldAttempt(credentialKey(provider, account.id, scope), now).allowed
  })

  const chosen = eligible[0]
  if (!chosen) return { ok: false, reason: "all-blocked" }

  state.attempted.add(chosen.id)
  state.attempts += 1
  return { ok: true, selection: { account: chosen, remaining: eligible.length - 1 } }
}
