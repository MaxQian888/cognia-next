// Reactive half of the tray's subscription-quota surface: `useTrayUsage`
// wraps `useAllConfiguredLimits` (ADR-0025 unified limits) with the tray's
// refresh policy — refresh on mount, on subscription changes, on explicit
// menu-driven requests (`lib/tray/usage-refresh-bus.ts`, fired by the
// dispatcher when the user clicks "Refresh" in the tray), and on an
// optional interval. Enabled only while some tray usage surface is on so
// idle installs never poll provider usage endpoints.
//
// The pure projection/formatting half lives in `lib/tray/usage-format.ts`.

"use client"

import { useEffect, useMemo } from "react"

import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { useAllConfiguredLimits } from "@/lib/subscription/limits/hooks"

import { summarizeLimits } from "./usage-format"
import { onTrayUsageRefreshRequest } from "./usage-refresh-bus"
import type { TrayUsageSnapshot } from "./types"

/** Aggregated usage for the tray, minus the selection (the store owns that). */
export type TrayUsageData = Omit<TrayUsageSnapshot, "selectedKey">

/**
 * Reactive tray-usage feed. `enabled=false` (no usage surface active) keeps
 * the hook fully inert — no fetch, no subscriptions, `null` result. The
 * underlying `useAllConfiguredLimits.refresh` already no-ops outside Tauri.
 */
export function useTrayUsage(enabled: boolean, refreshMinutes: number): TrayUsageData | null {
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

  return useMemo(() => {
    if (!enabled) return null
    let fetchedAt: number | null = null
    for (const snap of snapshots) {
      if (fetchedAt == null || snap.fetchedAt > fetchedAt) fetchedAt = snap.fetchedAt
    }
    return { accounts: summarizeLimits(snapshots), fetchedAt }
  }, [enabled, snapshots])
}
