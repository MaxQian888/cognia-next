"use client"

/**
 * UnifiedRecentRuns — dashboard widget showing the most-recent execution
 * rows from every source the scheduler page surfaces. Fed by the
 * `useUnifiedRecentRuns` hook; rows are clickable and emit the run via
 * `onSelectRun` so the page can open `RunDetailSheet`.
 *
 * Replaces the app-only `recentExecutions` slice that used to live inline
 * in `SchedulerDashboardView`.
 */

import { useTranslations } from "next-intl"
import { Activity } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useUnifiedRecentRuns } from "@/hooks/scheduler/use-unified-recent-runs"
import { kindConfig } from "./details/_shared/kind-config"
import { formatRelativeTime } from "@/lib/scheduler/format-utils"
import { RunStatusPill } from "@/components/workflow/runs/run-status-pill"
import { toRunStatusPill, type UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

export interface UnifiedRecentRunsProps {
  /** Maximum rows shown. Default 5. */
  limit?: number
  /** Click handler — usually opens `RunDetailSheet`. */
  onSelectRun?: (run: UnifiedExecutionRun) => void
  /**
   * Merged onto the outer `Card`. The scheduler overview passes a flattening
   * class set so the widget reads as a page section rather than a nested box.
   */
  className?: string
}

export function UnifiedRecentRuns({ limit = 5, onSelectRun, className }: UnifiedRecentRunsProps) {
  const t = useTranslations("scheduler")
  const { runs, isLoading } = useUnifiedRecentRuns({ limit: limit * 4 })

  // Slice locally after fan-in — the hook ordered by startedAt desc already.
  const displayed = runs.slice(0, limit)

  return (
    <Card className={cn("border-border/50 bg-card/80", className)}>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-purple-500" aria-hidden="true" />
          {t("recentExecutions")}
        </h3>

        {isLoading ? (
          <p
            className="py-4 text-center text-xs text-muted-foreground"
            data-testid="unified-runs-loading"
          >
            {t("loading")}
          </p>
        ) : displayed.length === 0 ? (
          <p
            className="py-4 text-center text-xs text-muted-foreground"
            data-testid="unified-runs-empty"
          >
            {t("noRecentExecutions")}
          </p>
        ) : (
          <ul className="space-y-0.5" data-testid="unified-runs-list">
            {displayed.map((run) => {
              const kindConf = kindConfig[run.kind]
              const startedAt = new Date(run.startedAt)
              const isClickable = !!onSelectRun
              return (
                <li key={run.unifiedId}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`unified-run-row-${run.unifiedId}`}
                    onClick={isClickable ? () => onSelectRun!(run) : undefined}
                    disabled={!isClickable}
                    className={cn(
                      "h-auto w-full justify-start gap-3 px-2 py-2 text-left",
                      isClickable && "hover:bg-accent/50"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded",
                        kindConf.bg,
                        kindConf.color
                      )}
                      aria-hidden="true"
                    >
                      {kindConf.icon}
                    </span>
                    <span className="flex-1 truncate text-xs font-medium">{run.itemName}</span>
                    <RunStatusPill status={toRunStatusPill(run.status)} showIcon={false} />
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {formatRelativeTime(startedAt)}
                    </span>
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
