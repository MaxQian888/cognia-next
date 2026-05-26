/**
 * usePerfStream — drives the Task-Manager-style `/performance` panel.
 *
 * On mount (desktop only) it starts the backend sampler, backfills the rolling
 * window from the sample ring, then subscribes to live `perf://sample` frames.
 * On unmount it stops the sampler — so there is no sampling overhead while the
 * panel is closed. "Pause" freezes the UI (stops appending) without stopping
 * the backend, matching Task Manager's behavior.
 */

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { isTauri } from "@/lib/tauri"
import {
  perfResetHotspots,
  perfSetInterval,
  perfSnapshot,
  perfStartSampling,
  perfStopSampling,
  subscribePerfSample,
} from "@/lib/perf/backend/commands"
import type { PerfSample } from "@/lib/perf/backend/types"

/** Rolling window length (~2 min at 1 Hz). */
export const PERF_HISTORY_LIMIT = 120
/** Selectable sampling cadences (ms). */
export const PERF_INTERVAL_OPTIONS = [500, 1000, 2000, 4000] as const
export const DEFAULT_PERF_INTERVAL = 1000

export interface UsePerfStreamResult {
  /** Rolling window of samples, oldest → newest. */
  history: PerfSample[]
  /** Most recent sample, or `null` before the first frame. */
  latest: PerfSample | null
  /** Whether the native runtime is available (desktop). */
  available: boolean
  /** UI freeze state (backend keeps sampling). */
  paused: boolean
  intervalMs: number
  setPaused: (paused: boolean) => void
  setIntervalMs: (ms: number) => void
  /** Clear backend hotspot stats. */
  reset: () => void
}

export function usePerfStream(): UsePerfStreamResult {
  const available = isTauri()
  const [history, setHistory] = useState<PerfSample[]>([])
  const [paused, setPausedState] = useState(false)
  const [intervalMs, setIntervalState] = useState<number>(DEFAULT_PERF_INTERVAL)

  const pausedRef = useRef(false)
  const aliveRef = useRef(true)

  const append = useCallback((sample: PerfSample) => {
    if (pausedRef.current) return
    setHistory((prev) => {
      const next =
        prev.length >= PERF_HISTORY_LIMIT
          ? prev.slice(prev.length - PERF_HISTORY_LIMIT + 1)
          : prev.slice()
      next.push(sample)
      return next
    })
  }, [])

  useEffect(() => {
    if (!available) return undefined
    aliveRef.current = true
    let unsubscribe: () => void = () => {}

    void (async () => {
      await perfStartSampling(DEFAULT_PERF_INTERVAL)
      const snapshot = await perfSnapshot()
      if (!aliveRef.current) return
      if (snapshot.samples.length > 0) {
        setHistory(snapshot.samples.slice(-PERF_HISTORY_LIMIT))
      }
      unsubscribe = subscribePerfSample(append)
    })()

    return () => {
      aliveRef.current = false
      unsubscribe()
      void perfStopSampling()
    }
  }, [available, append])

  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next
    setPausedState(next)
  }, [])

  const setIntervalMs = useCallback((ms: number) => {
    setIntervalState(ms)
    void perfSetInterval(ms)
  }, [])

  const reset = useCallback(() => {
    void perfResetHotspots()
  }, [])

  const latest = history.length > 0 ? history[history.length - 1] : null

  return {
    history,
    latest,
    available,
    paused,
    intervalMs,
    setPaused,
    setIntervalMs,
    reset,
  }
}
