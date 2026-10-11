"use client"

/**
 * Activity module: a per-day heatmap with 1M / 3M / 1Y (ADR-0225 §2). Cells
 * fill the panel's width: the cell size is derived from the width step, so a
 * year fits a narrow panel and a month is not lost in a wide one.
 */

import { useFormatter, useTranslations } from "next-intl"

import {
  GLANCE_ACTIVITY_RANGES,
  GLANCE_WIDTH_PX,
  type GlanceActivityRange,
  type GlanceModuleSize,
} from "@/types/glance/layout"
import { cn } from "@/lib/utils"

import { useGlance } from "../glance-context"
import { GlanceCompactSection, GlanceSection } from "../glance-primitives"

const LEVEL_CLASS = [
  "bg-muted",
  "bg-success/25",
  "bg-success/45",
  "bg-success/70",
  "bg-success",
] as const

const GAP = 2
/** Horizontal padding of a section, both sides. */
const SECTION_PADDING = { desktop: 28, mobile: 40 } as const
/** The phone's content width the mobile drawer lays out against. */
const MOBILE_WIDTH = 390

export function heatmapCellSize(columns: number, available: number, max: number): number {
  return Math.max(3, Math.min(max, Math.floor((available - (columns - 1) * GAP) / columns)))
}

export function GlanceActivityModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.activity")
  const format = useFormatter()
  const { snapshot, send, route, width, platform } = useGlance()
  const activity = snapshot.activity
  const title = t("label")

  if (!activity) {
    return (
      <GlanceCompactSection moduleId="activity" title={title}>
        <span className="text-muted-foreground">{t("loading")}</span>
      </GlanceCompactSection>
    )
  }

  const openUsage = () => route({ kind: "open-owner", owner: "usage" })
  const available =
    (platform === "mobile" ? MOBILE_WIDTH : GLANCE_WIDTH_PX[width]) - SECTION_PADDING[platform]
  const dayTitle = (day: { day: string; tokens: number }) =>
    t("dayTitle", {
      day: format.dateTime(new Date(`${day.day}T12:00:00`), { dateStyle: "medium" }),
      tokens: format.number(day.tokens, { notation: "compact" }),
    })

  if (size === "compact") {
    const last = activity.days.slice(-28)
    const cell = heatmapCellSize(last.length, available - 120, 10)
    return (
      <GlanceCompactSection
        moduleId="activity"
        title={title}
        label={t("open")}
        onClick={openUsage}
        trailing={
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
            {t("streak", { count: activity.currentStreak })}
          </span>
        }
      >
        <span className="flex items-center" style={{ gap: GAP }} aria-hidden>
          {last.map((day) => (
            <i
              key={day.day}
              className={cn("block rounded-[2px]", LEVEL_CLASS[day.level])}
              style={{ width: cell, height: cell }}
            />
          ))}
        </span>
      </GlanceCompactSection>
    )
  }

  const columns = Math.ceil(activity.days.length / 7)
  const cell = heatmapCellSize(columns, available, size === "expanded" ? 14 : 11)

  return (
    <GlanceSection
      moduleId="activity"
      title={title}
      meta={
        <span className="truncate text-[11px] tabular-nums text-muted-foreground/80">
          {t("summary", { days: activity.activeDays, streak: activity.currentStreak })}
        </span>
      }
      aside={
        <div
          role="radiogroup"
          aria-label={t("rangeLabel")}
          className="inline-flex gap-0.5 rounded-md bg-muted p-0.5"
        >
          {GLANCE_ACTIVITY_RANGES.map((range: GlanceActivityRange) => (
            <button
              key={range}
              type="button"
              role="radio"
              aria-checked={activity.range === range}
              onClick={() => {
                if (range !== activity.range) void send({ kind: "set-activity-range", range })
              }}
              className={cn(
                "rounded px-1.5 text-[11px] leading-5 transition-colors",
                activity.range === range
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(`range.${range}`)}
            </button>
          ))}
        </div>
      }
    >
      <button
        type="button"
        data-glance-nav
        aria-label={t("open")}
        onClick={openUsage}
        className="-mx-1 block rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          className="grid"
          style={{ gridAutoFlow: "column", gridTemplateRows: `repeat(7, ${cell}px)`, gap: GAP }}
        >
          {activity.days.map((day) => (
            <i
              key={day.day}
              title={dayTitle(day)}
              className={cn("block rounded-[2px]", LEVEL_CLASS[day.level])}
              style={{ width: cell, height: cell }}
            />
          ))}
        </span>
      </button>
      {size === "expanded" ? (
        <div className="mt-1 flex items-center gap-3 text-[11.5px] text-muted-foreground">
          {activity.peakHour != null ? (
            <span>{t("peakHour", { hour: activity.peakHour })}</span>
          ) : null}
          <span className="flex-1" />
          <span>{t("longestStreak", { count: activity.longestStreak })}</span>
        </div>
      ) : null}
    </GlanceSection>
  )
}
