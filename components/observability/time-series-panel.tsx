"use client"

/**
 * Generic time-series panel. Renders the series named by `panel.seriesKind`
 * (cost / request-rate / error-rate / latency percentiles / token throughput)
 * as a recharts area or line chart, with optional warn/crit threshold
 * reference lines. Colors resolve through `useThemeColors` because recharts
 * SVG attributes can't read CSS vars.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { PanelFrame } from "./panel-frame"
import type { PanelDef } from "./panel-registry"
import type { ObservabilitySeries } from "@/hooks/observability/use-observability-series"
import { useThemeColors, type ThemeColors } from "@/hooks/logging/use-theme-colors"
import { TOOLTIP_STYLE, CHART_MARGINS } from "@/lib/observability/chart-config"
import {
  DEFAULT_THRESHOLDS,
  type ThresholdConfig,
  type ThresholdMetric,
} from "@/lib/observability/thresholds"
import { formatMs, formatPercent, formatUsd } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"

type SeriesDef = { key: string; labelKey: string; color: string; stackId?: string }

interface ChartConfig {
  type: "area" | "line"
  /** recharts row data — the series points (`{ t, …metrics }`). */
  data: unknown[]
  series: SeriesDef[]
  valueFormat: (v: number) => string
  yDomain?: [number | string, number | string]
}

/** Build the recharts config for a panel's series. Exported for unit testing. */
export function buildChartConfig(
  panel: PanelDef,
  series: ObservabilitySeries,
  colors: ThemeColors
): ChartConfig {
  switch (panel.seriesKind) {
    case "cost":
      return {
        type: "area",
        data: series.cost.points,
        series: [{ key: "costUsd", labelKey: "series.cost", color: colors["chart-1"] }],
        valueFormat: (v) => formatUsd(v),
      }
    case "requestRate":
      return {
        type: "area",
        data: series.requestRate.points,
        series: [{ key: "perSec", labelKey: "series.perSec", color: colors["chart-2"] }],
        valueFormat: (v) => `${v.toFixed(2)}/s`,
      }
    case "errorRate":
      return {
        type: "line",
        data: series.errorRate.points,
        series: [{ key: "errorRate", labelKey: "series.errorRate", color: colors.destructive }],
        valueFormat: (v) => formatPercent(v, 1),
        yDomain: [0, "auto"],
      }
    case "latency":
      return {
        type: "line",
        data: series.latency.points,
        series: [
          { key: "p50", labelKey: "series.p50", color: colors["chart-2"] },
          { key: "p95", labelKey: "series.p95", color: colors["chart-4"] },
          { key: "p99", labelKey: "series.p99", color: colors.destructive },
        ],
        valueFormat: (v) => formatMs(v),
      }
    case "tokens":
      return {
        type: "area",
        data: series.tokens.points,
        series: [
          { key: "input", labelKey: "series.input", color: colors["chart-1"], stackId: "tok" },
          { key: "output", labelKey: "series.output", color: colors["chart-2"], stackId: "tok" },
          {
            key: "cacheRead",
            labelKey: "series.cacheRead",
            color: colors["chart-3"],
            stackId: "tok",
          },
          {
            key: "cacheCreation",
            labelKey: "series.cacheCreation",
            color: colors["chart-4"],
            stackId: "tok",
          },
        ],
        valueFormat: (v) => String(Math.round(v)),
      }
    default:
      return { type: "area", data: [], series: [], valueFormat: (v) => String(v) }
  }
}

function axisTimeFormatter(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface TimeSeriesPanelProps {
  panel: PanelDef
  series: ObservabilitySeries
  editMode?: boolean
  /** Resolved thresholds (defaults merged with user overrides). */
  thresholds?: Record<ThresholdMetric, ThresholdConfig>
}

export function TimeSeriesPanel({ panel, series, editMode, thresholds }: TimeSeriesPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const cfg = buildChartConfig(panel, series, colors)
  const table = thresholds ?? DEFAULT_THRESHOLDS
  const threshold = panel.threshold ? table[panel.threshold] : undefined

  // Clicking a legend entry hides/shows that series. Only shown for multi-series
  // panels (latency percentiles, token throughput).
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const multi = cfg.series.length > 1

  return (
    <PanelFrame
      title={t(`panels.${panel.titleKey}`)}
      editMode={editMode}
      data-testid={`ts-panel-${panel.id}`}
    >
      <div className="flex h-full w-full flex-col" data-testid={`ts-chart-${panel.id}`}>
        {multi && (
          <div
            className="mb-1 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1"
            data-testid={`ts-legend-${panel.id}`}
          >
            {cfg.series.map((s) => {
              const isHidden = hidden.has(s.key)
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggle(s.key)}
                  aria-pressed={!isHidden}
                  data-testid={`ts-legend-${panel.id}-${s.key}`}
                  className={cn(
                    "flex items-center gap-1 text-[11px] transition-opacity",
                    isHidden ? "opacity-40" : "opacity-100"
                  )}
                >
                  <span
                    className="size-2 rounded-sm"
                    style={{ backgroundColor: s.color }}
                    aria-hidden="true"
                  />
                  <span className={cn(isHidden && "line-through")}>{t(s.labelKey)}</span>
                </button>
              )
            })}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            {cfg.type === "area" ? (
              <AreaChart data={cfg.data} margin={CHART_MARGINS.default}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="t" tickFormatter={axisTimeFormatter} tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  width={48}
                  tickFormatter={(v) => cfg.valueFormat(Number(v))}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                  labelFormatter={(l) => axisTimeFormatter(Number(l))}
                  formatter={(value) => cfg.valueFormat(Number(value))}
                />
                {cfg.series.map((s) => (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={t(s.labelKey)}
                    stackId={s.stackId}
                    stroke={s.color}
                    fill={s.color}
                    fillOpacity={0.18}
                    hide={hidden.has(s.key)}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </AreaChart>
            ) : (
              <LineChart data={cfg.data} margin={CHART_MARGINS.default}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="t" tickFormatter={axisTimeFormatter} tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  width={48}
                  domain={cfg.yDomain}
                  tickFormatter={(v) => cfg.valueFormat(Number(v))}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                  labelFormatter={(l) => axisTimeFormatter(Number(l))}
                  formatter={(value) => cfg.valueFormat(Number(value))}
                />
                {threshold && (
                  <>
                    <ReferenceLine
                      y={threshold.warn}
                      stroke={colors.warning}
                      strokeDasharray="4 4"
                      strokeOpacity={0.7}
                    />
                    <ReferenceLine
                      y={threshold.crit}
                      stroke={colors.destructive}
                      strokeDasharray="4 4"
                      strokeOpacity={0.7}
                    />
                  </>
                )}
                {cfg.series.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={t(s.labelKey)}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    hide={hidden.has(s.key)}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>
    </PanelFrame>
  )
}
