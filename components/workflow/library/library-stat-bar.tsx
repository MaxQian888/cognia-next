"use client"

/**
 * LibraryStatBar — top-of-library dashboard with 7-day run count, success
 * rate, active-workflow count, and today's failed runs. The data source is
 * `lib/db/workflow-stats.ts` (30s in-memory cached). When `getLibraryStats`
 * resolves with all-zero counts (e.g., a fresh install), the bar collapses
 * to nothing so we don't waste space on a sparse first-run.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useFormatter } from "next-intl"
import { getLibraryStats, type LibraryStats } from "@/lib/db/workflow-stats"

export function LibraryStatBar() {
  const t = useTranslations("workflows.library.statBar")
  const fmt = useFormatter()
  const [stats, setStats] = useState<LibraryStats | null>(null)

  useEffect(() => {
    let cancelled = false
    getLibraryStats(Date.now())
      .then((s) => {
        if (!cancelled) setStats(s)
      })
      .catch(() => {
        if (!cancelled) setStats(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!stats) return null
  if (
    stats.runs7d === 0 &&
    stats.activeWorkflows === 0 &&
    stats.failedToday === 0 &&
    stats.successRate === null
  ) {
    return null
  }

  const successPct =
    stats.successRate === null ? "—" : fmt.number(stats.successRate, { style: "percent" })

  return (
    <div className="grid grid-cols-2 gap-2 border-b px-6 py-3 sm:grid-cols-4">
      <Card label={t("runs7d")} value={fmt.number(stats.runs7d)} />
      <Card label={t("successRate")} value={successPct} />
      <Card label={t("activeWorkflows")} value={fmt.number(stats.activeWorkflows)} />
      <Card
        label={t("failedToday")}
        value={fmt.number(stats.failedToday)}
        emphasize={stats.failedToday > 0}
      />
    </div>
  )
}

function Card({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="rounded-md border bg-card/50 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={
          "text-lg font-semibold tabular-nums " +
          (emphasize ? "text-wf-status-failed" : "text-foreground")
        }
      >
        {value}
      </p>
    </div>
  )
}
