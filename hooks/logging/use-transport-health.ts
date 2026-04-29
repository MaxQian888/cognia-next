/**
 * useTransportHealth Hook
 *
 * Polls logger transport health snapshots for UI observability.
 */

import { useCallback, useEffect, useState } from "react"
import { getTransportHealthSnapshot, type TransportHealthSnapshot } from "@/lib/logger"
import {
  getNativeLoggingReadiness,
  type NativeLoggingReadiness,
} from "@/lib/native/native-logging-readiness"

export interface UseTransportHealthOptions {
  autoRefresh?: boolean
  refreshInterval?: number
}

export interface UseTransportHealthResult {
  healthByTransport: Record<string, TransportHealthSnapshot>
  /**
   * Rolling per-transport queue-depth samples sourced from the same polling
   * cadence as `healthByTransport` — consumers can use these to render
   * sparklines without maintaining their own buffers.
   */
  queueDepthHistoryByTransport: Record<string, number[]>
  nativeLogging: NativeLoggingReadiness
  isLoading: boolean
  error: Error | null
  refresh: () => void
}

const MAX_HISTORY_SAMPLES = 30

const DEFAULT_OPTIONS: Required<UseTransportHealthOptions> = {
  autoRefresh: true,
  refreshInterval: 3000,
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
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(() => {
    try {
      const snapshot = getTransportHealthSnapshot()
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
      setNativeLogging(getNativeLoggingReadiness())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to read transport health"))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!opts.autoRefresh) {
      return
    }

    const timer = setInterval(refresh, opts.refreshInterval)
    return () => clearInterval(timer)
  }, [opts.autoRefresh, opts.refreshInterval, refresh])

  return {
    healthByTransport,
    queueDepthHistoryByTransport,
    nativeLogging,
    isLoading,
    error,
    refresh,
  }
}
