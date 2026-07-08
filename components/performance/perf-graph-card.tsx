"use client"

/**
 * PerfGraphCard — a Windows-Task-Manager-style rolling graph: a big current-
 * value readout above a filled area chart of the recent window. Reused for CPU,
 * memory, runtime busy %, and task count.
 */

import { useMemo } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from "recharts"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { TOOLTIP_STYLE } from "@/lib/observability/chart-config"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { cn } from "@/lib/utils"

/** Recharts Y-axis domain max value (number, keyword, or data-driven fn). */
type YDomainMax = number | string | ((dataMax: number) => number)

/**
 * Y-axis domain for the rolling area. With a fixed `max` (percentages) the axis
 * is pinned exactly so the threshold line and the 100% gridline stay
 * meaningful. With an auto axis we add ~10% headroom above the peak so the
 * area's top stroke isn't clipped flush against the top edge. Exported for unit
 * testing the headroom function.
 */
export function perfYDomain(max?: number): [number, YDomainMax] {
  if (typeof max === "number") return [0, max]
  // The `- 1e-9` absorbs float noise (e.g. `50 * 1.1 === 55.00000000000001`)
  // so integer peaks get clean headroom instead of an off-by-one tick.
  return [0, (dataMax: number) => (dataMax <= 0 ? 1 : Math.ceil(dataMax * 1.1 - 1e-9))]
}

export interface PerfGraphCardProps {
  title: string
  /** Pre-formatted current value (e.g. "42.3%" or "1.5 GB"). */
  current: string
  /** Series values, oldest → newest. */
  points: number[]
  /** Stroke/fill color (resolved oklch/hex string). */
  color: string
  /** Fixed Y-axis max (e.g. 100 for percentages); omit for auto. */
  max?: number
  /**
   * Chart height in px. In `fill` mode this is the *minimum* height and the
   * chart grows to fill the card; otherwise it is the fixed height.
   */
  height?: number
  /**
   * Let the chart grow to fill the card's available height instead of a fixed
   * box. Used by the overview where the graph shares a stretched grid row with
   * a taller metric rail — without this the chart leaves a large empty gap.
   */
  fill?: boolean
  /** Optional secondary line under the value (e.g. peak / detail). */
  subtitle?: string
  className?: string
  "data-testid"?: string
  /** Optional horizontal threshold line (e.g. 80 for a warning line). */
  threshold?: number
}

export function PerfGraphCard({
  title,
  current,
  points,
  color,
  max,
  height = 220,
  fill = false,
  subtitle,
  className,
  "data-testid": testId,
  threshold,
}: PerfGraphCardProps) {
  const colors = useThemeColors()
  const data = useMemo(() => points.map((value, index) => ({ index, value })), [points])
  const gradientId = useMemo(() => `perf-grad-${title.replace(/[^a-zA-Z0-9]/g, "")}`, [title])

  const yDomain = perfYDomain(max)

  return (
    <Card className={cn("flex flex-col", className)} data-testid={testId}>
      <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0 pb-2">
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        <span
          className="font-mono text-2xl font-semibold tabular-nums"
          data-testid="perf-graph-value"
        >
          {current}
        </span>
      </CardHeader>
      <CardContent className={cn("flex-1 pb-3", fill && "flex min-h-0 flex-col")}>
        {subtitle ? (
          <p className="mb-2 text-xs text-muted-foreground" data-testid="perf-graph-subtitle">
            {subtitle}
          </p>
        ) : null}
        <div
          className={cn(fill && "min-h-0 flex-1")}
          style={fill ? { minHeight: height } : undefined}
        >
          {/* initialDimension pre-empts recharts' -1×-1 first render before
              ResizeObserver reports (same pattern as perf-sparkline). */}
          <ResponsiveContainer
            width="100%"
            height={fill ? "100%" : height}
            initialDimension={{ width: 320, height }}
          >
            <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              <YAxis hide domain={yDomain} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE.contentStyle}
                labelStyle={TOOLTIP_STYLE.labelStyle}
                itemStyle={TOOLTIP_STYLE.itemStyle}
                cursor={{
                  stroke: colors["muted-foreground"],
                  strokeOpacity: 0.5,
                  strokeDasharray: "3 3",
                }}
                labelFormatter={() => ""}
                formatter={(value) => [Number(value).toFixed(1), title]}
              />
              {typeof threshold === "number" && (
                <ReferenceLine
                  y={threshold}
                  stroke={colors.destructive}
                  strokeDasharray="6 4"
                  strokeWidth={1.5}
                  data-testid="perf-graph-threshold"
                />
              )}
              <Area
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
