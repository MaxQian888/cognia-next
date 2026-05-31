"use client"

/**
 * Timeline (agenda) view for the scheduler dashboard. Projects the next runs of
 * all active tasks via {@link computeUpcomingOccurrences}, groups them by local
 * day, and renders a day-headed agenda. Rows are clickable → `onSelectTask`.
 *
 * This is the mobile-friendly projection (a single scrolling column), so the
 * dashboard falls back to it on narrow screens even when "calendar" is chosen.
 */

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { CalendarClock } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ScheduledTask } from "@/types/scheduler"
import {
  computeUpcomingOccurrences,
  dayKey,
  groupOccurrencesByDay,
} from "@/lib/scheduler/upcoming-occurrences"
import { listContainerVariants, listItemVariants, staticIf } from "./scheduler-motion"

export interface SchedulerTimelineViewProps {
  tasks: ScheduledTask[]
  onSelectTask: (taskId: string) => void
  /** Window length in days. Defaults to 14. */
  windowDays?: number
  /** Injectable "now" for deterministic tests. */
  now?: Date
  className?: string
}

const STATUS_DOT = "bg-green-500"

export function SchedulerTimelineView({
  tasks,
  onSelectTask,
  windowDays = 14,
  now,
  className,
}: SchedulerTimelineViewProps) {
  const t = useTranslations("scheduler")
  const locale = useLocale()
  const prefersReduced = useReducedMotion()

  const from = useMemo(() => now ?? new Date(), [now])

  const days = useMemo(() => {
    const occ = computeUpcomingOccurrences(tasks, { from, days: windowDays })
    return groupOccurrencesByDay(occ)
  }, [tasks, from, windowDays])

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale]
  )
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" }),
    [locale]
  )

  const todayKey = dayKey(from)
  const tomorrowKey = dayKey(new Date(from.getTime() + 24 * 60 * 60 * 1000))

  const dayLabel = (key: string, date: Date) => {
    if (key === todayKey) return t("timeline.today")
    if (key === tomorrowKey) return t("timeline.tomorrow")
    return dateFmt.format(date)
  }

  if (days.length === 0) {
    return (
      <div
        data-testid="scheduler-timeline-empty"
        className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground"
      >
        <CalendarClock className="h-8 w-8 opacity-40" aria-hidden="true" />
        <p className="text-sm">{t("timeline.empty")}</p>
      </div>
    )
  }

  return (
    <div
      data-testid="scheduler-timeline-view"
      aria-label={t("timeline.aria")}
      className={cn("space-y-4", className)}
    >
      {days.map((day) => (
        <section key={day.key} data-testid={`timeline-day-${day.key}`}>
          <div className="sticky top-0 z-10 -mx-1 flex items-baseline gap-2 bg-background/85 px-1 py-1.5 backdrop-blur">
            <h3 className="text-sm font-semibold">{dayLabel(day.key, day.date)}</h3>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("timeline.runsCount", { count: day.occurrences.length })}
            </span>
          </div>
          <motion.ul
            variants={staticIf(prefersReduced, listContainerVariants)}
            initial="hidden"
            animate="show"
            className="mt-1 space-y-0.5"
          >
            {day.occurrences.map((occ, i) => (
              <motion.li
                key={`${occ.taskId}-${occ.date.getTime()}-${i}`}
                variants={listItemVariants}
              >
                <button
                  type="button"
                  onClick={() => onSelectTask(occ.taskId)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/50"
                  data-testid={`timeline-occ-${occ.taskId}`}
                >
                  <span className="w-14 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                    {timeFmt.format(occ.date)}
                  </span>
                  <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT)}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {occ.taskName}
                  </span>
                  <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t(`triggerTypes.${occ.triggerType}`)}
                  </span>
                </button>
              </motion.li>
            ))}
          </motion.ul>
        </section>
      ))}
    </div>
  )
}
