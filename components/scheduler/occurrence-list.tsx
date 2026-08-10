"use client"

/**
 * Shared upcoming-run list rendered by BOTH the calendar day panel and the
 * timeline agenda. Previously each view carried its own near-identical row
 * markup, and each one repeated a task's name once per projected run — a
 * 5-minute interval produced a wall of identical lines.
 *
 * Here the runs are collapsed per task via {@link groupOccurrencesByTask}: one
 * row per task, carrying its fire times as a compact chip strip (capped, with
 * a "+n" overflow). Clicking anywhere on the row routes to `onSelectTask`.
 */

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { groupOccurrencesByTask, type Occurrence } from "@/lib/scheduler/upcoming-occurrences"
import { listContainerVariants, listItemVariants, staticIf } from "./scheduler-motion"

/** How many fire times are printed before collapsing into "+n". */
export const MAX_VISIBLE_TIMES = 4

export interface OccurrenceListProps {
  occurrences: Occurrence[]
  onSelectTask: (taskId: string) => void
  /**
   * Prefix for each row's `data-testid` — `calendar-occ` in the calendar day
   * panel, `timeline-occ` in the agenda, so either surface stays addressable.
   */
  testIdPrefix: string
  className?: string
}

export function OccurrenceList({
  occurrences,
  onSelectTask,
  testIdPrefix,
  className,
}: OccurrenceListProps) {
  const t = useTranslations("scheduler")
  const locale = useLocale()
  const prefersReduced = useReducedMotion()

  const groups = useMemo(() => groupOccurrencesByTask(occurrences), [occurrences])
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale]
  )

  return (
    <motion.ul
      variants={staticIf(prefersReduced, listContainerVariants)}
      initial="hidden"
      animate="show"
      className={cn("space-y-0.5", className)}
      data-testid={`${testIdPrefix}-list`}
    >
      {groups.map((group) => {
        const visible = group.times.slice(0, MAX_VISIBLE_TIMES)
        const overflow = group.times.length - visible.length
        return (
          <motion.li key={group.taskId} variants={listItemVariants}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSelectTask(group.taskId)}
              data-testid={`${testIdPrefix}-${group.taskId}`}
              aria-label={t("occurrenceList.rowAria", {
                name: group.taskName,
                count: group.times.length,
              })}
              className="h-auto w-full items-start justify-start gap-2.5 px-2 py-1.5 text-left whitespace-normal"
            >
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {group.taskName}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t(`triggerTypes.${group.triggerType}`)}
                  </span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
                  {visible.map((time) => (
                    <span key={time.getTime()}>{timeFmt.format(time)}</span>
                  ))}
                  {overflow > 0 && (
                    <span data-testid={`${testIdPrefix}-${group.taskId}-overflow`}>
                      {t("occurrenceList.moreTimes", { count: overflow })}
                    </span>
                  )}
                </span>
              </span>
            </Button>
          </motion.li>
        )
      })}
    </motion.ul>
  )
}
