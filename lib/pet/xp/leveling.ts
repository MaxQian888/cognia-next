// Pure XP → level → stage math. The curve is quadratic so each level costs a bit
// more than the last. Stages are unlocked by level bands (the egg stage is
// pre-hatch and handled by the caller via the soul, not here).

import type { PetStage } from "@/types/pet"

/** Total cumulative XP required to *reach* a given level (level 1 = 0). */
export function totalXpForLevel(level: number): number {
  const l = Math.max(1, Math.floor(level))
  return 50 * (l - 1) * l
}

/** The level a given XP total corresponds to (>= 1). */
export function levelForXp(xp: number): number {
  if (xp <= 0) return 1
  let level = 1
  while (totalXpForLevel(level + 1) <= xp) level++
  return level
}

/** Non-egg stage for a (hatched) level. */
export function stageForLevel(level: number): Exclude<PetStage, "egg"> {
  if (level >= 20) return "elder"
  if (level >= 10) return "adult"
  if (level >= 5) return "juvenile"
  return "baby"
}

export interface LevelProgress {
  level: number
  /** XP accumulated within the current level. */
  intoLevel: number
  /** XP needed to span the current level. */
  span: number
  /** 0–1 progress toward the next level. */
  fraction: number
}

export function levelProgress(xp: number): LevelProgress {
  const level = levelForXp(xp)
  const base = totalXpForLevel(level)
  const next = totalXpForLevel(level + 1)
  const span = next - base
  const intoLevel = xp - base
  return { level, intoLevel, span, fraction: span > 0 ? intoLevel / span : 0 }
}
