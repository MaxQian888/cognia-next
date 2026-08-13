"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  perfCloseLease,
  perfLeaseSnapshot,
  perfOpenLease,
  perfRenewLease,
  subscribePerfFrame,
} from "@/lib/perf/backend/commands"
import type {
  PerfConnectionState,
  PerfFrame,
  PerfGap,
  PerfSample,
  PerfSourceDescriptor,
} from "@/lib/perf/backend/types"
import { mergePerfFrames } from "@/lib/perf/frame-merge"
import { getRendererPerformanceCollector } from "@/lib/perf/renderer-collector"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

export const PERF_HISTORY_LIMIT = 120
export const PERF_INTERVAL_OPTIONS = [500, 1000, 2000, 4000] as const
export const DEFAULT_PERF_INTERVAL = 1000
const LEASE_HEARTBEAT_MS = 5000

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

export interface UsePerfStreamResult {
  history: PerfFrame[]
  latest: PerfFrame | null
  rendererHistory: PerfFrame[]
  hostHistory: PerfFrame[]
  sources: PerfSourceDescriptor[]
  gaps: PerfGap[]
  available: boolean
  hostState: PerfConnectionState
  error: string | null
  paused: boolean
  intervalMs: number
  setPaused: (paused: boolean) => void
  setIntervalMs: (ms: number) => void
  reset: () => void
}

export function usePerfStream(): UsePerfStreamResult {
  const [rendererHistory, setRendererHistory] = useState<PerfFrame[]>([])
  const [hostHistory, setHostHistory] = useState<PerfFrame[]>([])
  const [sources, setSources] = useState<PerfSourceDescriptor[]>(() => [
    getRendererPerformanceCollector().source,
  ])
  const [gaps, setGaps] = useState<PerfGap[]>([])
  const [hostState, setHostState] = useState<PerfConnectionState>("connecting")
  const [error, setError] = useState<string | null>(null)
  const [paused, setPausedState] = useState(false)
  const [intervalMs, setIntervalState] = useState(preferredIntervalMs)
  const pausedRef = useRef(false)

  const appendRenderer = useCallback((frame: PerfFrame) => {
    if (!pausedRef.current) setRendererHistory((previous) => appendBounded(previous, frame))
  }, [])
  const appendHost = useCallback((frame: PerfFrame) => {
    if (!pausedRef.current) setHostHistory((previous) => appendBounded(previous, frame))
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

  useEffect(() => {
    const scope = getActiveRuntimeTargetContext()
    const targetId = scope?.targetId ?? "web-standalone"
    const routingGeneration = scope?.routingGeneration ?? 0
    const collector = getRendererPerformanceCollector()
    let cancelled = false
    let leaseId: string | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    const buffered: PerfFrame[] = []

    // Subscribe before opening or snapshotting so no early frame can be lost.
    const unsubscribe = subscribePerfFrame((frame) => {
      if (frame.targetId !== targetId || frame.routingGeneration !== routingGeneration) return
      if (!leaseId) buffered.push(frame)
      else if (!frame.leaseId || frame.leaseId === leaseId) appendHost(frame)
    })

    void (async () => {
      try {
        const result = await perfOpenLease({
          clientId: collector.source.sourceId,
          deviceId: collector.source.hostInstanceId,
          targetId,
          routingGeneration,
          purpose: "live",
          requestedCadenceMs: intervalMs,
          sourceId: collector.source.sourceId,
        })
        if (!result.accepted) {
          if (!cancelled) {
            setHostState(result.code === "unsupported" ? "unsupported" : "error")
            setError(`${result.code}: ${result.detail}`)
          }
          return
        }
        leaseId = result.lease.leaseId
        if (cancelled) {
          await perfCloseLease(leaseId)
          return
        }
        setSources((current) => [
          ...current.filter((source) => source.kind !== "host"),
          result.source,
        ])
        const snapshot = await perfLeaseSnapshot(leaseId)
        if (cancelled) return
        const merged = mergePerfFrames(
          snapshot,
          buffered.filter((frame) => !frame.leaseId || frame.leaseId === leaseId),
          { targetId, routingGeneration }
        )
        setHostHistory(merged.frames.slice(-PERF_HISTORY_LIMIT))
        setGaps(merged.gaps)
        setHostState("live")
        setError(null)
        heartbeat = setInterval(() => {
          if (!leaseId) return
          void perfRenewLease(leaseId).catch((renewError: unknown) => {
            if (cancelled) return
            setHostState("stale")
            setError(renewError instanceof Error ? renewError.message : String(renewError))
          })
        }, LEASE_HEARTBEAT_MS)
      } catch (openError) {
        if (cancelled) return
        setHostState("unsupported")
        setError(openError instanceof Error ? openError.message : String(openError))
      }
    })()

    return () => {
      cancelled = true
      unsubscribe()
      if (heartbeat) clearInterval(heartbeat)
      if (leaseId) void perfCloseLease(leaseId)
    }
  }, [appendHost, intervalMs])

  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next
    setPausedState(next)
  }, [])

  const setIntervalMs = useCallback((next: number) => {
    preferredIntervalMs = next
    setIntervalState(next)
    setRendererHistory([])
    setHostHistory([])
    setGaps([])
    setHostState("connecting")
  }, [])

  const reset = useCallback(() => {
    // A panel reset establishes a new local visual baseline. Process-wide span
    // registries remain cumulative and captures keep their own baselines.
    setRendererHistory([])
    setHostHistory([])
    setGaps([])
  }, [])

  const history = hostHistory.length > 0 ? hostHistory : rendererHistory
  const latest = history.at(-1) ?? null

  return useMemo(
    () => ({
      history,
      latest,
      rendererHistory,
      hostHistory,
      sources,
      gaps,
      available: true,
      hostState,
      error,
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
      gaps,
      hostState,
      error,
      paused,
      intervalMs,
      setPaused,
      setIntervalMs,
      reset,
    ]
  )
}
