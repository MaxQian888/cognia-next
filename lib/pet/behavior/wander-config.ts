// Numeric tuning behind the user-facing wander settings (VPet-style "smart
// move"). Pure tables — the locomotion FSM consumes the resolved tuning, so
// every bucket is unit-testable as data.

import type { PetWanderFrequency } from "@/types/pet"

/** Resolved wander pacing. Speeds are LOGICAL px/s — scale by the monitor's
 * scale factor before feeding the FSM (positions are physical px). */
export interface WanderTuning {
  /** Inclusive rest-interval bounds between walks, ms. */
  restMinMs: number
  restMaxMs: number
  /** Walk speed, logical px/s. */
  walkSpeedPxPerSec: number
}

/** Half-width of the target window around the current spot for range "near". */
export const NEAR_RANGE_PX = 240

/** "Only after interaction": a walk may start this long after the last one. */
export const INTERACTION_WINDOW_MS = 5 * 60_000

/** How long a gated rest pushes the next eligibility check forward. */
export const RECHECK_DELAY_MS = 5_000

const TUNING: Record<PetWanderFrequency, WanderTuning> = {
  calm: { restMinMs: 45_000, restMaxMs: 120_000, walkSpeedPxPerSec: 36 },
  normal: { restMinMs: 20_000, restMaxMs: 60_000, walkSpeedPxPerSec: 48 },
  lively: { restMinMs: 8_000, restMaxMs: 25_000, walkSpeedPxPerSec: 64 },
}

/** Low-power mode doubles the rest intervals (fewer wake-ups, same speed). */
export function resolveWanderTuning(
  frequency: PetWanderFrequency,
  lowPower: boolean
): WanderTuning {
  const base = TUNING[frequency]
  if (!lowPower) return base
  return { ...base, restMinMs: base.restMinMs * 2, restMaxMs: base.restMaxMs * 2 }
}
