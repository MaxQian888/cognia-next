"use client"

/**
 * The four numbers that explain a Site, above its tabs.
 *
 * The tab bar answers "where do I click" and never "is anything wrong here".
 * Each stat is a fraction whose denominator is what the Site *could* have —
 * ready/total versions, managed/total provider resources — so a shortfall is
 * legible without opening the tab that details it.
 *
 * Column count follows the data, the way `components/devices/device-hero.tsx`
 * does: `buildSiteStats` returns only what this Site can answer, and a fixed
 * grid would leave an empty tile that reads as a value which failed to load.
 * Spelled out rather than interpolated so Tailwind's scanner emits the classes.
 */
import { useTranslations } from "next-intl"

import { buildSiteStats, type SiteStat, type SiteStatsInput } from "@/lib/sites/site-stats"
import { cn } from "@/lib/utils"

const STAT_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 @xl/site-pane:grid-cols-4",
  5: "grid-cols-2 @xl/site-pane:grid-cols-5",
}

const STAT_TONE: Record<SiteStat["tone"], string> = {
  positive: "text-success",
  attention: "text-warning",
  neutral: "text-foreground",
}

export function SiteHeroStats(props: SiteStatsInput) {
  const t = useTranslations("sites")
  const stats = buildSiteStats(props)
  if (stats.length === 0) return null

  return (
    <dl
      className={cn(
        "mt-3 grid gap-x-4 gap-y-1.5",
        STAT_COLUMNS[stats.length] ?? "grid-cols-2 @xl/site-pane:grid-cols-4"
      )}
      data-testid="site-hero-stats"
    >
      {stats.map((stat) => (
        <div key={stat.key} data-testid={`site-stat-${stat.key}`}>
          <dd className={cn("text-sm font-semibold tabular-nums", STAT_TONE[stat.tone])}>
            {stat.value}
            {stat.detail ? (
              <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                {t(`stats.detail.${stat.key}`, { count: stat.detail })}
              </span>
            ) : null}
          </dd>
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t(`stats.${stat.key}`)}
          </dt>
        </div>
      ))}
    </dl>
  )
}
