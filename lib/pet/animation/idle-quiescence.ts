// Pure idle-quiescence policy for the SVG skin. The framer-motion loop runs at a
// constant 60fps whenever the pet is visible; once the pet has been sitting idle
// (no state change, no one-shot) for a while, there is nothing to animate, so we
// collapse to a still frame and stop the loop — zero rAF churn until something
// happens. Any state/one-shot/interaction change resumes motion immediately.

import type { PetOneShot, PetVisualState } from "@/types/pet"

/** Idle time before the breathing loop quiesces (ms). */
export const QUIESCE_MS = 12_000
/** Shorter dwell under low power (battery-friendly). */
export const QUIESCE_MS_LOW_POWER = 6_000

export function quiescenceDelay(lowPower: boolean): number {
  return lowPower ? QUIESCE_MS_LOW_POWER : QUIESCE_MS
}

/**
 * True when the pet has been in the plain idle state (no one-shot) for longer
 * than the quiescence delay — the renderer should hold a still frame.
 */
export function shouldQuiesce(
  state: PetVisualState,
  oneShot: PetOneShot | null,
  msSinceLastChange: number,
  opts: { lowPower: boolean }
): boolean {
  if (state !== "idle" || oneShot !== null) return false
  return msSinceLastChange > quiescenceDelay(opts.lowPower)
}
