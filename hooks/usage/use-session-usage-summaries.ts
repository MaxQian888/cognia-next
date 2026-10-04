"use client"

/**
 * Usage totals (turns, tokens, priced cost) for a set of conversations, live.
 *
 * Reads only the usage rows of the ids asked for (`sessionUsage` is indexed by
 * `sessionId`), never the whole table: a conversation list asks for the rows
 * it shows, and a full read re-ran on every turn of every conversation. Cost
 * goes through `aggregateBySession`, so unpriced turns stay visible to
 * `formatBucketCost` (a lower bound, or no figure) instead of reading as free.
 *
 * Shared by the conversation manager table and Settings → Agent runtime →
 * Sessions.
 */

import { useMemo } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { aggregateBySession, type SessionUsageSummary } from "@/lib/usage/session-analytics"

const EMPTY_USAGE: SessionUsageRow[] = []

export interface SessionUsageSummaries {
  /** By conversation id; a conversation with no recorded turn is absent. */
  summaries: ReadonlyMap<string, SessionUsageSummary>
  /** The first read for this id set has not answered yet. */
  loading: boolean
}

const EMPTY_SUMMARIES: ReadonlyMap<string, SessionUsageSummary> = new Map()

export function useSessionUsageSummaries(ids: readonly string[]): SessionUsageSummaries {
  // One stable key per id set, so a re-render with the same ids in a new array
  // does not restart the live query.
  const idsKey = useMemo(() => [...new Set(ids)].sort().join("\n"), [ids])
  const rows = useClientLiveQuery(
    () =>
      idsKey
        ? getDb().sessionUsage.where("sessionId").anyOf(idsKey.split("\n")).toArray()
        : EMPTY_USAGE,
    [idsKey],
    EMPTY_USAGE
  )
  const summaries = useMemo(
    () =>
      rows
        ? new Map(aggregateBySession(rows).map((summary) => [summary.sessionId, summary]))
        : EMPTY_SUMMARIES,
    [rows]
  )
  return { summaries, loading: rows === undefined }
}
