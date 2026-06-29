// Storybook-only fixture builders for the core pet shapes (bones / soul / needs /
// profile / view). The pet types are deterministic value objects, so realistic
// literals are enough to drive every presentational pet component without pulling
// in the bones generator or the Dexie-backed `usePet` hook.
import type { PetBones, PetNeeds, PetProfile, PetSoul, PetStage } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"

/** A vivid, fully-specified appearance. Override any field for variant stories. */
export function makePetBones(over: Partial<PetBones> = {}): PetBones {
  return {
    species: "cat",
    rarity: "legendary",
    stars: 5,
    eyes: "star",
    hat: "crown",
    shiny: true,
    bodyType: "round",
    palette: { primary: "#6d5ae0", secondary: "#b6a8ff", accent: "#ffd24a" },
    stats: { debugging: 90, patience: 35, chaos: 60, wisdom: 72, snark: 48 },
    ...over,
  }
}

/** A hatched soul. Pass `null` at the call site for an unhatched pet. */
export function makePetSoul(over: Partial<PetSoul> = {}): PetSoul {
  return {
    name: "Boba",
    personality: "Smug, well-read, mildly chaotic.",
    hatchDate: new Date(Date.UTC(2026, 4, 1, 9, 0)).toISOString(),
    ...over,
  }
}

/** Healthy needs (high energy/mood/bond). */
export function makePetNeeds(over: Partial<PetNeeds> = {}): PetNeeds {
  return {
    energy: 82,
    mood: 74,
    bond: 61,
    lastTickAt: new Date(Date.UTC(2026, 5, 29, 8, 0)).toISOString(),
    ...over,
  }
}

/** A persisted, hatched profile. */
export function makePetProfile(over: Partial<PetProfile> = {}): PetProfile {
  return {
    id: "global",
    soul: makePetSoul(),
    xp: 1240,
    level: 7,
    stage: "adult",
    needs: makePetNeeds(),
    accountFingerprint: "story-account",
    createdAt: new Date(Date.UTC(2026, 4, 1, 9, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 5, 29, 8, 0)).toISOString(),
    ...over,
  }
}

/** The derived read model the interaction/nurture panels consume. */
export function makePetView(over: Partial<PetView> = {}): PetView {
  const bones = over.bones ?? makePetBones()
  const needs = over.needs ?? makePetNeeds()
  return {
    bones,
    effectiveBones: over.effectiveBones ?? bones,
    needs,
    mood: "happy",
    effectiveStats: over.effectiveStats ?? bones.stats,
    condition: "well",
    ...over,
  }
}

export const PET_STAGES: PetStage[] = ["egg", "baby", "juvenile", "adult", "elder"]
