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
 *
 * It never renders inside the Capacitor mobile shell: the floating panel is a
 * desktop / web affordance only, so the mobile runtime is excluded ahead of
 * both the dev auto-mount and the production opt-in flag.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { PERF_NAMESPACE } from "./perf-marker"
import { getRendererPerformanceCollector } from "./renderer-collector"
import { detectNativePlatform } from "@/lib/capacitor/_shared"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

const HUD_LOCALSTORAGE_KEY = "cogniaPerfHud"
const MAX_ENTRIES_PER_NAME = 60
const RAF_FPS_SAMPLE_WINDOW_MS = 1000

interface Entry {
  duration: number
  startTime: number
}

interface StoreShape {
  byName: ReadonlyMap<string, Entry[]>
  subscribers: Set<() => void>
}

const rendererCollector = getRendererPerformanceCollector()

// The HUD is a subscriber of the shared per-document collector.
const perfStore: StoreShape = {
  // No cast: `Entry` is a structural subset of the collector's entry type, and
  // the map is genuinely read-only from here — clearing goes through
  // `rendererCollector.clearMeasurements()`.
  byName: rendererCollector.getMeasurements(),
  subscribers: new Set(),
}

let snapshotVersion = 0

// In-session dismissal triggered by the HUD's × button. The localStorage flag
// persists the choice across reloads in production, but in dev
// `isHudEnabledForRuntime()` always returns true, so this module flag is what
// actually hides the panel — and lets us drop the page reload the close button
// used to do.
let dismissed = false
const enabledSubscribers = new Set<() => void>()

function notifyEnabledChange(): void {
  for (const sub of enabledSubscribers) sub()
}

/**
 * Test seam for feeding the same shared collector used in production. Global
 * Performance entries remain intact for DevTools and other observers.
 */
function drainEntries(
  entries: ArrayLike<{ name: string; duration: number; startTime: number }>
): boolean {
  return rendererCollector.ingestPerformanceEntries(entries as ArrayLike<PerformanceEntry>)
}

function subscribe(cb: () => void): () => void {
  perfStore.subscribers.add(cb)
  const demandId = rendererCollector.openDemand({ purpose: "live", cadenceMs: 1000 })
  const unsubscribeFrames = rendererCollector.subscribe(() => {
    snapshotVersion++
    cb()
  })
  return () => {
    perfStore.subscribers.delete(cb)
    unsubscribeFrames()
    rendererCollector.closeDemand(demandId)
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
  // The perf HUD is a desktop / web debugging affordance. Exclude the
  // Capacitor mobile shell first — before the dev-mode short-circuit and the
  // production flag — so it never auto-mounts on device and can't be flipped
  // on there via localStorage either. `detectNativePlatform()` returns "web"
  // when `window` is undefined (SSR), so this is safe to call unconditionally.
  if (detectNativePlatform() === "mobile") return false
  if (dismissed) return false
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

function aggregate(byName: ReadonlyMap<string, Entry[]>): AggregateStat[] {
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

// The HUD flips on/off from two sources: the in-session × button (via
// `notifyEnabledChange`) and cross-tab `storage` events. Subscribing via
// useSyncExternalStore keeps React's hydration reconciliation correct without a
// `setState`-in-effect pattern (lint rule react-hooks/set-state-in-effect).
function subscribeEnabled(notify: () => void): () => void {
  enabledSubscribers.add(notify)
  if (typeof window === "undefined") {
    return () => {
      enabledSubscribers.delete(notify)
    }
  }
  const handler = (e: StorageEvent) => {
    if (e.key !== HUD_LOCALSTORAGE_KEY) return
    // A cross-tab re-enable clears an in-session dismissal so the panel can
    // return without a reload.
    if (e.newValue === "1") dismissed = false
    notify()
  }
  window.addEventListener("storage", handler)
  return () => {
    enabledSubscribers.delete(notify)
    window.removeEventListener("storage", handler)
  }
}

export function PerfHud(): ReactNode {
  const enabled = useSyncExternalStore(
    subscribeEnabled,
    () => isHudEnabledForRuntime(),
    () => false
  )
  if (!enabled) return null
  return <PerfHudInner />
}

function PerfHudInner() {
  const t = useTranslations("performance.hud")
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
    // Hide the panel in-place. Setting the module flag + notifying subscribers
    // re-evaluates `isHudEnabledForRuntime()` to false so React unmounts the
    // HUD — no full page reload. The localStorage write persists the choice
    // across reloads in production.
    dismissed = true
    try {
      window.localStorage.setItem(HUD_LOCALSTORAGE_KEY, "0")
    } catch {
      // ignore
    }
    notifyEnabledChange()
  }

  const clearEntries = () => {
    rendererCollector.clearMeasurements()
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
          {t("title")} <span className="text-muted-foreground">· {t("fps", { value: fps })}</span>
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={clearEntries}
            aria-label={t("clearLabel")}
            data-testid="perf-hud-clear"
          >
            {t("clear")}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={disable}
            aria-label={t("disable")}
            data-testid="perf-hud-disable"
          >
            ×
          </button>
        </div>
      </div>
      {stats.length === 0 ? (
        <p className="py-2 text-center text-muted-foreground" data-testid="perf-hud-empty">
          {t("waiting")}
        </p>
      ) : (
        <table className="w-full border-separate border-spacing-x-2">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left">{t("columns.name")}</th>
              <th className="text-right">{t("columns.count")}</th>
              <th className="text-right">{t("columns.p50")}</th>
              <th className="text-right">{t("columns.p95")}</th>
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
  drainEntries,
  HUD_LOCALSTORAGE_KEY,
  MAX_ENTRIES_PER_NAME,
  peek: (name: string): Entry[] => (perfStore.byName.get(name) ?? []).slice(),
  reset: () => {
    rendererCollector.clearMeasurements()
    perfStore.subscribers.clear()
    snapshotVersion = 0
    dismissed = false
    enabledSubscribers.clear()
  },
  ingest: (name: string, duration: number) => {
    rendererCollector.ingestPerformanceEntries([
      { name, duration, startTime: 0, entryType: "measure" } as PerformanceEntry,
    ])
    snapshotVersion++
    for (const sub of perfStore.subscribers) sub()
  },
}
