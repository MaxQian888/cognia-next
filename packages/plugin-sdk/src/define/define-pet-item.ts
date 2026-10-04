/**
 * Plugin SDK helper for data-only pet shop item contributions.
 *
 * Checks the item with the same validator the host runs at manifest
 * validation and again at registration, so an author sees exactly the rule
 * that would otherwise drop the item when the plugin is enabled.
 */

import { assertValidPetItemDef } from "@/lib/plugin/registries/pet-contribution-validation"
import type { PluginPetItemDef } from "@/types/plugin/plugin-pet"

export function definePetItem(def: PluginPetItemDef): PluginPetItemDef {
  return assertValidPetItemDef(def, `definePetItem: item "${String(def?.id)}"`)
}
