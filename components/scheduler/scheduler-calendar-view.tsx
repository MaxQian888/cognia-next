"use client"

/**
 * Calendar (month grid) view for the scheduler dashboard. Renders a Monday-first
 * month matrix with a per-day run-density indicator (dots, capped with "+n")
 * computed from {@link computeUnifiedOccurrences}. Selecting a day reveals that
 * day's runs in an inline panel — rendered by the shared {@link OccurrenceList},
 * the same collapsed-per-item list the timeline agenda uses, so an item with
 * many fires that day is one row and not N repeats. A row click routes to
 * `onSelectItem` with the item's `unifiedId`.
 *
 * The view projects every scheduler source, not just app tasks: a workspace
 * whose schedule is mostly workflow triggers and backups used to render an
 * almost-empty month here.
 *
 * Only future runs are projected, so days before "today" in the current month
 * are intentionally empty. The grid is horizontally scroll-safe on narrow
 * screens; the dashboard prefers the timeline view on mobile.
 */

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import {
  computeUnifiedOccurrences,
  countOccurrencesByDay,
  dayKey,
  type Occurrence,
} from "@/lib/scheduler/upcoming-occurrences"
import { OccurrenceList } from "./occurrence-list"

const DAY_MS = 24 * 60 * 60 * 1000

export interface MonthCell {
  date: Date
  inMonth: boolean
}

/**
 * Build a 6×7 Monday-first month matrix (42 cells) covering `month` of `year`
 * with leading/trailing days from the adjacent months. Pure + exported for
 * direct unit testing.
 */
export function buildMonthMatrix(year: number, month: number): MonthCell[] {
  const first = new Date(year, month, 1)
  // JS getDay(): 0=Sun..6=Sat. Convert to Monday-first offset (Mon=0..Sun=6).
  const offset = (first.getDay() + 6) % 7
  const start = new Date(year, month, 1 - offset)
  const cells: MonthCell[] = []
  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getTime() + i * DAY_MS)
    cells.push({ date, inMonth: date.getMonth() === month })
  }
  return cells
}

export interface SchedulerCalendarViewProps {
  /** Every scheduled item, merged across sources. */
  items: UnifiedScheduledItem[]
  /** Receives the clicked row's `unifiedId`. */
  onSelectItem: (unifiedId: string) => void
  /** Injectable "now" for deterministic tests. */
  now?: Date
  className?: string
}

