"use client"

/**
 * TaskExecutionHistory - Scrollable execution log list for a scheduled task
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Clock, CheckCircle, XCircle, RefreshCw, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/scheduler/format-utils"
import type { TaskExecution, TaskExecutionStatus } from "@/types/scheduler"

interface ExecutionStatusConfig {
  icon: React.ComponentType<{ className?: string }>
  bg: string
  color: string
}

const executionStatusConfig: Record<TaskExecutionStatus, ExecutionStatusConfig> = {
  pending: { icon: Clock, bg: "bg-gray-500/15", color: "text-gray-500" },
  running: { icon: RefreshCw, bg: "bg-blue-500/15", color: "text-blue-500" },
  completed: { icon: CheckCircle, bg: "bg-green-500/15", color: "text-green-500" },
  failed: { icon: XCircle, bg: "bg-red-500/15", color: "text-red-500" },
  cancelled: { icon: AlertCircle, bg: "bg-yellow-500/15", color: "text-yellow-500" },
  skipped: { icon: AlertCircle, bg: "bg-orange-500/15", color: "text-orange-500" },
}

/**
 * Format a Date with the active locale via next-intl's formatter.
 * en: "Apr 12, 2026 · 02:00 AM" — zh-CN: "2026年4月12日 · 上午02:00"
 */
function formatTimestamp(date: Date, format: ReturnType<typeof useFormatter>): string {
  const datePart = format.dateTime(date, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
  const timePart = format.dateTime(date, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
  return `${datePart} · ${timePart}`
}

/**
 * Extract a result summary string from an unknown result value
 */
function getResultSummary(result: unknown): string | null {
  if (!result) return null
  if (typeof result === "string") return result.slice(0, 80) || null
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>
    if (typeof r.summary === "string") return r.summary.slice(0, 80)
    if (typeof r.message === "string") return r.message.slice(0, 80)
  }
  return null
}

/** Beyond this, a one-line error is worth an explicit expand affordance. */
const ERROR_INLINE_LIMIT = 80

/**
 * Failure detail for one row. Collapsed it stays a single truncated line so the
 * list keeps its rhythm; expanded it wraps inside a bounded, scrollable block
 * rather than pushing every following row down the page. The toggle stops
 * propagation so expanding an error never also opens the run sheet behind it.
 */
function ExecutionErrorLine({
  error,
  expandLabel,
  collapseLabel,
}: {
  error: string
  expandLabel: string
  collapseLabel: string
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = error.length > ERROR_INLINE_LIMIT || error.includes("\n")

  return (
    <div className="mt-0.5">
      <p
        data-testid="error-message"
        title={error}
        className={cn(
          "text-[11px] text-red-400",
          expanded && isLong
            ? "max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-red-500/5 px-1.5 py-1 font-mono"
            : "truncate"
        )}
      >
        {error}
      </p>
      {isLong && (
        <Button
          type="button"
          variant="link"
          size="xs"
          data-testid="error-toggle"
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="mt-0.5 h-auto p-0 text-[10px] text-muted-foreground"
        >
          {expanded ? collapseLabel : expandLabel}
        </Button>
      )}
    </div>
  )
}

interface TaskExecutionHistoryProps {
  executions: TaskExecution[]
  /**
   * Initial page size and increment per "Load more" click. Defaults to 10.
   */
  maxItems?: number
  /**
   * Fired when the user clicks (or Enter/Space-keys) a row. When set the rows
   * render as buttons; consumers typically open a `RunDetailSheet` for the
   * selected execution.
   */
  onSelectExecution?: (execution: TaskExecution) => void
}

export function TaskExecutionHistory({
  executions,
  maxItems = 10,
  onSelectExecution,
}: TaskExecutionHistoryProps) {
  const t = useTranslations("scheduler")
  const format = useFormatter()
  const [displayCount, setDisplayCount] = useState(maxItems)

  const displayed = executions.slice(0, displayCount)
  const hasMore = executions.length > displayed.length
  const remaining = executions.length - displayed.length

  if (displayed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
        <Clock className="h-5 w-5 opacity-40" />
        <span className="text-sm">{t("noExecutionsYet")}</span>
      </div>
    )
  }

  const isClickable = !!onSelectExecution

  return (
    <div className="flex flex-col">
      {displayed.map((execution, index) => {
        const config = executionStatusConfig[execution.status]
        const Icon = config.icon
        const isLast = index === displayed.length - 1
        const resultSummary =
          execution.status === "completed" ? getResultSummary(execution.output) : null
        // Only ever attached when `onSelectExecution` is set (see `isClickable`).
        const handleKey = (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onSelectExecution!(execution)
          }
        }

        return (
          <div
            key={execution.id}
            data-testid="execution-row"
            role={isClickable ? "button" : undefined}
            tabIndex={isClickable ? 0 : undefined}
            onClick={isClickable ? () => onSelectExecution!(execution) : undefined}
            onKeyDown={isClickable ? handleKey : undefined}
            className={cn(
              "flex items-start gap-3 py-2.5 px-1",
              !isLast && "border-b border-border/30",
              isClickable &&
                "cursor-pointer hover:bg-accent/50 focus:bg-accent/50 focus:outline-none"
            )}
          >
            {/* Status icon */}
            <div
              data-testid={`status-icon-${execution.status}`}
              className={cn(
                "shrink-0 flex items-center justify-center rounded-md",
                "h-5 w-5",
                config.bg
              )}
            >
              <Icon
                className={cn(
                  "h-3 w-3",
                  config.color,
                  execution.status === "running" && "animate-spin"
                )}
              />
            </div>

            {/* Info column */}
            <div className="flex-1 min-w-0">
              {/* Timestamp + non-default trigger provenance */}
              <p className="text-xs text-muted-foreground truncate">
                {formatTimestamp(execution.startedAt, format)}
                {execution.triggerSource && execution.triggerSource !== "schedule" && (
                  <Badge
                    variant="outline"
                    className="ml-1.5 rounded-pill px-1.5 text-[10px]"
                    data-testid="execution-trigger-source"
                  >
                    {t(`triggerSources.${execution.triggerSource}`)}
                  </Badge>
                )}
              </p>

              {/* Detail line: error for failed, result for completed */}
              {execution.status === "failed" && execution.error && (
                <ExecutionErrorLine
                  error={execution.error}
                  expandLabel={t("showMore")}
                  collapseLabel={t("showLess")}
                />
              )}
              {execution.status === "completed" && resultSummary && (
                <p className="text-[11px] text-muted-foreground truncate">{resultSummary}</p>
              )}

              {/* Terminal reason */}
              {execution.terminalReason && (
                <p className="text-[10px] text-amber-400 truncate">{execution.terminalReason}</p>
              )}
            </div>

            {/* Duration */}
            <span
              className="shrink-0 text-xs tabular-nums text-muted-foreground font-mono"
              data-testid="execution-duration"
            >
              {formatDuration(execution.duration)}
            </span>
          </div>
        )
      })}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDisplayCount((count) => count + maxItems)}
            data-testid="execution-load-more"
          >
            {t("loadMore")} ({remaining})
          </Button>
        </div>
      )}
    </div>
  )
}
