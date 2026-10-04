/**
 * useTransportHealth Hook
 *
 * Polls logger transport health snapshots for UI observability.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { getTransportHealthSnapshot } from "@cognia/logging"
import type {
  TransportHealthSnapshot,
  UseTransportHealthOptions,
  UseTransportHealthResult,
} from "@/types/logging"
import {
  getNativeLoggingReadiness,
  type NativeLoggingReadiness,
} from "@/lib/native/native-logging-readiness"
import { getBehaviorEventExporterHealthSnapshot } from "@/lib/telemetry/events/track-event"

export type { UseTransportHealthOptions, UseTransportHealthResult } from "@/types/logging"

const MAX_HISTORY_SAMPLES = 30

const DEFAULT_OPTIONS: Required<UseTransportHealthOptions> = {
  autoRefresh: true,
  refreshInterval: 3000,
  enabled: true,
}

/** What one health chip says: how many tiles are healthy, out of how many. */
export interface TransportHealthSummaryCounts {
  /** Tiles whose status is `healthy`. */
  healthy: number
  /** Every tile the chip renders: one per transport, plus the native pipeline on Tauri. */
  total: number
  /** Whether the native pipeline is a tile at all and reports `degraded`. */
  nativeNeedsAttention: boolean
}

/**
 * The aggregate the log panel's transport chip prints, as a pure function, so
 * every surface that summarises delivery health counts the same things.
 *
 * The `/logs` header pill and the panel chip used to disagree: the pill
 * counted transports only (5/6) while the chip beside the list also counted
 * the native pipeline as a tile (6/7), so the same page printed two
 * denominators for one fact. Both now call this. The native pipeline is a tile
 * only on Tauri — in a browser it is permanently `inactive` and counting it
 * would make every web session read "one unhealthy".
 */
export function summarizeTransportHealth(
  healthByTransport: Record<string, TransportHealthSnapshot>,
  nativeLogging: Pick<NativeLoggingReadiness, "runtime" | "status"> | null | undefined
): TransportHealthSummaryCounts {
  let healthy = 0
  let total = 0
  for (const health of Object.values(healthByTransport)) {
    total += 1
    if (health.status === "healthy") healthy += 1
  }
  const nativeIsTile = nativeLogging?.runtime === "tauri"
  if (nativeIsTile) {
    total += 1
    if (nativeLogging.status === "healthy") healthy += 1
  }
  return {
    healthy,
    total,
    nativeNeedsAttention: nativeIsTile && nativeLogging.status === "degraded",
  }
}

/**
 * Field-level comparison that ignores `updatedAt` (which churns every poll even
 * when nothing of substance changed). When the result is `true` we can skip
 * both the React state update and the history append.
 */
function snapshotsShallowEqual(
  prev: Record<string, TransportHealthSnapshot>,
  next: Record<string, TransportHealthSnapshot>
): boolean {
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  if (prevKeys.length !== nextKeys.length) return false
  for (const key of nextKeys) {
    const a = prev[key]
    const b = next[key]
    if (!a || !b) return false
    if (
      a.transport !== b.transport ||
      a.status !== b.status ||
      a.queueDepth !== b.queueDepth ||
      a.retryCount !== b.retryCount ||
      a.droppedEntries !== b.droppedEntries ||
      a.lastSuccessAt !== b.lastSuccessAt ||
      a.lastFailureAt !== b.lastFailureAt ||
      a.lastError !== b.lastError
    ) {
      return false
    }
  }
  return true
}

export function useTransportHealth(
  options: UseTransportHealthOptions = {}
): UseTransportHealthResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const [healthByTransport, setHealthByTransport] = useState<
    Record<string, TransportHealthSnapshot>
  >({})
  const [queueDepthHistoryByTransport, setQueueDepthHistoryByTransport] = useState<
    Record<string, number[]>
  >({})
  const [nativeLogging, setNativeLogging] = useState<NativeLoggingReadiness>(
    getNativeLoggingReadiness()
  )
  const [isLoading, setIsLoading] = useState(opts.enabled !== false)
  const [error, setError] = useState<Error | null>(null)

  const lastSnapshotRef = useRef<Record<string, TransportHealthSnapshot>>({})

  const refresh = useCallback(() => {
    try {
      const snapshot = {
        ...getTransportHealthSnapshot(),
        ...getBehaviorEventExporterHealthSnapshot(),
      }
      const changed = !snapshotsShallowEqual(lastSnapshotRef.current, snapshot)
      if (changed) {
        lastSnapshotRef.current = snapshot
        setHealthByTransport(snapshot)
        setQueueDepthHistoryByTransport((prev) => {
          const next: Record<string, number[]> = { ...prev }
          for (const [name, health] of Object.entries(snapshot)) {
            const previous = prev[name] ?? []
            const appended = [...previous, health.queueDepth]
            if (appended.length > MAX_HISTORY_SAMPLES) appended.shift()
            next[name] = appended
          }
          return next
        })
      }
      // `getNativeLoggingReadiness()` returns a module-level singleton, so
      // reference equality is the right gate here.
      const readiness = getNativeLoggingReadiness()
      setNativeLogging((prev) => (Object.is(prev, readiness) ? prev : readiness))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to read transport health"))
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Disabled, the hook reads nothing: a consumer handed a host's shared poll
  // calls it unconditionally (rules of hooks) and must not start a second one.
  const enabled = opts.enabled !== false

  useEffect(() => {
    if (!enabled) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    refresh()
  }, [refresh, enabled])

  useEffect(() => {
    if (!enabled || !opts.autoRefresh) {
      return
    }

    const timer = setInterval(refresh, opts.refreshInterval)
    return () => clearInterval(timer)
  }, [enabled, opts.autoRefresh, opts.refreshInterval, refresh])

  return {
    healthByTransport,
    queueDepthHistoryByTransport,
    nativeLogging,
    isLoading,
    error,
    refresh,
  }
}
