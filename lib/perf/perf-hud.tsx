"use client"

/**
 * `<PerfHud>` — dev / opt-in production floating panel that subscribes to
 * `workflow-ai:*` PerformanceObserver entries and aggregates them into a
 * p50 / p95 table. Off by default in production; flip on via:
 *
 *   localStorage.cogniaPerfHud = "1"
 *   location.reload()
 *
 * The HUD does no work at all when off — it returns `null` before any
 * subscription or PerformanceObserver instantiation. In dev (`NODE_ENV !==
 * "production"`) it auto-mounts so engineers see metrics without flipping
 * the flag.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { PERF_NAMESPACE } from "./perf-marker"
import { cn } from "@/lib/utils"

const HUD_LOCALSTORAGE_KEY = "cogniaPerfHud"
const MAX_ENTRIES_PER_NAME = 60
const RAF_FPS_SAMPLE_WINDOW_MS = 1000

interface Entry {
  duration: number
  startTime: number
}

interface StoreShape {
  byName: Map<string, Entry[]>
  observer: PerformanceObserver | null
  subscribers: Set<() => void>
  started: boolean
}

// Module-singleton so the HUD doesn't lose history when remounted.
const perfStore: StoreShape = {
  byName: new Map(),
  observer: null,
  subscribers: new Set(),
  started: false,
}

let snapshotVersion = 0

function startObserver(): void {
  if (perfStore.started) return
  if (typeof PerformanceObserver === "undefined") return
  perfStore.started = true
  perfStore.observer = new PerformanceObserver((list) => {
    let mutated = false
    for (const entry of list.getEntries()) {
      if (!entry.name.startsWith(PERF_NAMESPACE)) continue
      const slot = perfStore.byName.get(entry.name) ?? []
      slot.push({ duration: entry.duration, startTime: entry.startTime })
      if (slot.length > MAX_ENTRIES_PER_NAME) slot.shift()
      perfStore.byName.set(entry.name, slot)
      mutated = true
    }
    if (mutated) {
      snapshotVersion++
      for (const sub of perfStore.subscribers) sub()
    }
  })
  try {
    perfStore.observer.observe({ entryTypes: ["measure"] })
  } catch {
    perfStore.started = false
    perfStore.observer = null
  }
}

function subscribe(cb: () => void): () => void {
  startObserver()
  perfStore.subscribers.add(cb)
  return () => {
    perfStore.subscribers.delete(cb)
  }
}

function getSnapshot(): number {
  return snapshotVersion
}

function getServerSnapshot(): number {
  return 0
}

// globalThis-prefixed access defeats Next.js / SWC compile-time inlining of
// `process.env.NODE_ENV`, so tests can toggle the runtime env without rebuilding.
function getNodeEnv(): string {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
  return env?.NODE_ENV ?? ""
}

function isHudEnabledForRuntime(): boolean {
  if (getNodeEnv() !== "production") return true
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(HUD_LOCALSTORAGE_KEY) === "1"
  } catch {
    return false
  }
}

interface AggregateStat {
  displayName: string
  count: number
  p50: number
  p95: number
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p))
  return sortedAsc[idx]
}

function aggregate(byName: Map<string, Entry[]>): AggregateStat[] {
  const stats: AggregateStat[] = []
  for (const [name, entries] of byName) {
    if (entries.length === 0) continue
    const sorted = entries.map((e) => e.duration).sort((a, b) => a - b)
    stats.push({
      displayName: name.slice(PERF_NAMESPACE.length),
      count: entries.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
    })
  }
  return stats.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

// Cross-tab storage events also flip the HUD on/off. Subscribing via
// useSyncExternalStore keeps React's hydration reconciliation correct
// without a `setState`-in-effect pattern (lint rule react-hooks/set-state-in-effect).
function subscribeStorageEvent(notify: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const handler = (e: StorageEvent) => {
    if (e.key === HUD_LOCALSTORAGE_KEY) notify()
  }
  window.addEventListener("storage", handler)
  return () => window.removeEventListener("storage", handler)
}

export function PerfHud(): ReactNode {
  const enabled = useSyncExternalStore(
    subscribeStorageEvent,
    () => isHudEnabledForRuntime(),
    () => false
  )
  if (!enabled) return null
  return <PerfHudInner />
}

function PerfHudInner() {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [fps, setFps] = useState(0)

  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return
    let frames = 0
    let last = performance.now()
    let raf = 0
    const tick = () => {
      frames++
      const now = performance.now()
      if (now - last >= RAF_FPS_SAMPLE_WINDOW_MS) {
        setFps(Math.round((frames * 1000) / (now - last)))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const stats = aggregate(perfStore.byName)

  const disable = () => {
    try {
      window.localStorage.setItem(HUD_LOCALSTORAGE_KEY, "0")
    } catch {
      // ignore
    }
    window.location.reload()
  }

  const clearEntries = () => {
    perfStore.byName.clear()
    snapshotVersion++
    for (const sub of perfStore.subscribers) sub()
  }

  return (
    <div
      data-testid="perf-hud"
      className={cn(
        "fixed bottom-2 right-2 z-[9999] max-w-sm rounded-md border border-border",
        "bg-card/95 p-2 font-mono text-[10px] text-card-foreground shadow-lg backdrop-blur"
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">
          Perf HUD <span className="text-muted-foreground">· {fps} fps</span>
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={clearEntries}
            aria-label="Clear HUD entries"
            data-testid="perf-hud-clear"
          >
            clear
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={disable}
            aria-label="Disable HUD"
            data-testid="perf-hud-disable"
          >
            ×
          </button>
        </div>
      </div>
      {stats.length === 0 ? (
        <p className="py-2 text-center text-muted-foreground" data-testid="perf-hud-empty">
          waiting for entries…
        </p>
      ) : (
        <table className="w-full border-separate border-spacing-x-2">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left">name</th>
              <th className="text-right">n</th>
              <th className="text-right">p50</th>
              <th className="text-right">p95</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.displayName} data-testid={`perf-hud-row-${s.displayName}`}>
                <td className="truncate" title={s.displayName}>
                  {s.displayName}
                </td>
                <td className="text-right">{s.count}</td>
                <td className="text-right">{s.p50.toFixed(1)}</td>
                <td className="text-right">{s.p95.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// Test-only exports for the helpers — kept out of the public API so the
// HUD's internals aren't load-bearing for non-test callers.
export const __test__ = {
  isHudEnabledForRuntime,
  aggregate,
  percentile,
  HUD_LOCALSTORAGE_KEY,
  reset: () => {
    perfStore.byName.clear()
    perfStore.observer?.disconnect()
    perfStore.observer = null
    perfStore.started = false
    perfStore.subscribers.clear()
    snapshotVersion = 0
  },
  ingest: (name: string, duration: number) => {
    const slot = perfStore.byName.get(name) ?? []
    slot.push({ duration, startTime: 0 })
    perfStore.byName.set(name, slot)
    snapshotVersion++
    for (const sub of perfStore.subscribers) sub()
  },
}
