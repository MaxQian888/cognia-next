// The PII-safe projection of the pet's public state.
//
// This is the shape every outside caller sees: plugins through `ctx.pet`, and
// the agent through its `pet_status` tool. The red line is what it leaves out.
// `accountFingerprint` seeds the deterministic appearance and is derived from
// the user's provider account id, raw `bones` describe the generated body, and
// `soul` carries more than the chosen name. None of the three crosses out of
// the host, so a projection is the only thing callers are ever handed.

import type { PetCondition, PetMood, PetNeeds, PetProfile, PetStage } from "@/types/pet"
import { computePetView } from "@/lib/pet/runtime/pet-view"

export interface PetSummary {
  hatched: boolean
  name: string | null
  level: number
  stage: PetStage
  xp: number
  mood: PetMood
  needs: Pick<PetNeeds, "energy" | "mood" | "bond">
  condition: PetCondition
  coins: number
}

/** Project a stored profile into the outside-facing summary. */
export function projectPetSummary(profile: PetProfile, now: number): PetSummary {
  const view = computePetView(profile, null, now)
  return {
    hatched: profile.soul !== null,
    name: profile.soul?.name ?? null,
    level: profile.level,
    stage: profile.stage,
    xp: profile.xp,
    mood: view.mood,
    needs: {
      energy: view.needs.energy,
      mood: view.needs.mood,
      bond: view.needs.bond,
    },
    condition: view.condition,
    coins:
      typeof profile.coins === "number" && Number.isFinite(profile.coins)
        ? Math.max(0, Math.floor(profile.coins))
        : 0,
  }
}
