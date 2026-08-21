"use client"

/**
 * KPI stat panel — a single big number with threshold coloring. The headline
 * metric and threshold come from the panel definition; values are derived from
 * the window KPIs.
 */

import { useTranslations } from "next-intl"
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
import { formatMs, formatPercent, formatRate, formatUsd } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"

const LEVEL_TEXT: Record<ThresholdLevel, string> = {
  ok: "text-foreground",
  warn: "text-warning",
  crit: "text-destructive",
}

function compactCount(n: number): string {
  if (!Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** Resolve a stat panel's display string + raw value for thresholding. */
export function resolveStat(panel: PanelDef, kpis: WindowKpis): { display: string; raw: number } {
  switch (panel.statMetric) {
    case "totalCost":
      return { display: formatUsd(kpis.totalCost), raw: kpis.totalCost }
    case "totalSpans":
      return { display: compactCount(kpis.totalSpans), raw: kpis.totalSpans }
    case "errorRate":
      return { display: formatPercent(kpis.errorRate, 1), raw: kpis.errorRate }
    case "cacheHitRate":
      return { display: formatPercent(kpis.cacheHitRate), raw: kpis.cacheHitRate }
    case "p95Latency":
      return { display: formatMs(kpis.p95LatencyMs), raw: kpis.p95LatencyMs }
    case "reqPerMin":
      return { display: formatRate(kpis.reqPerMin), raw: kpis.reqPerMin }
    case "toolCalls":
      return { display: compactCount(kpis.toolCalls), raw: kpis.toolCalls }
    case "toolFailures":
      return { display: compactCount(kpis.toolFailures), raw: kpis.toolFailures }
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
}

export function StatPanel({ panel, kpis, editMode, thresholds }: StatPanelProps) {
  const t = useTranslations("observability")
  const { display, raw } = resolveStat(panel, kpis)
  const level = statLevel(panel, raw, thresholds)

  return (
    <PanelFrame
      title={t(`panels.${panel.titleKey}`)}
      editMode={editMode}
      level={level}
      data-testid={`stat-panel-${panel.id}`}
    >
      <div className="flex h-full items-center">
        <span
          className={cn(
            "text-3xl font-semibold tabular-nums leading-none",
            level && LEVEL_TEXT[level]
          )}
          data-testid={`stat-value-${panel.id}`}
        >
          {display}
        </span>
      </div>
    </PanelFrame>
  )
}
