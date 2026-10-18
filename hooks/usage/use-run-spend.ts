"use client"

/**
 * Live spend of a run whose turns land in the usage ledger under one grouping
 * key (`goal:<goalId>`, `team:<runId>`), for the ADR-0232 "spent vs typical"
 * line. Re-reads as the run writes turns. Pass `null` to stay idle.
 */

import { useMemo } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { spendFromUsageRows, type RunSpend } from "@/lib/usage/run-estimate/progress"

const NO_ROWS: SessionUsageRow[] = []

export function useRunSpend(usageSessionId: string | null): RunSpend | null {
  const rows = useClientLiveQuery(
    () =>
      usageSessionId
        ? getDb().sessionUsage.where("sessionId").equals(usageSessionId).toArray()
        : NO_ROWS,
    [usageSessionId],
    NO_ROWS
  )
  return useMemo(
    () => (usageSessionId && rows ? spendFromUsageRows(rows) : null),
    [rows, usageSessionId]
  )
}
