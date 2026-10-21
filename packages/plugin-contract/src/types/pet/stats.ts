// Stat growth domain. The 5 flavour stats on `PetBones` are DETERMINISTIC from
// the account fingerprint (load-bearing RNG draw order — never mutate them).
// Growth earned by working alongside the pet accumulates separately in an
// additive `statProgress` on the profile; the effective value the UI shows is
// `clamp(base + progress, 0, 100)`. See `lib/pet/stats/*` and ADR pet system.

import type { PetStats } from "./bones"

/** The five growable stat dimensions (mirrors `PetStats` keys). */
export type PetStatKey = "debugging" | "patience" | "chaos" | "wisdom" | "snark"

/** Cumulative additive growth on top of the deterministic base stats (each ≥ 0). */
export type PetStatProgress = Record<PetStatKey, number>

/** Stable iteration order for the stat keys. */
export const STAT_KEYS: readonly PetStatKey[] = [
  "debugging",
  "patience",
  "chaos",
  "wisdom",
  "snark",
]

/** All-zero growth (a fresh pet has earned nothing yet). */
export const ZERO_STAT_PROGRESS: PetStatProgress = {
  debugging: 0,
  patience: 0,
  chaos: 0,
  wisdom: 0,
  snark: 0,
}

function clampStat(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

/** Base + growth, clamped — a non-finite growth value is treated as 0 (never
 *  poisons the base stat). */
function withGrowth(base: number, growth: number | undefined): number {
  return clampStat(base + (Number.isFinite(growth) ? (growth as number) : 0))
}

/** Effective stats shown to the user: base plus earned growth, clamped to [0, 100]. */
export function effectiveStats(base: PetStats, progress?: PetStatProgress): PetStats {
  return {
    debugging: withGrowth(base.debugging, progress?.debugging),
    patience: withGrowth(base.patience, progress?.patience),
    chaos: withGrowth(base.chaos, progress?.chaos),
    wisdom: withGrowth(base.wisdom, progress?.wisdom),
    snark: withGrowth(base.snark, progress?.snark),
  }
}

/** Fill missing keys with 0 and clamp negatives/non-finite to 0 (legacy rows). */
export function normalizeStatProgress(p?: Partial<PetStatProgress>): PetStatProgress {
  const one = (v: number | undefined) => (Number.isFinite(v) ? Math.max(0, v as number) : 0)
  return {
    debugging: one(p?.debugging),
    patience: one(p?.patience),
    chaos: one(p?.chaos),
    wisdom: one(p?.wisdom),
    snark: one(p?.snark),
  }
}
