/**
 * Skill Registry — dynamic overlay for plugin-contributed agent skills.
 *
 * Plugins shipping the `skills` capability call `registerSkill` on enable;
 * the plugin manager calls `unregisterSkillsByPlugin(pluginId)` on disable
 * to drop every skill the plugin contributed in a single shot.
 *
 * Per-plugin cleanup: `unregisterSkillsByPlugin(pluginId)`.
 */

import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { createOverlayRegistry } from "./createOverlayRegistry"
import { reportRegistryConflict } from "@/lib/plugin/contracts/conflict-reporter"

const registry = createOverlayRegistry<PluginSkillDef>({
  name: "skill",
  // W4.2: without a conflict policy the default last-wins let plugin B hijack
  // plugin A's skill id (and unregistering B then dropped A's entry). Mirror
  // the pet registries: the incumbent plugin wins, the rejection is reported.
  conflictPolicy: "first-wins-cross-plugin",
  onConflict: (info) => {
    reportRegistryConflict({
      pluginId: info.incomingPluginId ?? "unknown",
      attemptedId: info.key,
      registry: "skill",
      winnerPluginId: info.existingPluginId,
    })
  },
})

/** Register a plugin-contributed skill. */
export const registerSkill = registry.register
/** Drop a single dynamically-registered skill by id. */
export const unregisterSkillById = registry.unregisterById
/** Drop every skill contributed by `pluginId`. Returns the number removed. */
export const unregisterSkillsByPlugin = registry.unregisterByPlugin
/** Get a skill by id. Returns undefined when not registered. */
export const getSkill = registry.get
/** Get the full registry entry (skill + pluginId tag) for an id. */
export const getSkillEntry = registry.getEntry
/** List every registered skill id in registration order. */
export const listSkillIds = registry.list
/** List every registered entry (id + skill + pluginId) in registration order. */
export const listSkillEntries = registry.entries
/** Test-only: clear every dynamically registered skill. */
export const __resetSkillsForTesting = registry.__resetForTesting
