"use client"

/**
 * PerfMemoryPressure — a macOS-Activity-Monitor-style memory pressure gauge.
 * Shows used / total memory with a color-coded pressure bar (green / yellow / red).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
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

const LEVEL_STYLES: Record<
  PressureLevel,
  { progress: string; badge: "secondary" | "outline" | "destructive" }
> = {
  low: {
    progress: "[&_[data-slot=progress-indicator]]:bg-success",
    badge: "secondary",
  },
  moderate: {
    progress: "[&_[data-slot=progress-indicator]]:bg-warning",
    badge: "outline",
  },
  high: {
    progress: "[&_[data-slot=progress-indicator]]:bg-destructive",
    badge: "destructive",
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
    <section className="border-y bg-background" data-testid="perf-memory-pressure">
      <header className="border-b px-4 py-3">
        <h3 className="text-sm font-medium">{t("title")}</h3>
      </header>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold tabular-nums">{usedStr}</span>
          <span className="text-sm text-muted-foreground">/ {totalStr}</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Progress
            value={Math.min(ratio * 100, 100)}
            className={cn("h-2", styles.progress)}
            data-testid="perf-mem-pressure-bar"
            data-level={level}
          />
          <div className="flex items-center gap-1.5">
            <Badge variant={styles.badge}>{t(level)}</Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {memory ? `${(ratio * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
