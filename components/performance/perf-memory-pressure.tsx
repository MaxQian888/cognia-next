"use client"

/**
 * PerfMemoryPressure — a macOS-Activity-Monitor-style memory pressure gauge.
 * Shows used / total memory with a color-coded pressure bar (green / yellow / red).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { SystemMemory } from "@/lib/perf/backend/types"
import { formatBytes } from "@/lib/perf/backend/format"

export interface PerfMemoryPressureProps {
  memory: SystemMemory | null
}

type PressureLevel = "low" | "moderate" | "high"

function pressureLevel(ratio: number): PressureLevel {
  if (ratio >= 0.85) return "high"
  if (ratio >= 0.7) return "moderate"
  return "low"
}

const LEVEL_STYLES: Record<PressureLevel, { bar: string; text: string; dot: string }> = {
  low: {
    bar: "bg-green-500",
    text: "text-green-600 dark:text-green-400",
    dot: "bg-green-500",
  },
  moderate: {
    bar: "bg-yellow-500",
    text: "text-yellow-600 dark:text-yellow-400",
    dot: "bg-yellow-500",
  },
  high: {
    bar: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
    dot: "bg-red-500",
  },
}

export function PerfMemoryPressure({ memory }: PerfMemoryPressureProps) {
  const t = useTranslations("performance.memoryPressure")

  const { ratio, level, usedStr, totalStr } = useMemo(() => {
    if (!memory || memory.totalBytes === 0) {
      return { ratio: 0, level: "low" as PressureLevel, usedStr: "—", totalStr: "—" }
    }
    const r = memory.usedBytes / memory.totalBytes
    return {
      ratio: r,
      level: pressureLevel(r),
      usedStr: formatBytes(memory.usedBytes),
      totalStr: formatBytes(memory.totalBytes),
    }
  }, [memory])

  const styles = LEVEL_STYLES[level]

  return (
    <Card data-testid="perf-memory-pressure">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pb-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold tabular-nums">{usedStr}</span>
          <span className="text-sm text-muted-foreground">/ {totalStr}</span>
        </div>

        <div className="space-y-1.5">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", styles.bar)}
              style={{ width: `${Math.min(ratio * 100, 100)}%` }}
              data-testid="perf-mem-pressure-bar"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", styles.dot)} />
            <span className={cn("text-xs font-medium", styles.text)}>{t(level)}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {memory ? `${(ratio * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
