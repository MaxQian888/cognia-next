"use client"

/**
 * "When will this actually run?" — the next few fire times of a trigger.
 *
 * A cron expression, an interval and a timezone are three inputs a person has
 * to combine in their head to answer that, and the form described the cron in
 * words without ever showing a date. Shown under the trigger fields of the task
 * form while it is being written, and in the agent's approval dialog before a
 * schedule write is confirmed, through the same expansion the calendar uses
 * (`projectTriggerFireTimes`), so the three cannot disagree.
 */

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { CalendarClockIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { validateCronExpression } from "@/lib/scheduler/cron-parser"
import { projectTriggerFireTimes } from "@/lib/scheduler/upcoming-occurrences"
import type { TaskTrigger } from "@/types/scheduler"

export const TRIGGER_PREVIEW_COUNT = 3

export interface TriggerPreviewProps {
  trigger: TaskTrigger | null | undefined
  /** The task's known next run, which anchors an interval's phase. */
  nextRunAt?: Date
  count?: number
  /** Injected in tests; defaults to the current time. */
  now?: Date
  className?: string
}

function formatFireTime(date: Date, locale: string, timezone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }
  // A trigger pinned to another zone shows its own wall clock, labelled, so
  // "09:00 Asia/Shanghai" is not silently rendered as 02:00 local.
  if (timezone) {
    try {
      return date.toLocaleString(locale, {
        ...options,
        timeZone: timezone,
        timeZoneName: "short",
      })
    } catch {
      // Unknown zone: fall through to local time.
    }
  }
  return date.toLocaleString(locale, options)
}

export function TriggerPreview({
  trigger,
  nextRunAt,
  count = TRIGGER_PREVIEW_COUNT,
  now,
  className,
}: TriggerPreviewProps) {
  const t = useTranslations("scheduler.triggerPreview")
  // The app's language, not the browser's: a zh-CN user on an English OS
  // should read the same dates the rest of the page shows.
  const locale = useLocale()
  const nowMs = now?.getTime()

  const state = useMemo(() => {
    if (!trigger) return { kind: "empty" as const }
    if (trigger.type === "event") return { kind: "event" as const }
    if (trigger.type === "cron") {
      const expression = trigger.cronExpression?.trim() ?? ""
      if (!expression || !validateCronExpression(expression).valid) {
        return { kind: "invalid" as const }
      }
    }
    const dates = projectTriggerFireTimes(trigger, count, {
      from: nowMs !== undefined ? new Date(nowMs) : new Date(),
      nextRunAt,
    })
    if (dates.length === 0) {
      return { kind: trigger.type === "once" ? ("past" as const) : ("none" as const) }
    }
    return { kind: "dates" as const, dates }
  }, [trigger, count, nextRunAt, nowMs])

  if (state.kind === "empty") return null

  return (
    <div
      className={cn("rounded-md border bg-muted/30 px-3 py-2 text-xs", className)}
      data-testid="trigger-preview"
      data-state={state.kind}
    >
      <p className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground">
        <CalendarClockIcon className="size-3.5" aria-hidden="true" />
        {state.kind === "dates" ? t("title", { count: state.dates.length }) : t("titleNone")}
      </p>
      {state.kind === "dates" ? (
        <ol className="space-y-0.5" aria-label={t("title", { count: state.dates.length })}>
          {state.dates.map((date) => (
            <li
              key={date.getTime()}
              className="tabular-nums text-foreground"
              data-testid="trigger-preview-date"
            >
              {formatFireTime(date, locale, trigger?.timezone)}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground" data-testid="trigger-preview-message">
          {t(state.kind)}
        </p>
      )}
    </div>
  )
}
