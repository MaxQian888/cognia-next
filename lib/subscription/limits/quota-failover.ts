// Bridge between "a quota reading failed" and the account-rotation policy in
// `lib/subscription/retry/failover.ts`.
//
// The coalescer is the one choke point every quota read passes through, so
// hooking failover there means it fires once per real network reading rather
// than once per mounted surface. This module is the thin part that knows about
// settings and the vault transport, keeping the coalescer itself dumb and the
// policy itself pure.
//
// Failover is opt-in per provider and off by default. Moving the active pointer
// changes which account the user is billed on and which subscription the
// sidecar spends, so it is never something to start doing on the user's behalf
// without an explicit yes.

import { handleSubscriptionFailure } from "@/lib/subscription/retry/failover"
import { classifyThrownFailure } from "@/lib/subscription/retry/failure-class"
import {
  getActiveAccount as defaultGetActiveAccount,
  listAccounts as defaultListAccounts,
  setActiveAccount as defaultSetActiveAccount,
} from "@/lib/subscription/core/transport"
import { notifySubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { useSettingsStore } from "@/stores/settings"

import type { FailoverDeps, FailoverOutcome } from "@/lib/subscription/retry/failover"
import type { ProviderId } from "@/types/subscription"

export interface QuotaFailoverInput {
  provider: ProviderId
  accountId: string
  /** The snapshot's `error` string, or the value a rejected query threw. */
  error: unknown
  /** Epoch ms. */
  now: number
  /** Per-provider opt-in reader. Injected in tests. */
  isEnabled?: (provider: ProviderId) => boolean
  deps?: Partial<FailoverDeps>
}

/**
 * Read the per-provider failover opt-in out of the settings store.
 *
 * Only the two OAuth subscription providers carry the toggle. Everything else
 * reports `false`, which keeps rotation off for providers whose accounts are
 * not interchangeable.
 */
export function isFailoverEnabled(provider: ProviderId): boolean {
  const settings = useSettingsStore.getState().settings
  if (provider === "anthropic") return settings?.subscriptionSettings?.autoFailoverEnabled === true
  if (provider === "codex") return settings?.codexSubscriptionSettings?.autoFailoverEnabled === true
  return false
}

/**
 * Classify a failed quota reading and, when it is an account-local cap and the
 * user opted in, move the active pointer to a healthy sibling.
 *
 * Never throws. A failover that cannot complete must not turn a rendered error
 * panel into a rejected promise.
 */
export async function runQuotaFailover(input: QuotaFailoverInput): Promise<FailoverOutcome | null> {
  const enabledFor = input.isEnabled ?? isFailoverEnabled
  const failure = classifyThrownFailure(input.error, input.now)
  // The breaker block was already armed by the coalescer's record step. Only
  // the rotation half runs here, so a non-rotatable failure is nothing to do.
  if (!failure.rotatable) return null

  const failoverEnabled = enabledFor(input.provider)
  if (!failoverEnabled) return null

  const deps: FailoverDeps = {
    listAccounts: input.deps?.listAccounts ?? defaultListAccounts,
    setActiveAccount: input.deps?.setActiveAccount ?? defaultSetActiveAccount,
    getActiveAccountId:
      input.deps?.getActiveAccountId ??
      (async (provider) => (await defaultGetActiveAccount(provider)).activeAccountId ?? null),
    breaker: input.deps?.breaker,
    now: input.deps?.now ?? (() => input.now),
    random: input.deps?.random,
    onSwitched: input.deps?.onSwitched ?? (() => notifySubscriptionChanged()),
  }

  try {
    return await handleSubscriptionFailure({
      provider: input.provider,
      accountId: input.accountId,
      failure,
      failoverEnabled,
      // The coalescer's record step already armed the block for this exact
      // failure. Recording it again here would count it twice.
      recordBlock: false,
      deps,
    })
  } catch {
    // A vault write failing is a worse outcome to propagate than to swallow:
    // the caller is already rendering a quota error, and the block that
    // matters was armed before this ran.
    return null
  }
}
