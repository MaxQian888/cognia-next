// Pure accumulation of stat growth onto the profile's `statProgress`. Progress is
// additive on top of the deterministic base stats and capped so `base + progress`
// can always reach (but not exceed) 100.

import type { PetStatKey, PetStatProgress } from "@/types/pet"
import { STAT_KEYS, normalizeStatProgress } from "@/types/pet"

/** Cap on a single stat's earned growth (base 0 + 100 progress = max 100). */
export const MAX_STAT_PROGRESS = 100

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_STAT_PROGRESS, value))
}

/** Add a growth delta onto existing progress, normalized + clamped per key. */
export function applyStatGrowth(
  progress: PetStatProgress | undefined,
  delta: PetStatProgress
): PetStatProgress {
  const cur = normalizeStatProgress(progress)
  const out = {} as PetStatProgress
  for (const k of STAT_KEYS) out[k] = clamp(cur[k] + (delta[k] ?? 0))
  return out
}

/** Keys whose progress strictly increased — drives the "grew" indicator. */
export function statsGrewKeys(before: PetStatProgress, after: PetStatProgress): PetStatKey[] {
  return STAT_KEYS.filter((k) => after[k] > before[k])
}
