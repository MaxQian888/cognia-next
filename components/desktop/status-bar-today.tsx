"use client"

/**
 * Status-bar "today" segment: what this install has spent since local
 * midnight — tokens, and cost once anything priced has run.
 *
 * It answers the question the plan-limits chip (`usage`) cannot: that one
 * reads a provider's quota meters and is empty for anyone on an API key or a
 * local model, while every turn on every surface lands in `sessionUsage`. The
 * figures come from the same `collectActivityStats` fold the welcome dashboard
 * uses, so the bar and the dashboard can never disagree about a day.
 *
 * Only today's rows are read (`at` is indexed), and the cut-off follows the
 * clock: `useNow` ticks once a minute, so the segment rolls over at midnight
 * instead of carrying yesterday's total into the morning. It renders nothing
 * until today has a turn, the way the bar's other ambient segments self-hide.
 */

import { useMemo } from "react"
import { useLocale, useNow, useTranslations } from "next-intl"
import { ActivityIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useClientLiveQuery } from "@/hooks/data"
import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { collectActivityStats } from "@/lib/usage/activity-stats"
import { startOfLocalDay } from "@/lib/usage/session-analytics"
import { useUIStore } from "@/stores/ui/ui-store"
import { formatCostInCurrency, formatTokens } from "@/types/system/usage"

/** How often the day boundary is re-read. A minute is plenty for "today". */
const CLOCK_TICK_MS = 60_000

export function StatusBarToday() {
  const t = useTranslations("desktop.statusBar.today")
  const locale = useLocale()
  const requestOpenSettings = useUIStore((s) => s.requestOpenSettings)
  const now = useNow({ updateInterval: CLOCK_TICK_MS })
  const nowMs = now.getTime()
  const since = startOfLocalDay(nowMs)

  const rows = useClientLiveQuery<SessionUsageRow[]>(
    () => getDb().sessionUsage.where("at").aboveOrEqual(since).toArray(),
    [since],
    []
  )

  const stats = useMemo(() => collectActivityStats(rows ?? [], { now: nowMs }), [rows, nowMs])
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale])

  if (!rows || stats.turns === 0) return null

  const tokens = formatTokens(stats.totalTokens)
  const cost = stats.costUsd > 0 ? formatCostInCurrency(stats.costUsd, "USD") : null
  const summary = cost ? t("summaryWithCost", { tokens, cost }) : t("summary", { tokens })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="status-today"
          aria-label={t("label", { summary })}
          title={t("label", { summary })}
          className="flex h-6 min-w-0 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ActivityIcon aria-hidden className="size-3 shrink-0" />
          <span className="tabular-nums">{tokens}</span>
          {cost ? (
            <>
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
              <span className="tabular-nums">{cost}</span>
            </>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-64 p-3">
        <p className="mb-2 text-xs font-medium">{t("title")}</p>
        <dl
          className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs"
          data-testid="status-today-details"
        >
          <Figure label={t("tokens")} value={tokens} />
          <Figure label={t("cost")} value={cost ?? formatCostInCurrency(0, "USD")} />
          <Figure label={t("sessions")} value={numberFormat.format(stats.sessions)} />
          <Figure label={t("turns")} value={numberFormat.format(stats.turns)} />
          <div className="col-span-2 flex min-w-0 items-baseline justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("topModel")}</dt>
            <dd className="truncate font-medium" title={stats.topModel ?? undefined}>
              {stats.topModel ?? t("none")}
            </dd>
          </div>
        </dl>
        <Button
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          data-testid="status-today-open"
          onClick={() => requestOpenSettings("subscription")}
        >
          {t("open")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}
