// Pure derivation of everything the UI needs from a stored profile (+ optional
// active-character binding) at a given time: recomputed bones, the binding-
// resolved render bones, the lazily-decayed needs, and the mood. Kept pure so the
// `usePet` hook is a thin wiring shell.

import type { PetBones, PetCharacterBinding, PetMood, PetNeeds, PetProfile } from "@/types/pet"
import { generateBones } from "@/lib/pet/bones/generate"
import { applyDecay } from "@/lib/pet/needs/decay"
import { resolveEffectiveBones } from "@/lib/pet/binding/resolve-bones"
import { deriveMood } from "@/lib/pet/state/reducer"

export interface PetView {
  bones: PetBones
  effectiveBones: PetBones
  needs: PetNeeds
  mood: PetMood
}

export function computePetView(
  profile: PetProfile,
  binding: PetCharacterBinding | null | undefined,
  now: number
): PetView {
  const bones = generateBones(profile.accountFingerprint)
  const needs = applyDecay(profile.needs, now)
  return {
    bones,
    effectiveBones: resolveEffectiveBones(bones, binding),
    needs,
    mood: deriveMood(needs),
  }
}
