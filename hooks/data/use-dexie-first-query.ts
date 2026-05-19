"use client"

import { useEffect, useState } from "react"

import { getSyncStateFor, runSyncDown } from "@/lib/sync/companion-sync"
import type { SyncableTable } from "@/lib/sync/types"

import { useClientLiveQuery } from "./use-client-live-query"

/**
 * Dexie-first read hook (Wave 4 / ADR-0026).
 *
 * Composes `useClientLiveQuery` (synchronous Dexie subscription) with the
 * companion sync orchestrator so consumers get three things in one call:
 *
 *   1. **Read-through cache** — the page renders from Dexie immediately;
 *      no spinner waiting on a network round-trip.
 *   2. **Background freshness** — when `table` is provided, the orchestrator
 *      is kicked once on mount. Subsequent triggers (network up, app
 *      resume, visibilitychange, sync://invalidate) are wired by
 *      `CompanionBootProvider` and propagate via Dexie's `liveQuery` so
 *      the same component re-renders with fresh data.
 *   3. **SWR-style indicator** — exposes `lastSyncedAt`, `isSyncing`, and
 *      `error` so badges like `ConnectionStateBadge` can show "synced X
 *      minutes ago" or "sync failed: ..." without re-querying.
 *
 * Replaces the ad-hoc `useEffect(() => transport.call(...))` pattern that
 * left mobile screens blank whenever the server was unreachable.
 */
export interface UseDexieFirstQueryOptions<T> {
  /** Dexie query (e.g. `() => getDb().sessions.toArray()`). */
  query: () => Promise<T> | T
  /** Dexie liveQuery dependency array. */
  deps: unknown[]
  /** Initial value rendered before the first Dexie resolution. */
  initial: T
  /**
   * If set, the orchestrator is kicked on mount and the hook reads
   * `lastSyncAt` / `lastError` for this table.
   */
  table?: SyncableTable
}

export interface DexieFirstQueryResult<T> {
  data: T | undefined
  /** True while the on-mount sync kick is in flight. */
  isSyncing: boolean
  /** Epoch ms of the last successful sync for `table`. `null` until first. */
  lastSyncedAt: number | null
  /** Last sync error message for `table`. `null` after the next success. */
  error: string | null
}

export function useDexieFirstQuery<T>(
  opts: UseDexieFirstQueryOptions<T>
): DexieFirstQueryResult<T> {
  const data = useClientLiveQuery<T>(opts.query, opts.deps, opts.initial)

  const [isSyncing, setIsSyncing] = useState(false)
  // The orchestrator state lives in a Map (not React state), so we
  // snapshot it into local state after every pull resolves. The
  // baseline snapshot also seeds initial render with the freshest
  // value the Map already knows.
  const [status, setStatus] = useState<{ lastSyncedAt: number | null; error: string | null }>(
    () => {
      if (!opts.table) return { lastSyncedAt: null, error: null }
      const initial = getSyncStateFor(opts.table)
      return {
        lastSyncedAt: initial?.lastSyncAt ?? null,
        error: initial?.lastError ?? null,
      }
    }
  )

  useEffect(() => {
    if (!opts.table) return
    let cancelled = false

    void (async () => {
      // setState calls deferred inside the async body so they don't
      // fire synchronously during effect dispatch.
      setIsSyncing(true)
      try {
        await runSyncDown()
      } catch {
        // runSyncDown swallows handler failures internally and persists
        // them on the per-table state; nothing more to do here.
      }
      if (cancelled) return
      const updated = getSyncStateFor(opts.table)
      setStatus({
        lastSyncedAt: updated?.lastSyncAt ?? null,
        error: updated?.lastError ?? null,
      })
      setIsSyncing(false)
    })()

    return () => {
      cancelled = true
    }
  }, [opts.table])

  return {
    data,
    isSyncing,
    lastSyncedAt: status.lastSyncedAt,
    error: status.error,
  }
}
