"use client"

/**
 * Adapters whose newest heartbeat reports `degraded` or `down`, plus the
 * per-set dismiss state that decides whether to surface them.
 *
 * Extracted from `connection-loss-banner.tsx` so the banner is a pure
 * presenter and this — the part with the Dexie query, the TTL timer and the
 * dismiss bookkeeping — is testable without rendering.
 *
 * Reads the dedicated `connectorHeartbeats` table (v51; last 5 min). The whole
 * table is heartbeats, so the `at`-range scan needs no `kind` filter, and the
 * window is small (5 min × N adapters, N ≤ 10) so the newest-per-adapter
 * grouping happens in JS.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { ConnectorHeartbeatRow } from "@/lib/db/connector-types"
import { useDismissableNoticeSet } from "./use-dismissable-notice-set"

const RECENT_WINDOW_MS = 5 * 60 * 1000
const DISMISS_KEY = "inbox.connectionLossBanner.dismiss"

export interface DegradedAdapter {
  adapterId: string
  state: "degraded" | "down"
  reason: string | null
  at: number
}

export interface DegradedAdaptersResult {
  /** Empty while healthy OR while the current failing set stands dismissed. */
  adapters: DegradedAdapter[]
  dismiss: () => void
}

export function useDegradedAdapters(): DegradedAdaptersResult {
  const recent = useLiveQuery<ConnectorHeartbeatRow[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    return getDb()
      .connectorHeartbeats.where("at")
      .above(Date.now() - RECENT_WINDOW_MS)
      .toArray()
  }, [])

  const degraded = useMemo<DegradedAdapter[]>(() => {
    if (!recent || recent.length === 0) return []
    const newestByAdapter = new Map<string, ConnectorHeartbeatRow>()
    for (const row of recent) {
      const prior = newestByAdapter.get(row.adapterId)
      if (!prior || prior.at < row.at) newestByAdapter.set(row.adapterId, row)
    }
    const out: DegradedAdapter[] = []
    for (const row of newestByAdapter.values()) {
      const state = (row.fields?.state as string | undefined) ?? "running"
      if (state !== "degraded" && state !== "down") continue
      out.push({
        adapterId: row.adapterId,
        state,
        reason: (row.fields?.reason as string | undefined) ?? row.reason ?? null,
        at: row.at,
      })
    }
    return out.sort((a, b) => b.at - a.at)
  }, [recent])

  const affected = useMemo(() => degraded.map((d) => d.adapterId), [degraded])
  // `localStorage`, not `sessionStorage` (v49): a tab reload must not
  // rebroadcast a failure set the operator already acknowledged. The shared
  // TTL is what eventually lets it back.
  const { hidden, dismiss } = useDismissableNoticeSet(DISMISS_KEY, "local", affected)

  return { adapters: hidden ? [] : degraded, dismiss }
}
