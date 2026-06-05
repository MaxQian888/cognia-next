// Ordered key lists for the motion-mapping editor — the single source the UI
// and tests iterate so the 11 states + 6 one-shots can't drift apart from the
// `PetVisualState` / `PetOneShot` unions (the type annotations make any
// mismatch a compile error).

import type { PetOneShot, PetVisualState } from "@/types/pet"

export const STATE_KEYS: readonly PetVisualState[] = [
  "idle",
  "thinking",
  "waiting",
  "review",
  "happy",
  "sad",
  "error",
  "sleeping",
  "greeting",
  "evolving",
  "interacting",
] as const

export const ONE_SHOT_KEYS: readonly PetOneShot[] = [
  "wave",
  "happy",
  "fed",
  "petted",
  "evolving",
  "levelUp",
  "sad",
  "surprised",
  "love",
  "sleepy",
] as const

/**
 * Override-table key for a state/one-shot. "happy" and "evolving" exist as
 * BOTH a resting state and a one-shot, so one-shots are namespaced.
 */
export function mappingKeyForState(state: PetVisualState): string {
  return state
}

export function mappingKeyForOneShot(shot: PetOneShot): string {
  return `shot:${shot}`
}

/** Resolve the override key for the currently-playing combination. */
export function overrideKeyFor(state: PetVisualState, oneShot: PetOneShot | null): string {
  return oneShot ? mappingKeyForOneShot(oneShot) : mappingKeyForState(state)
}

/** One editor row per mappable key, resting states first. */
export interface MappingRow {
  key: string
  kind: "state" | "oneShot"
  /** The raw state/one-shot id (for i18n label lookup). */
  id: string
}

export const ALL_MAPPING_ROWS: readonly MappingRow[] = [
  ...STATE_KEYS.map((s) => ({ key: mappingKeyForState(s), kind: "state" as const, id: s })),
  ...ONE_SHOT_KEYS.map((s) => ({ key: mappingKeyForOneShot(s), kind: "oneShot" as const, id: s })),
]
