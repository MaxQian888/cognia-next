/**
 * Plugin SDK helper for data-only pet achievement contributions.
 *
 * Pure authoring helper with lightweight validation for the manifest invariants
 * the host registry expects before compiling the condition DSL.
 */

import type { PluginPetAchievementDef } from "@/types/plugin/plugin-pet"

export function definePetAchievement(def: PluginPetAchievementDef): PluginPetAchievementDef {
  assertEnglishLabel(def.labels, `definePetAchievement: achievement "${def.id}"`)
  assertNonNegativeThreshold(def.condition.gte, `definePetAchievement: achievement "${def.id}"`)
  return def
}

function assertEnglishLabel(labels: Record<string, string>, context: string): void {
  if (typeof labels.en === "string" && labels.en.trim().length > 0) return
  throw new Error(`${context} must declare a non-empty English label at labels.en`)
}

function assertNonNegativeThreshold(value: number, context: string): void {
  if (Number.isFinite(value) && value >= 0) return
  throw new Error(`${context} condition.gte must be a finite non-negative number`)
}
