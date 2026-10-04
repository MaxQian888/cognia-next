/**
 * Plugin SDK — `pet` capability surface (`@cognia/plugin-sdk/api/pet`).
 *
 * Everything an author needs around `ctx.pet`: the data-only contribution
 * helpers for `manifest.petItems[]` / `manifest.petAchievements[]`, the
 * vocabulary and limits the host enforces (so a reward can be typed and sized
 * to what will actually be granted), the errors a refused call throws (so they
 * can be told apart with `instanceof`), and the plugin-scoped teardown for the
 * contribution registries.
 *
 * The constants and errors come from the dependency-free contract module; the
 * ctx.pet implementation itself stays host-side.
 */

export { definePetAchievement } from "../define/define-pet-achievement"
export { definePetItem } from "../define/define-pet-item"

export {
  MAX_COINS_PER_EMIT,
  MAX_XP_PER_EMIT,
  PLUGIN_EMITTABLE_PET_EVENT_KINDS,
  PetCooldownError,
  PetEventKindNotAllowedError,
  PetItemKindMismatchError,
  PetItemNotOwnedError,
} from "@/lib/plugin/api/pet-api-contract"

export {
  buildPluginAchievementId,
  compilePluginAchievement,
  getPluginAchievementDisplay,
  listCompiledPluginAchievements,
  listPetAchievementEntries,
  unregisterPetAchievementsByPlugin,
} from "@/lib/plugin/registries/pet-achievement-registry"

export {
  buildPluginItemId,
  getPluginItemDisplay,
  getProjectedPluginItem,
  listPetItemEntries,
  listProjectedPluginItems,
  projectPluginItem,
  unregisterPetItemsByPlugin,
} from "@/lib/plugin/registries/pet-item-registry"

export type {
  PluginPetAchievementCondition,
  PluginPetAchievementDef,
  PluginPetItemDef,
} from "@/types/plugin/plugin-pet"

export type { PetEventKind, PetEventSource } from "@/types/pet"

export type {
  PluginEmittablePetEventKind,
  PluginPetAvailability,
  PluginPetEvent,
  PluginPetUnavailableReason,
} from "@/lib/plugin/api/pet-api-contract"

export type {
  PluginPetAPI,
  PluginPetInteractionKind,
  PluginPetSummary,
} from "@/lib/plugin/api/pet-api"
