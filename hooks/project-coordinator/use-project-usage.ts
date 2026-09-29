"use client"

import { useMemo } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useClientLiveQuery } from "@/hooks/data"
import { listLocalUsageForProjectSince, type SessionUsageRow } from "@/lib/db/session-usage"
import { getSessionsByIds } from "@/lib/db/sessions"
import {
  aggregateBucketsBy,
  aggregateByDay,
  aggregateByModel,
  aggregateBySession,
  bucketTokens,
  type ModelUsageRow,
  type SessionUsageSummary,
} from "@/lib/usage/session-analytics"
import type { DailyUsage } from "@/types/system/usage"

/**
 * What one workspace spent (ADR-0204): the rows its sessions recorded in the
 * trailing window, rolled up by the same aggregators the Usage dashboard uses,
 * so a workspace's figure and the dashboard's can never disagree about a turn.
 */

export interface ProjectUsageTotals {
  costUsd: number
  turns: number
  tokens: number
  unpricedTurns: number
}

export interface ProjectUsage {
  totals: ProjectUsageTotals
  daily: DailyUsage[]
  bySession: SessionUsageSummary[]
  byModel: ModelUsageRow[]
  /** The sessions named in `bySession`, for titles and roles. */
  sessions: ReadonlyMap<string, ChatSession>
}

/** Midnight (local) that opens a `days`-day window ending on `now`'s day. */
export function projectUsageWindowStart(now: number, days: number): number {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (Math.max(1, Math.floor(days)) - 1))
  return start.getTime()
}

/** Pure roll-up, exported for tests. */
export function summarizeProjectUsage(
  rows: readonly SessionUsageRow[],
  sessions: readonly ChatSession[]
): ProjectUsage {
  const bucket = aggregateBucketsBy(rows, () => "all").get("all")
  return {
    totals: {
      costUsd: bucket?.costUsd ?? 0,
      turns: bucket?.turns ?? 0,
      tokens: bucket ? bucketTokens(bucket) : 0,
      unpricedTurns: bucket?.unpricedTurns ?? 0,
    },
    daily: aggregateByDay(rows),
    bySession: aggregateBySession(rows),
    byModel: aggregateByModel(rows),
    sessions: new Map(sessions.map((session) => [session.id, session])),
  }
}

interface Loaded {
  rows: SessionUsageRow[]
  sessions: ChatSession[]
}

/** `undefined` while loading. `now` should be coarse (the day) to keep the query stable. */
export function useProjectUsage(
  projectId: string,
  days: number,
  now: number
): ProjectUsage | undefined {
  const since = projectUsageWindowStart(now, days)
  const loaded = useClientLiveQuery<Loaded>(
    async () => {
      const rows = await listLocalUsageForProjectSince(projectId, since)
      const sessions = await getSessionsByIds([...new Set(rows.map((row) => row.sessionId))])
      return { rows, sessions }
    },
    [projectId, since],
    { rows: [], sessions: [] }
  )
  return useMemo(
    () => (loaded ? summarizeProjectUsage(loaded.rows, loaded.sessions) : undefined),
    [loaded]
  )
}
