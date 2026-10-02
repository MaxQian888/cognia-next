"use client"

/**
 * Availability history cells, the range selector and the legend.
 *
 * Each cell is one bucket of the selected range (an hour for 24 h, a UTC day
 * otherwise). A cell is a button in a roving-tabindex group: one tab stop for
 * the whole strip, arrow keys move between periods, and the focused or
 * hovered period's counts are written out below the strip, so the detail is
 * reachable by keyboard and on touch screens, not only through a hover title.
 * No-data cells are outlined, not filled, and incomplete periods are marked.
 */

import { useId, useRef, useState, type KeyboardEvent } from "react"
import { useLocale, useTranslations } from "next-intl"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { HistoryBucket, HistoryRange } from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

import { LEGEND_ORDER, STATUS_STYLES, usePercentLabel } from "./status-labels"
import { formatBucketPeriod } from "./status-format"

export function useBucketDescription(range: HistoryRange) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const percent = usePercentLabel()
  return (bucket: HistoryBucket): string => {
    const counts = bucket.availability
    const parts = [
      t("history.cell", {
        period: formatBucketPeriod(bucket, range, locale),
        status: t(`statuses.${bucket.status}`),
        pass: counts.passCount,
        fail: counts.failCount,
        unknown: counts.unknownCount,
        expected: counts.expectedSlots,
        availability: percent(counts.observedAvailability),
        coverage: percent(counts.coverage),
      }),
    ]
    if (counts.excludedSlots > 0) {
      parts.push(t("history.cellExcluded", { count: counts.excludedSlots }))
    }
    if (bucket.partial) parts.push(t("history.cellPartial"))
    return parts.join(" ")
  }
}

export interface HistoryStripProps {
  buckets: readonly HistoryBucket[]
  range: HistoryRange
  /** Component (or "All components") name for the group label. */
  name: string
  compact?: boolean
  testId?: string
}

export function HistoryStrip({ buckets, range, name, compact = false, testId }: HistoryStripProps) {
  const t = useTranslations("publicStatus")
  const describe = useBucketDescription(range)
  const [active, setActive] = useState<number | null>(null)
  const [focusWithin, setFocusWithin] = useState(false)
  const cells = useRef<Array<HTMLButtonElement | null>>([])
  const hintId = useId()

  if (buckets.length === 0) return null

  const last = buckets.length - 1
  const activeIndex = active === null ? null : Math.min(active, last)
  const tabStop = activeIndex ?? last

  const move = (next: number) => {
    const clamped = Math.max(0, Math.min(last, next))
    setActive(clamped)
    cells.current[clamped]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = activeIndex ?? last
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        event.preventDefault()
        move(current - 1)
        break
      case "ArrowRight":
      case "ArrowUp":
        event.preventDefault()
        move(current + 1)
        break
      case "Home":
        event.preventDefault()
        move(0)
        break
      case "End":
        event.preventDefault()
        move(last)
        break
      default:
        break
    }
  }

  const detail = activeIndex === null ? null : describe(buckets[activeIndex]!)

  return (
    <div data-testid={testId}>
      <span id={hintId} className="sr-only">
        {t("history.selectHint")}
      </span>
      <div
        role="group"
        aria-label={t("history.groupLabel", { name, range: t(`ranges.${range}`) })}
        aria-describedby={hintId}
        className="grid gap-px sm:gap-0.5"
        style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocusWithin(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocusWithin(false)
            setActive(null)
          }
        }}
        onMouseLeave={() => {
          if (!focusWithin) setActive(null)
        }}
      >
        {buckets.map((bucket, index) => {
          const label = describe(bucket)
          return (
            <button
              key={bucket.start}
              ref={(element) => {
                cells.current[index] = element
              }}
              type="button"
              tabIndex={index === tabStop ? 0 : -1}
              aria-label={label}
              title={label}
              data-testid="history-cell"
              data-status={bucket.status}
              data-partial={bucket.partial || undefined}
              aria-current={index === activeIndex ? "true" : undefined}
              onFocus={() => setActive(index)}
              onMouseEnter={() => setActive(index)}
              onClick={() => setActive(index)}
              className={cn(
                "min-w-0 rounded-[2px] transition-opacity outline-none hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                compact ? "h-5" : "h-7",
                STATUS_STYLES[bucket.status].dot,
                bucket.partial && "opacity-60 ring-1 ring-foreground/30 ring-inset",
                index === activeIndex && "ring-2 ring-foreground/60"
              )}
            />
          )
        })}
      </div>
      <p
        className="mt-2 min-h-4 text-xs leading-5 text-muted-foreground"
        data-testid="history-detail"
      >
        {detail ?? (
          <span className="flex items-center justify-between gap-4">
            <span>{t(`history.rangeStart.${range}`)}</span>
            <span>{t("history.now")}</span>
          </span>
        )}
      </p>
    </div>
  )
}

export function HistoryRangeSelector({
  value,
  ranges,
  onChange,
  pending,
}: {
  value: HistoryRange
  ranges: readonly HistoryRange[]
  onChange: (range: HistoryRange) => void
  pending: boolean
}) {
  const t = useTranslations("publicStatus")
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as HistoryRange)
      }}
      aria-label={t("history.rangeSelector")}
      aria-busy={pending || undefined}
      data-testid="history-range-selector"
    >
      {ranges.map((range) => (
        <ToggleGroupItem key={range} value={range} aria-label={t(`ranges.${range}`)}>
          {t(`rangesShort.${range}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export function HistoryLegend() {
  const t = useTranslations("publicStatus")
  return (
    <ul
      aria-label={t("history.legend")}
      className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"
    >
      {LEGEND_ORDER.map((status) => (
        <li key={status} className="inline-flex items-center gap-2">
          <span className={cn("size-2.5 rounded-[2px]", STATUS_STYLES[status].dot)} aria-hidden />
          {t(`statuses.${status}`)}
        </li>
      ))}
      <li className="inline-flex items-center gap-2">
        <span
          className="size-2.5 rounded-[2px] bg-emerald-500 opacity-60 ring-1 ring-foreground/30 ring-inset"
          aria-hidden
        />
        {t("history.partial")}
      </li>
    </ul>
  )
}
