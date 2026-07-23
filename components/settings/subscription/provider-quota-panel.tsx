"use client"

// Per-provider quota panel: the active account's rate-limit windows
// (`LimitsMetersCard`, windows-only) plus its credit/quota balance
// (`BalanceCard`). One shared surface for every subscription provider — the
// Usage tab stacks it for codex/opencode, and each provider's own tab embeds
// it so quota lives next to the account list. Auto-fetches once per account
// when the stored snapshot is missing or stale, mirroring the Anthropic
// overview's behavior.

import { useEffect, useRef } from "react"
import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"
import { useTranslations } from "next-intl"

import { BalanceCard } from "@/components/settings/subscription/balance-card"
import { LimitsMetersCard } from "@/components/settings/subscription/limits-meters-card"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import { Button } from "@/components/ui/button"

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
  const t = useTranslations("subscription.limits.query")
  // Shared clock so this panel stays in step with the overview gauges and the
  // usage tab; `nowProp` still wins when a caller pins the time (tests).
  const tickedNow = useSubscriptionNow()
  const now = nowProp ?? tickedNow

  const { accounts, activeAccountId } = useAccounts(provider)
  const { snapshot, queryEnabled, setQueryEnabled, refresh } = useProviderLimits(
    provider,
    activeAccountId ?? ""
  )

  // One auto-fetch per (mount, account) when there's nothing fresh to show.
  const autoFetchedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isTauri() || !activeAccountId || !queryEnabled) return
    if (autoFetchedForRef.current === activeAccountId) return
    if (!usageWindowsStale({ fetchedAt: snapshot?.fetchedAt ?? null }, now)) return
    autoFetchedForRef.current = activeAccountId
    void refresh()
  }, [activeAccountId, snapshot, now, queryEnabled, refresh])

  if (!activeAccountId) return null
  const active = accounts.find((a) => a.id === activeAccountId)
  const label = active?.label ?? active?.email ?? activeAccountId

  return (
    <>
      <SettingsAlert
        title={queryEnabled ? t("enabledTitle") : t("disabledTitle")}
        action={
          <Button
            size="sm"
            variant={queryEnabled ? "ghost" : "outline"}
            onClick={() => void setQueryEnabled(!queryEnabled)}
          >
            {queryEnabled ? t("disable") : t("enable")}
          </Button>
        }
      >
        {queryEnabled ? t("enabledBody") : t("disabledBody")}
      </SettingsAlert>
      <LimitsMetersCard
        provider={provider}
        accountId={activeAccountId}
        label={label}
        now={now}
        windowsOnly
      />
      <BalanceCard
        provider={provider}
        accountId={activeAccountId}
        queryEnabled={queryEnabled}
        label={label}
      />
    </>
  )
}
