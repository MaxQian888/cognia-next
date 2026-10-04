"use client"

/**
 * How one conversation's cost compares with the user's other recent ones.
 *
 * Peers are the sessions active in the trailing {@link SESSION_RANK_WINDOW_DAYS}
 * local days, read with one `at` range scan and folded with the shared
 * `aggregateBySession`. The target arrives already summarized by the caller
 * from its own full history, because a long-running conversation can be older
 * than the peer window and ranking only its recent turns would understate it.
 * Pass `null` to keep the query idle (the Insights sheet only asks while open).
 */

import { useMemo } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getDb } from "@/lib/db/schema"
import { isLocalSpend, type SessionUsageRow } from "@/lib/db/session-usage"
import {
  aggregateBySession,
  startOfLocalDay,
  type SessionUsageSummary,
} from "@/lib/usage/session-analytics"
import {
  SESSION_RANK_WINDOW_DAYS,
  rankSessionCost,
  type SessionCostRank,
} from "@/lib/usage/session-cost-profile"

const EMPTY_ROWS: SessionUsageRow[] = []

export function useSessionCostRank(
  target: SessionUsageSummary | null,
  /** Clock anchor, supplied by the caller so render stays pure. */
  now: number
): SessionCostRank | null {
  const active = target !== null
  // Whole-day window, so the query key only moves at local midnight.
  const since = startOfLocalDay(now, SESSION_RANK_WINDOW_DAYS - 1)
  const rows = useClientLiveQuery(
    () => (active ? getDb().sessionUsage.where("at").aboveOrEqual(since).toArray() : EMPTY_ROWS),
    [active, since],
    EMPTY_ROWS
  )
  return useMemo(() => {
    if (!target || !rows) return null
    return rankSessionCost(target, aggregateBySession(rows.filter(isLocalSpend)))
  }, [rows, target])
}
