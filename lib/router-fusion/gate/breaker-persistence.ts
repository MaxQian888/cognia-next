/**
 * Keeps the Router + Fusion breaker's trips across restarts (ADR-0188 D38).
 *
 * The breaker itself lives in memory so the send path reads it synchronously.
 * A trip is also written into `AppSettings.routerFusion.trippedSurfaces`, so a
 * surface that kept failing stays on the original path after a restart until
 * the user re-arms it, and re-arming clears both.
 *
 * Gate-level: loaded at boot on the off path too. It only subscribes to the
 * in-memory breaker; nothing is written unless a trip or a re-arm happens, and
 * neither can happen while every switch is off.
 */

import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

import {
  hydrateBreakerTrips,
  rearmSurface,
  subscribeBreaker,
  type SurfaceTripState,
} from "./breaker"

export type PersistedTrips = Partial<Record<RouterFusionSurface, SurfaceTripState>>

export interface BreakerPersistenceDeps {
  /** The trips the settings hold right now. */
  readTrips: () => PersistedTrips | null | undefined
  /** Replace the persisted trips with exactly these. */
  writeTrips: (trips: PersistedTrips) => Promise<void>
  /** A surface just tripped: tell the user it runs the original path now. */
  notifyTripped: (surface: RouterFusionSurface, trip: SurfaceTripState) => void
}

function withoutSurface(trips: PersistedTrips, surface: RouterFusionSurface): PersistedTrips {
  const next = { ...trips }
  delete next[surface]
  return next
}

/**
 * Hydrate persisted trips and start mirroring new ones. Returns the
 * unsubscribe. Writes are serialized so two trips in a row cannot lose one.
 */
export function startBreakerPersistence(deps: BreakerPersistenceDeps): () => void {
  hydrateBreakerTrips(deps.readTrips() ?? undefined)
  let writes: Promise<void> = Promise.resolve()
  const enqueue = (change: (trips: PersistedTrips) => PersistedTrips) => {
    writes = writes
      .then(() => deps.writeTrips(change({ ...(deps.readTrips() ?? {}) })))
      .catch((error) => console.error("[router-fusion] could not persist the breaker state", error))
  }
  return subscribeBreaker((event) => {
    if (event.type === "tripped") {
      enqueue((trips) => ({ ...trips, [event.surface]: { ...event.trip } }))
      deps.notifyTripped(event.surface, event.trip)
    } else if (event.type === "rearmed") {
      enqueue((trips) => withoutSurface(trips, event.surface))
    }
  })
}

/**
 * The user re-arms a surface: close the in-memory breaker and clear the
 * persisted trip, even one hydrated from an earlier session that this window
 * never tripped itself.
 */
export async function rearmRouterFusionSurface(
  surface: RouterFusionSurface,
  deps: Pick<BreakerPersistenceDeps, "readTrips" | "writeTrips">
): Promise<void> {
  rearmSurface(surface)
  const trips = deps.readTrips() ?? {}
  if (trips[surface]) await deps.writeTrips(withoutSurface({ ...trips }, surface))
}
