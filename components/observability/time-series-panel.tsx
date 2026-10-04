"use client"

/**
 * Generic time-series panel. Renders the series named by `panel.seriesKind`
 * (cost / request-rate / error-rate / latency percentiles / token throughput)
 * as a recharts area or line chart, with optional warn/crit threshold
 * reference lines. Colors resolve through `useThemeColors` because recharts
 * SVG attributes can't read CSS vars.
 *
 * Values and the time axis format in the APP locale. The axis used to print a
 * bare `HH:mm` at every width, so a 7-day window read "14:00 · 14:00 · 14:00"
 * with nothing to say which day a spike was on; `axisTimeFormat` adds the date
 * past 24h. Units ("/s") are a message, not a template literal.
 *
 * With `onDrillWindow`, clicking a point pins the range to that point's bucket
 * (`bucketWindow`) and the channel switches to Explore — the traces the point
 * counted, listed.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
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
import { axisTimeFormat, bucketWindow } from "@/lib/observability/time-range"
import {
  useObservabilityFormatters,
  type ObservabilityFormatters,
} from "@/hooks/observability/use-observability-formatters"
import { cn } from "@/lib/utils"

/** How a chart prints its values. `perSecond` is a translated "{value}/s". */
export interface ChartFormatters {
  usd: (value: number) => string
  percent: (fraction: number, digits?: number) => string
  duration: (ms: number) => string
  compact: (value: number) => string
  perSecond: (value: number) => string
}

/** Locale-neutral defaults, for callers (and tests) without a provider. */
export const NEUTRAL_CHART_FORMATTERS: ChartFormatters = {
  usd: (v) => formatUsd(v),
  percent: (v, digits = 0) => formatPercent(v, digits),
  duration: (v) => formatMs(v),
  compact: (v) => String(Math.round(v)),
  perSecond: (v) => `${v.toFixed(2)}/s`,
}

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
  colors: ThemeColors,
  fmt: ChartFormatters = NEUTRAL_CHART_FORMATTERS
): ChartConfig {
  switch (panel.seriesKind) {
    case "cost":
      return {
        type: "area",
        data: series.cost.points,
        series: [{ key: "costUsd", labelKey: "series.cost", color: colors["chart-1"] }],
        valueFormat: (v) => fmt.usd(v),
      }
    case "requestRate":
      return {
        type: "area",
        data: series.requestRate.points,
        series: [{ key: "perSec", labelKey: "series.perSec", color: colors["chart-2"] }],
        valueFormat: (v) => fmt.perSecond(v),
      }
    case "errorRate":
      return {
        type: "line",
        data: series.errorRate.points,
        series: [{ key: "errorRate", labelKey: "series.errorRate", color: colors.destructive }],
        valueFormat: (v) => fmt.percent(v, 1),
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
        valueFormat: (v) => fmt.duration(v),
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
        valueFormat: (v) => fmt.compact(v),
      }
    default:
      return { type: "area", data: [], series: [], valueFormat: (v) => String(v) }
  }
}

/** The epoch-ms span a series covers: first bucket start → last bucket end. */
export function seriesSpanMs(data: unknown[], bucketMs: number): number {
  const first = (data[0] as { t?: number } | undefined)?.t
  const last = (data[data.length - 1] as { t?: number } | undefined)?.t
  if (typeof first !== "number" || typeof last !== "number") return 0
  return last - first + Math.max(0, bucketMs)
}

/** The bucket start a recharts click landed on, from its index or its label. */
export function clickedBucket(
  state: { activeIndex?: unknown; activeLabel?: unknown } | null | undefined,
  data: unknown[]
): number | null {
  if (!state) return null
  const index =
    typeof state.activeIndex === "number" ? state.activeIndex : Number(state.activeIndex)
  const fromIndex = Number.isInteger(index)
    ? (data[index] as { t?: number } | undefined)?.t
    : undefined
  if (typeof fromIndex === "number") return fromIndex
  const label = Number(state.activeLabel)
  return Number.isFinite(label) && state.activeLabel !== undefined ? label : null
}

