// Achievements + 图鉴 (dex). Definitions are static (in code); unlock records are
// persisted rows. Unlock conditions are evaluated against the pet profile and the
// activity ledger. See `lib/pet/achievements/registry.ts` + `check.ts`.

import type { PetBones } from "./bones"
import type { PetProfile, PetActivityRow } from "./profile"

/** Stable achievement identifier. */
export type PetAchievementId = string

/** Snapshot passed to an unlock predicate. */
export interface PetAchievementContext {
  profile: PetProfile
  /** Recomputed appearance (for shiny/rarity achievements). */
  bones: PetBones
  /** Newest-first slice of the activity ledger (already capped by the caller). */
  activity: PetActivityRow[]
  /** Aggregate counters derived from the full ledger (e.g. fed: 50). */
  counters: Record<string, number>
}

/** Static achievement definition. */
export interface PetAchievement {
  id: PetAchievementId
  /** i18n key suffix under `pet.achievements.<i18nKey>`. */
  i18nKey: string
  /** Lucide icon name (resolved by the UI). */
  icon: string
  /** Predicate — returns true once the achievement is earned. Pure. */
  isUnlocked: (ctx: PetAchievementContext) => boolean
}

/** Persisted unlock record. */
export interface PetAchievementRecord {
  id: PetAchievementId
  /** Epoch ms. */
  unlockedAt: number
}
