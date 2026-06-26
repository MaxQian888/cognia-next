"use client"

/**
 * Execution Monitor — single "what is running right now" surface.
 *
 * Renders the unified row list from {@link useExecutionMonitor} (broker legs +
 * active workflow runs + active scheduler executions) and lets the user cancel
 * any broker-governed leg (chat + every headless leg) individually or all at
 * once via {@link getExecutionBroker}. Workflow / scheduler rows are shown for
 * observability but are governed by their own subsystems, so they have no
 * cancel affordance here.
 */

import { useTranslations } from "next-intl"
import { Activity, Eye, X } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getExecutionBroker } from "@/lib/execution/broker"
import { promoteLegToPane } from "@/lib/execution/promote-to-pane"
import type { UnifiedExecutionRow, UnifiedExecutionStatus } from "@/lib/execution/monitor-model"
import { useExecutionMonitor } from "./use-execution-monitor"

/** Broker leg kinds that map to a dedicated i18n label. */
const KIND_KEYS: Record<string, string> = {
  chat: "kind.chat",
  "workflow-step": "kind.workflowStep",
  scheduled: "kind.scheduled",
  connector: "kind.connector",
  subagent: "kind.subagent",
  goal: "kind.goal",
  team: "kind.team",
  workflow: "kind.workflow",
}

const STATUS_KEYS: Record<UnifiedExecutionStatus, string> = {
  queued: "status.queued",
  running: "status.running",
  waiting: "status.waiting",
  done: "status.done",
  error: "status.error",
  cancelled: "status.cancelled",
}

const STATUS_DOT: Record<UnifiedExecutionStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-blue-500",
  waiting: "bg-yellow-500",
  done: "bg-green-500",
  error: "bg-red-500",
  cancelled: "bg-muted-foreground/40",
}

export interface ExecutionMonitorPanelProps {
  /** Scope the monitor to a single workspace (unscoped rows are always shown). */
  projectId?: string
  className?: string
}

export function ExecutionMonitorPanel({ projectId, className }: ExecutionMonitorPanelProps) {
  const t = useTranslations("execution")
  const { rows, runningCount } = useExecutionMonitor(projectId)
  const hasCancellable = rows.some((r) => r.cancellable)

  const kindLabel = (kind: string) => (KIND_KEYS[kind] ? t(KIND_KEYS[kind]) : kind)

  const cancelRow = (row: UnifiedExecutionRow) => {
    if (row.legId) getExecutionBroker().cancel(row.legId)
  }

  return (
    <Card className={cn("border-border/50 bg-card/80", className)} data-testid="execution-monitor">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-500" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("runningCount", { count: runningCount })}
          </span>
          {hasCancellable && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2 text-xs"
              onClick={() => getExecutionBroker().cancelAll()}
            >
              {t("cancelAll")}
            </Button>
          )}
        </div>

        {rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul role="list" aria-label={t("title")} className="space-y-0.5">
            {rows.map((row) => (
              <li
                key={row.rowId}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/40"
              >
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[row.status])}
                  aria-hidden="true"
                />
                <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {kindLabel(row.kind)}
                </span>
                <span className="flex-1 truncate text-xs font-medium" title={row.label}>
                  {row.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t(STATUS_KEYS[row.status])}
                </span>
                {row.sessionId && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={t("watchLeg", { label: row.label })}
                    onClick={() => void promoteLegToPane(row.sessionId!)}
                  >
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
                {row.cancellable && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-red-500"
                    aria-label={t("cancelLeg", { label: row.label })}
                    onClick={() => cancelRow(row)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
