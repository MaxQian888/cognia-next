"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  PerfConnectionState,
  PerfFrame,
  PerfGap,
  PerfSample,
  PerfSourceDescriptor,
} from "@/lib/perf/backend/types"
import {
  getPerfHostLiveLease,
  type PerfHostIssue,
  type PerfHostLeaseSubscription,
  type PerfHostLeaseView,
} from "@/lib/perf/host-live-lease"
import { getRendererPerformanceCollector } from "@/lib/perf/renderer-collector"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

export const PERF_HISTORY_LIMIT = 120
export const PERF_INTERVAL_OPTIONS = [500, 1000, 2000, 4000] as const
export const DEFAULT_PERF_INTERVAL = 1000

let preferredIntervalMs = DEFAULT_PERF_INTERVAL

export function resetPreferredInterval(): void {
  preferredIntervalMs = DEFAULT_PERF_INTERVAL
}

export function trailingSameCadence(samples: PerfSample[], intervalMs: number): PerfSample[] {
  let start = samples.length
  while (start > 0 && samples[start - 1].intervalMs === intervalMs) start--
  return samples.slice(start)
}

function appendBounded(previous: PerfFrame[], frame: PerfFrame): PerfFrame[] {
  const existing = previous.findIndex(
    (item) =>
      item.hostInstanceId === frame.hostInstanceId &&
      item.samplingSessionId === frame.samplingSessionId &&
      item.sequence === frame.sequence
  )
  if (existing >= 0) return previous
  const next = [...previous, frame].sort((left, right) => left.wallEndMs - right.wallEndMs)
  return next.slice(-PERF_HISTORY_LIMIT)
}

const INITIAL_HOST_VIEW: PerfHostLeaseView = {
  state: "connecting",
  issue: null,
  source: null,
  frames: [],
  gaps: [],
}

export interface UsePerfStreamResult {
  history: PerfFrame[]
  latest: PerfFrame | null
  rendererHistory: PerfFrame[]
  hostHistory: PerfFrame[]
  sources: PerfSourceDescriptor[]
  gaps: PerfGap[]
  available: boolean
  hostState: PerfConnectionState
  /** Raw host wording of {@link hostIssue}, for logs and exports. */
  error: string | null
  /** Why the host lease is not live, typed so the panel can localize it. */
  hostIssue: PerfHostIssue | null
  paused: boolean
  intervalMs: number
  setPaused: (paused: boolean) => void
  setIntervalMs: (ms: number) => void
  reset: () => void
}

export function usePerfStream(): UsePerfStreamResult {
  const [rendererHistory, setRendererHistory] = useState<PerfFrame[]>([])
  const [hostView, setHostView] = useState<PerfHostLeaseView>(INITIAL_HOST_VIEW)
  const [paused, setPausedState] = useState(false)
  const [intervalMs, setIntervalState] = useState(preferredIntervalMs)
  const pausedRef = useRef(false)
  const hostSubscriptionRef = useRef<PerfHostLeaseSubscription | null>(null)

  const appendRenderer = useCallback((frame: PerfFrame) => {
    if (!pausedRef.current) setRendererHistory((previous) => appendBounded(previous, frame))
  }, [])

  useEffect(() => {
    const collector = getRendererPerformanceCollector()
    const scope = getActiveRuntimeTargetContext()
    collector.setScope({
      targetId: scope?.targetId ?? "web-standalone",
      routingGeneration: scope?.routingGeneration ?? 0,
    })
    const unsubscribe = collector.subscribe(appendRenderer)
    const demandId = collector.openDemand({ purpose: "live", cadenceMs: intervalMs })
    return () => {
      unsubscribe()
      collector.closeDemand(demandId)
    }
  }, [appendRenderer, intervalMs])

  // Host frames come through the renderer's ONE shared lease. Every consumer
  // opening its own was how the status-bar segment and this page refused each
  // other with `device-purpose-limit`.
  useEffect(() => {
    const subscription = getPerfHostLiveLease().subscribe({
      cadenceMs: intervalMs,
      onChange: (view) =>
        setHostView((previous) =>
          // Paused freezes the graphs, not the connection state.
          pausedRef.current ? { ...view, frames: previous.frames, gaps: previous.gaps } : view
        ),
    })
    hostSubscriptionRef.current = subscription
    return () => {
      if (hostSubscriptionRef.current === subscription) hostSubscriptionRef.current = null
      subscription.unsubscribe()
    }
  }, [intervalMs])

  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next
    setPausedState(next)
  }, [])

  const setIntervalMs = useCallback((next: number) => {
    preferredIntervalMs = next
    setIntervalState(next)
    setRendererHistory([])
    setHostView((previous) => ({ ...previous, state: "connecting", frames: [], gaps: [] }))
  }, [])

  const reset = useCallback(() => {
    // A panel reset establishes a new local visual baseline. Process-wide span
    // registries remain cumulative and captures keep their own baselines.
    setRendererHistory([])
    hostSubscriptionRef.current?.resetHistory()
  }, [])

  const hostHistory = hostView.frames
  const sources = useMemo(
    () => [getRendererPerformanceCollector().source, ...(hostView.source ? [hostView.source] : [])],
    [hostView.source]
  )
  const history = hostHistory.length > 0 ? hostHistory : rendererHistory
  const latest = history.at(-1) ?? null

  return useMemo(
    () => ({
      history,
      latest,
      rendererHistory,
      hostHistory,
      sources,
      gaps: hostView.gaps,
      available: true,
      hostState: hostView.state,
      error: hostView.issue?.detail ?? null,
      hostIssue: hostView.issue,
      paused,
      intervalMs,
      setPaused,
      setIntervalMs,
      reset,
    }),
    [
      history,
      latest,
      rendererHistory,
      hostHistory,
      sources,
      hostView.gaps,
      hostView.state,
      hostView.issue,
      paused,
      intervalMs,
      setPaused,
      setIntervalMs,
      reset,
    ]
  )
}
