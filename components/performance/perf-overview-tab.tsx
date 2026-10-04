"use client"

/**
 * PerfOverviewTab — the Task-Manager "Performance" layout: a left rail of
 * metric tiles grouped by source, and a large rolling graph for the selected
 * metric on the right.
 *
 * The rail is built from the metric catalog (`lib/perf/metric-catalog.ts`)
 * against each source's advertised capabilities. It used to chart five fixed
 * process / Tokio fields off a single history, which on web and mobile — and
 * on the Node host — were structural zeros: a flat "0% CPU" line for a
 * process that was never measured. Now the Renderer shows what a browser can
 * measure (frame rate, main-thread blocking, long tasks, JS heap), the host
 * shows what its runtime reports, and a source that measures nothing says so.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { AlertCircleIcon, ChevronRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import type { PerfConnectionState, PerfFrame, PerfSourceDescriptor } from "@/lib/perf/backend/types"
import {
  formatPerfMetricValue,
  metricSeries,
  metricsForSource,
  summarizeSeries,
  type PerfMetricDefinition,
  type PerfMetricId,
} from "@/lib/perf/metric-catalog"
import { cn } from "@/lib/utils"
import { PerfGraphCard } from "./perf-graph-card"
import { PerfMetricTile } from "./perf-metric-tile"
import { PerfMemoryPressure } from "./perf-memory-pressure"

const CHART_TOKENS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const

interface RailMetric {
  definition: PerfMetricDefinition
  points: (number | null)[]
  timestamps: number[]
  color: string
  value: string
}

interface RailGroup {
  kind: "host" | "renderer"
  state: PerfConnectionState
  metrics: RailMetric[]
  latest: PerfFrame | null
}

export interface PerfOverviewTabProps {
  rendererHistory: PerfFrame[]
  hostHistory: PerfFrame[]
  sources: PerfSourceDescriptor[]
  hostState: PerfConnectionState
  /** Controlled selection (from `?metric=`); `null` picks the first available metric. */
  selectedMetric: PerfMetricId | null
  onSelectMetric: (metric: PerfMetricId) => void
  /** Requested sampling cadence, for the graph's window caption. */
  intervalMs: number
  /** Jump to Diagnose, where source state and gaps are explained. */
  onOpenDiagnose?: () => void
}

/** The metric the overview should chart: the requested one when available, else the first. */
export function resolveOverviewMetric(
  available: readonly PerfMetricId[],
  requested: PerfMetricId | null
): PerfMetricId | null {
  if (requested && available.includes(requested)) return requested
  return available[0] ?? null
}

