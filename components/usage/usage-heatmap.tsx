"use client"

/**
 * GitHub-style calendar heatmap of daily spend, over the vendored Kibo UI
 * `ContributionGraph` primitive. Every day in the active range gets a cell
 * (`fillDailyRange` pads the ones with no usage), intensity encodes USD cost,
 * and each cell carries both an aria-label and a tooltip that opens on hover
 * *and* on keyboard focus.
 *
 * Extracted from `components/settings/subscription/tabs/usage-tab.tsx` so the
 * chat welcome dashboard draws the *same* component over the *same*
 * `aggregateByDay` output — one heatmap implementation, one intensity scale,
 * one set of strings (`subscription.usage.costOverTime.heatmap.*`). Two copies
 * is exactly how two views of one table start disagreeing.
 *
 * Callers vary only the test-id prefix, so each surface stays independently
 * addressable in tests.
 */

import type * as React from "react"
import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"

import {
  ContributionGraph,
  ContributionGraphBlock,
  ContributionGraphCalendar,
  ContributionGraphFooter,
  ContributionGraphLegend,
  ContributionGraphTotalCount,
} from "@/components/ui/contribution-graph"
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { fillDailyRange, parseLocalDay } from "@/lib/usage/session-analytics"
import { formatCostInCurrency } from "@/types/system/usage"
import type { DailyUsage } from "@/types/system/usage"

/**
 * Cost intensity bucket for one day, 0–4 (matching the graph's `maxLevel`).
 * 0 is reserved for "no spend" so an empty day always reads as an empty cell;
 * every day with spend lands in 1–4, scaled against the range's busiest day.
 */
export function costLevel(cost: number, maxCost: number): number {
  if (!(cost > 0)) return 0
  if (!(maxCost > 0)) return 1
  return Math.min(4, Math.max(1, Math.ceil((cost / maxCost) * 4)))
}

/**
 * Tint one heatmap cell with the same palette colour the bar chart uses, so the
 * two views of the same data read as one series. Level 0 keeps the primitive's
 * themed `fill-muted` default (legible in both light and dark).
 */
export function levelStyle(level: number, accent: string): React.CSSProperties | undefined {
  if (level <= 0) return undefined
  return { fill: accent, fillOpacity: 0.25 + level * 0.1875 }
}

export interface UsageHeatmapProps {
  /** Sparse daily aggregates — `fillDailyRange` pads them to the full window. */
  daily: DailyUsage[]
  /** Trailing window in days; the grid always renders exactly this many cells. */
  rangeDays: number
  /** Render-time "now", so the grid and the row filter agree on "today". */
  now: number
  /** Test-id prefix for the root, each cell, and the total. */
  testIdPrefix?: string
  className?: string
}

export function UsageHeatmap({
  daily,
  rangeDays,
  now,
  testIdPrefix = "usage-cost-heatmap",
  className,
}: UsageHeatmapProps) {
  const t = useTranslations("subscription.usage.costOverTime")
  const locale = useLocale()
  const colors = useThemeColors()
  const accent = paletteColor(colors, 3)

  const cells = useMemo(() => fillDailyRange(daily, rangeDays, now), [daily, rangeDays, now])
  const maxCost = useMemo(() => cells.reduce((max, c) => Math.max(max, c.cost), 0), [cells])
  const totals = useMemo(
    () =>
      cells.reduce((acc, c) => ({ cost: acc.cost + c.cost, requests: acc.requests + c.requests }), {
        cost: 0,
        requests: 0,
      }),
    [cells]
  )

  const activities = useMemo(
    () =>
      cells.map((c) => ({
        date: c.date,
        count: c.requests,
        level: costLevel(c.cost, maxCost),
      })),
    [cells, maxCost]
  )
  const byDate = useMemo(() => new Map(cells.map((c) => [c.date, c])), [cells])

  // Month axis labels come from the active locale rather than a translation key
  // per month — `Intl` already knows every calendar we ship.
  const monthLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: "short" })
    return Array.from({ length: 12 }, (_, m) => fmt.format(new Date(2020, m, 15)))
  }, [locale])
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale]
  )

  // Every date reaching here came out of `cells`, and the calendar skips its
  // week-padding slots (`ContributionGraphCalendar` never yields an undefined
  // activity), so the lookup always hits — the fallback only exists so a future
  // change to the primitive degrades to a $0 label instead of throwing.
  const cellLabel = (date: string) => {
    const cell = byDate.get(date) ?? { cost: 0, requests: 0 }
    return t("heatmap.cell", {
      date: dayFormat.format(parseLocalDay(date)),
      cost: formatCostInCurrency(cell.cost, "USD"),
      requests: cell.requests,
    })
  }

  return (
    <TooltipProvider delayDuration={100}>
      <ContributionGraph
        data={activities}
        maxLevel={4}
        weekStart={1}
        blockSize={12}
        blockMargin={3}
        fontSize={11}
        totalCount={totals.requests}
        labels={{
          months: monthLabels,
          legend: { less: t("heatmap.less"), more: t("heatmap.more") },
        }}
        className={cn("text-muted-foreground", className)}
        data-testid={testIdPrefix}
      >
        <ContributionGraphCalendar>
          {({ activity, dayIndex, weekIndex }) => (
            <UiTooltip>
              <TooltipTrigger asChild>
                <ContributionGraphBlock
                  activity={activity}
                  dayIndex={dayIndex}
                  weekIndex={weekIndex}
                  className="stroke-[1px] stroke-border outline-none focus-visible:stroke-ring focus-visible:stroke-2"
                  style={levelStyle(activity.level, accent)}
                  role="img"
                  tabIndex={0}
                  aria-label={cellLabel(activity.date)}
                  data-testid={`${testIdPrefix}-cell-${activity.date}`}
                />
              </TooltipTrigger>
              <TooltipContent>{cellLabel(activity.date)}</TooltipContent>
            </UiTooltip>
          )}
        </ContributionGraphCalendar>
        <ContributionGraphFooter className="items-center text-xs">
          <ContributionGraphTotalCount>
            {({ totalCount }) => (
              <span data-testid={`${testIdPrefix}-total`}>
                {t("heatmap.total", {
                  cost: formatCostInCurrency(totals.cost, "USD"),
                  days: cells.length,
                  requests: totalCount,
                })}
              </span>
            )}
          </ContributionGraphTotalCount>
          <ContributionGraphLegend>
            {({ level }) => (
              <svg height={12} key={level} width={12} aria-hidden>
                <rect
                  className={cn("stroke-[1px] stroke-border", level === 0 && "fill-muted")}
                  style={levelStyle(level, accent)}
                  height={12}
                  rx={2}
                  ry={2}
                  width={12}
                />
              </svg>
            )}
          </ContributionGraphLegend>
        </ContributionGraphFooter>
      </ContributionGraph>
    </TooltipProvider>
  )
}
