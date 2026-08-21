"use client"

/**
 * Shared upcoming-run list rendered by BOTH the calendar day panel and the
 * timeline agenda. Previously each view carried its own near-identical row
 * markup, and each one repeated an item's name once per projected run — a
 * 5-minute interval produced a wall of identical lines.
 *
 * Here the runs are collapsed per item via {@link groupOccurrencesByTask}: one
 * row per item, carrying its fire times as a compact chip strip (capped, with
 * a "+n" overflow). Clicking anywhere on the row routes to `onSelectItem`.
 *
 * Each row carries its source's accent dot (matching `kindConfig`), so a month
 * full of projected runs still reads as "which subsystem scheduled this".
 */

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { groupOccurrencesByTask, type Occurrence } from "@/lib/scheduler/upcoming-occurrences"
import { listContainerVariants, listItemVariants, staticIf } from "./scheduler-motion"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

/** How many fire times are printed before collapsing into "+n". */
export const MAX_VISIBLE_TIMES = 4

export interface OccurrenceListProps {
  occurrences: Occurrence[]
  /** Receives the clicked row's routing id (a `unifiedId`). */
  onSelectItem: (id: string) => void
  /**
   * Prefix for each row's `data-testid` — `calendar-occ` in the calendar day
   * panel, `timeline-occ` in the agenda, so either surface stays addressable.
   */
  testIdPrefix: string
  className?: string
}

export function OccurrenceList({
  occurrences,
  onSelectItem,
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
              onClick={() => onSelectItem(group.taskId)}
              data-testid={`${testIdPrefix}-${group.taskId}`}
              aria-label={t("occurrenceList.rowAria", {
                name: group.taskName,
                count: group.times.length,
              })}
              className="h-auto w-full items-start justify-start gap-2.5 px-2 py-1.5 text-left whitespace-normal"
            >
              <span
                data-testid={`${testIdPrefix}-${group.taskId}-kind`}
                className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", kindAccent(group.kind))}
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

/**
 * The kind's accent as a background colour. `kindConfig` carries `text-*`
 * classes (the icon tint); the dot needs the matching `bg-*`, and Tailwind
 * cannot see a runtime-built class name, so the mapping is spelled out.
 */
function kindAccent(kind: ScheduledItemKind): string {
  switch (kind) {
    case "app":
      return "bg-indigo-500"
    case "workflow":
      return "bg-violet-500"
    case "backup":
      return "bg-orange-500"
    case "plugin":
      return "bg-emerald-500"
    case "system":
      return "bg-slate-500"
    case "connector":
      return "bg-cyan-500"
  }
}
