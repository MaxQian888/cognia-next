// Pure derivation of the persistent care condition from (lazily-decayed) needs.
// Today needs decay but nothing happens; this gives the decay a gentle, always-
// recoverable consequence: if energy OR mood stays low long enough, the pet
// becomes "unwell" (a persistent visual state, distinct from transient one-shots)
// until the user feeds/plays/pets it back above the recovery threshold. A
// hysteresis gap (enter at 25, clear at 45) prevents flapping. A rolling
// care-quality EMA tracks how well-kept the pet has been over its lifetime.

import type { PetCareState, PetCondition, PetNeeds } from "@/types/pet"
import { normalizeCareState } from "@/types/pet"

/** Energy/mood at or below this counts as "low". */
export const UNWELL_NEED_THRESHOLD = 25
/**
 * Upper bound of the "neutral" mood band. At/above this the pet reads as happy;
 * in `[UNWELL_NEED_THRESHOLD, NEUTRAL_MOOD_CEILING)` it's neutral. Centralised
 * here so the tray's coarse 3-band emoji (`lib/tray/status-section.ts`) can't
 * drift from the care thresholds it sits beside.
 */
export const NEUTRAL_MOOD_CEILING = 60
/** A need must stay low this long before the pet actually becomes unwell. */
export const UNWELL_SUSTAIN_MS = 6 * 3_600_000
/** Both energy and mood must rise to this to clear unwell (hysteresis). */
export const WELL_RECOVERY_THRESHOLD = 45
/** EMA weight on the prior care-quality value (0.9 = slow-moving). */
export const CARE_QUALITY_INERTIA = 0.9

export interface DeriveCareInput {
  needs: PetNeeds
  prev?: PetCareState
  now: number
}

export interface DeriveCareResult {
  care: PetCareState
  /** True exactly on the well → unwell transition (controller fires the notify). */
  becameUnwell: boolean
  /** True exactly on the unwell → well transition (controller may celebrate). */
  recovered: boolean
}

/** Derive the next care state. Pure + idempotent: calling twice with the prior
 *  result as `prev` yields the same condition with both flags false. */
export function deriveCareState(input: DeriveCareInput): DeriveCareResult {
  const prev = normalizeCareState(input.prev)
  const { needs, now } = input

  const low = needs.energy < UNWELL_NEED_THRESHOLD || needs.mood < UNWELL_NEED_THRESHOLD
  const recoveredNeeds =
    needs.energy >= WELL_RECOVERY_THRESHOLD && needs.mood >= WELL_RECOVERY_THRESHOLD

  // Rolling care quality: EMA of the average of the three needs.
  const target = (needs.energy + needs.mood + needs.bond) / 3
  const careQuality = Math.round(
    prev.careQuality * CARE_QUALITY_INERTIA + target * (1 - CARE_QUALITY_INERTIA)
  )

  let lowSince = prev.lowSince
  let condition: PetCondition = prev.condition
  let notifiedAt = prev.notifiedAt
  let everUnwell = prev.everUnwell
  let becameUnwell = false
  let recovered = false

  if (low) {
    if (lowSince == null) lowSince = now
    if (condition === "well" && now - lowSince >= UNWELL_SUSTAIN_MS) {
      condition = "unwell"
      becameUnwell = true
      everUnwell = true
    }
  } else if (recoveredNeeds) {
    // Fully recovered: reset the low timer and (if we were unwell) heal.
    lowSince = null
    if (condition === "unwell") {
      condition = "well"
      notifiedAt = null
      recovered = true
    }
  }
  // In the hysteresis band [25, 45): keep the current condition and the running
  // lowSince timer so brief upticks don't reset the slide into unwell.

  return {
    care: { lowSince, condition, notifiedAt, everUnwell, careQuality },
    becameUnwell,
    recovered,
  }
}
