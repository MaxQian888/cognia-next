"use client"

/**
 * This calendar month's local spend and where it is heading, live.
 *
 * The rows come from one `at` range scan starting at {@link forecastQueryStart}
 * (the earlier of the month's first midnight and the trailing rate window), and
 * the projection is the pure {@link forecastMonthSpend}. The query key is the
 * local day, like `useCostBudgetStatus`, so the subscription is rebuilt once at
 * midnight; the projection itself follows the shared subscription ticker so the
 * "rest of the month" shrinks as the day goes on.
 */

import { useMemo, useState } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { localDayString } from "@/lib/db/provider-cost-daily"
import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"
import { parseLocalDay } from "@/lib/usage/session-analytics"
import {
  forecastMonthSpend,
  forecastQueryStart,
  type MonthForecast,
} from "@/lib/usage/usage-insights"

const EMPTY_ROWS: SessionUsageRow[] = []

export interface MonthForecastState {
  /** `null` until the first read answers. */
  forecast: MonthForecast | null
  /** The clock the forecast was computed against. */
  now: number
}

export function useMonthForecast(): MonthForecastState {
  const ticked = useSubscriptionNow()
  const [mountedAt] = useState(() => Date.now())
  const now = ticked > 0 ? ticked : mountedAt
  const dayKey = localDayString(now)

  const rows = useClientLiveQuery(
    () =>
      getDb()
        .sessionUsage.where("at")
        .aboveOrEqual(forecastQueryStart(parseLocalDay(dayKey).getTime()))
        .toArray(),
    [dayKey],
    EMPTY_ROWS
  )

  const forecast = useMemo(() => (rows ? forecastMonthSpend(rows, now) : null), [rows, now])
  return { forecast, now }
}
