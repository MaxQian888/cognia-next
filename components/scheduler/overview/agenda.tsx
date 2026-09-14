"use client"

/**
 * The one agenda (ADR-0179 §3): what fires over the next two weeks, grouped
 * by day, with a density row above it that doubles as a day picker.
 *
 * The calendar, the timeline and the upcoming list were this same projection
 * three times over. The density row keeps the calendar's one distinct
 * answer, "which days are busy", without a second view to switch to.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import type { Agenda as AgendaData } from "@/lib/scheduler/agenda"
import type { Occurrence, OccurrenceDay } from "@/lib/scheduler/upcoming-occurrences"

import { KindIcon } from "../kind-visuals"

export interface AgendaProps {
  agenda: AgendaData
  /** The days the density row shows; the agenda was built over the same window. */
  windowDays: number
  now: number
  onSelectItem: (unifiedId: string) => void
  className?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function densityClass(count: number): string {
  if (count === 0) return "bg-muted"
  if (count < 3) return "bg-primary/30"
  if (count < 8) return "bg-primary/60"
  return "bg-primary"
}

export function Agenda({ agenda, windowDays, now, onSelectItem, className }: AgendaProps) {
  const t = useTranslations("scheduler.agenda")
  const [pinnedDay, setPinnedDay] = useState<string | null>(null)

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const densityDays = Array.from({ length: windowDays }, (_, offset) => {
    const date = new Date(today.getTime() + offset * DAY_MS)
    const key = localDayKey(date)
    return { key, date, count: agenda.countsByDay.get(key) ?? 0 }
  })

  const days: OccurrenceDay[] = pinnedDay
    ? agenda.days.filter((day) => day.key === pinnedDay)
    : agenda.days

  return (
    <div className={cn("min-w-0", className)} data-testid="agenda">
      <ol className="flex gap-1" aria-label={t("densityLabel", { days: windowDays })}>
        {densityDays.map((day) => {
          const label = t("densityCell", {
            date: day.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
            count: day.count,
          })
          const pinned = pinnedDay === day.key
          return (
            <li key={day.key} className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setPinnedDay(pinned ? null : day.key)}
                aria-pressed={pinned}
                aria-label={label}
                title={label}
                className={cn(
                  "block h-5 w-full rounded-sm transition-shadow",
                  densityClass(day.count),
                  pinned && "ring-2 ring-ring ring-offset-1 ring-offset-background"
                )}
                data-testid="agenda-density-cell"
                data-count={day.count}
              />
            </li>
          )
        })}
      </ol>

      {days.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="agenda-empty">
          {pinnedDay ? t("emptyDay") : t("empty")}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {days.map((day) => (
            <section key={day.key} data-testid={`agenda-day-${day.key}`}>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {dayHeading(day, today, t)}
                <span className="ms-2 font-normal normal-case tracking-normal tabular-nums">
                  {t("runsCount", { count: day.occurrences.length })}
                </span>
              </h4>
              <ol className="flex flex-col">
                {day.occurrences.map((occurrence, index) => (
                  <li key={`${occurrence.taskId}:${occurrence.date.getTime()}:${index}`}>
                    <OccurrenceRow occurrence={occurrence} onSelectItem={onSelectItem} />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function OccurrenceRow({
  occurrence,
  onSelectItem,
}: {
  occurrence: Occurrence
  onSelectItem: (unifiedId: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectItem(occurrence.taskId)}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="agenda-occurrence"
    >
      <span className="w-14 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {occurrence.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      </span>
      <KindIcon kind={occurrence.kind} className="size-3 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{occurrence.taskName}</span>
    </button>
  )
}

function localDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function dayHeading(day: OccurrenceDay, today: Date, t: (key: string) => string): string {
  const diff = Math.round((day.date.getTime() - today.getTime()) / DAY_MS)
  if (diff === 0) return t("today")
  if (diff === 1) return t("tomorrow")
  return day.date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
}
