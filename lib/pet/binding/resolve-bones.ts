// Resolve the bones to render when a bound Character is active. A binding may
// override the cosmetic fields (species/eyes/hat/bodyType/palette); the identity
// fields (rarity, stars, shiny, stats) always come from the global bones so the
// pet you "own" keeps its earned rarity even when wearing a persona's look.

import type { PetBones, PetCharacterBinding, PetCosmeticOverride } from "@/types/pet"

export function resolveEffectiveBones(
  globalBones: PetBones,
  binding: PetCharacterBinding | null | undefined
): PetBones {
  if (!binding) return globalBones
  return {
    ...globalBones,
    species: binding.species ?? globalBones.species,
    eyes: binding.eyes ?? globalBones.eyes,
    hat: binding.hat ?? globalBones.hat,
    bodyType: binding.bodyType ?? globalBones.bodyType,
    palette: binding.palette ?? globalBones.palette,
  }
}

/**
 * Overlay the user's cosmetic restyle on top of the (already binding-resolved)
 * bones. Only the non-identity visuals are touched; rarity/stars/shiny/stats/
 * species stay exactly as they were. Absent/empty override = bones unchanged.
 */
export function applyCosmeticOverlay(
  bones: PetBones,
  cosmetic: PetCosmeticOverride | null | undefined
): PetBones {
  if (!cosmetic) return bones
  return {
    ...bones,
    palette: cosmetic.palette ?? bones.palette,
    hat: cosmetic.hat ?? bones.hat,
    eyes: cosmetic.eyes ?? bones.eyes,
    bodyType: cosmetic.bodyType ?? bones.bodyType,
  }
}
