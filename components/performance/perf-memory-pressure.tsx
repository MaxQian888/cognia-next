"use client"

/**
 * Used/total memory utilization. The host does not currently expose operating
 * system pressure signals, so this component deliberately avoids inferring
 * pressure severity from utilization thresholds.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Progress } from "@/components/ui/progress"
import type { SystemMemory } from "@/lib/perf/backend/types"
import { formatBytes } from "@/lib/perf/backend/format"

export interface PerfMemoryPressureProps {
  memory: SystemMemory | null
}

export function PerfMemoryPressure({ memory }: PerfMemoryPressureProps) {
  const t = useTranslations("performance.memoryPressure")

  const { ratio, usedStr, totalStr } = useMemo(() => {
    if (!memory || memory.totalBytes === 0) {
      return { ratio: 0, usedStr: "—", totalStr: "—" }
    }
    const r = memory.usedBytes / memory.totalBytes
    return {
      ratio: r,
      usedStr: formatBytes(memory.usedBytes),
      totalStr: formatBytes(memory.totalBytes),
    }
  }, [memory])

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
            className="h-2"
            data-testid="perf-mem-pressure-bar"
            data-kind="utilization"
          />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t("utilization")}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {memory ? `${(ratio * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
