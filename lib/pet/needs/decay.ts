// Pure needs math. Decay is applied lazily on read: given the last settled value
// and the elapsed wall-clock time, compute the current value. Interactions first
// settle decay to "now", then add their restore. Everything clamps to [0, 100].

import type { NeedDecayConfig, PetNeedKind, PetNeeds } from "@/types/pet"
import { DEFAULT_NEED_DECAY } from "@/lib/pet/defaults"

const HOUR_MS = 3_600_000

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** Direct interaction kinds (drive the restore table + interaction one-shots). */
export type PetInteractionKind =
  | "fed"
  | "played"
  | "petted"
  | "talked"
  | "slept"
  | "cleaned"
  | "treated"

/** How much each interaction restores (or costs). */
export const INTERACTION_EFFECTS: Record<
  PetInteractionKind,
  Partial<Record<PetNeedKind, number>>
> = {
  fed: { energy: 25, mood: 4 },
  played: { mood: 25, energy: -6, bond: 4 },
  petted: { bond: 8, mood: 6 },
  talked: { bond: 5, mood: 3 },
  // Rest deeply restores energy; a small mood lift from feeling rested.
  slept: { energy: 40, mood: 6 },
  // A wash perks up mood and a little bond.
  cleaned: { mood: 12, bond: 3 },
  // A treat is a bonding reward — costs a touch of energy (sugar rush/crash).
  treated: { mood: 8, bond: 6, energy: -2 },
}

/** Apply time-based decay from `needs.lastTickAt` up to `now`. */
export function applyDecay(
  needs: PetNeeds,
  now: number,
  config: NeedDecayConfig = DEFAULT_NEED_DECAY
): PetNeeds {
  const elapsedHours = Math.max(0, (now - new Date(needs.lastTickAt).getTime()) / HOUR_MS)
  const decayed = (kind: PetNeedKind) =>
    clamp(Math.max(config[kind].floor, needs[kind] - config[kind].perHour * elapsedHours))
  return {
    energy: decayed("energy"),
    mood: decayed("mood"),
    bond: decayed("bond"),
    lastTickAt: new Date(now).toISOString(),
  }
}

/** Settle decay to `now`, then add an arbitrary needs effect (item consumption). */
export function applyNeedEffect(
  needs: PetNeeds,
  effect: Partial<Record<PetNeedKind, number>>,
  now: number,
  config: NeedDecayConfig = DEFAULT_NEED_DECAY
): PetNeeds {
  const settled = applyDecay(needs, now, config)
  return {
    energy: clamp(settled.energy + (effect.energy ?? 0)),
    mood: clamp(settled.mood + (effect.mood ?? 0)),
    bond: clamp(settled.bond + (effect.bond ?? 0)),
    lastTickAt: settled.lastTickAt,
  }
}

/** Settle decay to `now`, then apply an interaction's restore. */
export function applyInteraction(
  needs: PetNeeds,
  interaction: keyof typeof INTERACTION_EFFECTS,
  now: number,
  config: NeedDecayConfig = DEFAULT_NEED_DECAY
): PetNeeds {
  return applyNeedEffect(needs, INTERACTION_EFFECTS[interaction], now, config)
}
