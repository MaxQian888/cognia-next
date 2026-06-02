// Default factories for a freshly-created pet record. Pure — no I/O, no clock
// reads except the injectable `now`, so callers (store init, tests) stay
// deterministic.

import type { NeedDecayConfig, PetNeeds, PetProfile } from "@/types/pet"

/** Starting needs — full bars at birth. */
export function createDefaultNeeds(now = Date.now()): PetNeeds {
  return {
    energy: 100,
    mood: 100,
    bond: 0,
    lastTickAt: new Date(now).toISOString(),
  }
}

/**
 * A brand-new global profile in the `egg` stage. Bones are NOT stored here; they
 * are recomputed from the account id and merged at the read site. The soul is
 * null until the egg is hatched.
 */
export function createDefaultProfile(accountFingerprint: string, now = Date.now()): PetProfile {
  const iso = new Date(now).toISOString()
  return {
    id: "global",
    soul: null,
    xp: 0,
    level: 1,
    stage: "egg",
    needs: createDefaultNeeds(now),
    accountFingerprint,
    createdAt: iso,
    updatedAt: iso,
  }
}

/**
 * How fast each need decays. Energy drains fastest (the pet tires), bond decays
 * slowest (relationships are sticky). Tuned for a "check in a few times a day"
 * cadence rather than a punishing tamagotchi.
 */
export const DEFAULT_NEED_DECAY: NeedDecayConfig = {
  energy: { perHour: 4, floor: 0 },
  mood: { perHour: 2.5, floor: 0 },
  bond: { perHour: 0.5, floor: 0 },
}
