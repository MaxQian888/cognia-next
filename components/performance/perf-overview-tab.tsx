"use client"

/**
 * PerfOverviewTab — the Task-Manager "Performance" layout: a left rail of
 * metric tiles (CPU / Memory / Runtime busy / Tasks) and a large rolling graph
 * for the selected metric on the right.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import type { PerfSample } from "@/lib/perf/backend/types"
import {
  formatBytes,
  formatBytesPerSec,
  formatCount,
  formatPercent,
} from "@/lib/perf/backend/format"
import { PerfGraphCard } from "./perf-graph-card"
import { PerfMetricTile } from "./perf-metric-tile"
import { PerfMemoryPressure } from "./perf-memory-pressure"

type MetricId = "cpu" | "memory" | "runtimeBusy" | "tasks" | "diskIo"

function mainCpu(sample: PerfSample): number {
  return sample.processes.find((p) => p.role === "main")?.cpuPct ?? 0
}
function mainMem(sample: PerfSample): number {
  return sample.processes.find((p) => p.role === "main")?.memBytes ?? 0
}
/** Combined disk throughput (read + write) summed across the whole tree. */
function totalDiskIo(sample: PerfSample): number {
  return sample.processes.reduce((sum, p) => sum + p.diskReadBps + p.diskWriteBps, 0)
}

export interface PerfOverviewTabProps {
  history: PerfSample[]
}

export function PerfOverviewTab({ history }: PerfOverviewTabProps) {
  const t = useTranslations("performance")
  const colors = useThemeColors()
  const [selected, setSelected] = useState<MetricId>("cpu")

  const latest = history.length > 0 ? history[history.length - 1] : null

  const metrics = useMemo(() => {
    const cpu = history.map(mainCpu)
    const mem = history.map(mainMem)
    const busy = history.map((s) => s.runtime.busyPct)
    const tasks = history.map((s) => s.runtime.aliveTasks)
    const diskIo = history.map(totalDiskIo)
    return {
      cpu: {
        id: "cpu" as const,
        label: t("metrics.cpu"),
        points: cpu,
        color: colors["chart-1"],
        max: 100,
        threshold: 80,
        value: formatPercent(latest ? mainCpu(latest) : 0),
      },
      memory: {
        id: "memory" as const,
        label: t("metrics.memory"),
        points: mem,
        color: colors["chart-2"],
        max: undefined,
        threshold: undefined,
        value: formatBytes(latest ? mainMem(latest) : 0),
      },
      runtimeBusy: {
        id: "runtimeBusy" as const,
        label: t("metrics.runtimeBusy"),
        points: busy,
        color: colors["chart-4"],
        max: 100,
        threshold: 80,
        value: formatPercent(latest ? latest.runtime.busyPct : 0),
      },
      tasks: {
        id: "tasks" as const,
        label: t("metrics.tasks"),
        points: tasks,
        color: colors["chart-3"],
        max: undefined,
        threshold: undefined,
        value: formatCount(latest ? latest.runtime.aliveTasks : 0),
      },
      diskIo: {
        id: "diskIo" as const,
        label: t("metrics.diskIo"),
        points: diskIo,
        color: colors["chart-5"],
        max: undefined,
        threshold: undefined,
        value: formatBytesPerSec(latest ? totalDiskIo(latest) : 0),
      },
    }
  }, [history, latest, colors, t])

  const order: MetricId[] = ["cpu", "memory", "runtimeBusy", "tasks", "diskIo"]
  const active = metrics[selected]

  const latestMemory = latest?.systemMemory ?? null

  return (
    <div
      className="grid h-full grid-cols-1 gap-4 md:grid-cols-[260px_1fr]"
      data-testid="perf-overview"
    >
      <div className="flex flex-col gap-3" role="tablist" aria-label={t("overview.selectMetric")}>
        <PerfMemoryPressure memory={latestMemory} />
        <div className="flex flex-col gap-2">
          {order.map((id) => {
            const m = metrics[id]
            return (
              <PerfMetricTile
                key={id}
                label={m.label}
                value={m.value}
                points={m.points}
                color={m.color}
                active={selected === id}
                onSelect={() => setSelected(id)}
                data-testid={`perf-tile-${id}`}
              />
            )
          })}
        </div>
      </div>
      <PerfGraphCard
        title={active.label}
        current={active.value}
        points={active.points}
        color={active.color}
        max={active.max}
        threshold={active.threshold}
        fill
        height={320}
        data-testid="perf-overview-graph"
      />
    </div>
  )
}
