"use client"

/**
 * The one place that touches a platform screen lock.
 *
 * Two runtimes, one shape. On the desktop the hold belongs in Rust, where the
 * process-global assertion already lives (`src-tauri/src/power_assertion.rs`)
 * and where an OS-level display assertion is the only thing a webview cannot
 * fake. Everywhere else it is the browser's Screen Wake Lock API, which the
 * Capacitor WebView exposes as well.
 *
 * Callers hand over the WHOLE desired set of holders rather than acquiring and
 * releasing individually. A set is idempotent: a coordinator that re-runs on
 * every store tick can call this a hundred times a second and only the edges do
 * any work, and a reload cannot strand a hold that no live conversation claims.
 */

import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/platform/detect"

/**
 * The browser lock is released by the user agent whenever the page is hidden,
 * and is NOT restored on return. Without re-requesting on the visibility edge,
 * the first alt-tab silently ends the hold for the rest of the turn.
 */
type Sentinel = { released: boolean; release: () => Promise<void> }

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<Sentinel> }
}

let held = new Set<string>()
let sentinel: Sentinel | null = null
let visibilityBound = false
/**
 * Whether this page has told the platform anything yet.
 *
 * The first sync always talks, even when it has nothing to ask for. A reload
 * in the middle of a run leaves the desktop holding a set no live conversation
 * claims, and the empty first sync is what clears it.
 */
let primed = false
/** Serializes request/release so a burst of edges cannot interleave. */
let queue: Promise<void> = Promise.resolve()

function wakeLockApi(): WakeLockNavigator["wakeLock"] | undefined {
  if (typeof navigator === "undefined") return undefined
  return (navigator as WakeLockNavigator).wakeLock
}

/**
 * Whether this runtime can hold the screen at all. False in a browser that
 * predates the Screen Wake Lock API, which the settings UI says out loud
 * instead of offering a switch that does nothing.
 */
export function isScreenHoldAvailable(): boolean {
  return isTauri() || typeof wakeLockApi()?.request === "function"
}

/** The holders currently held. Sorted. Exported for the UI readout and tests. */
export function screenWakeHolders(): string[] {
  return [...held].sort()
}

async function applyDesktop(next: Set<string>): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core")
  // The whole set, not the edges. Rust holds what this page last said and
  // nothing else, so a reload cannot strand a hold nobody claims.
  await invoke("power_screen_holds_set", { holders: [...next].sort() })
}

async function applyBrowser(next: Set<string>): Promise<void> {
  const api = wakeLockApi()
  if (!api) return
  if (next.size > 0) {
    if (sentinel && !sentinel.released) return
    // `request` rejects on a hidden page. That is not a failure worth shouting
    // about: the visibility listener re-requests the moment the page is back.
    sentinel = await api.request("screen")
    return
  }
  const current = sentinel
  sentinel = null
  if (current && !current.released) await current.release()
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return
  visibilityBound = true
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    if (held.size === 0) return
    if (sentinel && !sentinel.released) return
    // Re-take what the user agent dropped while the page was hidden.
    queue = queue.then(() => applyBrowser(held)).catch(() => undefined)
  })
}

/**
 * Make the platform hold exactly `holders`. Safe to call with the same set
 * repeatedly, and safe to call with an empty set to drop everything.
 */
export async function syncScreenWakeHolders(holders: readonly string[]): Promise<void> {
  const next = new Set(holders)
  const run = queue.then(async () => {
    const unchanged = primed && next.size === held.size && [...next].every((id) => held.has(id))
    if (unchanged && (next.size === 0 || isTauri() || (sentinel && !sentinel.released))) return
    try {
      if (isTauri()) await applyDesktop(next)
      else await applyBrowser(next)
      // Only commit after the platform agreed. Recording the set first would
      // make a failed acquire look held, and the next sync would skip it.
      held = next
      primed = true
      if (next.size > 0) bindVisibility()
    } catch (error) {
      loggers.app.warn("screen wake lock sync failed", {
        error: error instanceof Error ? error.message : String(error),
        holders: [...next],
      })
    }
  })
  queue = run.catch(() => undefined)
  return run
}

/** Drop every hold. Used by the coordinator on unmount. */
export async function releaseAllScreenWakeHolders(): Promise<void> {
  await syncScreenWakeHolders([])
}

/** @internal test seam. Clears module state without touching the platform. */
export function __resetScreenWakeLockForTests(): void {
  held = new Set()
  sentinel = null
  visibilityBound = false
  primed = false
  queue = Promise.resolve()
}
