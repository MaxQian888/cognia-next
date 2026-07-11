"use client"

/**
 * useNativeLogQuery — stateful wrapper around the cross-platform native log
 * read-back API (`logs_query` / `logs_list_files`).
 *
 * Works on Tauri desktop (invoke) and on Capacitor mobile / web companion
 * (companion RPC against the paired desktop), because `queryNativeLogs` goes
 * through the unified transport. `available` distinguishes "no backend
 * reachable" (plain web, unpaired phone) from an empty result set.
 *
 * Fetching is effect-driven: the query object + a refresh tick form a request
 * key, the effect resolves it, and `loading` is *derived* (last settled key ≠
 * current key) — no synchronous setState inside effects
 * (react-hooks/set-state-in-effect is enforced repo-wide).
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  listNativeLogFiles,
  queryNativeLogs,
  type NativeLogFileInfo,
  type NativeLogQueryInput,
  type NativeLogQueryResult,
} from "@/lib/native/native-logging"

export interface UseNativeLogQueryOptions {
  /** Initial query; merged over `{ file: "structured", limit: 200 }`. */
  initialQuery?: NativeLogQueryInput
  /** Auto-refresh interval in ms; 0 / undefined disables polling. */
  refreshIntervalMs?: number
  /** Also fetch the log-directory file listing. Default false. */
  listFiles?: boolean
}

export interface UseNativeLogQueryState {
  query: NativeLogQueryInput
  setQuery: (patch: Partial<NativeLogQueryInput>) => void
  result: NativeLogQueryResult | null
  files: NativeLogFileInfo[]
  loading: boolean
  /** null = first fetch not settled yet; false = no backend reachable. */
  available: boolean | null
  refresh: () => void
}

interface Settled {
  key: string
  result: NativeLogQueryResult | null
  files: NativeLogFileInfo[]
}

export function useNativeLogQuery(options: UseNativeLogQueryOptions = {}): UseNativeLogQueryState {
  const { initialQuery, refreshIntervalMs, listFiles = false } = options
  const [query, setQueryState] = useState<NativeLogQueryInput>(() => ({
    file: "structured",
    limit: 200,
    ...initialQuery,
  }))
  const [tick, setTick] = useState(0)
  const [settled, setSettled] = useState<Settled | null>(null)

  const requestKey = useMemo(
    () => JSON.stringify([query, tick, listFiles]),
    [query, tick, listFiles]
  )

  const setQuery = useCallback((patch: Partial<NativeLogQueryInput>) => {
    setQueryState((prev) => ({ ...prev, ...patch }))
  }, [])

  const refresh = useCallback(() => {
    setTick((prev) => prev + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [nextResult, nextFiles] = await Promise.all([
        queryNativeLogs(query),
        listFiles ? listNativeLogFiles() : Promise.resolve(null),
      ])
      if (cancelled) return
      setSettled((prev) => ({
        key: requestKey,
        result: nextResult,
        // Keep the previous listing when this fetch skipped it.
        files: nextFiles ?? prev?.files ?? [],
      }))
    })()
    return () => {
      cancelled = true
    }
  }, [requestKey, query, listFiles])

  useEffect(() => {
    if (!refreshIntervalMs || refreshIntervalMs <= 0) return
    const timer = setInterval(() => {
      setTick((prev) => prev + 1)
    }, refreshIntervalMs)
    return () => clearInterval(timer)
  }, [refreshIntervalMs])

  return {
    query,
    setQuery,
    result: settled?.result ?? null,
    files: settled?.files ?? [],
    loading: settled?.key !== requestKey,
    available: settled ? settled.result !== null : null,
    refresh,
  }
}
