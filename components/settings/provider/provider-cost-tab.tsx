"use client"

/**
 * ProviderCostTab — "Cost" tab in the provider detail panel.
 *
 * Sections:
 *  1. Period toggle (Last 7 Days / Last 30 Days)
 *  2. Overview cards row (monthly total, total calls, avg cost/call, total tokens)
 *  3. Per-model cost table (model | calls | input tokens | output tokens | est. cost)
 *  4. Empty state when no usage data exists for the provider
 */

import React, { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores"
import { getBuiltInProviderCatalogEntry } from "@/types/provider/built-in-provider-catalog"
import type { ProviderModelUsageEntry } from "@/stores/settings/settings-store"

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface ProviderCostTabProps {
  providerId: string
}

type Period = "7d" | "30d"

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Abbreviate large token counts: 1200000 → "1.2M", 500000 → "500K", 999 → "999" */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000
    return `${Number.isInteger(val) ? val : val.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const val = n / 1_000
    return `${Number.isInteger(val) ? val : val.toFixed(0)}K`
  }
  return String(n)
}

/** Format cost in USD with 2 decimal places */
function formatCost(cost: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cost)
}

/** Return ISO date strings for the past N days (including today) */
function getPastDays(n: number): Set<string> {
  const dates = new Set<string>()
  const today = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    dates.add(d.toISOString().slice(0, 10))
  }
  return dates
}

interface ModelRow {
  modelId: string
  callCount: number
  inputTokens: number
  outputTokens: number
  estimatedCost: number | null // null → show "N/A"
}

/* ── Empty State ─────────────────────────────────────────────────────────── */

function EmptyState({ t }: { t: (key: string) => string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <p className="text-base font-medium text-foreground">{t("costTab.emptyTitle")}</p>
      <p className="mt-1 text-sm text-muted-foreground max-w-xs">{t("costTab.emptyDescription")}</p>
    </div>
  )
}

/* ── Overview Card ───────────────────────────────────────────────────────── */

interface OverviewCardProps {
  label: string
  value: string
}

function OverviewCard({ label, value }: OverviewCardProps) {
  return (
    <div className="rounded-lg border p-4 text-center">
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

/* ── Main Component ──────────────────────────────────────────────────────── */

export function ProviderCostTab({ providerId }: ProviderCostTabProps) {
  const t = useTranslations("providers")
  const [period, setPeriod] = useState<Period>("30d")

  const providerUsageStats = useSettingsStore((s) => s.providerUsageStats) ?? {}
  // cognia-next stores usage as a flat `ProviderModelUsageEntry[]` keyed by
  // `${providerId}:${modelId}`. Aggregate it here into the
  // `Record<modelId, { dailyStats: Record<date, { calls, inputTokens, outputTokens }> }>`
  // shape Cognia's tab expects.
  const providerStats = useMemo(() => {
    const out: Record<
      string,
      {
        dailyStats: Record<string, { calls: number; inputTokens: number; outputTokens: number }>
      }
    > = {}
    for (const [key, entries] of Object.entries(providerUsageStats)) {
      if (!key.startsWith(`${providerId}:`)) continue
      const modelId = key.slice(providerId.length + 1)
      const dailyStats: Record<
        string,
        { calls: number; inputTokens: number; outputTokens: number }
      > = {}
      for (const e of entries) {
        const date = e.at.slice(0, 10) // YYYY-MM-DD
        const cur = dailyStats[date] ?? { calls: 0, inputTokens: 0, outputTokens: 0 }
        cur.calls += 1
        cur.inputTokens += e.promptTokens
        cur.outputTokens += e.completionTokens
        dailyStats[date] = cur
      }
      out[modelId] = { dailyStats }
    }
    return Object.keys(out).length > 0 ? out : null
  }, [providerUsageStats, providerId])

  // Look up catalog entry for pricing
  const catalogEntry = useMemo(() => getBuiltInProviderCatalogEntry(providerId), [providerId])

  // Build a model pricing map: modelId → { promptPer1M, completionPer1M }
  const pricingMap = useMemo(() => {
    const map = new Map<string, { promptPer1M: number; completionPer1M: number }>()
    if (catalogEntry?.models) {
      for (const model of catalogEntry.models) {
        if (model.pricing) {
          map.set(model.id, {
            promptPer1M: model.pricing.promptPer1M,
            completionPer1M: model.pricing.completionPer1M,
          })
        }
      }
    }
    return map
  }, [catalogEntry])

  // Compute per-model rows filtered by the selected period
  const rows: ModelRow[] = useMemo(() => {
    if (!providerStats) return []

    const pastDays = getPastDays(period === "7d" ? 7 : 30)

    return Object.entries(providerStats).map(([modelId, entry]) => {
      // Aggregate dailyStats for the selected period
      let callCount = 0
      let inputTokens = 0
      let outputTokens = 0

      for (const [date, daily] of Object.entries(entry.dailyStats)) {
        if (pastDays.has(date)) {
          callCount += daily.calls
          inputTokens += daily.inputTokens
          outputTokens += daily.outputTokens
        }
      }

      const pricing = pricingMap.get(modelId)
      const estimatedCost = pricing
        ? (inputTokens * pricing.promptPer1M) / 1_000_000 +
          (outputTokens * pricing.completionPer1M) / 1_000_000
        : null

      return { modelId, callCount, inputTokens, outputTokens, estimatedCost }
    })
  }, [providerStats, period, pricingMap])

  // Overview totals — use full lifetime stats for total calls + tokens,
  // period-filtered rows for cost (matches what user is viewing)
  const totals = useMemo(() => {
    if (!providerStats) {
      return { totalCost: 0, totalCalls: 0, avgCostPerCall: 0, totalTokens: 0 }
    }

    const totalCalls = rows.reduce((acc, r) => acc + r.callCount, 0)
    const totalTokens = rows.reduce((acc, r) => acc + r.inputTokens + r.outputTokens, 0)
    const totalCost = rows.reduce((acc, r) => acc + (r.estimatedCost ?? 0), 0)
    const avgCostPerCall = totalCalls > 0 ? totalCost / totalCalls : 0

    return { totalCost, totalCalls, avgCostPerCall, totalTokens }
  }, [rows, providerStats])

  // Show empty state when no provider data at all
  if (!providerStats || Object.keys(providerStats).length === 0) {
    return <EmptyState t={t} />
  }

  return (
    <div className="space-y-5">
      {/* ── Period toggle ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Button
          variant={period === "7d" ? "default" : "ghost"}
          size="sm"
          onClick={() => setPeriod("7d")}
        >
          {t("costTab.last7Days")}
        </Button>
        <Button
          variant={period === "30d" ? "default" : "ghost"}
          size="sm"
          onClick={() => setPeriod("30d")}
        >
          {t("costTab.last30Days")}
        </Button>
      </div>

      {/* ── Overview cards ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <OverviewCard label={t("costTab.monthlyCost")} value={formatCost(totals.totalCost)} />
        <OverviewCard label={t("costTab.totalCalls")} value={String(totals.totalCalls)} />
        <OverviewCard
          label={t("costTab.avgCostPerCall")}
          value={formatCost(totals.avgCostPerCall)}
        />
        <OverviewCard label={t("costTab.totalTokens")} value={formatTokens(totals.totalTokens)} />
      </div>

      {/* ── Per-model cost table ──────────────────────────────────────── */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                {t("costTab.modelName")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("costTab.callCount")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("costTab.inputTokens")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("costTab.outputTokens")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("costTab.estimatedCost")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.modelId}
                className="border-b last:border-b-0 hover:bg-muted/20 transition-colors"
              >
                <td className="px-3 py-2 font-mono text-xs">{row.modelId}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.callCount}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatTokens(row.inputTokens)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatTokens(row.outputTokens)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.estimatedCost !== null ? formatCost(row.estimatedCost) : "N/A"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default ProviderCostTab
