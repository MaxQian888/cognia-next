"use client"

/**
 * What caching saved, and what a typical turn — and a bad one — costs.
 *
 * Two read-outs that the headline averages hide. The cache saving is the money
 * the prompt cache kept off the bill, which is otherwise invisible because a
 * saving never appears as a line item. The percentiles show the long tail: the
 * p90 turn is usually several times the median, and that tail is what a budget
 * actually has to absorb.
 *
 * Presentational: both inputs come from the pure helpers in
 * `lib/usage/usage-insights.ts`, so the Usage dashboard (a date range) and the
 * Session Insights sheet (one conversation) mount the same panel.
 */

import { useTranslations } from "next-intl"
import { PiggyBankIcon } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { CacheSavings, Percentiles, TurnDistribution } from "@/lib/usage/usage-insights"
import { formatCost, formatDuration, formatTokens, formatTokensPerSec } from "@/types/system/usage"

export interface UsageEfficiencyPanelProps {
  savings: CacheSavings
  distribution: TurnDistribution
  testid?: string
}

type Formatter = (value: number) => string

export function UsageEfficiencyPanel({
  savings,
  distribution,
  testid = "usage-efficiency",
}: UsageEfficiencyPanelProps) {
  const t = useTranslations("usageInsights.efficiency")
  const speed: Formatter = (v) => t("tokPerSec", { value: formatTokensPerSec(v) })
  const rows: Array<{ id: string; label: string; stats: Percentiles; fmt: Formatter }> = []
  if (distribution.costPerTurn) {
    rows.push({
      id: "cost",
      label: t("costPerTurn"),
      stats: distribution.costPerTurn,
      fmt: formatCost,
    })
  }
  if (distribution.latencyMs) {
    rows.push({
      id: "latency",
      label: t("latency"),
      stats: distribution.latencyMs,
      fmt: formatDuration,
    })
  }
  if (distribution.outputTokensPerSec) {
    rows.push({
      id: "throughput",
      label: t("throughput"),
      stats: distribution.outputTokensPerSec,
      fmt: speed,
    })
  }

  return (
    <div className="space-y-4" data-testid={testid}>
      <div className="flex items-start gap-3 rounded-lg border p-3" data-testid={`${testid}-cache`}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <PiggyBankIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("cacheSaved")}
          </p>
          {savings.savedUsd > 0 ? (
            <>
              <p
                className="font-mono text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                data-testid={`${testid}-cache-value`}
              >
                {t("cacheSavedValue", { cost: formatCost(savings.savedUsd) })}
              </p>
              {savings.savingsRate != null ? (
                <p className="text-xs text-muted-foreground">
                  {t("cacheSavedHint", { pct: Math.round(savings.savingsRate * 100) })}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid={`${testid}-cache-none`}>
              {t("cacheNone")}
            </p>
          )}
          {savings.unpricedReadTokens > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t("cacheUnpriced", { tokens: formatTokens(savings.unpricedReadTokens) })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("distributionTitle")}
        </p>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid={`${testid}-distribution-empty`}>
            {t("distributionEmpty")}
          </p>
        ) : (
          <Table data-testid={`${testid}-distribution`}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colMetric")}</TableHead>
                <TableHead className="text-right">{t("colP50")}</TableHead>
                <TableHead className="text-right">{t("colP90")}</TableHead>
                <TableHead className="hidden text-right sm:table-cell">{t("colP99")}</TableHead>
                <TableHead className="text-right">{t("colMax")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-testid={`${testid}-row-${row.id}`}>
                  <TableCell className="text-xs">
                    {row.label}
                    <p className="text-[10px] text-muted-foreground">
                      {t("sample", { count: row.stats.count })}
                    </p>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {row.fmt(row.stats.p50)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {row.fmt(row.stats.p90)}
                  </TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular-nums sm:table-cell">
                    {row.fmt(row.stats.p99)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {row.fmt(row.stats.max)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
