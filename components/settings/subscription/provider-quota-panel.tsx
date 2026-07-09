"use client"

// Per-provider quota panel: the active account's rate-limit windows
// (`LimitsMetersCard`, windows-only) plus its credit/quota balance
// (`BalanceCard`). One shared surface for every subscription provider — the
// Usage tab stacks it for codex/opencode, and each provider's own tab embeds
// it so quota lives next to the account list. Auto-fetches once per account
// when the stored snapshot is missing or stale, mirroring the Anthropic
// overview's behavior.

import { useEffect, useRef, useState } from "react"

import { BalanceCard } from "@/components/settings/subscription/balance-card"
import { LimitsMetersCard } from "@/components/settings/subscription/limits-meters-card"

import { useAccounts } from "@/lib/subscription/core/hooks"
import { useProviderLimits } from "@/lib/subscription/limits/hooks"
import { usageWindowsStale } from "@/lib/subscription/anthropic/overview-windows"
import { isTauri } from "@/lib/tauri"

import type { ProviderId } from "@/types/subscription"

export interface ProviderQuotaPanelProps {
  provider: ProviderId
  /**
   * Render clock for reset countdowns. Parents that already tick a clock
   * (the Usage tab) pass it in; standalone embeds (provider tabs) omit it
   * and the panel ticks its own once a minute.
   */
  now?: number
}

/**
 * Renders nothing when the provider has no active account — quota is an
 * account-scoped concept, and an empty shell would just add noise.
 */
export function ProviderQuotaPanel({ provider, now: nowProp }: ProviderQuotaPanelProps) {
  const [internalNow, setInternalNow] = useState(() => Date.now())
  useEffect(() => {
    if (nowProp != null) return
    const id = setInterval(() => setInternalNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [nowProp])
  const now = nowProp ?? internalNow

  const { accounts, activeAccountId } = useAccounts(provider)
  const { snapshot, refresh } = useProviderLimits(provider, activeAccountId ?? "")

  // One auto-fetch per (mount, account) when there's nothing fresh to show.
  const autoFetchedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isTauri() || !activeAccountId) return
    if (autoFetchedForRef.current === activeAccountId) return
    if (!usageWindowsStale({ fetchedAt: snapshot?.fetchedAt ?? null }, now)) return
    autoFetchedForRef.current = activeAccountId
    void refresh()
  }, [activeAccountId, snapshot, now, refresh])

  if (!activeAccountId) return null
  const active = accounts.find((a) => a.id === activeAccountId)
  const label = active?.label ?? active?.email ?? activeAccountId

  return (
    <>
      <LimitsMetersCard
        provider={provider}
        accountId={activeAccountId}
        label={label}
        now={now}
        windowsOnly
      />
      <BalanceCard provider={provider} accountId={activeAccountId} label={label} />
    </>
  )
}
