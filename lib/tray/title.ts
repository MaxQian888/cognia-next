// Reactive half of the composable menu-bar title (ADR-0225 §11). The pure
// field model and formatter live in `lib/tray/title-format.ts`.
//
// Feeds run only while the title is on and only for the fields it shows:
//
//   * usage fields: one 30-day usage glance in the tray's counted scope, whose
//     daily buckets every window (1D / 7D / 30D) is summed from, so the title
//     agrees with the tray panel's usage module about the same days;
//   * running / awaiting: the island's own projection, the same counts the
//     panel's Fleet module shows;
//   * quota: the tray's quota feed (`snapshot.usage`, already running while a
//     taskbar readout is on), highest used share or the pinned subscription;
//   * budget: the cost-budget verdict every budget surface reads.
//
// The title is a main-window concern: auxiliary windows load the same root
// layout and must not push a title of their own.

"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { useGlanceNow } from "@/hooks/glance/use-glance-now"
import { useCostBudgetStatus } from "@/hooks/usage/use-cost-budget-status"
import { useUsageGlance } from "@/hooks/usage/use-usage-glance"
import {
  getIslandProjection,
  getIslandProjectionServerSnapshot,
  subscribeIslandProjection,
} from "@/lib/island/projection-store"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { isTauri } from "@/lib/tauri"
import type { UsageGlanceQuery } from "@/lib/usage/usage-glance"

import {
  formatTrayTitle,
  titleNeedsUsage,
  type TrayTitleLabels,
  type TrayTitlePeriod,
} from "./title-format"
import type { TrayDisplayPrefs, TrayUsageSnapshot } from "./types"
import { selectDisplayAccount } from "./usage-format"

/** Fleet counts from the island projection: working and awaiting rows. */
export function fleetTitleCounts(
  rows: ReadonlyArray<{ status: string; stale?: boolean }> | null | undefined
): { working: number; awaiting: number } | null {
  if (!rows) return null
  let working = 0
  let awaiting = 0
  for (const row of rows) {
    // A stale row is one the island stopped hearing from; the panel counts it
    // apart, and so does the title.
    if (row.stale) continue
    if (row.status === "working") working += 1
    else if (row.status === "blocked") awaiting += 1
  }
  return { working, awaiting }
}

/**
 * The menu-bar title text for the current state, or null when the title is
 * off or has nothing to say.
 */
export function useTrayTitle(
  display: Pick<TrayDisplayPrefs, "taskbarUsageMode" | "titleFields" | "usageScope">,
  usage: TrayUsageSnapshot | null | undefined
): string | null {
  const t = useTranslations("tray.title")
  const on = display.taskbarUsageMode === "title" && isTauri() && isMainAppWindow()
  const fields = display.titleFields
  const now = useGlanceNow(on)

  const query = useMemo<UsageGlanceQuery>(
    () => ({ period: "30d", scope: display.usageScope, metric: "tokens" }),
    [display.usageScope]
  )
  const { snapshot: glance } = useUsageGlance({
    query,
    enabled: on && titleNeedsUsage(fields),
  })

  const island = useSyncExternalStore(
    subscribeIslandProjection,
    getIslandProjection,
    getIslandProjectionServerSnapshot
  )
  const budget = useCostBudgetStatus()

  const period = useCallback((p: TrayTitlePeriod) => t(`period.${p}`), [t])
  const labels = useMemo<TrayTitleLabels>(
    () => ({
      usage: (p, value) => t("usage", { period: period(p), value }),
      running: (count) => t("running", { count }),
      awaiting: (count) => t("awaiting", { count }),
      quota: (pct) => t("quota", { pct }),
      budget: (pct) => t("budget", { pct }),
    }),
    [t, period]
  )

  return useMemo(() => {
    if (!on) return null
    const account = usage ? selectDisplayAccount(usage.accounts, usage.selectedKey) : null
    return formatTrayTitle(
      fields,
      {
        daily: glance?.daily ?? null,
        fleet: fleetTitleCounts(island?.rows),
        quotaUsedPct: account?.worst?.usedPct ?? null,
        budgetRatio: budget.worst?.ratio ?? null,
        now,
      },
      labels
    )
  }, [on, fields, glance, island, usage, budget.worst, now, labels])
}
