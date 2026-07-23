/**
 * usePerfStream — drives the Task-Manager-style `/performance` panel.
 *
 * On mount (desktop only) it takes a sampling lease, backfills the rolling
 * window from the sample ring, then subscribes to live `perf://sample` frames.
 * On unmount it releases the lease — the backend loop stops once every
 * consumer has, so there is no sampling overhead while nothing is watching.
 * "Pause" freezes the UI (stops appending) without stopping the backend,
 * matching Task Manager's behavior.
 *
 * The rolling window is index-keyed, so every path that could mix sampling
 * cadences in it (backfill, pause/resume, a cadence change) is funnelled
 * through {@link trailingSameCadence} or clears the window outright.
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

/**
 * Cadence the user last picked, remembered for the session.
 *
 * Module-scoped on purpose: leaving `/performance` unmounts the hook entirely,
 * so a `useRef` would hand the next visit the default again and silently undo
 * the choice. The backend also retains its interval, but the mount path has to
 * pass one to `perfStartSampling`, so the preference has to live here.
 */
let preferredIntervalMs = DEFAULT_PERF_INTERVAL

/** Reset the remembered cadence. Test seam. */
export function resetPreferredInterval(): void {
  preferredIntervalMs = DEFAULT_PERF_INTERVAL
}

/**
 * Trailing run of samples that share `intervalMs`.
 *
 * The rolling graphs are keyed by array index, not by time, so mixing cadences
 * in one window silently distorts every chart — a 4 s stretch and a 500 ms
 * stretch occupy the same horizontal space. The backend ring spans cadence
 * changes, so anything backfilled from it has to be cut back to the newest
 * contiguous run at the current cadence.
 */
export function trailingSameCadence(samples: PerfSample[], intervalMs: number): PerfSample[] {
  let start = samples.length
  while (start > 0 && samples[start - 1].intervalMs === intervalMs) start--
  return samples.slice(start)
}

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
  const [intervalMs, setIntervalState] = useState<number>(preferredIntervalMs)

  const pausedRef = useRef(false)

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
    // Effect-local, NOT a ref: under StrictMode / a fast remount the second
    // effect would reset a shared ref before the first effect's async
    // continuation reads it, so effect #1 would subscribe into a closure whose
    // cleanup had already run — leaking the listener for the page's lifetime.
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    const ms = preferredIntervalMs
    void (async () => {
      await perfStartSampling(ms)
      const snapshot = await perfSnapshot()
      if (cancelled) return
      const backfill = trailingSameCadence(snapshot.samples, ms)
      if (backfill.length > 0) setHistory(backfill.slice(-PERF_HISTORY_LIMIT))
      const off = subscribePerfSample(append)
      // The cleanup may have run during either await above; it can only clear
      // the flag, so re-check and unsubscribe here instead of leaking.
      if (cancelled) off()
      else unsubscribe = off
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
      void perfStopSampling()
    }
  }, [available, append])

  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next
    setPausedState(next)
    if (next) return
    // The backend kept sampling through the pause, so resume by refilling from
    // the ring rather than appending live frames onto a window with a hole in
    // it — an index-keyed graph would splice across the gap with no cue.
    void perfSnapshot()
      .then((snapshot) => {
        if (pausedRef.current) return
        const refill = trailingSameCadence(snapshot.samples, preferredIntervalMs)
        if (refill.length > 0) setHistory(refill.slice(-PERF_HISTORY_LIMIT))
      })
      .catch(() => {})
  }, [])

  const setIntervalMs = useCallback((ms: number) => {
    preferredIntervalMs = ms
    setIntervalState(ms)
    // Samples at the old cadence can't share an index-keyed axis with the new
    // ones; drop the window and let it refill at the new rate.
    setHistory([])
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
