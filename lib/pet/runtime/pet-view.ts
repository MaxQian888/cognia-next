// Pure derivation of everything the UI needs from a stored profile (+ optional
// active-character binding) at a given time: recomputed bones, the binding-
// resolved render bones, the lazily-decayed needs, and the mood. Kept pure so the
// `usePet` hook is a thin wiring shell.

import type {
  PetBones,
  PetCharacterBinding,
  PetCondition,
  PetMood,
  PetNeeds,
  PetProfile,
  PetStats,
} from "@/types/pet"
import { effectiveStats } from "@/types/pet"
import { generateBones } from "@/lib/pet/bones/generate"
import { applyDecay } from "@/lib/pet/needs/decay"
import { deriveCareState } from "@/lib/pet/care/condition"
import { applyCosmeticOverlay, resolveEffectiveBones } from "@/lib/pet/binding/resolve-bones"
import { deriveMood } from "@/lib/pet/state/reducer"

export interface PetView {
  bones: PetBones
  effectiveBones: PetBones
  needs: PetNeeds
  mood: PetMood
  /** Base bones stats + earned growth (clamped) — what the stat card shows. */
  effectiveStats: PetStats
  /**
   * Care condition recomputed from the freshly-decayed needs, so an idle pet
   * can read as `unwell` purely from elapsed time (the controller persists the
   * authoritative transition + notify on the next event).
   */
  condition: PetCondition
}

export function computePetView(
  profile: PetProfile,
  binding: PetCharacterBinding | null | undefined,
  now: number
): PetView {
  const bones = generateBones(profile.accountFingerprint)
  const needs = applyDecay(profile.needs, now)
  const { care } = deriveCareState({ needs, prev: profile.care, now })
  return {
    bones,
    effectiveBones: applyCosmeticOverlay(resolveEffectiveBones(bones, binding), profile.cosmetic),
    needs,
    mood: deriveMood(needs),
    effectiveStats: effectiveStats(bones.stats, profile.statProgress),
    condition: care.condition,
  }
}
