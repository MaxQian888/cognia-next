"use client"

/**
 * Transport-backed live fleet store — the companion-side sibling of the
 * Tauri-only `fleetStreamStore`. One refcounted `transport.subscribe` on
 * `fleet://update`, backfilled once via `fleet_get_snapshot`, with the same
 * `generatedAt` monotonic guard so a stale backfill never clobbers a newer
 * live event. Feeds the mobile / companion-browser fleet view through
 * `hooks/fleet/use-fleet-snapshot.ts`.
 */

import { transport } from "@/lib/tauri"
import { fleetRemoteGetSnapshot } from "@/lib/fleet/fleet-remote-actions"
import { EMPTY_FLEET_SNAPSHOT } from "@/lib/fleet/fleet-stream-store"
import { FLEET_UPDATE_EVENT, type FleetSnapshot } from "@/lib/fleet/types"

let snapshot: FleetSnapshot = EMPTY_FLEET_SNAPSHOT
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined
/** Bumped on every teardown so in-flight backfill from a prior generation
 * detects it is stale. */
let generation = 0

const emit = () => {
  for (const fn of listeners) fn()
}

const applyIfNewer = (next: FleetSnapshot) => {
  // Monotonic guard: identical to fleet-stream-store's applyBackfill.
  if (next.generatedAt < snapshot.generatedAt) return
  if (Object.is(next, snapshot)) return
  snapshot = next
  emit()
}

const attach = () => {
  const gen = generation
  // Subscribe to live updates FIRST (no gap where an update could be missed),
  // then backfill. `transport.subscribe` returns synchronously, so no stale
  // guard is needed here; the guards below cover a detach that races the async
  // handler / backfill of a superseded generation.
  unsubscribe = transport.subscribe<FleetSnapshot>(FLEET_UPDATE_EVENT, (payload) => {
    if (gen !== generation) return
    applyIfNewer(payload)
  })
  void fleetRemoteGetSnapshot().then((fetched) => {
    if (gen !== generation) return
    applyIfNewer(fetched)
  })
}

const detach = () => {
  generation += 1
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = undefined
  }
}

export interface FleetRemoteStore {
  subscribe(onChange: () => void): () => void
  getSnapshot(): FleetSnapshot
  getServerSnapshot(): FleetSnapshot
  resetForTests(): void
}

export const fleetRemoteStore: FleetRemoteStore = {
  subscribe(onChange: () => void): () => void {
    const cold = listeners.size === 0
    listeners.add(onChange)
    if (cold) attach()
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(onChange)
      if (listeners.size === 0) detach()
    }
  },
  getSnapshot(): FleetSnapshot {
    return snapshot
  },
  getServerSnapshot(): FleetSnapshot {
    return EMPTY_FLEET_SNAPSHOT
  },
  resetForTests(): void {
    listeners.clear()
    detach()
    snapshot = EMPTY_FLEET_SNAPSHOT
  },
}
