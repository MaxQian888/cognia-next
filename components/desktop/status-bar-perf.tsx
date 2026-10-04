"use client"

/**
 * Status-bar performance segment — compact CPU%/mem for the app's main process
 * with a live sparkline, popover detail, and a jump to `/performance`. Reuses
 * `usePerfStream` (which starts/stops the native sampler on mount/unmount) plus
 * the shared `PerfSparkline` / `PerfMetricTile` widgets. Because mounting begins
 * sampling, the parent only mounts this when `barItems.perf` is on. Returns
 * `null` when the native runtime is unavailable (web).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { CpuIcon } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { PerfMetricTile } from "@/components/performance/perf-metric-tile"
import { PerfSparkline } from "@/components/performance/perf-sparkline"
import { usePerfStream } from "@/hooks/perf/use-perf-stream"
import { formatBytes } from "@/lib/perf/backend/format"
import { perfDashboardHref } from "@/lib/perf/dashboard-url"

export function StatusBarPerf() {
  const t = useTranslations("desktop.statusBar")
  const router = useRouter()
  const { history, latest, available } = usePerfStream()

  // Until the host lease delivers its first frame the stream falls back to
  // Renderer frames, which carry no processes. Their Tokio/memory fields are
  // structural zeros, so an unmeasured interval is a gap and the readout is
  // "—" rather than a confident "0%".
  const cpuSeries = useMemo(
    () => history.map((s) => s.processes.find((p) => p.role === "main")?.cpuPct ?? null),
    [history]
  )
  const memSeries = useMemo(
    () => history.map((s) => s.processes.find((p) => p.role === "main")?.memBytes ?? null),
    [history]
  )

  if (!available) return null

  const main = latest?.processes.find((p) => p.role === "main") ?? null
  const cpuText = main ? `${Math.round(main.cpuPct)}%` : "—"
  const memText = main ? formatBytes(main.memBytes, 0) : "—"

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="status-perf"
          aria-label={t("perf")}
          className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <CpuIcon aria-hidden className="size-3" />
          <span className="tabular-nums">{cpuText}</span>
          <PerfSparkline points={cpuSeries} color="currentColor" className="h-3.5 w-10" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-64 space-y-2 p-2">
        <PerfMetricTile
          label={t("perfCpu")}
          value={cpuText}
          points={cpuSeries}
          color="currentColor"
          active={false}
          onSelect={() =>
            router.push(perfDashboardHref({ tab: "overview", metric: "host.main.cpu-pct" }))
          }
          data-testid="status-perf-cpu"
        />
        <PerfMetricTile
          label={t("perfMem")}
          value={memText}
          points={memSeries}
          color="currentColor"
          active={false}
          onSelect={() =>
            router.push(perfDashboardHref({ tab: "overview", metric: "host.main.memory-bytes" }))
          }
          data-testid="status-perf-mem"
        />
      </PopoverContent>
    </Popover>
  )
}
