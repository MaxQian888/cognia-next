"use client"

/**
 * Reactive feed for `UsageGlanceSnapshotV1`, the projection the tray, the tray
 * quick panel and the Capacity Dock all read.
 *
 * The scheduling policy is the interesting part, and it is deliberately not a
 * timer:
 *
 *   * LOCAL spend is a Dexie live query, so a committed turn reaches the menu
 *     bar within a frame of the write, with no polling at all.
 *   * EXTERNAL spend is scanned only when a surface actually shows the
 *     all-tools scope, and then only on mount, on an explicit refresh, or when
 *     a source invalidates. An install with every ambient surface off performs
 *     zero filesystem work, which is the cost CodeBurn's unconditional
 *     30-second poll pays and this does not.
 *   * `enabled=false` makes the whole hook inert. No query, no scan, no
 *     subscription, and a `null` snapshot the callers already handle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"

import { getDb } from "@/lib/db/schema"
import { localDayString } from "@/lib/db/provider-cost-daily"
import { parseLocalDay } from "@/lib/usage/session-analytics"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { foldSourceFreshness, type UsageSourceStateRow } from "@/lib/db/usage-source-states"
import { refreshExternalUsageIndex } from "@/lib/usage/external-usage-index"
import { resolveScanInput } from "@/lib/session-import"
import {
  buildUsageGlance,
  periodStart,
  type UsageGlanceBudget,
  type UsageGlanceQuery,
  type UsageGlanceQuota,
  type UsageGlanceSnapshotV1,
} from "@/lib/usage/usage-glance"

/**
 * Midday offset applied to the day anchor before deriving the window start.
 * `parseLocalDay` returns local midnight, and feeding that straight into a
 * "today" window would place the boundary exactly on it, where a DST shift can
 * land the anchor in the previous day. Noon is unambiguous in every zone.
 */
const HALF_DAY_MS = 43_200_000

export interface UseUsageGlanceOptions {
  query: UsageGlanceQuery
  /** Gate the whole hook. Off means no query, no scan, no subscription. */
  enabled?: boolean
  /** Quota fold, supplied by the caller that already reads the limits plane. */
  quota?: UsageGlanceQuota | null
  /** Budget fold, supplied by the caller that already reads the budget plane. */
  budget?: UsageGlanceBudget | null
}

export interface UseUsageGlanceResult {
  snapshot: UsageGlanceSnapshotV1 | null
  /** True while the first Dexie read is in flight. */
  loading: boolean
  /** True while an external scan is running. */
  scanning: boolean
  /** Re-read the external index now. Resolves when the scan settles. */
  refresh: () => Promise<void>
  /** Per-source diagnostics behind the freshness label. */
  sourceStates: UsageSourceStateRow[]
}

/**
 * Rows are read over the `at` index rather than the whole table. A 90-day
 * window on a busy install is tens of thousands of rows and the tray rebuilds
 * on every store change, so reading the full table here would put a table scan
 * on a hot path.
 */
async function readRows(fromMs: number): Promise<SessionUsageRow[]> {
  return getDb().sessionUsage.where("at").aboveOrEqual(fromMs).toArray()
}

export function useUsageGlance(opts: UseUsageGlanceOptions): UseUsageGlanceResult {
  const { query, enabled = true, quota = null, budget = null } = opts
  const [scanning, setScanning] = useState(false)
  const [scanTick, setScanTick] = useState(0)
  const inFlight = useRef<Promise<void> | null>(null)

  // The shared ticker owns the clock, because reading it during render is an
  // impure render. Anchoring the window on local midnight also keeps the
  // live-query key stable through the day, so the subscription is rebuilt once
  // at midnight rather than on every render.
  const ticked = useSubscriptionNow()
  const [mountedAt] = useState(() => Date.now())
  const nowMs = ticked > 0 ? ticked : mountedAt
  const dayKey = localDayString(nowMs)
  const fromMs = useMemo(
    () => periodStart(query.period, parseLocalDay(dayKey).getTime() + HALF_DAY_MS),
    [query.period, dayKey]
  )

  const rows = useLiveQuery<SessionUsageRow[] | undefined>(
    async () => (enabled ? readRows(fromMs) : []),
    [enabled, fromMs, scanTick],
    undefined
  )

  const sourceStates = useLiveQuery<UsageSourceStateRow[]>(
    async () => (enabled && query.scope === "all-tools" ? getDb().usageSourceStates.toArray() : []),
    [enabled, query.scope, scanTick],
    []
  )

  const refresh = useCallback(async () => {
    if (!enabled) return
    // Single-flight. A user mashing "Refresh" must not start six scans.
    if (inFlight.current) return inFlight.current
    const run = (async () => {
      setScanning(true)
      try {
        const input = await resolveScanInput()
        await refreshExternalUsageIndex(input, { force: true })
      } catch {
        // A failed scan leaves the previously indexed rows in place and the
        // source states degraded, which the freshness row already reports.
      } finally {
        setScanning(false)
        inFlight.current = null
        setScanTick((n) => n + 1)
      }
    })()
    inFlight.current = run
    return run
  }, [enabled])

  // Scan on entering the all-tools scope, never on a timer. Sources inside
  // their freshness TTL are skipped by the orchestrator, so re-entering the
  // scope repeatedly costs a Dexie read and nothing else.
  useEffect(() => {
    if (!enabled || query.scope !== "all-tools") return
    let cancelled = false
    void (async () => {
      try {
        const input = await resolveScanInput()
        if (cancelled) return
        await refreshExternalUsageIndex(input)
        if (!cancelled) setScanTick((n) => n + 1)
      } catch {
        // Same as above: degraded state is reported, not thrown.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, query.scope])

  const snapshot = useMemo(() => {
    if (!enabled || rows === undefined) return null
    const freshness =
      query.scope === "all-tools" ? foldSourceFreshness(sourceStates ?? []) : "fresh"
    return buildUsageGlance({ rows, query, freshness, quota, budget, now: nowMs })
  }, [enabled, rows, query, sourceStates, quota, budget, nowMs])

  return {
    snapshot,
    loading: enabled && rows === undefined,
    scanning,
    refresh,
    sourceStates: sourceStates ?? [],
  }
}
