// Reactive half of the tray's usage surface. Two independent feeds:
//
//   * QUOTA, via `useAllConfiguredLimits` (ADR-0025 unified limits), on the
//     tray's own refresh policy: on mount, on subscription changes, on
//     explicit menu-driven requests (`lib/tray/usage-refresh-bus.ts`, fired by
//     the dispatcher when the user clicks "Refresh"), and on an optional
//     interval.
//   * SPEND, via `useUsageGlance` (ADR-0165), which is a Dexie live query and
//     needs no polling at all. It only reaches the filesystem when the user
//     puts the tray in the all-tools scope.
//
// Both are gated on some tray usage surface being enabled, so an idle install
// neither polls provider endpoints nor reads a single transcript.
//
// The pure projection/formatting half lives in `lib/tray/usage-format.ts`.

"use client"

import { useEffect, useMemo } from "react"

import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { useAllConfiguredLimits } from "@/lib/subscription/limits/hooks"
import { useUsageGlance } from "@/hooks/usage/use-usage-glance"
import type { UsageGlanceQuery, UsageGlanceQuota } from "@/lib/usage/usage-glance"

import { selectDisplayAccount, summarizeLimits } from "./usage-format"
import { onTrayUsageRefreshRequest } from "./usage-refresh-bus"
import type { TrayDisplayPrefs, TrayUsageSnapshot } from "./types"

/** Aggregated usage for the tray, minus the selection (the store owns that). */
export type TrayUsageData = Omit<TrayUsageSnapshot, "selectedKey">

/**
 * Reactive tray-usage feed. `enabled=false` (no usage surface active) keeps
 * the hook fully inert — no fetch, no subscriptions, `null` result. The
 * underlying `useAllConfiguredLimits.refresh` already no-ops outside Tauri.
 */
export function useTrayUsage(
  enabled: boolean,
  refreshMinutes: number,
  display?: Pick<TrayDisplayPrefs, "usageMetric" | "usagePeriod" | "usageScope" | "usageAccountKey">
): TrayUsageData | null {
  const { snapshots, refresh } = useAllConfiguredLimits()

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const offBus = subscribeSubscriptionChanged(() => void refresh())
    const offRequest = onTrayUsageRefreshRequest(() => void refresh())
    const timer =
      refreshMinutes > 0 ? setInterval(() => void refresh(), refreshMinutes * 60_000) : null
    return () => {
      offBus()
      offRequest()
      if (timer) clearInterval(timer)
    }
  }, [enabled, refreshMinutes, refresh])

  const accounts = useMemo(() => summarizeLimits(snapshots), [snapshots])

  // Fold the quota answer into the glance so a spend surface can still colour
  // itself by plan headroom when no USD budget is configured.
  const quota = useMemo<UsageGlanceQuota | null>(() => {
    const account = selectDisplayAccount(accounts, display?.usageAccountKey ?? null)
    if (!account?.worst) return null
    return {
      worstUsedPct: account.worst.usedPct,
      worstAccountKey: account.key,
      resetAt: account.worst.resetAt ?? null,
    }
  }, [accounts, display?.usageAccountKey])

  const glanceQuery = useMemo<UsageGlanceQuery>(
    () => ({
      period: display?.usagePeriod ?? "today",
      scope: display?.usageScope ?? "cognia",
      metric: display?.usageMetric ?? "quota",
    }),
    [display?.usagePeriod, display?.usageScope, display?.usageMetric]
  )

  // The spend feed is only worth running when a surface actually leads with a
  // spend number. Leaving it on under the quota metric would make every
  // quota-configured install pay for a Dexie subscription it never reads.
  const glanceEnabled = enabled && glanceQuery.metric !== "quota"
  const { snapshot: glance } = useUsageGlance({
    query: glanceQuery,
    enabled: glanceEnabled,
    quota,
  })

  return useMemo(() => {
    if (!enabled) return null
    let fetchedAt: number | null = null
    for (const snap of snapshots) {
      if (fetchedAt == null || snap.fetchedAt > fetchedAt) fetchedAt = snap.fetchedAt
    }
    return { accounts, fetchedAt, glance: glance ?? null }
  }, [enabled, snapshots, accounts, glance])
}
