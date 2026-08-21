"use client"

/**
 * Scheduler overview headline — deliberately NOT a row of stat cards.
 *
 * The old overview stacked five `StatCard`s plus a six-chip kind strip, so the
 * page opened with eleven boxes competing for attention while saying very
 * little. This is one band instead: two readings that actually matter
 * (how many things are scheduled and how they split; how the runs have been
 * going), each with a proportional bar that carries the comparison the numbers
 * alone can't, and a hairline-separated kind rail underneath.
 *
 * Both readings come from {@link UnifiedStatistics}, i.e. the same merged list
 * the sidebar renders. They used to come from the app-only scheduler store, so
 * the headline announced "2 tasks" directly beside a list of 4 rows.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"
import type { UnifiedStatistics } from "@/lib/scheduler/unified-filter"
import { SCHEDULED_ITEM_KINDS, type ScheduledItemKind } from "@/types/scheduler/unified"

export interface SchedulerOverviewSummaryProps {
  statistics: UnifiedStatistics
  /**
   * When supplied, each kind in the rail becomes a button that pins that kind
   * in the sidebar filter — the rail is the natural place to ask "show me only
   * the workflow triggers", and it used to be inert.
   */
  onSelectKind?: (kind: ScheduledItemKind) => void
  /** Kinds currently pinned in the sidebar, so the rail can mark them. */
  selectedKinds?: ReadonlySet<ScheduledItemKind>
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
  onSelectKind,
  selectedKinds,
  className,
}: SchedulerOverviewSummaryProps) {
  const t = useTranslations("scheduler")

  const {
    totalItems,
    activeItems,
    pausedItems,
    otherItems,
    totalRuns,
    successfulRuns,
    failedRuns,
    successRate,
    countsByKind,
    activeCountsByKind,
  } = statistics

  // No run has ever been recorded: a red 0% would read as "everything is
  // failing" on a fresh install. Say nothing instead of saying something false.
  const hasRuns = successRate !== null
  const tone = hasRuns ? successRateTone(successRate) : null

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
          <p
            className="mt-0.5 text-3xl font-semibold tabular-nums leading-none"
            data-testid="summary-total-items"
          >
            {totalItems}
          </p>

          <div
            className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="presentation"
          >
            <span
              data-testid="summary-bar-active"
              className="bg-green-500"
              style={{ width: `${share(activeItems, totalItems)}%` }}
            />
            <span
              data-testid="summary-bar-paused"
              className="bg-yellow-500"
              style={{ width: `${share(pausedItems, totalItems)}%` }}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <Legend dot="bg-green-500" label={t("activeTasks")} value={activeItems} />
            <Legend dot="bg-yellow-500" label={t("pausedTasks")} value={pausedItems} />
            {otherItems > 0 && (
              <Legend
                dot="bg-muted-foreground/40"
                label={t("statuses.disabled")}
                value={otherItems}
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
            className={cn(
              "mt-0.5 text-3xl font-semibold tabular-nums leading-none",
              tone ? tone.text : "text-muted-foreground/60"
            )}
            data-testid="summary-success-rate"
          >
            {hasRuns ? `${successRate}%` : "—"}
          </p>

          <Progress
            value={successRate ?? 0}
            aria-label={t("successRate")}
            className={cn(
              "mt-3 h-1.5 bg-muted",
              tone ? progressIndicatorTone[tone.bar] : undefined
            )}
          />

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {hasRuns ? (
              <>
                <Legend dot="bg-blue-500" label={t("totalExecutions")} value={totalRuns} />
                <Legend dot="bg-green-500" label={t("successful")} value={successfulRuns} />
                <Legend dot="bg-red-500" label={t("failed")} value={failedRuns} />
              </>
            ) : (
              <span className="text-muted-foreground" data-testid="summary-no-runs">
                {t("dashboard.noRunsYet")}
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        data-testid="kind-summary-strip"
        className="flex flex-wrap items-baseline gap-y-1 border-t border-border/50 pt-3 text-xs"
      >
        {SCHEDULED_ITEM_KINDS.map((kind) => {
          const total = countsByKind[kind] ?? 0
          const active = activeCountsByKind[kind] ?? 0
          const isPinned = selectedKinds?.has(kind) === true
          const body = (
            <>
              <span className={cn(total > 0 && "font-medium")}>{t(`kindFilter.${kind}`)}</span>
              <span className="tabular-nums">{total}</span>
              {active > 0 && (
                <span className="text-[10px] tabular-nums text-green-500">
                  {t("active")} {active}
                </span>
              )}
            </>
          )
          const shell = cn(
            "flex items-baseline gap-1.5 border-l border-border/50 px-3 first:border-l-0 first:pl-0",
            total === 0 && "text-muted-foreground/50",
            isPinned && "text-primary"
          )

          if (!onSelectKind) {
            return (
              <span key={kind} data-testid={`kind-summary-${kind}`} className={shell}>
                {body}
              </span>
            )
          }

          return (
            <button
              key={kind}
              type="button"
              data-testid={`kind-summary-${kind}`}
              data-pinned={isPinned || undefined}
              aria-pressed={isPinned}
              onClick={() => onSelectKind(kind)}
              className={cn(shell, "rounded-sm hover:text-foreground")}
            >
              {body}
            </button>
          )
        })}
      </div>
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
