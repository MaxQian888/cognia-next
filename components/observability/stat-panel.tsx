"use client"

/**
 * KPI stat cell — one number with threshold coloring. The headline metric and
 * threshold come from the panel definition; values are derived from the window
 * KPIs.
 *
 * It is a cell of the `KpiStrip`, not a framed grid tile. Each KPI used to be
 * its own `PanelFrame` in the draggable grid — a bordered section with a
 * header rule, eight of them in a 5 + 3 arrangement of unequal widths, and on
 * a phone four rows of them before the first chart. A number does not need a
 * frame, a title bar or a drag handle; the strip draws one set of hairlines
 * around all of them and this cell is just label + value.
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

const LEVEL_DOT: Record<ThresholdLevel, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  crit: "bg-destructive",
}

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
  /** Resolved thresholds (defaults merged with user overrides). */
  thresholds?: Record<ThresholdMetric, ThresholdConfig>
  /** Errors-only drill into Explore; honoured only on `drillErrors` panels. */
  onDrill?: () => void
  className?: string
}

export function StatPanel({ panel, kpis, thresholds, onDrill, className }: StatPanelProps) {
  const t = useTranslations("observability")
  const tLevel = useTranslations("observability.thresholdLevel")
  const fmt = useObservabilityFormatters()
  const { display, raw } = resolveStat(panel, kpis, fmt)
  const level = statLevel(panel, raw, thresholds)
  const title = t(`panels.${panel.titleKey}`)
  const drill = panel.drillErrors && onDrill ? onDrill : undefined
  const valueClass = cn(
    "truncate text-xl font-semibold tabular-nums leading-tight @lg/kpi:text-2xl",
    level && LEVEL_TEXT[level]
  )

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1 px-3 py-2.5", className)}
      data-testid={`stat-panel-${panel.id}`}
    >
      <dt className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {level && (
          <span
            className={cn("size-1.5 shrink-0 rounded-full", LEVEL_DOT[level])}
            data-testid="panel-threshold-dot"
            data-level={level}
            aria-hidden="true"
          />
        )}
        <span className="truncate">{title}</span>
        {level && level !== "ok" && (
          <span className="sr-only" data-testid="panel-threshold-sr">
            {tLevel(level)}
          </span>
        )}
      </dt>
      <dd className="min-w-0">
        {drill ? (
          <Button
            type="button"
            variant="ghost"
            onClick={drill}
            className="-mx-1.5 h-auto max-w-full justify-start px-1.5 py-0"
            aria-label={t("drill.showFailing", { metric: title, value: display })}
            title={t("drill.showFailingHint")}
            data-testid={`stat-drill-${panel.id}`}
          >
            <span className={valueClass} data-testid={`stat-value-${panel.id}`}>
              {display}
            </span>
          </Button>
        ) : (
          <span className={cn("block", valueClass)} data-testid={`stat-value-${panel.id}`}>
            {display}
          </span>
        )}
      </dd>
    </div>
  )
}