export function PerfOverviewTab({
  rendererHistory,
  hostHistory,
  sources,
  hostState,
  selectedMetric,
  onSelectMetric,
  intervalMs,
  onOpenDiagnose,
}: PerfOverviewTabProps) {
  const t = useTranslations("performance")
  const colors = useThemeColors()

  const groups = useMemo<RailGroup[]>(() => {
    const build = (kind: "host" | "renderer", history: PerfFrame[]): RailGroup => {
      const source = sources.find((candidate) => candidate.kind === kind) ?? null
      const timestamps = history.map((frame) => frame.wallEndMs)
      const metrics = metricsForSource(source).map((definition, index) => {
        const points = metricSeries(history, definition)
        const summary = summarizeSeries(points)
        return {
          definition,
          points,
          timestamps,
          color: colors[CHART_TOKENS[index % CHART_TOKENS.length]],
          value: formatPerfMetricValue(definition.unit, summary.latest),
        }
      })
      return {
        kind,
        state: kind === "host" ? hostState : (source?.connection.state ?? "unsupported"),
        metrics,
        latest: history.at(-1) ?? null,
      }
    }
    // Host first: when a host is attached it is what the user came to watch.
    return [build("host", hostHistory), build("renderer", rendererHistory)]
  }, [colors, hostHistory, hostState, rendererHistory, sources])

  const allMetrics = useMemo(() => groups.flatMap((group) => group.metrics), [groups])
  const activeId = resolveOverviewMetric(
    allMetrics.map((metric) => metric.definition.id),
    selectedMetric
  )
  const active = allMetrics.find((metric) => metric.definition.id === activeId) ?? null
  const summary = useMemo(() => summarizeSeries(active?.points ?? []), [active])
  const hostGroup = groups[0]
  const hostMemory = hostGroup.latest?.systemMemory ?? null
  const windowSeconds = Math.round(((active?.points.length ?? 0) * intervalMs) / 1000)

  return (
    <div
      className="grid h-full grid-cols-1 gap-4 md:grid-cols-[280px_1fr]"
      data-testid="perf-overview"
    >
      {/* `group`, not `tablist`: the tiles are `aria-pressed` toggle buttons,
          and a tablist whose children are neither `role="tab"` nor paired with
          a `tabpanel` is invalid ARIA that announces nothing useful. */}
      <div className="flex flex-col gap-4" role="group" aria-label={t("overview.selectMetric")}>
        {groups.map((group) => (
          <section
            key={group.kind}
            className="flex flex-col"
            aria-labelledby={`perf-rail-${group.kind}`}
            data-testid={`perf-rail-${group.kind}`}
          >
            <header className="flex items-center justify-between gap-2 px-1 pb-1.5">
              <h3
                id={`perf-rail-${group.kind}`}
                className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                {t(`overview.groups.${group.kind}`)}
              </h3>
              <Badge
                variant={group.state === "live" ? "secondary" : "outline"}
                className="h-5 gap-1 px-1.5 text-[10px]"
                data-testid={`perf-rail-${group.kind}-state`}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    group.state === "live"
                      ? "bg-success"
                      : group.state === "error" || group.state === "stale"
                        ? "bg-warning"
                        : "bg-muted-foreground/50"
                  )}
                />
                {t(`sourceHealth.state.${group.state}`)}
              </Badge>
            </header>
            {group.kind === "host" && hostMemory ? (
              <div className="mb-2">
                <PerfMemoryPressure memory={hostMemory} />
              </div>
            ) : null}
            {group.metrics.length > 0 ? (
              <div className="flex flex-col gap-1">
                {group.metrics.map((metric) => (
                  <PerfMetricTile
                    key={metric.definition.id}
                    label={t(`metrics.${metric.definition.labelKey}`)}
                    value={metric.value}
                    points={metric.points}
                    color={metric.color}
                    active={metric.definition.id === activeId}
                    onSelect={() => onSelectMetric(metric.definition.id)}
                    data-testid={`perf-tile-${metric.definition.id}`}
                  />
                ))}
              </div>
            ) : (
              <div
                className="flex items-start gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground"
                data-testid={`perf-rail-${group.kind}-empty`}
              >
                <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <div className="min-w-0 space-y-1.5">
                  <p>{t(`overview.unavailable.${group.kind}.${group.state}`)}</p>
                  {onOpenDiagnose ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={onOpenDiagnose}
                    >
                      {t("overview.openDiagnose")}
                      <ChevronRightIcon className="size-3" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </section>
        ))}
      </div>

      {active ? (
        <PerfGraphCard
          title={t(`metrics.${active.definition.labelKey}`)}
          current={active.value}
          points={active.points}
          timestamps={active.timestamps}
          color={active.color}
          max={active.definition.max}
          threshold={active.definition.threshold}
          formatValue={(value) => formatPerfMetricValue(active.definition.unit, value)}
          subtitle={
            summary.samples === 0
              ? t("overview.waiting")
              : t("overview.summary", {
                  peak: formatPerfMetricValue(active.definition.unit, summary.peak),
                  average: formatPerfMetricValue(active.definition.unit, summary.average),
                  seconds: windowSeconds,
                })
          }
          description={t(`metricDescriptions.${active.definition.labelKey}`)}
          fill
          height={320}
          data-testid="perf-overview-graph"
        />
      ) : (
        <div
          className="flex min-h-[320px] items-center justify-center border-y text-sm text-muted-foreground"
          data-testid="perf-overview-no-metrics"
        >
          {t("overview.noMetrics")}
        </div>
      )}
    </div>
  )
}