export function SchedulerCalendarView({
  items,
  onSelectItem,
  now,
  className,
}: SchedulerCalendarViewProps) {
  const t = useTranslations("scheduler")
  const locale = useLocale()

  const today = useMemo(() => now ?? new Date(), [now])
  const todayKey = dayKey(today)

  const [anchor, setAnchor] = useState(() => ({
    year: today.getFullYear(),
    month: today.getMonth(),
  }))
  const [selectedKey, setSelectedKey] = useState<string>(todayKey)

  const cells = useMemo(() => buildMonthMatrix(anchor.year, anchor.month), [anchor])

  // Project occurrences from "now" through the end of the displayed grid.
  const occurrences = useMemo(() => {
    const gridEnd = cells[cells.length - 1].date
    const spanDays = Math.ceil((gridEnd.getTime() - today.getTime()) / DAY_MS) + 1
    if (spanDays <= 0) return [] as Occurrence[]
    return computeUnifiedOccurrences(items, { from: today, days: spanDays })
  }, [items, today, cells])

  const countsByDay = useMemo(() => countOccurrencesByDay(occurrences), [occurrences])
  const selectedOccurrences = useMemo(
    () => occurrences.filter((o) => dayKey(o.date) === selectedKey),
    [occurrences, selectedKey]
  )

  const weekdayLabels = useMemo(() => {
    // 2024-01-01 is a Monday — format 7 consecutive days for Monday-first heads.
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" })
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)))
  }, [locale])

  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(
        new Date(anchor.year, anchor.month, 1)
      ),
    [locale, anchor]
  )
  const selectedDayLabel = useMemo(() => {
    const cell = cells.find((c) => dayKey(c.date) === selectedKey)
    if (!cell) return ""
    if (selectedKey === todayKey) return t("timeline.today")
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(cell.date)
  }, [cells, selectedKey, todayKey, locale, t])

  const shiftMonth = (delta: number) => {
    setAnchor((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  return (
    <div
      data-testid="scheduler-calendar-view"
      aria-label={t("calendar.aria")}
      className={cn("space-y-4", className)}
    >
      {/* Month nav */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarDays className="h-4 w-4 text-blue-500" aria-hidden="true" />
          {monthLabel}
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("calendar.prevMonth")}
            data-testid="calendar-prev-month"
            onClick={() => shiftMonth(-1)}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            data-testid="calendar-today"
            onClick={() => {
              setAnchor({ year: today.getFullYear(), month: today.getMonth() })
              setSelectedKey(todayKey)
            }}
          >
            {t("calendar.today")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("calendar.nextMonth")}
            data-testid="calendar-next-month"
            onClick={() => shiftMonth(1)}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Grid (min width keeps 7 columns legible; container scrolls if narrower) */}
      <div className="overflow-x-auto">
        <div className="min-w-[18rem]">
          <div className="grid grid-cols-7 gap-1 pb-1">
            {weekdayLabels.map((label, i) => (
              <div
                key={i}
                className="py-1 text-center text-[11px] font-medium text-muted-foreground"
              >
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell) => {
              const key = dayKey(cell.date)
              const count = countsByDay.get(key) ?? 0
              const isToday = key === todayKey
              const isSelected = key === selectedKey
              return (
                <Toggle
                  key={key}
                  pressed={isSelected}
                  onPressedChange={() => setSelectedKey(key)}
                  aria-label={t("calendar.dayAria", {
                    day: cell.date.getDate(),
                    count,
                  })}
                  data-testid={`calendar-day-${key}`}
                  className={cn(
                    "flex min-h-[3rem] flex-col items-center gap-1 rounded-md border p-1 text-center transition-colors",
                    !cell.inMonth && "opacity-40",
                    // Selected wins (solid fill); today shows a soft tinted ring
                    // when not selected. Distinct states, always-legible number.
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : isToday
                        ? "border-primary/60 bg-primary/10 hover:bg-primary/15"
                        : "border-transparent hover:bg-muted/50"
                  )}
                >
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      isSelected
                        ? "font-semibold text-primary-foreground"
                        : isToday
                          ? "font-semibold text-primary"
                          : "text-foreground"
                    )}
                  >
                    {cell.date.getDate()}
                  </span>
                  {count > 0 && <DensityDots count={count} selected={isSelected} />}
                </Toggle>
              )
            })}
          </div>
        </div>
      </div>

      {/* Selected-day runs — same collapsed-per-task list the timeline uses. */}
      <div data-testid="calendar-day-panel" className="rounded-lg border border-border/50 p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2 px-2">
          <h4 className="text-xs font-semibold">{selectedDayLabel}</h4>
          {selectedOccurrences.length > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t("timeline.runsCount", { count: selectedOccurrences.length })}
            </span>
          )}
        </div>
        {selectedOccurrences.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">{t("calendar.noRuns")}</p>
        ) : (
          <OccurrenceList
            occurrences={selectedOccurrences}
            onSelectItem={onSelectItem}
            testIdPrefix="calendar-occ"
          />
        )}
      </div>
    </div>
  )
}

/** Up to 3 density dots, then a "+n" count for busier days. */
function DensityDots({ count, selected }: { count: number; selected?: boolean }) {
  const dots = Math.min(count, 3)
  return (
    <span className="flex items-center gap-0.5" data-testid="calendar-density">
      {Array.from({ length: dots }, (_, i) => (
        <span
          key={i}
          className={cn("h-1 w-1 rounded-full", selected ? "bg-primary-foreground" : "bg-blue-500")}
          aria-hidden="true"
        />
      ))}
      {count > 3 && (
        <span
          className={cn(
            "text-[9px] leading-none",
            selected ? "text-primary-foreground/80" : "text-muted-foreground"
          )}
        >
          +{count - 3}
        </span>
      )}
    </span>
  )
}
