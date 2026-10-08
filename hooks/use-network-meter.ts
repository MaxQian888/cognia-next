"use client"

/**
 * Live network speed + latency for the desktop status bar (`lib/network/
 * net-meter.ts` explains what is measured and against what).
 *
 * Cadence: interface counters every {@link THROUGHPUT_INTERVAL_MS} (a handful
 * of syscalls), a latency probe every {@link LATENCY_INTERVAL_MS} (one `HEAD`
 * on a kept-alive connection). Both stop while the window is hidden — a
 * readout nobody can see is not worth a request a quarter-minute — and the
 * first read after it comes back starts a fresh rate baseline instead of
 * averaging over the whole time away.
 *
 * Only runs inside the Tauri shell (`enabled` is the caller's platform
 * check); in a browser the commands do not exist and `available` stays false.
 */

import { useEffect, useMemo, useRef, useState } from "react"

import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import {
  computeThroughput,
  probeLatency,
  readNetworkCounters,
  resolveLatencyTarget,
  type InterfaceCounters,
  type LatencySample,
  type LatencyTarget,
  type NetworkCounters,
  type Throughput,
} from "@/lib/network/net-meter"
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { loggers } from "@cognia/logging"

const log = loggers.ui.child("network-meter")

export const THROUGHPUT_INTERVAL_MS = 2_000
export const LATENCY_INTERVAL_MS = 15_000
/** One minute of throughput at the default cadence. */
export const THROUGHPUT_HISTORY = 30
/** Five minutes of latency at the default cadence. */
export const LATENCY_HISTORY = 20

export interface NetworkMeter {
  /** True once the first counter read succeeded. */
  available: boolean
  /** Latest rate, `null` until two reads exist. */
  throughput: Throughput | null
  /** Oldest → newest; `null` marks an interval with no honest rate. */
  rxHistory: (number | null)[]
  txHistory: (number | null)[]
  /** Counted interfaces from the latest read, busiest first. */
  interfaces: InterfaceCounters[]
  /** Where latency is measured to, or `null` when there is nowhere to go. */
  target: LatencyTarget | null
  latency: LatencySample | null
  /** Oldest → newest probes against the current target. */
  latencyHistory: LatencySample[]
}

function pushBounded<T>(list: readonly T[], item: T, cap: number): T[] {
  const next = [...list, item]
  return next.length > cap ? next.slice(next.length - cap) : next
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden"
  )
  useEffect(() => {
    if (typeof document === "undefined") return
    const onChange = () => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [])
  return visible
}

export function useNetworkMeter({ enabled }: { enabled: boolean }): NetworkMeter {
  const visible = useDocumentVisible()
  const active = enabled && visible

  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const signalingUrl = useSettingsStore((s) => s.settings?.signalingUrl)
  const target = useMemo(
    () =>
      resolveLatencyTarget({
        provider: resolveStandaloneProvider({ defaultProvider, providerSettings, customProviders }),
        signalingUrl: signalingUrl?.trim() || DEFAULT_SIGNALING_URL,
      }),
    [defaultProvider, providerSettings, customProviders, signalingUrl]
  )
  const targetUrl = target?.url ?? null

  const [available, setAvailable] = useState(false)
  const [rxHistory, setRxHistory] = useState<(number | null)[]>([])
  const [txHistory, setTxHistory] = useState<(number | null)[]>([])
  const [throughput, setThroughput] = useState<Throughput | null>(null)
  const [interfaces, setInterfaces] = useState<InterfaceCounters[]>([])
  const [latencyState, setLatencyState] = useState<{
    url: string | null
    history: LatencySample[]
  }>({ url: null, history: [] })

  const lastCounters = useRef<NetworkCounters | null>(null)

  useEffect(() => {
    if (!active) {
      // Coming back must not average over the time away.
      lastCounters.current = null
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const next = await readNetworkCounters()
        if (cancelled) return
        const prev = lastCounters.current
        lastCounters.current = next
        setAvailable(true)
        setInterfaces(next.interfaces)
        if (!prev) return
        const rate = computeThroughput(prev, next)
        setThroughput(rate)
        setRxHistory((h) => pushBounded(h, rate?.rxBps ?? null, THROUGHPUT_HISTORY))
        setTxHistory((h) => pushBounded(h, rate?.txBps ?? null, THROUGHPUT_HISTORY))
      } catch (error) {
        if (cancelled) return
        log.warn("interface counter read failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), THROUGHPUT_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active])

  useEffect(() => {
    if (!active || !targetUrl) return
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      // A probe slower than the cadence must not stack a second one on top.
      if (inFlight) return
      inFlight = true
      try {
        const sample = await probeLatency(targetUrl)
        if (cancelled) return
        setLatencyState((state) => ({
          url: targetUrl,
          history: pushBounded(
            state.url === targetUrl ? state.history : [],
            sample,
            LATENCY_HISTORY
          ),
        }))
      } catch (error) {
        if (cancelled) return
        log.warn("latency probe failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), LATENCY_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, targetUrl])

  // Probes against a previous target describe a different hop.
  const latencyHistory = latencyState.url === targetUrl ? latencyState.history : []

  return {
    available,
    throughput,
    rxHistory,
    txHistory,
    interfaces,
    target,
    latency: latencyHistory.at(-1) ?? null,
    latencyHistory,
  }
}
