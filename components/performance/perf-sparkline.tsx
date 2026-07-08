"use client"

/**
 * PerfSparkline — the shared tiny filled-area trend used across the perf panel:
 * the overview metric tiles, the per-worker busy rows, and the per-process CPU
 * column. One implementation instead of the two near-identical inline charts
 * that used to live in `perf-metric-tile` and `perf-runtime-tab`.
 *
 * The caller sizes it via `className` (e.g. `h-8 w-16`); the chart fills its box.
 */

import { useMemo } from "react"
import { Area, AreaChart, ResponsiveContainer } from "recharts"
import { cn } from "@/lib/utils"

export interface PerfSparklineProps {
  /** Series values, oldest → newest. */
  points: number[]
  /** Stroke/fill color (resolved oklch/hex string). */
  color: string
  strokeWidth?: number
  fillOpacity?: number
  /** Sizing/spacing classes for the wrapper box (e.g. `"h-8 w-16 shrink-0"`). */
  className?: string
  "data-testid"?: string
}

export function PerfSparkline({
  points,
  color,
  strokeWidth = 1.5,
  fillOpacity = 0.18,
  className,
  "data-testid": testId,
}: PerfSparklineProps) {
  const data = useMemo(() => points.map((value, index) => ({ index, value })), [points])

  return (
    <div className={cn("h-8 w-16", className)} data-testid={testId}>
      {/* initialDimension pre-empts recharts' first render at its internal
          -1×-1 default ("The width(-1) and height(-1) of chart should be
          greater than 0") before ResizeObserver reports — same pattern as
          a2ui-chart / skill-analytics. 64×32 matches the default h-8 w-16
          box; the first real measurement corrects it immediately. */}
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 64, height: 32 }}>
        <AreaChart data={data} margin={{ top: 1, right: 0, left: 0, bottom: 0 }}>
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={strokeWidth}
            fill={color}
            fillOpacity={fillOpacity}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