export interface TimeSeriesPanelProps {
  panel: PanelDef
  series: ObservabilitySeries
  editMode?: boolean
  /** Resolved thresholds (defaults merged with user overrides). */
  thresholds?: Record<ThresholdMetric, ThresholdConfig>
  /** Pin the range to a clicked point's bucket and switch to Explore. */
  onDrillWindow?: (window: { since: number; until: number }) => void
}

function toChartFormatters(
  fmt: ObservabilityFormatters,
  perSecond: (value: string) => string
): ChartFormatters {
  return {
    usd: (v) => fmt.usd(v),
    percent: (v, digits) => fmt.percent(v, digits),
    duration: (v) => fmt.duration(v),
    compact: (v) => fmt.compact(v),
    perSecond: (v) => perSecond(fmt.decimal(v, 2)),
  }
}

export function TimeSeriesPanel({
  panel,
  series,
  editMode,
  thresholds,
  onDrillWindow,
}: TimeSeriesPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const fmt = useObservabilityFormatters()
  const cfg = buildChartConfig(
    panel,
    series,
    colors,
    toChartFormatters(fmt, (value) => t("series.perSecValue", { value }))
  )
  const axisOptions = axisTimeFormat(seriesSpanMs(cfg.data, series.bucketMs))
  const axisTime = (value: unknown) => fmt.dateTimeWith(Number(value), axisOptions)
  // In edit mode a click is the start of a drag; never navigate on it.
  const drill = onDrillWindow && !editMode ? onDrillWindow : undefined
  const handleChartClick = drill
    ? (state: { activeIndex?: unknown; activeLabel?: unknown } | null) => {
        const start = clickedBucket(state, cfg.data)
        if (start === null) return
        const last = (cfg.data[cfg.data.length - 1] as { t?: number } | undefined)?.t
        const until = typeof last === "number" ? last + series.bucketMs : undefined
        drill(bucketWindow(start, series.bucketMs, until === undefined ? undefined : { until }))
      }
    : undefined
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
      <div
        className={cn("flex h-full w-full flex-col", drill && "cursor-pointer")}
        data-testid={`ts-chart-${panel.id}`}
        data-drillable={drill ? "true" : undefined}
        title={drill ? t("drill.pointHint") : undefined}
      >
        {multi && (
          <div
            className="mb-1 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1"
            data-testid={`ts-legend-${panel.id}`}
          >
            {cfg.series.map((s) => {
              const isHidden = hidden.has(s.key)
              return (
                <Button
                  key={s.key}
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => toggle(s.key)}
                  aria-pressed={!isHidden}
                  data-testid={`ts-legend-${panel.id}-${s.key}`}
                  className={cn(
                    "h-5 items-center gap-1 px-1 text-[11px] transition-opacity",
                    isHidden ? "opacity-40" : "opacity-100"
                  )}
                >
                  <span
                    className="size-2 rounded-sm"
                    style={{ backgroundColor: s.color }}
                    aria-hidden="true"
                  />
                  <span className={cn(isHidden && "line-through")}>{t(s.labelKey)}</span>
                </Button>
              )
            })}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={1}
            minHeight={1}
            initialDimension={{ width: 320, height: 180 }}
          >
            {cfg.type === "area" ? (
              <AreaChart data={cfg.data} margin={CHART_MARGINS.default} onClick={handleChartClick}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="t" tickFormatter={axisTime} tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  width={48}
                  tickFormatter={(v) => cfg.valueFormat(Number(v))}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                  labelFormatter={(l) => fmt.dateTime(Number(l))}
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
              <LineChart data={cfg.data} margin={CHART_MARGINS.default} onClick={handleChartClick}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="t" tickFormatter={axisTime} tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  width={48}
                  domain={cfg.yDomain}
                  tickFormatter={(v) => cfg.valueFormat(Number(v))}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                  labelFormatter={(l) => fmt.dateTime(Number(l))}
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
