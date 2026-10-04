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
 *
 * A row's main button narrows the list to the trace. A trace that carries
 * agent-trace spans also offers "Open in Traces" — the waterfall in the
 * Traces channel — when the host can open it. The view lists the newest
 * `PAGE_SIZE` traces first and grows by a page per "Show more"; the overflow
 * used to be a disabled button reporting how many traces it was hiding.
 */

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Crosshair, Waypoints } from "lucide-react"
import { AGENT_TRACE_MODULE } from "@cognia/agent-trace/log-adapter"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Empty, EmptyTitle } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import type { StructuredLogEntry } from "@cognia/logging"

const TRACE_ID_PREFIX_LENGTH = 8
const MINI_TIMELINE_WIDTH = 240
const MINI_TIMELINE_HEIGHT = 16
/** Traces per page of the list; "Show more" adds one page. */
const PAGE_SIZE = 50

export interface LogTraceViewProps {
  filteredLogs: StructuredLogEntry[]
  onSelectTrace: (traceId: string) => void
  /**
   * Opens a trace in the host's trace explorer. Offered on traces that carry
   * agent-trace spans — the explorer's waterfall is built from those.
   */
  onOpenTrace?: (traceId: string) => void
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
  /** Whether any entry is an agent-trace span, i.e. the Traces channel has it. */
  hasAgentSpans: boolean
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
    let hasAgentSpans = false
    for (const log of traceLogs) {
      if (log.module === AGENT_TRACE_MODULE) hasAgentSpans = true
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
      hasAgentSpans,
    })
  }
  summaries.sort((a, b) => b.endMs - a.endMs)
  return summaries
}

type LoggingTranslator = ReturnType<typeof useTranslations<"logging">>

/** Compact duration with the unit from the message bundle (`850 ms`, `1.2 s`…). */
export function formatTraceDuration(ms: number, t: LoggingTranslator): string {
  if (ms < 1000) return t("panel.durationUnits.ms", { value: Math.max(0, Math.round(ms)) })
  if (ms < 60_000) return t("panel.durationUnits.s", { value: (ms / 1000).toFixed(1) })
  if (ms < 3_600_000) return t("panel.durationUnits.m", { value: Math.round(ms / 60_000) })
  return t("panel.durationUnits.h", { value: Math.round(ms / 3_600_000) })
}

interface TraceRowProps {
  summary: TraceSummary
  onSelect: (traceId: string) => void
  onOpenTrace?: (traceId: string) => void
  t: LoggingTranslator
}

const TraceRow = memo(function TraceRow({ summary, onSelect, onOpenTrace, t }: TraceRowProps) {
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

  const durationText = formatTraceDuration(duration, t)

  return (
    <div
      className="flex items-stretch border-y bg-background"
      data-testid={`log-trace-item-${summary.traceId}`}
    >
      <Button
        type="button"
        variant="ghost"
        data-testid={`log-trace-row-${summary.traceId}`}
        onClick={() => onSelect(summary.traceId)}
        aria-label={t("panel.traceRowAria", {
          id: summary.traceId,
          count: total,
          duration: durationText,
        })}
        className={cn(
          "h-auto min-w-0 flex-1 flex-col items-stretch gap-1 rounded-none px-3 py-2 text-left whitespace-normal",
          "hover:bg-accent/30",
          "motion-safe:transition-colors"
        )}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Crosshair className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden />
          <span className="font-mono text-foreground">
            {summary.traceId.slice(0, TRACE_ID_PREFIX_LENGTH)}
          </span>
          <span
            className="text-muted-foreground tabular-nums"
            title={t("panel.traceDurationLabel")}
          >
            {durationText}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {t("panel.traceEventCount", { count: total })}
          </span>
          {summary.errorCount > 0 && (
            <Badge variant="outline" className="h-5 border-destructive/40 text-destructive">
              {t("panel.fieldValue", { label: t("levels.error"), value: summary.errorCount })}
            </Badge>
          )}
          {summary.warnCount > 0 && (
            <Badge variant="outline" className="h-5 border-warning/40 text-warning">
              {t("panel.fieldValue", { label: t("levels.warn"), value: summary.warnCount })}
            </Badge>
          )}
        </div>
        <svg
          width={MINI_TIMELINE_WIDTH}
          height={MINI_TIMELINE_HEIGHT}
          viewBox={`0 0 ${MINI_TIMELINE_WIDTH} ${MINI_TIMELINE_HEIGHT}`}
          className="max-w-full text-muted-foreground/40"
          aria-hidden
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
      </Button>
      {onOpenTrace && summary.hasAgentSpans ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto shrink-0 gap-1.5 rounded-none border-l px-3 text-xs"
          data-testid={`log-trace-open-${summary.traceId}`}
          aria-label={t("panel.openTraceAria", { id: summary.traceId })}
          onClick={() => onOpenTrace(summary.traceId)}
        >
          <Waypoints className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">{t("detail.openTrace")}</span>
        </Button>
      ) : null}
    </div>
  )
})

export function LogTraceView({
  filteredLogs,
  onSelectTrace,
  onOpenTrace,
  className,
}: LogTraceViewProps) {
  const t = useTranslations("logging")
  const summaries = useMemo(() => summarize(filteredLogs), [filteredLogs])
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

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

  const visible = summaries.slice(0, visibleCount)
  const overflow = summaries.length - visible.length

  return (
    <div data-testid="log-trace-view" className={cn("flex flex-col gap-2 p-3", className)}>
      {visible.map((summary) => (
        <TraceRow
          key={summary.traceId}
          summary={summary}
          onSelect={onSelectTrace}
          onOpenTrace={onOpenTrace}
          t={t}
        />
      ))}
      {overflow > 0 && (
        <div className="flex flex-col items-center gap-1 pt-2">
          <span className="text-xs text-muted-foreground" data-testid="log-trace-view-overflow">
            {t("panel.traceOverflow", { count: overflow })}
          </span>
          <Button
            variant="outline"
            size="sm"
            data-testid="log-trace-view-show-more"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            {t("panel.traceShowMore", { count: Math.min(PAGE_SIZE, overflow) })}
          </Button>
        </div>
      )}
    </div>
  )
}

export default LogTraceView
