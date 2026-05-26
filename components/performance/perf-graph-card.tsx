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
  height?: number
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
  subtitle,
  className,
  "data-testid": testId,
  threshold,
}: PerfGraphCardProps) {
  const colors = useThemeColors()
  const data = useMemo(() => points.map((value, index) => ({ index, value })), [points])
  const gradientId = useMemo(() => `perf-grad-${title.replace(/[^a-zA-Z0-9]/g, "")}`, [title])

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
      <CardContent className="flex-1 pb-3">
        {subtitle ? (
          <p className="mb-2 text-xs text-muted-foreground" data-testid="perf-graph-subtitle">
            {subtitle}
          </p>
        ) : null}
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
            <YAxis hide domain={[0, max ?? "auto"]} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE.contentStyle}
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
      </CardContent>
    </Card>
  )
}
