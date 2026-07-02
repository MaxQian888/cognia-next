/**
 * Pet Achievement Registry — dynamic overlay for plugin-contributed pet
 * achievements. Plugins with the `pet-achievement` capability declare a
 * `petAchievements` manifest array; the `OVERLAY_REGISTRY_CAPABILITIES`
 * dispatch loop registers each def on enable and drops them all via
 * `unregisterPetAchievementsByPlugin(pluginId)` on disable.
 *
 * Defs are DATA-ONLY (manifests round-trip through Dexie), so unlock logic
 * arrives as a small condition DSL that `compilePluginAchievement` interprets
 * into the host's `PetAchievement` predicate shape. Compiled ids are
 * namespaced `plugin:<pluginId>:<localId>` so they can never collide with the
 * static `PET_ACHIEVEMENTS` ids in Dexie unlock records.
 */

import type { PluginPetAchievementDef } from "@/types/plugin/plugin-pet"
import type { PetAchievement } from "@/types/pet"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginPetAchievementDef>({
  name: "pet-achievement",
  keyFn: (id, _entry, opts) => `${opts?.pluginId ?? ""}:${id}`,
  conflictPolicy: "first-wins-cross-plugin",
})

export const registerPetAchievement = registry.register
export const unregisterPetAchievementById = registry.unregisterById
export const unregisterPetAchievementsByPlugin = registry.unregisterByPlugin
export const listPetAchievementEntries = registry.entries
export const __resetPetAchievementsForTesting = registry.__resetForTesting

/** Build the namespaced runtime id for a plugin achievement. */
export function buildPluginAchievementId(pluginId: string | undefined, localId: string): string {
  return `plugin:${pluginId ?? ""}:${localId}`
}

/** Compile a data-only def into the host's predicate-bearing shape. */
export function compilePluginAchievement(
  def: PluginPetAchievementDef,
  pluginId: string | undefined
): PetAchievement {
  const condition = def.condition
  return {
    id: buildPluginAchievementId(pluginId, def.id),
    // Plugin achievements carry display labels, not host i18n keys; the
    // achievements tab resolves them via `labels`/`descriptions` directly.
    i18nKey: def.id,
    icon: def.icon ?? "Sparkles",
    isUnlocked: (ctx) => {
      switch (condition.type) {
        case "counter":
          return (ctx.counters[condition.kind] ?? 0) >= condition.gte
        case "level":
          return ctx.profile.level >= condition.gte
        case "need":
          return ctx.profile.needs[condition.need] >= condition.gte
        default:
          return false
      }
    },
  }
}

/** Every registered plugin achievement, compiled for the check loop. */
export function listCompiledPluginAchievements(): PetAchievement[] {
  return registry.entries().map(({ entry, pluginId }) => compilePluginAchievement(entry, pluginId))
}

/**
 * Display metadata for a compiled plugin achievement id, for the
 * achievements tab (which otherwise renders host i18n keys).
 */
export function getPluginAchievementDisplay(
  runtimeId: string
): { def: PluginPetAchievementDef; pluginId?: string } | undefined {
  if (!runtimeId.startsWith("plugin:")) return undefined
  const rest = runtimeId.slice("plugin:".length)
  const firstColon = rest.indexOf(":")
  if (firstColon < 0) return undefined
  const key = `${rest.slice(0, firstColon)}:${rest.slice(firstColon + 1)}`
  const entry = registry.getEntry(key)
  return entry ? { def: entry.entry, pluginId: entry.pluginId } : undefined
}
