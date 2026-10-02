"use client"

/**
 * Live public status snapshot for one history range.
 *
 * Plan §11 page behaviour, in one place:
 * - fetch the validated snapshot, then poll every 60 s while the tab is
 *   visible; hidden tabs stop polling and a visible tab refreshes at once;
 * - abort the in-flight request on unmount, runtime change and range change,
 *   and drop any response that a newer request (or a newer revision) has
 *   superseded;
 * - a failed request backs off with jitter up to five minutes and keeps the
 *   last validated snapshot with its original timestamps;
 * - snapshot age is recomputed on a timer and on visibility restore, using
 *   the server clock observed at fetch time (`snapshotFreshness`).
 *
 * There is no fallback data of any kind: no snapshot means "unknown".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  HISTORY_RANGES,
  parseIsoMs,
  parsePublicSnapshot,
  snapshotFreshness,
  statusApiUrl,
  type HistoryRange,
  type PublicStatusSnapshot,
  type SnapshotFreshness,
  type StatusRuntime,
} from "@/lib/status/public-status"

import {
  isAbortError,
  statusGet,
  StatusRequestError,
  type StatusRequestErrorKind,
} from "./status-transport"

export const STATUS_POLL_INTERVAL_MS = 60_000
export const STATUS_BASE_BACKOFF_MS = 15_000
export const STATUS_MAX_BACKOFF_MS = 300_000
export const STATUS_FRESHNESS_TICK_MS = 15_000
export const DEFAULT_STATUS_RANGE: HistoryRange = "90d"

/**
 * Delay before retry number `failures` (1-based): exponential from 15 s,
 * capped at five minutes, with jitter over the upper half of the step so
 * many open pages do not retry in lockstep after a shared outage.
 */
export function statusBackoffDelayMs(failures: number, random: () => number = Math.random): number {
  const step = Math.min(
    STATUS_MAX_BACKOFF_MS,
    STATUS_BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1)
  )
  return Math.round(step / 2 + (random() * step) / 2)
}

export interface LoadedSnapshot {
  snapshot: PublicStatusSnapshot
  /** Client clock when the response arrived. */
  fetchedAtClientMs: number
}

export interface PublicStatusError {
  kind: StatusRequestErrorKind
  /** Consecutive failures, including this one. */
  failures: number
  at: number
}

export interface PublicStatusState {
  range: HistoryRange
  setRange: (range: HistoryRange) => void
  /** Ranges the service advertises, or the contract set before any snapshot. */
  availableRanges: readonly HistoryRange[]
  loaded: LoadedSnapshot | null
  freshness: SnapshotFreshness | null
  /** A request for the selected range has not produced a snapshot yet. */
  pendingRange: boolean
  error: PublicStatusError | null
  refreshing: boolean
  refresh: () => void
}

export interface UsePublicStatusOptions {
  initialRange?: HistoryRange
  /** Jitter source; tests pin it. */
  random?: () => number
}

function computeFreshness(loaded: LoadedSnapshot, nowMs: number): SnapshotFreshness {
  const generatedAtMs = parseIsoMs(loaded.snapshot.generatedAt) ?? Number.NaN
  const serverTimeMs = parseIsoMs(loaded.snapshot.serverTime) ?? Number.NaN
  return snapshotFreshness({
    generatedAtMs,
    serverTimeMs,
    staleAfterMs: loaded.snapshot.staleAfterMs,
    fetchedAtClientMs: loaded.fetchedAtClientMs,
    nowClientMs: Math.max(nowMs, loaded.fetchedAtClientMs),
  })
}

export function usePublicStatus(
  runtime: StatusRuntime | null,
  options: UsePublicStatusOptions = {}
): PublicStatusState {
  const [range, setRangeState] = useState<HistoryRange>(
    options.initialRange ?? DEFAULT_STATUS_RANGE
  )
  const [loaded, setLoaded] = useState<LoadedSnapshot | null>(null)
  const [error, setError] = useState<PublicStatusError | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const loadedRef = useRef<LoadedSnapshot | null>(null)
  const generationRef = useRef(0)
  const runRef = useRef<(() => void) | null>(null)
  // Read once: the jitter source is fixed for the life of the page.
  const randomRef = useRef(options.random ?? Math.random)

  const apiBase = runtime?.apiBase ?? null

  useEffect(() => {
    if (apiBase === null) return
    const generation = ++generationRef.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let controller: AbortController | null = null
    let failures = 0

    const isCurrent = () => !disposed && generation === generationRef.current

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }

    const schedule = (delayMs: number) => {
      clearTimer()
      // A hidden tab stops polling; the visibility handler resumes it.
      if (document.visibilityState === "hidden") return
      timer = setTimeout(() => void run(), delayMs)
    }

    const run = async () => {
      if (!isCurrent()) return
      clearTimer()
      controller?.abort()
      const own = new AbortController()
      controller = own
      try {
        const { value, receivedAtMs } = await statusGet(
          statusApiUrl(apiBase, `/snapshot?range=${encodeURIComponent(range)}`),
          parsePublicSnapshot,
          { signal: own.signal }
        )
        if (!isCurrent() || own.signal.aborted) return
        if (value.range !== range) {
          throw new StatusRequestError("invalid", { message: "snapshot range mismatch" })
        }
        const current = loadedRef.current
        const superseded =
          current !== null &&
          current.snapshot.range === value.range &&
          value.revision < current.snapshot.revision
        if (!superseded) {
          const next = { snapshot: value, fetchedAtClientMs: receivedAtMs }
          loadedRef.current = next
          setLoaded(next)
        }
        failures = 0
        setError(null)
        setNowMs(Date.now())
        schedule(STATUS_POLL_INTERVAL_MS)
      } catch (caught) {
        if (!isCurrent() || isAbortError(caught)) return
        failures += 1
        const kind = caught instanceof StatusRequestError ? caught.kind : "network"
        setError({ kind, failures, at: Date.now() })
        setNowMs(Date.now())
        schedule(statusBackoffDelayMs(failures, randomRef.current))
      } finally {
        if (isCurrent() && controller === own) {
          controller = null
          setRefreshing(false)
        }
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        clearTimer()
        return
      }
      setNowMs(Date.now())
      void run()
    }

    runRef.current = () => void run()
    document.addEventListener("visibilitychange", onVisibility)
    void run()

    return () => {
      disposed = true
      clearTimer()
      controller?.abort()
      document.removeEventListener("visibilitychange", onVisibility)
      runRef.current = null
    }
  }, [apiBase, range])

  // Age is a function of the clock, not of the last fetch: tick while visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") setNowMs(Date.now())
    }, STATUS_FRESHNESS_TICK_MS)
    return () => clearInterval(id)
  }, [])

  const setRange = useCallback((next: HistoryRange) => {
    setRangeState(next)
    // A failure belonged to the previous range's request; the new request
    // reports its own.
    setError(null)
  }, [])

  const refresh = useCallback(() => {
    if (!runRef.current) return
    setRefreshing(true)
    runRef.current()
  }, [])

  const freshness = useMemo(
    () => (loaded ? computeFreshness(loaded, nowMs) : null),
    [loaded, nowMs]
  )

  const availableRanges = loaded?.snapshot.capabilities.historyRanges.length
    ? loaded.snapshot.capabilities.historyRanges
    : HISTORY_RANGES

  return {
    range,
    setRange,
    availableRanges,
    loaded,
    freshness,
    pendingRange: loaded === null || loaded.snapshot.range !== range,
    error,
    refreshing,
    refresh,
  }
}
