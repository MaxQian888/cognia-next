// Resolve the bones to render when a bound Character is active. A binding may
// override the cosmetic fields (species/eyes/hat/bodyType/palette); the identity
// fields (rarity, stars, shiny, stats) always come from the global bones so the
// pet you "own" keeps its earned rarity even when wearing a persona's look.

import type { PetBones, PetCharacterBinding } from "@/types/pet"

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
