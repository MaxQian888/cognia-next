"use client"

/**
 * KPI stat panel — a single big number with threshold coloring. The headline
 * metric and threshold come from the panel definition; values are derived from
 * the window KPIs.
 *
 * Numbers format in the APP locale (`useObservabilityFormatters`); the pure
 * `resolveStat` takes the formatter set as an argument so it stays testable
 * without a provider, defaulting to the locale-neutral `format-utils` forms.
 *
 * A stat flagged `drillErrors` (error rate, tool failures) is also the way
 * into those failures: with `onDrill`, the number is a button that turns on
 * errors-only and switches to Explore. Before, the dashboard could tell you
 * 14% of traces failed and offer no way to see one of them.
 */

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { PanelFrame } from "./panel-frame"
import type { PanelDef } from "./panel-registry"
import type { WindowKpis } from "@/lib/observability/aggregate-series"
import {
  DEFAULT_THRESHOLDS,
  evalThreshold,
  type ThresholdConfig,
  type ThresholdLevel,
  type ThresholdMetric,
} from "@/lib/observability/thresholds"
import { formatMs, formatPercent, formatUsd } from "@/lib/observability/format-utils"
import {
  useObservabilityFormatters,
  type ObservabilityFormatters,
} from "@/hooks/observability/use-observability-formatters"
import { cn } from "@/lib/utils"

/** The formatter subset a stat needs. */
export type StatFormatters = Pick<
  ObservabilityFormatters,
  "usd" | "compact" | "percent" | "duration" | "decimal"
>

const LEVEL_TEXT: Record<ThresholdLevel, string> = {
  ok: "text-foreground",
  warn: "text-warning",
  crit: "text-destructive",
}

function compactCount(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** Locale-neutral defaults, for callers (and tests) without a provider. */
export const NEUTRAL_STAT_FORMATTERS: StatFormatters = {
  usd: formatUsd,
  compact: compactCount,
  percent: formatPercent,
  duration: formatMs,
  decimal: (value, digits = 2) =>
    typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—",
}

/** Resolve a stat panel's display string + raw value for thresholding. */
export function resolveStat(
  panel: PanelDef,
  kpis: WindowKpis,
  fmt: StatFormatters = NEUTRAL_STAT_FORMATTERS
): { display: string; raw: number } {
  switch (panel.statMetric) {
    case "totalCost":
      return { display: fmt.usd(kpis.totalCost), raw: kpis.totalCost }
    case "totalSpans":
      return { display: fmt.compact(kpis.totalSpans), raw: kpis.totalSpans }
    case "errorRate":
      return { display: fmt.percent(kpis.errorRate, 1), raw: kpis.errorRate }
    case "cacheHitRate":
      return { display: fmt.percent(kpis.cacheHitRate), raw: kpis.cacheHitRate }
    case "p95Latency":
      return { display: fmt.duration(kpis.p95LatencyMs), raw: kpis.p95LatencyMs }
    case "reqPerMin":
      return { display: fmt.decimal(kpis.reqPerMin, 2), raw: kpis.reqPerMin }
    case "toolCalls":
      return { display: fmt.compact(kpis.toolCalls), raw: kpis.toolCalls }
    case "toolFailures":
      return { display: fmt.compact(kpis.toolFailures), raw: kpis.toolFailures }
    default:
      return { display: "—", raw: 0 }
  }
}

export function statLevel(
  panel: PanelDef,
  raw: number,
  thresholds: Record<ThresholdMetric, ThresholdConfig> = DEFAULT_THRESHOLDS
): ThresholdLevel | undefined {
  if (!panel.threshold) return undefined
  return evalThreshold(raw, thresholds[panel.threshold])
}

export interface StatPanelProps {
  panel: PanelDef
  kpis: WindowKpis
  editMode?: boolean
  /** Resolved thresholds (defaults merged with user overrides). */
  thresholds?: Record<ThresholdMetric, ThresholdConfig>
  /** Errors-only drill into Explore; honoured only on `drillErrors` panels. */
  onDrill?: () => void
}

export function StatPanel({ panel, kpis, editMode, thresholds, onDrill }: StatPanelProps) {
  const t = useTranslations("observability")
  const fmt = useObservabilityFormatters()
  const { display, raw } = resolveStat(panel, kpis, fmt)
  const level = statLevel(panel, raw, thresholds)
  const title = t(`panels.${panel.titleKey}`)
  // In edit mode the tile is a drag target; a click there must not navigate.
  const drill = panel.drillErrors && onDrill && !editMode ? onDrill : undefined
  const valueClass = cn(
    "text-3xl font-semibold tabular-nums leading-none",
    level && LEVEL_TEXT[level]
  )

  return (
    <PanelFrame
      title={title}
      editMode={editMode}
      level={level}
      data-testid={`stat-panel-${panel.id}`}
    >
      <div className="flex h-full items-center">
        {drill ? (
          <Button
            type="button"
            variant="ghost"
            onClick={drill}
            className="-ml-2 h-auto px-2 py-1"
            aria-label={t("drill.showFailing", { metric: title, value: display })}
            title={t("drill.showFailingHint")}
            data-testid={`stat-drill-${panel.id}`}
          >
            <span className={valueClass} data-testid={`stat-value-${panel.id}`}>
              {display}
            </span>
          </Button>
        ) : (
          <span className={valueClass} data-testid={`stat-value-${panel.id}`}>
            {display}
          </span>
        )}
      </div>
    </PanelFrame>
  )
}
