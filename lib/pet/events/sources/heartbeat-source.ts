// Wall-clock heartbeat → pet events. Every other source (chat, terminal, goal,
// workflow, scheduler, …) is EDGE-triggered on subsystem activity, so a pet that
// is simply left alone never advances: needs decay is settled only when the
// controller processes an event, and the neglect → `unwell` → care-notify
// transition only fires inside that processing. Without a self-tick, a user who
// walks away never trips the care alert no matter how far the needs decay.
//
// This source emits a low-frequency `idle` tick so the loop closes on elapsed
// time alone. The controller's `idle` handling settles decay to `now` (see
// `lib/pet/runtime/apply-event.ts`), re-derives the care condition, and persists
// it — exactly as if a real subsystem had nudged the pet. The first tick fires
// immediately on wiring so decay accrued while the app was closed is settled at
// launch (and an already-unwell pet surfaces without waiting a full interval).

import type { PetEmit } from "../pet-event-bus"

/**
 * Default cadence: every 15 minutes. Long enough that the periodic
 * read-modify-write of the singleton profile is negligible, short enough that an
 * `unwell` pet surfaces (and the gentle care notify fires) within a quarter-hour
 * of the needs crossing the sustain threshold.
 */
export const HEARTBEAT_INTERVAL_MS = 15 * 60_000

export interface HeartbeatDeps {
  /** Override the tick cadence (tests). */
  intervalMs?: number
  /** Injectable timer (tests) — defaults to the global `setInterval`. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Injectable clear (tests) — defaults to the global `clearInterval`. */
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
}

/** Build a heartbeat source wire with injectable cadence + timer (for tests). */
export function createHeartbeatSource(deps: HeartbeatDeps = {}): (emit: PetEmit) => () => void {
  const intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clearIv = deps.clearInterval ?? ((h) => clearInterval(h))
  return (emit) => {
    const tick = () => emit({ source: "system", kind: "idle" })
    // Settle decay accrued while the app was closed straight away.
    tick()
    const handle = setIv(tick, intervalMs)
    return () => clearIv(handle)
  }
}

/** Default wire used by `DEFAULT_PET_SOURCES`. */
export const wireHeartbeatSource = createHeartbeatSource()
