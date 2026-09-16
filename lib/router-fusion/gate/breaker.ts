/**
 * Per-surface runtime breaker (ADR-0188 D38).
 *
 * Counts CONSECUTIVE infrastructure faults per surface. Crossing the threshold
 * trips the surface: from then on the gate answers "tripped" and the surface
 * runs its original path until the user re-arms it. A success resets the count.
 * Refusals never reach this module (see `faults.ts`).
 *
 * State lives in memory so the send path can read it synchronously. The trip is
 * ALSO persisted into `AppSettings.routerFusion.trippedSurfaces` by
 * `breaker-persistence` (a listener registered at boot), so a restart does not
 * quietly re-arm a surface that kept failing; `hydrateBreakerTrips` loads it back.
 */

import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

export interface SurfaceTripState {
  trippedAt: number
  reason: string
}

export interface BreakerSnapshot {
  surface: RouterFusionSurface
  consecutiveFaults: number
  lastFault: { code: string; at: number } | null
  trip: SurfaceTripState | null
}

export type BreakerEvent =
  | { type: "fault"; surface: RouterFusionSurface; code: string; consecutiveFaults: number }
  | { type: "tripped"; surface: RouterFusionSurface; trip: SurfaceTripState }
  | { type: "rearmed"; surface: RouterFusionSurface }

interface SurfaceState {
  consecutiveFaults: number
  lastFault: { code: string; at: number } | null
  trip: SurfaceTripState | null
}

const states = new Map<RouterFusionSurface, SurfaceState>()
const listeners = new Set<(event: BreakerEvent) => void>()

function stateFor(surface: RouterFusionSurface): SurfaceState {
  let state = states.get(surface)
  if (!state) {
    state = { consecutiveFaults: 0, lastFault: null, trip: null }
    states.set(surface, state)
  }
  return state
}

function publish(event: BreakerEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      // A broken listener (e.g. a failed settings write) must not turn a
      // fallback into a crash of the very send it is protecting.
      console.error("[router-fusion] breaker listener failed", error)
    }
  }
}

export interface FaultRecord {
  consecutiveFaults: number
  tripped: boolean
  justTripped: boolean
}

export function recordFusionFault(
  surface: RouterFusionSurface,
  code: string,
  threshold: number,
  now: number = Date.now()
): FaultRecord {
  const state = stateFor(surface)
  state.consecutiveFaults += 1
  state.lastFault = { code, at: now }
  publish({ type: "fault", surface, code, consecutiveFaults: state.consecutiveFaults })
  const limit = Number.isSafeInteger(threshold) && threshold >= 1 ? threshold : 1
  if (!state.trip && state.consecutiveFaults >= limit) {
    state.trip = { trippedAt: now, reason: code }
    publish({ type: "tripped", surface, trip: state.trip })
    return { consecutiveFaults: state.consecutiveFaults, tripped: true, justTripped: true }
  }
  return {
    consecutiveFaults: state.consecutiveFaults,
    tripped: state.trip !== null,
    justTripped: false,
  }
}

export function recordFusionSuccess(surface: RouterFusionSurface): void {
  const state = states.get(surface)
  if (state) state.consecutiveFaults = 0
}

export function isSurfaceTripped(surface: RouterFusionSurface): boolean {
  return states.get(surface)?.trip != null
}

/** Load trips persisted by a previous session. Never clears a live trip. */
export function hydrateBreakerTrips(
  trips: Partial<Record<RouterFusionSurface, SurfaceTripState>> | undefined
): void {
  if (!trips) return
  for (const [surface, trip] of Object.entries(trips) as Array<
    [RouterFusionSurface, SurfaceTripState | undefined]
  >) {
    if (!trip) continue
    const state = stateFor(surface)
    if (!state.trip) state.trip = { trippedAt: trip.trippedAt, reason: trip.reason }
  }
}

/** User action: close the breaker and give the surface a clean count. */
export function rearmSurface(surface: RouterFusionSurface): void {
  const state = stateFor(surface)
  const wasTripped = state.trip !== null
  state.trip = null
  state.consecutiveFaults = 0
  if (wasTripped) publish({ type: "rearmed", surface })
}

export function getBreakerSnapshot(surface: RouterFusionSurface): BreakerSnapshot {
  const state = stateFor(surface)
  return {
    surface,
    consecutiveFaults: state.consecutiveFaults,
    lastFault: state.lastFault ? { ...state.lastFault } : null,
    trip: state.trip ? { ...state.trip } : null,
  }
}

export function subscribeBreaker(listener: (event: BreakerEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function __resetBreakerForTesting(): void {
  states.clear()
  listeners.clear()
}
