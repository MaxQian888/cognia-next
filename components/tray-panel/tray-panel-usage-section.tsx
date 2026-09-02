"use client"

/**
 * Compact spend readout at the top of the tray quick panel (ADR-0165).
 *
 * The panel is a least-privilege webview with no Dexie and no app stores, so
 * this component renders a projection the main window already computed and
 * pushed over `tray-panel://state`. It derives nothing of its own beyond
 * layout, which is what keeps the number here identical to the one in the
 * menu bar above it.
 *
 * It refuses to draw a number it cannot stand behind: an entirely unpriced
 * window renders a dash, a partially priced one renders a lower bound, and an
 * incomplete scan says so in its own row rather than letting the headline
 * imply completeness.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon, ExternalLinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  costConfidence,
  formatGlanceMetric,
  glanceSeverity,
  sparklineSeries,
  UNKNOWN_COST,
  type GlanceSeverity,
} from "@/lib/usage/usage-glance-format"
import { PERIOD_LABEL_KEYS, type UsageGlanceMetric } from "@/lib/usage/usage-glance-format"
import type { UsageGlanceSnapshotV1 } from "@/lib/usage/usage-glance"
import { cn } from "@/lib/utils"

/** Meter fill per severity. Same vocabulary as the tray badge colours. */
const SEVERITY_FILL: Record<GlanceSeverity, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  crit: "bg-rose-500",
  exceeded: "bg-rose-500",
  unknown: "bg-muted-foreground/40",
}

export interface TrayPanelUsageSectionProps {
  glance: UsageGlanceSnapshotV1 | null | undefined
  /** Which metric leads. Follows the tray's own pref. */
  metric: UsageGlanceMetric
  onRefresh: () => void
  onOpenFull: () => void
  /** True while an external scan is in flight. */
  refreshing?: boolean
}

/**
 * Normalized meter position, 0-1. Prefers the budget (the number that has a
 * threshold), falls back to plan quota, and returns null when neither is
 * configured so the meter is omitted rather than drawn empty.
 */
export function meterRatio(glance: UsageGlanceSnapshotV1): number | null {
  const budgetRatio = glance.budget?.ratio
  if (typeof budgetRatio === "number" && Number.isFinite(budgetRatio)) {
    return Math.min(1, Math.max(0, budgetRatio))
  }
  const pct = glance.quota?.worstUsedPct
  if (typeof pct === "number" && Number.isFinite(pct)) return Math.min(1, Math.max(0, pct / 100))
  return null
}

/** Sparkline path over a 0-1 normalized series. Pure, so the test can read it. */
export function sparklinePath(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return ""
  const max = Math.max(...values, 0)
  const step = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const y = max > 0 ? height - (v / max) * height : height
      return `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${y.toFixed(2)}`
    })
    .join(" ")
}

export function TrayPanelUsageSection({
  glance,
  metric,
  onRefresh,
  onOpenFull,
  refreshing = false,
}: TrayPanelUsageSectionProps) {
  const t = useTranslations("trayPanel.usage")
  const tTray = useTranslations("tray.usage")

  const series = useMemo(
    () => (glance ? sparklineSeries(glance, 7, metric === "tokens" ? "tokens" : "spend") : []),
    [glance, metric]
  )
  const path = useMemo(() => sparklinePath(series, 96, 20), [series])

  if (!glance) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="tray-panel-usage">
        {t("loading")}
      </div>
    )
  }

  const headline = formatGlanceMetric(glance, metric)
  const severity = glanceSeverity(glance)
  const ratio = meterRatio(glance)
  const confidence = costConfidence(glance)
  const topProvider = glance.topProviders[0]
  const topModel = glance.topModels[0]

  return (
    <section
      className="flex flex-col gap-2 border-b px-3 py-2"
      data-testid="tray-panel-usage"
      aria-label={t("title")}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-lg font-semibold tabular-nums" data-testid="usage-headline">
            {headline}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {tTray(`period.${PERIOD_LABEL_KEYS[glance.query.period]}`)}
          </span>
        </div>
        {series.length > 0 && (
          <svg
            width={96}
            height={20}
            viewBox="0 0 96 20"
            className="shrink text-muted-foreground"
            role="img"
            aria-label={t("sparkline")}
          >
            <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
          </svg>
        )}
      </div>

      {ratio !== null && (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("meter")}
        >
          <div
            className={cn("h-full rounded-full transition-[width]", SEVERITY_FILL[severity])}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        {topProvider && <span className="truncate">{topProvider.id}</span>}
        {topModel && <span className="truncate">{topModel.id}</span>}
        <span className="tabular-nums">{t("turns", { count: glance.turns })}</span>
      </div>

      {(confidence !== "exact" || glance.freshness !== "fresh") && (
        <p
          className="text-[11px] text-amber-600 dark:text-amber-500"
          data-testid="usage-disclosure"
        >
          {confidence === "unknown"
            ? t("noPricing")
            : confidence === "lowerBound"
              ? t("partialPricing", { count: glance.unpricedTurns })
              : tTray(`freshness.${glance.freshness}`)}
        </p>
      )}

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
          {t("refresh")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={onOpenFull}
        >
          <ExternalLinkIcon className="size-3" />
          {t("openFull")}
        </Button>
      </div>
    </section>
  )
}

/** Re-exported so the panel can render the dash without importing two modules. */
export { UNKNOWN_COST }
