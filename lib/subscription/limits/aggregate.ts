// Cross-provider aggregation: query the unified limits for every configured
// subscription account and return them with the active account pinned first.
// This is what the TUI `/limits` panel and the desktop multi-provider view
// consume. All seams are injected so it runs offline in tests and in the CLI
// (which supplies a node-`fetch`-backed `authedGet`).

import {
  getActiveAccount as defaultGetActiveAccount,
  listAccounts as defaultListAccounts,
} from "@/lib/subscription/core/transport"
import { ALL_PROVIDER_IDS } from "@/types/subscription"

import { queryAccountLimits, type LimitsRunnerDeps } from "./runner"

import type {
  AccountSummary,
  ActiveSnapshot,
  ProviderId,
  ProviderLimits,
} from "@/types/subscription"

export interface AggregateDeps extends Partial<LimitsRunnerDeps> {
  listAccounts: (provider: ProviderId) => Promise<AccountSummary[]>
  getActiveAccount: (provider: ProviderId) => Promise<ActiveSnapshot>
  /** Currently-active provider (CLI config / desktop selection) — pinned first. */
  activeProvider?: ProviderId
  /** Test seam: override the per-account runner. */
  runAccount?: (provider: ProviderId, accountId: string) => Promise<ProviderLimits | null>
}

interface Target {
  provider: ProviderId
  accountId: string
  active: boolean
}

/**
 * Query limits for every configured account across all providers. Accounts that
 * yield no usable snapshot (no token, no source, unavailable) are dropped. The
 * active provider's active account sorts first; the rest keep enumeration order.
 */
export async function queryAllConfiguredLimits(
  deps: Partial<AggregateDeps> = {}
): Promise<ProviderLimits[]> {
  const listAccounts = deps.listAccounts ?? defaultListAccounts
  const getActiveAccount = deps.getActiveAccount ?? defaultGetActiveAccount
  const runAccount =
    deps.runAccount ??
    ((provider: ProviderId, accountId: string) => queryAccountLimits(provider, accountId, deps))

  // Enumerate targets across every provider, tagging the active one.
  const targets: Target[] = []
  for (const provider of ALL_PROVIDER_IDS) {
    const [summaries, active] = await Promise.all([
      listAccounts(provider),
      getActiveAccount(provider),
    ])
    const activeId = active.activeAccountId
    for (const summary of summaries) {
      targets.push({
        provider,
        accountId: summary.id,
        active: deps.activeProvider === provider && summary.id === activeId,
      })
    }
  }

  const results = await Promise.all(
    targets.map(async (t) => {
      const snap = await runAccount(t.provider, t.accountId)
      return snap ? { snap, active: t.active } : null
    })
  )

  const usable = results.filter((r): r is { snap: ProviderLimits; active: boolean } => r !== null)
  // Stable sort with the active account first.
  usable.sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1))
  return usable.map((r) => r.snap)
}
