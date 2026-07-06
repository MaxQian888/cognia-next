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

/** An effective chaos stat at/above this promotes the wander bucket one step
 *  livelier (calm→normal→lively) — a chaotic pet just won't sit still. */
export const CHAOS_LIVELY_THRESHOLD = 70

const LIVELIER: Record<PetWanderFrequency, PetWanderFrequency> = {
  calm: "normal",
  normal: "lively",
  lively: "lively",
}

/**
 * Resolve the effective tuning. Low-power mode doubles the rest intervals
 * (fewer wake-ups, same speed) and applies AFTER the chaos promotion. `chaos`
 * defaults to 0 so existing callers keep today's behavior.
 */
export function resolveWanderTuning(
  frequency: PetWanderFrequency,
  lowPower: boolean,
  chaos = 0
): WanderTuning {
  const effective = chaos >= CHAOS_LIVELY_THRESHOLD ? LIVELIER[frequency] : frequency
  const base = TUNING[effective]
  if (!lowPower) return base
  return { ...base, restMinMs: base.restMinMs * 2, restMaxMs: base.restMaxMs * 2 }
}
