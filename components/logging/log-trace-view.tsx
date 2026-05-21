"use client"

/**
 * LogTraceView
 *
 * Groups the currently filtered logs by traceId and renders a list of trace
 * rows. Each row shows the trace prefix, duration, per-level event counts,
 * and a mini horizontal timeline of its events.
 *
 * Logs without a traceId are excluded; an explanatory empty state appears
 * when no entries carry one.
 */

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Crosshair } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Empty, EmptyTitle } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import type { StructuredLogEntry } from "@/lib/logger"

const TRACE_ID_PREFIX_LENGTH = 8
const MINI_TIMELINE_WIDTH = 240
const MINI_TIMELINE_HEIGHT = 16
const MAX_TRACES = 50

export interface LogTraceViewProps {
  filteredLogs: StructuredLogEntry[]
  onSelectTrace: (traceId: string) => void
  className?: string
}

interface TraceSummary {
  traceId: string
  logs: StructuredLogEntry[]
  startMs: number
  endMs: number
  errorCount: number
  warnCount: number
  infoCount: number
  otherCount: number
}

function summarize(logs: StructuredLogEntry[]): TraceSummary[] {
  const groups = new Map<string, StructuredLogEntry[]>()
  for (const log of logs) {
    if (!log.traceId) continue
    const existing = groups.get(log.traceId)
    if (existing) {
      existing.push(log)
    } else {
      groups.set(log.traceId, [log])
    }
  }
  const summaries: TraceSummary[] = []
  for (const [traceId, traceLogs] of groups) {
    let startMs = Infinity
    let endMs = -Infinity
    let errorCount = 0
    let warnCount = 0
    let infoCount = 0
    let otherCount = 0
    for (const log of traceLogs) {
      const ts = new Date(log.timestamp).getTime()
      if (ts < startMs) startMs = ts
      if (ts > endMs) endMs = ts
      if (log.level === "error" || log.level === "fatal") errorCount++
      else if (log.level === "warn") warnCount++
      else if (log.level === "info") infoCount++
      else otherCount++
    }
    summaries.push({
      traceId,
      logs: traceLogs,
      startMs,
      endMs,
      errorCount,
      warnCount,
      infoCount,
      otherCount,
    })
  }
  summaries.sort((a, b) => b.endMs - a.endMs)
  return summaries
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

interface TraceRowProps {
  summary: TraceSummary
  onSelect: (traceId: string) => void
  totalLabel: string
  errorsLabel: string
  warningsLabel: string
  durationLabel: string
}

const TraceRow = memo(function TraceRow({
  summary,
  onSelect,
  totalLabel,
  errorsLabel,
  warningsLabel,
  durationLabel,
}: TraceRowProps) {
  const total = summary.logs.length
  const duration = Math.max(0, summary.endMs - summary.startMs)
  const span = duration || 1
  const ticks = summary.logs.map((log) => {
    const ts = new Date(log.timestamp).getTime()
    const x = ((ts - summary.startMs) / span) * MINI_TIMELINE_WIDTH
    const isError = log.level === "error" || log.level === "fatal"
    const isWarn = log.level === "warn"
    return {
      key: log.id,
      x,
      color: isError ? "var(--destructive)" : isWarn ? "var(--warning)" : "var(--success)",
    }
  })

  return (
    <button
      type="button"
      data-testid={`log-trace-row-${summary.traceId}`}
      onClick={() => onSelect(summary.traceId)}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md border bg-card px-3 py-2 text-left",
        "hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "motion-safe:transition-colors"
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Crosshair className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden />
        <span className="font-mono text-foreground">
          {summary.traceId.slice(0, TRACE_ID_PREFIX_LENGTH)}
        </span>
        <span className="text-muted-foreground tabular-nums" title={durationLabel}>
          {formatDuration(duration)}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {totalLabel}: {total}
        </span>
        {summary.errorCount > 0 && (
          <Badge variant="outline" className="h-5 border-destructive/40 text-destructive">
            {errorsLabel}: {summary.errorCount}
          </Badge>
        )}
        {summary.warnCount > 0 && (
          <Badge variant="outline" className="h-5 border-warning/40 text-warning">
            {warningsLabel}: {summary.warnCount}
          </Badge>
        )}
      </div>
      <svg
        width={MINI_TIMELINE_WIDTH}
        height={MINI_TIMELINE_HEIGHT}
        viewBox={`0 0 ${MINI_TIMELINE_WIDTH} ${MINI_TIMELINE_HEIGHT}`}
        className="text-muted-foreground/40"
        role="img"
        aria-label={`${total} events spanning ${formatDuration(duration)}`}
      >
        <line
          x1={0}
          x2={MINI_TIMELINE_WIDTH}
          y1={MINI_TIMELINE_HEIGHT / 2}
          y2={MINI_TIMELINE_HEIGHT / 2}
          stroke="currentColor"
          strokeWidth={1}
        />
        {ticks.map((tick) => (
          <circle
            key={tick.key}
            cx={tick.x}
            cy={MINI_TIMELINE_HEIGHT / 2}
            r={2.5}
            fill={tick.color}
          />
        ))}
      </svg>
    </button>
  )
})

export function LogTraceView({ filteredLogs, onSelectTrace, className }: LogTraceViewProps) {
  const t = useTranslations("logging")
  const summaries = useMemo(() => summarize(filteredLogs), [filteredLogs])

  if (summaries.length === 0) {
    return (
      <Empty className={cn("py-12", className)} data-testid="log-trace-view-empty">
        <EmptyTitle>{t("panel.noTraceEvents")}</EmptyTitle>
        <p className="mt-2 text-xs text-muted-foreground text-center max-w-xs">
          {t("panel.noTraceEventsHint")}
        </p>
      </Empty>
    )
  }

  const visible = summaries.slice(0, MAX_TRACES)
  const overflow = summaries.length - visible.length

  return (
    <div data-testid="log-trace-view" className={cn("flex flex-col gap-2 p-3", className)}>
      {visible.map((summary) => (
        <TraceRow
          key={summary.traceId}
          summary={summary}
          onSelect={onSelectTrace}
          totalLabel={t("panel.traceTotal")}
          errorsLabel={t("levels.error")}
          warningsLabel={t("levels.warn")}
          durationLabel={t("panel.traceDurationLabel")}
        />
      ))}
      {overflow > 0 && (
        <div className="flex items-center justify-center pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled
            data-testid="log-trace-view-overflow"
            className="text-xs text-muted-foreground"
          >
            {t("panel.traceOverflow", { count: overflow })}
          </Button>
        </div>
      )}
    </div>
  )
}

export default LogTraceView
