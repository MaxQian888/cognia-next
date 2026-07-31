// Care-quality → evolution flavor mapping (pure). Consulted by `applyPetEvent`
// exactly at a stage transition — this is the resolved FUTURE hook from the
// original design ("careQuality could bias evolution flavor"). Cosmetic only.

import type { PetEvolutionFlavor } from "@/types/pet"

/** <40 plain · 40–75 normal · >75 radiant. Non-finite input reads as normal. */
export function flavorForCareQuality(careQuality: number): PetEvolutionFlavor {
  if (!Number.isFinite(careQuality)) return "normal"
  if (careQuality < 40) return "plain"
  if (careQuality > 75) return "radiant"
  return "normal"
}
