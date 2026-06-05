// The persisted pet record. A single global row (id = "global") backs the
// "global mascot"; per-character appearance overrides live separately in
// `PetCharacterBinding`. Bones are NOT stored here — they are recomputed from the
// account id and merged over the soul-derived view at load time.

import type { PetNeeds } from "./needs"
import type { ProactiveState } from "./proactive"
import type { PetSoul } from "./soul"

/** Growth stages, unlocked by level thresholds. Drives the evolution morph. */
export type PetStage = "egg" | "baby" | "juvenile" | "adult" | "elder"

export interface PetProfile {
  /** Singleton primary key. */
  id: "global"
  /** Null until the egg is hatched (Soul generated + persisted). */
  soul: PetSoul | null
  /** Cumulative experience points. */
  xp: number
  /** Derived from xp via the level curve; cached for cheap reads. */
  level: number
  /** Derived from level via stage thresholds; cached for the renderer. */
  stage: PetStage
  /** The nurture needs (with lazy-decay bookkeeping). */
  needs: PetNeeds
  /**
   * Which account identifier the current bones derive from. If the active
   * account changes, this drift is detected so we can re-hatch intentionally
   * rather than silently swap identities.
   */
  accountFingerprint: string
  /**
   * Proactive-speak counters (non-indexed; absent until the engine first
   * speaks). Advanced via `lib/pet/llm/proactive/scheduler-state.ts`.
   */
  proactiveState?: ProactiveState
  createdAt: string
  updatedAt: string
}

/** One row in the append-only activity ledger (XP + interaction history). */
export interface PetActivityRow {
  /** Auto-increment primary key. */
  id?: number
  /** The event kind that produced this entry. */
  kind: string
  /** Source subsystem (chat/goal/...) or "user" for direct interactions. */
  source: string
  /** XP awarded by this entry (0 if none). */
  xp: number
  /** Epoch ms. */
  ts: number
}
