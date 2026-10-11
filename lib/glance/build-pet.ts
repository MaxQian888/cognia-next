/**
 * Pet slice: mood and needs, decayed to now (ADR-0225 §2). Uses the same
 * `computePetView` the pet widget and the tray menu use, so all three agree.
 */

import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"

import type { GlancePetSlice } from "./snapshot"

export function buildPetSlice(
  enabled: boolean,
  profile: PetProfile | null | undefined,
  now: number
): GlancePetSlice {
  if (!enabled || !profile) {
    return {
      updatedAt: now,
      enabled: false,
      mood: null,
      condition: null,
      energy: 0,
      moodLevel: 0,
      bond: 0,
    }
  }
  const view = computePetView(profile, null, now)
  return {
    updatedAt: now,
    enabled: true,
    mood: view.mood,
    condition: view.condition,
    energy: Math.round(view.needs.energy),
    moodLevel: Math.round(view.needs.mood),
    bond: Math.round(view.needs.bond),
  }
}
