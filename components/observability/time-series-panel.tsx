"use client"

/**
 * Generic time-series panel. Renders the series named by `panel.seriesKind`
 * (cost / request-rate / error-rate / latency percentiles / token throughput)
 * as a recharts area or line chart, with optional warn/crit threshold
 * reference lines. Colors resolve through `useThemeColors` because recharts
 * SVG attributes can't read CSS vars.
 */

import { useTranslations } from "next-intl"
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
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
import { DEFAULT_THRESHOLDS } from "@/lib/observability/thresholds"
import { formatMs, formatPercent, formatUsd } from "@/lib/observability/format-utils"

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
}

export function TimeSeriesPanel({ panel, series, editMode }: TimeSeriesPanelProps) {
  const t = useTranslations("observability")
  const colors = useThemeColors()
  const cfg = buildChartConfig(panel, series, colors)
  const threshold = panel.threshold ? DEFAULT_THRESHOLDS[panel.threshold] : undefined

  return (
    <PanelFrame
      title={t(`panels.${panel.titleKey}`)}
      editMode={editMode}
      data-testid={`ts-panel-${panel.id}`}
    >
      <div className="h-full w-full" data-testid={`ts-chart-${panel.id}`}>
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
              {cfg.series.length > 1 && <Legend />}
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
              {cfg.series.length > 1 && <Legend />}
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
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </PanelFrame>
  )
}
