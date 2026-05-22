"use client"

import { memo, useMemo } from "react"
import { cn } from "@/lib/utils"

interface PlotPoint {
  x: number
  y: number
}

interface SvgPlotterRichOutputProps {
  points: PlotPoint[]
  height?: number
  className?: string
}

export const SvgPlotterRichOutput = memo(function SvgPlotterRichOutput({
  points,
  height = 260,
  className,
}: SvgPlotterRichOutputProps) {
  const path = useMemo(() => {
    if (points.length === 0) {
      return ""
    }

    const minX = Math.min(...points.map((point) => point.x))
    const maxX = Math.max(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxY = Math.max(...points.map((point) => point.y))

    const width = 640
    const padding = 32
    const innerWidth = width - padding * 2
    const innerHeight = height - padding * 2

    return points
      .map((point, index) => {
        const x = padding + ((point.x - minX) / Math.max(maxX - minX, 1)) * innerWidth
        const y = height - padding - ((point.y - minY) / Math.max(maxY - minY, 1)) * innerHeight
        return `${index === 0 ? "M" : "L"} ${x} ${y}`
      })
      .join(" ")
  }, [height, points])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border/60 bg-background/70 p-3",
        className
      )}
    >
      {/* SVG presentation attributes resolve `var(--token)` so the axis
          rules and plot line track the active appearance palette. */}
      <svg width="100%" height={height} viewBox={`0 0 640 ${height}`}>
        <line
          x1="32"
          y1={height - 32}
          x2="608"
          y2={height - 32}
          stroke="var(--muted-foreground)"
          strokeWidth="1.5"
        />
        <line
          x1="32"
          y1="32"
          x2="32"
          y2={height - 32}
          stroke="var(--muted-foreground)"
          strokeWidth="1.5"
        />
        <path
          d={path}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
})
