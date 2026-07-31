"use client"

/**
 * Adapters whose outbound queue cap has tripped repeatedly in the last 24h.
 *
 * The cap (`OUTBOUND_QUEUE_SOFT_CAP`, default 5000) fires in `enqueueOutbound`
 * when the table overflows; each aged pending row emits an
 * `outbound.queue_capped` audit entry. Past `SATURATION_THRESHOLD` entries for
 * one adapter, the operator needs to know the backlog is being dropped.
 *
 * Extracted from `outbound-saturation-banner.tsx`. Dismiss is the shared
 * `useDismissableNoticeSet` machine, pointed at `sessionStorage` rather than
 * `localStorage`: this failing set is short-lived and should reset on its own
 * once the cap stops firing.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { AuditEntry } from "@/types/connectors/audit"
import { useDismissableNoticeSet } from "./use-dismissable-notice-set"

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
const SATURATION_THRESHOLD = 100
const DISMISS_KEY = "inbox.outboundSaturationBanner.dismiss"

export interface SaturatedAdapter {
  adapterId: string
  cappedCount: number
  lastAt: number
}

export interface OutboundSaturationResult {
  adapters: SaturatedAdapter[]
  dismiss: () => void
}

export function useOutboundSaturation(): OutboundSaturationResult {
  // The window is small (24h × N adapters), so a JS-side group + threshold
  // beats a per-adapter live-query fan-out.
  const recent = useLiveQuery<AuditEntry[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    return getDb()
      .connectorAudit.where("at")
      .above(Date.now() - RECENT_WINDOW_MS)
      .filter((row) => row.kind === "outbound.queue_capped")
      .toArray()
  }, [])

  const saturated = useMemo<SaturatedAdapter[]>(() => {
    if (!recent || recent.length === 0) return []
    const byAdapter = new Map<string, SaturatedAdapter>()
    for (const row of recent) {
      const prior = byAdapter.get(row.adapterId)
      if (prior) {
        prior.cappedCount += 1
        if (row.at > prior.lastAt) prior.lastAt = row.at
      } else {
        byAdapter.set(row.adapterId, { adapterId: row.adapterId, cappedCount: 1, lastAt: row.at })
      }
    }
    return Array.from(byAdapter.values())
      .filter((row) => row.cappedCount >= SATURATION_THRESHOLD)
      .sort((a, b) => b.lastAt - a.lastAt)
  }, [recent])

  const affected = useMemo(() => saturated.map((s) => s.adapterId), [saturated])
  const { hidden, dismiss } = useDismissableNoticeSet(DISMISS_KEY, "session", affected)

  return { adapters: hidden ? [] : saturated, dismiss }
}
