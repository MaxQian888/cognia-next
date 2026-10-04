"use client"

/**
 * useNativeLogQuery — stateful wrapper around the cross-platform native log
 * read-back API (`logs_query` / `logs_list_files`).
 *
 * Works on Tauri desktop (invoke) and on Capacitor mobile / web companion
 * (companion RPC against the paired desktop), because both commands go
 * through the unified transport.
 *
 * Two different failures used to read the same. `queryNativeLogs` folds every
 * rejection into `null`, and `available` was "the last result was not null" —
 * so a desktop whose log file was locked, or a paired phone whose desktop
 * timed out once, rendered "Native logs unavailable — pair with a desktop
 * first" and hid the toolbar the user needed to retry with another file. The
 * hook now calls the transport itself and sorts the rejection:
 *
 *   - `available: false` — nothing here can answer: plain web
 *     (`no_host_transport`) or an unpaired companion (`not_paired`);
 *   - `error` — a host answered and the call failed. `available` stays true,
 *     the previous result is kept, and the viewer shows the error above it.
 *
 * Fetching is effect-driven: the query object + a refresh tick form a request
 * key, the effect resolves it, and `loading` is *derived* (last settled key ≠
 * current key) — no synchronous setState inside effects
 * (react-hooks/set-state-in-effect is enforced repo-wide).
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { transport } from "@/lib/tauri"
import { NO_HOST_TRANSPORT_CODE } from "@/lib/tauri/transport-web"
import type {
  NativeLogFileInfo,
  NativeLogQueryInput,
  NativeLogQueryResult,
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
  /** The last successful result. Kept across a failed refresh. */
  result: NativeLogQueryResult | null
  files: NativeLogFileInfo[]
  loading: boolean
  /**
   * null = first fetch not settled yet; false = no backend can answer here
   * (plain web, unpaired companion). A host that answered with a failure is
   * still available — see `error`.
   */
  available: boolean | null
  /** The last fetch's failure message when a host answered with an error. */
  error: string | null
  refresh: () => void
}

/** Rejection codes that mean "nothing on this device can serve the call". */
const UNAVAILABLE_CODES = new Set<string>([NO_HOST_TRANSPORT_CODE, "not_paired"])

type Outcome<T> = { ok: true; value: T } | { ok: false; unavailable: boolean; message: string }

/** Classify a transport rejection; exported for the tests. */
export function classifyNativeLogError(error: unknown): { unavailable: boolean; message: string } {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : ""
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error)
  return { unavailable: UNAVAILABLE_CODES.has(code), message }
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await transport.call<T>(name, args) }
  } catch (error) {
    return { ok: false, ...classifyNativeLogError(error) }
  }
}

interface Settled {
  key: string
  result: NativeLogQueryResult | null
  files: NativeLogFileInfo[]
  available: boolean
  error: string | null
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
      const [queried, listed] = await Promise.all([
        call<NativeLogQueryResult>("logs_query", { query }),
        listFiles ? call<NativeLogFileInfo[]>("logs_list_files", {}) : Promise.resolve(null),
      ])
      if (cancelled) return
      setSettled((prev) => {
        if (queried.ok) {
          return {
            key: requestKey,
            result: queried.value,
            // Keep the previous listing when this fetch skipped or failed it.
            files: listed && listed.ok ? listed.value : (prev?.files ?? []),
            available: true,
            error: null,
          }
        }
        if (queried.unavailable) {
          return { key: requestKey, result: null, files: [], available: false, error: null }
        }
        // A host answered and failed: stay available, keep what was shown.
        return {
          key: requestKey,
          result: prev?.result ?? null,
          files: prev?.files ?? [],
          available: true,
          error: queried.message,
        }
      })
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
    available: settled ? settled.available : null,
    error: settled?.error ?? null,
    refresh,
  }
}
