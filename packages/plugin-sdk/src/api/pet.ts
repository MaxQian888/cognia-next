/**
 * Plugin SDK — `pet` capability surface.
 *
 * Re-exports the data-only pet contribution helpers and the host overlay
 * registries for `manifest.petAchievements[]` and `manifest.petItems[]`.
 */

export { definePetAchievement } from "../define/define-pet-achievement"
export { definePetItem } from "../define/define-pet-item"

export {
  buildPluginAchievementId,
  compilePluginAchievement,
  getPluginAchievementDisplay,
  listCompiledPluginAchievements,
  listPetAchievementEntries,
  registerPetAchievement,
  unregisterPetAchievementById,
  unregisterPetAchievementsByPlugin,
} from "@/lib/plugin/registries/pet-achievement-registry"

export {
  buildPluginItemId,
  getPluginItemDisplay,
  getProjectedPluginItem,
  listPetItemEntries,
  listProjectedPluginItems,
  projectPluginItem,
  registerPetItem,
  unregisterPetItemById,
  unregisterPetItemsByPlugin,
} from "@/lib/plugin/registries/pet-item-registry"

export type {
  PluginPetAchievementCondition,
  PluginPetAchievementDef,
  PluginPetItemDef,
} from "@/types/plugin/plugin-pet"

export type {
  PluginPetAPI,
  PluginPetEvent,
  PluginPetInteractionKind,
  PluginPetSummary,
} from "@/lib/plugin/api/pet-api"
