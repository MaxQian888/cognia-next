"use client"

/**
 * Weekday × hour punch card of when the turns happened.
 *
 * The calendar heatmap shows which DAYS were busy; this shows the rhythm inside
 * a week — the 2 a.m. scheduled workflow, the Monday-morning burst — which is
 * where unattended spend tends to hide. Intensity is turns, not dollars, so a
 * cheap model used all afternoon still shows up; each cell's label carries both.
 *
 * Weeks start on Monday and weekday names come from `Intl`, so nothing here is
 * a hard-coded string.
 */

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import type { ActivityMatrix } from "@/lib/usage/usage-insights"
import { formatCostInCurrency } from "@/types/system/usage"

/** `Date#getDay()` indices in Monday-first display order. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

/**
 * Chart palette, not `primary`: in the neutral themes `primary` is near-black,
 * and a grid of black squares reads as blocked-out cells, not as intensity.
 */
const LEVEL_CLASS = [
  "bg-muted",
  "bg-chart-2/25",
  "bg-chart-2/50",
  "bg-chart-2/75",
  "bg-chart-2",
] as const

/** 0 for an empty cell, else 1–4 scaled against the busiest cell. */
export function activityLevel(turns: number, maxTurns: number): number {
  if (turns <= 0 || maxTurns <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((turns / maxTurns) * 4)))
}

function weekdayNames(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" })
  // 2026-01-04 is a Sunday, so day `i` of that week has `getDay() === i`.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2026, 0, 4 + i)))
}

export interface UsageActivityMatrixProps {
  matrix: ActivityMatrix
  testid?: string
}

export function UsageActivityMatrix({
  matrix,
  testid = "usage-activity-matrix",
}: UsageActivityMatrixProps) {
  const t = useTranslations("usageInsights.activity")
  const locale = useLocale()
  const names = useMemo(() => weekdayNames(locale), [locale])

  if (matrix.maxTurns === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testid}-empty`}>
        {t("empty")}
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid={testid}>
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[30rem] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5"
          role="grid"
          aria-label={t("label")}
        >
          {WEEK_ORDER.map((weekday) => (
            <div key={weekday} role="row" className="contents">
              <span
                role="rowheader"
                className="truncate pr-1 text-right text-[10px] leading-4 text-muted-foreground"
              >
                {names[weekday]}
              </span>
              {matrix.turns[weekday].map((turns, hour) => {
                const label = t("cell", {
                  weekday: names[weekday],
                  hour,
                  turns,
                  cost: formatCostInCurrency(matrix.costUsd[weekday][hour], "USD"),
                })
                return (
                  <span
                    key={hour}
                    role="gridcell"
                    aria-label={label}
                    title={label}
                    className={cn(
                      "h-4 rounded-[3px]",
                      LEVEL_CLASS[activityLevel(turns, matrix.maxTurns)]
                    )}
                    data-testid={`${testid}-cell-${weekday}-${hour}`}
                    data-level={activityLevel(turns, matrix.maxTurns)}
                  />
                )
              })}
            </div>
          ))}
          <span aria-hidden />
          {Array.from({ length: 24 }, (_, hour) => (
            <span
              key={hour}
              aria-hidden
              className="text-center text-[9px] leading-3 text-muted-foreground"
            >
              {hour % 6 === 0 ? hour : ""}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        {matrix.peak ? (
          <span data-testid={`${testid}-peak`}>
            {t("peak", {
              weekday: names[matrix.peak.weekday],
              hour: matrix.peak.hour,
              turns: matrix.peak.turns,
            })}
          </span>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-1" aria-hidden>
          {t("less")}
          {LEVEL_CLASS.map((cls) => (
            <span key={cls} className={cn("size-2.5 rounded-[2px]", cls)} />
          ))}
          {t("more")}
        </span>
      </div>
    </div>
  )
}
