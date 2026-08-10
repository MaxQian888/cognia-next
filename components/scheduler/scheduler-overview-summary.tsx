"use client"

/**
 * Scheduler overview headline — deliberately NOT a row of stat cards.
 *
 * The old overview stacked five `StatCard`s plus a six-chip kind strip, so the
 * page opened with eleven boxes competing for attention while saying very
 * little. This is one band instead: two readings that actually matter
 * (how many tasks exist and how they split; how the runs have been going),
 * each with a proportional bar that carries the comparison the numbers alone
 * can't, and a hairline-separated kind rail underneath.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"
import type { TaskStatistics } from "@/types/scheduler"
import { SCHEDULED_ITEM_KINDS, type ScheduledItemKind } from "@/types/scheduler/unified"

export interface SchedulerOverviewSummaryProps {
  statistics: TaskStatistics
  countsByKind?: Record<ScheduledItemKind, number>
  activeCountsByKind?: Record<ScheduledItemKind, number>
  className?: string
}

/** Success-rate colour bands, shared by the number and its meter. */
export function successRateTone(rate: number): {
  text: string
  bar: "bg-green-500" | "bg-yellow-500" | "bg-red-500"
} {
  if (rate >= 90) return { text: "text-green-500", bar: "bg-green-500" }
  if (rate >= 70) return { text: "text-yellow-500", bar: "bg-yellow-500" }
  return { text: "text-red-500", bar: "bg-red-500" }
}

const progressIndicatorTone = {
  "bg-green-500": "[&>[data-slot=progress-indicator]]:bg-green-500",
  "bg-yellow-500": "[&>[data-slot=progress-indicator]]:bg-yellow-500",
  "bg-red-500": "[&>[data-slot=progress-indicator]]:bg-red-500",
} as const

/** Percentage of `part` in `total`, guarding the zero-total case. */
function share(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (part / total) * 100))
}

export function SchedulerOverviewSummary({
  statistics,
  countsByKind,
  activeCountsByKind,
  className,
}: SchedulerOverviewSummaryProps) {
  const t = useTranslations("scheduler")

  const {
    totalTasks,
    activeTasks,
    pausedTasks,
    totalExecutions,
    successfulExecutions,
    failedExecutions,
  } = statistics
  const idleTasks = Math.max(0, totalTasks - activeTasks - pausedTasks)
  const successRate =
    totalExecutions > 0 ? Math.round((successfulExecutions / totalExecutions) * 100) : 0
  const tone = successRateTone(successRate)

  return (
    <section
      data-testid="scheduler-overview-summary"
      aria-label={t("overview")}
      className={cn("space-y-4", className)}
    >
      <div className="grid gap-6 sm:grid-cols-2 sm:gap-10">
        {/* Fleet composition */}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("totalTasks")}
          </p>
          <p className="mt-0.5 text-3xl font-semibold tabular-nums leading-none">{totalTasks}</p>

          <div
            className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="presentation"
          >
            <span
              data-testid="summary-bar-active"
              className="bg-green-500"
              style={{ width: `${share(activeTasks, totalTasks)}%` }}
            />
            <span
              data-testid="summary-bar-paused"
              className="bg-yellow-500"
              style={{ width: `${share(pausedTasks, totalTasks)}%` }}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <Legend dot="bg-green-500" label={t("activeTasks")} value={activeTasks} />
            <Legend dot="bg-yellow-500" label={t("pausedTasks")} value={pausedTasks} />
            {idleTasks > 0 && (
              <Legend
                dot="bg-muted-foreground/40"
                label={t("statuses.disabled")}
                value={idleTasks}
              />
            )}
          </div>
        </div>

        {/* Run health */}
        <div className="sm:border-l sm:border-border/50 sm:pl-10">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("successRate")}
          </p>
          <p
            className={cn("mt-0.5 text-3xl font-semibold tabular-nums leading-none", tone.text)}
            data-testid="summary-success-rate"
          >
            {successRate}%
          </p>

          <Progress
            value={successRate}
            aria-label={t("successRate")}
            className={cn("mt-3 h-1.5 bg-muted", progressIndicatorTone[tone.bar])}
          />

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <Legend dot="bg-blue-500" label={t("totalExecutions")} value={totalExecutions} />
            <Legend dot="bg-green-500" label={t("successful")} value={successfulExecutions} />
            <Legend dot="bg-red-500" label={t("failed")} value={failedExecutions} />
          </div>
        </div>
      </div>

      {countsByKind && (
        <div
          data-testid="kind-summary-strip"
          className="flex flex-wrap items-baseline gap-y-1 border-t border-border/50 pt-3 text-xs"
        >
          {SCHEDULED_ITEM_KINDS.map((kind) => {
            const total = countsByKind[kind] ?? 0
            const active = activeCountsByKind?.[kind] ?? 0
            return (
              <span
                key={kind}
                data-testid={`kind-summary-${kind}`}
                className={cn(
                  "flex items-baseline gap-1.5 border-l border-border/50 px-3 first:border-l-0 first:pl-0",
                  total === 0 && "text-muted-foreground/50"
                )}
              >
                <span className={cn(total > 0 && "font-medium")}>{t(`kindFilter.${kind}`)}</span>
                <span className="tabular-nums">{total}</span>
                {active > 0 && (
                  <span className="text-[10px] tabular-nums text-green-500">
                    {t("active")} {active}
                  </span>
                )}
              </span>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Legend({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span
        className={cn("h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full", dot)}
        aria-hidden="true"
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  )
}
