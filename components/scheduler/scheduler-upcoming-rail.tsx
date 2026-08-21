"use client"

/**
 * SchedulerUpcomingRail — the xl-only right rail beside an open detail pane.
 *
 * It answers "what runs next, and what ran last" while the pane in the middle
 * is showing one specific item. The overview already answers both questions in
 * its own body, so the page only mounts the rail once a detail has taken the
 * pane over — otherwise the same two lists rendered twice on the same screen.
 *
 * Both blocks are cross-source: they used to take the app-only `upcomingTasks`
 * and `recentExecutions` slices, so a schedule made of workflow triggers and
 * backups showed an empty rail.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ArrowRight, Calendar, Activity } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { formatRelativeTime } from "@/lib/scheduler/format-utils"
import { selectUpcomingItems } from "@/lib/scheduler/unified-filter"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"

export interface SchedulerUpcomingRailProps {
  /** Every scheduled item, merged across sources. */
  items: UnifiedScheduledItem[]
  /** Recent runs across every source that keeps a history, newest first. */
  recentRuns: UnifiedExecutionRun[]
  /** Select a scheduled item by `unifiedId`. */
  onSelectItem: (unifiedId: string) => void
  /** Open the run-detail sheet. */
  onSelectRun: (run: UnifiedExecutionRun) => void
  /**
   * Injectable "now" for deterministic tests/stories. Left out in the app, the
   * rail reads the shared 1-second ticker so its countdowns stay live instead
   * of freezing at whatever the last unrelated re-render happened to say.
   */
  now?: number
  className?: string
}

const MAX_ROWS = 5

const RUN_STATUS_DOT: Record<UnifiedExecutionRun["status"], string> = {
  succeeded: "bg-green-500",
  failed: "bg-red-500",
  running: "bg-blue-500",
  cancelled: "bg-muted-foreground/40",
  skipped: "bg-muted-foreground/40",
}

export function SchedulerUpcomingRail({
  items,
  recentRuns,
  onSelectItem,
  onSelectRun,
  now,
  className,
}: SchedulerUpcomingRailProps) {
  const t = useTranslations("scheduler")
  const tick = useNowTicker()
  const clock = now ?? tick

  const upcoming = useMemo(
    () => selectUpcomingItems(items, { limit: MAX_ROWS, now: clock }),
    [items, clock]
  )
  const recent = useMemo(() => recentRuns.slice(0, MAX_ROWS), [recentRuns])

  return (
    <aside
      data-testid="scheduler-upcoming-rail"
      aria-label={t("upcomingRail.ariaLabel")}
      className={cn(
        "hidden h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/50 bg-background/40 p-3 xl:flex",
        className
      )}
    >
      <section data-testid="upcoming-rail-upcoming">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Calendar className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
          {t("upcomingRail.title")}
        </h3>
        {upcoming.length === 0 ? (
          <p
            className="py-3 text-center text-[11px] text-muted-foreground"
            data-testid="upcoming-rail-no-upcoming"
          >
            {t("upcomingRail.empty")}
          </p>
        ) : (
          <div className="space-y-0.5">
            {upcoming.map((item) => (
              <Button
                key={item.unifiedId}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onSelectItem(item.unifiedId)}
                className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
                data-testid={`upcoming-rail-upcoming-${item.unifiedId}`}
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{item.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {formatRelativeTime(new Date(item.nextRunAt!))}
                </span>
                <ArrowRight
                  className="h-3 w-3 shrink-0 text-muted-foreground/40"
                  aria-hidden="true"
                />
              </Button>
            ))}
          </div>
        )}
      </section>

      <section data-testid="upcoming-rail-recent">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Activity className="h-3.5 w-3.5 text-purple-500" aria-hidden="true" />
          {t("upcomingRail.recentTitle")}
        </h3>
        {recent.length === 0 ? (
          <p
            className="py-3 text-center text-[11px] text-muted-foreground"
            data-testid="upcoming-rail-no-recent"
          >
            {t("noRecentExecutions")}
          </p>
        ) : (
          <div className="space-y-0.5">
            {recent.map((run) => (
              <Button
                key={run.unifiedId}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onSelectRun(run)}
                className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
                data-testid={`upcoming-rail-recent-${run.unifiedId}`}
              >
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", RUN_STATUS_DOT[run.status])}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                  {run.itemName}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {formatRelativeTime(new Date(run.finishedAt ?? run.startedAt))}
                </span>
              </Button>
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}
