/**
 * Plugin SDK helper for data-only pet achievement contributions.
 *
 * Checks the achievement with the same validator the host runs at manifest
 * validation and again at registration — including that a `counter`
 * condition names an event kind the activity ledger records, without which the
 * achievement could never unlock.
 */

import { assertValidPetAchievementDef } from "@/lib/plugin/registries/pet-contribution-validation"
import type { PluginPetAchievementDef } from "@/types/plugin/plugin-pet"

export function definePetAchievement(def: PluginPetAchievementDef): PluginPetAchievementDef {
  return assertValidPetAchievementDef(def, `definePetAchievement: achievement "${String(def?.id)}"`)
}
