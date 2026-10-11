/**
 * The newest island projection, readable by other main-window code.
 *
 * `IslandInitializer` is the only writer: it already projects the Fleet
 * snapshot and attention aggregation into `IslandState` for the island window.
 * The tray panel's Fleet summary (ADR-0225) reads the same projection through
 * here instead of running a second projection over the same inputs, so the
 * panel and the island can never disagree about what is running.
 */

import type { IslandState } from "./types"

let current: IslandState | null = null
const listeners = new Set<() => void>()

/** Publish a fresh projection. Called by `IslandInitializer` only. */
export function publishIslandProjection(state: IslandState | null): void {
  if (state === current) return
  current = state
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore` snapshot getter. */
export function getIslandProjection(): IslandState | null {
  return current
}

/** Server snapshot: there is no projection outside a running main window. */
export function getIslandProjectionServerSnapshot(): IslandState | null {
  return null
}

export function subscribeIslandProjection(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam. */
export function __resetIslandProjectionForTesting(): void {
  current = null
  listeners.clear()
}
