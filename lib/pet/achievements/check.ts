// Pure achievement evaluation: given a context snapshot and the set already
// unlocked, return the ids that newly qualify. The caller persists these and may
// surface a toast / one-shot. Plugin-contributed achievements (compiled from
// their data-only condition DSL, ids namespaced `plugin:<pluginId>:<id>`) are
// evaluated alongside the static registry.

import type { PetAchievementContext, PetAchievementId } from "@/types/pet"
import { listCompiledPluginAchievements } from "@/lib/plugin/registries/pet-achievement-registry"
import { PET_ACHIEVEMENTS } from "./registry"

export function checkAchievements(
  ctx: PetAchievementContext,
  alreadyUnlocked: Iterable<PetAchievementId>
): PetAchievementId[] {
  const have = new Set(alreadyUnlocked)
  const newly: PetAchievementId[] = []
  for (const achievement of [...PET_ACHIEVEMENTS, ...listCompiledPluginAchievements()]) {
    if (have.has(achievement.id)) continue
    if (achievement.isUnlocked(ctx)) newly.push(achievement.id)
  }
  return newly
}
