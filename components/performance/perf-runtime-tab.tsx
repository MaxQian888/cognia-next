"use client"

/**
 * PerfRuntimeTab — Tokio runtime detail grouped into Workers · Tasks · Queues ·
 * Throughput KPI cards (shared `StatCard` idiom), a per-worker busy-% card with
 * sparklines, and a card surfacing the dial9 flight-recorder trace files for
 * offline analysis (per the no-in-process-sampler decision: live span hotspots
 * + the existing trace, not a new profiler).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  ArrowLeftRightIcon,
  CpuIcon,
  FolderOpenIcon,
  GaugeIcon,
  LayersIcon,
  ListOrderedIcon,
  ListTreeIcon,
  PauseIcon,
  PlayIcon,
  TimerIcon,
  TrendingUpIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { StatCard } from "@/components/observability/stat-card"
import type { PerfSample, RuntimeSample, TraceFile } from "@/lib/perf/backend/types"
import { perfListTraces, perfOpenTraceDir } from "@/lib/perf/backend/commands"
import { formatBytes, formatCount, formatPercent } from "@/lib/perf/backend/format"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { PerfSparkline } from "./perf-sparkline"

/** Mean worker busy % above which the runtime is considered saturated. */
const BUSY_THRESHOLD = 80

export interface PerfRuntimeTabProps {
  runtime: RuntimeSample | null
  history?: PerfSample[]
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
    </div>
  )
}

export function PerfRuntimeTab({ runtime, history = [] }: PerfRuntimeTabProps) {
  const t = useTranslations("performance.runtime")
  const colors = useThemeColors()
  const [traces, setTraces] = useState<TraceFile[]>([])
  const aliveRef = useRef(true)

  const workerHistories = useMemo(() => {
    if (!runtime) return []
    return runtime.perWorkerBusyPct.map((_, i) =>
      history.map((s) => s.runtime.perWorkerBusyPct[i] ?? 0)
    )
  }, [history, runtime])

  useEffect(() => {
    aliveRef.current = true
    void (async () => {
      const list = await perfListTraces()
      if (aliveRef.current) setTraces(list)
    })()
    return () => {
      aliveRef.current = false
    }
  }, [])

  const openTraces = useCallback(() => {
    void perfOpenTraceDir()
  }, [])

  if (!runtime) {
    return (
      <p
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="perf-runtime-empty"
      >
        {t("empty")}
      </p>
    )
  }

  const busySaturated = runtime.busyPct >= BUSY_THRESHOLD

  return (
    <div className="space-y-5" data-testid="perf-runtime">
      <Section title={t("groups.workers")}>
        <StatCard
          icon={CpuIcon}
          label={t("workers")}
          value={formatCount(runtime.workers)}
          color="bg-chart-1/10 text-chart-1"
          data-testid="perf-rt-workers"
        />
        <StatCard
          icon={GaugeIcon}
          label={t("busy")}
          value={formatPercent(runtime.busyPct)}
          color={
            busySaturated ? "bg-destructive/10 text-destructive" : "bg-chart-4/10 text-chart-4"
          }
          trend={busySaturated ? "up" : undefined}
          data-testid="perf-rt-busy"
        />
      </Section>

      <Section title={t("groups.tasks")}>
        <StatCard
          icon={ActivityIcon}
          label={t("aliveTasks")}
          value={formatCount(runtime.aliveTasks)}
          color="bg-chart-2/10 text-chart-2"
          data-testid="perf-rt-alive"
        />
        <StatCard
          icon={PlayIcon}
          label={t("spawned")}
          value={formatCount(runtime.spawnedTasksCount)}
          color="bg-chart-3/10 text-chart-3"
          data-testid="perf-rt-spawned"
        />
      </Section>

      <Section title={t("groups.queues")}>
        <StatCard
          icon={ListTreeIcon}
          label={t("globalQueue")}
          value={formatCount(runtime.globalQueueDepth)}
          color="bg-chart-5/10 text-chart-5"
          data-testid="perf-rt-global-queue"
        />
        <StatCard
          icon={LayersIcon}
          label={t("blockingThreads")}
          value={formatCount(runtime.blockingThreads)}
          color="bg-chart-1/10 text-chart-1"
          data-testid="perf-rt-blocking"
        />
        <StatCard
          icon={ListOrderedIcon}
          label={t("blockingQueue")}
          value={formatCount(runtime.blockingQueueDepth)}
          color="bg-chart-2/10 text-chart-2"
          data-testid="perf-rt-blocking-queue"
        />
      </Section>

      <Section title={t("groups.throughput")}>
        <StatCard
          icon={ArrowLeftRightIcon}
          label={t("steal")}
          value={formatCount(runtime.workerStealCount)}
          color="bg-chart-3/10 text-chart-3"
          data-testid="perf-rt-steal"
        />
        <StatCard
          icon={PauseIcon}
          label={t("park")}
          value={formatCount(runtime.workerParkCount)}
          color="bg-chart-4/10 text-chart-4"
          data-testid="perf-rt-park"
        />
        <StatCard
          icon={TrendingUpIcon}
          label={t("overflow")}
          value={formatCount(runtime.workerOverflowCount)}
          color="bg-chart-5/10 text-chart-5"
          data-testid="perf-rt-overflow"
        />
        <StatCard
          icon={TimerIcon}
          label={t("forcedYields")}
          value={formatCount(runtime.budgetForcedYieldCount)}
          color="bg-chart-1/10 text-chart-1"
          data-testid="perf-rt-yields"
        />
      </Section>

      <section className="border-y bg-background" data-testid="perf-rt-per-worker">
        <header className="border-b px-4 py-3">
          <h3 className="text-base font-medium">{t("perWorker")}</h3>
        </header>
        <div className="flex flex-col gap-2 p-4">
          {runtime.perWorkerBusyPct.map((pct, i) => (
            <div key={i} className="flex items-center gap-3" data-testid={`perf-rt-worker-${i}`}>
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                {t("workerN", { n: i })}
              </span>
              <Progress value={Math.min(pct, 100)} className="h-2 flex-1" />
              <PerfSparkline
                points={workerHistories[i] ?? []}
                color={colors["chart-1"]}
                strokeWidth={1}
                fillOpacity={0.15}
                className="h-4 w-14 shrink-0"
              />
              <span className="w-14 text-right font-mono text-xs tabular-nums">
                {formatPercent(pct)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y bg-background" data-testid="perf-rt-traces">
        <header className="flex flex-row flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <h3 className="text-base font-medium">{t("traces.title")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("traces.description")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={openTraces} data-testid="perf-open-traces">
            <FolderOpenIcon className="mr-1 size-4" />
            {t("traces.open")}
          </Button>
        </header>
        <div className="p-4">
          {traces.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="perf-traces-empty">
              {t("traces.empty")}
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {traces.map((f, index) => (
                <li
                  key={f.traceId}
                  className="flex items-center justify-between py-1.5"
                  data-testid={`perf-trace-${f.traceId}`}
                >
                  <span className="font-mono text-xs">
                    {t("traces.identity", { index: index + 1 })}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {formatBytes(f.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
