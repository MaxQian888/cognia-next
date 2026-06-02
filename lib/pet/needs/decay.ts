// Pure needs math. Decay is applied lazily on read: given the last settled value
// and the elapsed wall-clock time, compute the current value. Interactions first
// settle decay to "now", then add their restore. Everything clamps to [0, 100].

import type { NeedDecayConfig, PetNeedKind, PetNeeds } from "@/types/pet"
import { DEFAULT_NEED_DECAY } from "@/lib/pet/defaults"

const HOUR_MS = 3_600_000

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** How much each interaction restores (or costs). */
export const INTERACTION_EFFECTS: Record<
  "fed" | "played" | "petted" | "talked",
  Partial<Record<PetNeedKind, number>>
> = {
  fed: { energy: 25, mood: 4 },
  played: { mood: 25, energy: -6, bond: 4 },
  petted: { bond: 8, mood: 6 },
  talked: { bond: 5, mood: 3 },
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

/** Settle decay to `now`, then apply an interaction's restore. */
export function applyInteraction(
  needs: PetNeeds,
  interaction: keyof typeof INTERACTION_EFFECTS,
  now: number,
  config: NeedDecayConfig = DEFAULT_NEED_DECAY
): PetNeeds {
  const settled = applyDecay(needs, now, config)
  const effect = INTERACTION_EFFECTS[interaction]
  return {
    energy: clamp(settled.energy + (effect.energy ?? 0)),
    mood: clamp(settled.mood + (effect.mood ?? 0)),
    bond: clamp(settled.bond + (effect.bond ?? 0)),
    lastTickAt: settled.lastTickAt,
  }
}
