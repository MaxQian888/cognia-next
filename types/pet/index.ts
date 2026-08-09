// Barrel for the pet subsystem types. Import from `@/types/pet`.

export type {
  PetSpecies,
  PetRarity,
  PetEyes,
  PetHat,
  PetBodyType,
  PetPalette,
  PetStats,
  PetBones,
  PetCosmeticOverride,
} from "./bones"
export type { PetSoul } from "./soul"
export type { PetNeedKind, PetNeeds, NeedDecayRate, NeedDecayConfig } from "./needs"
export type { PetStatKey, PetStatProgress } from "./stats"
export { STAT_KEYS, ZERO_STAT_PROGRESS, effectiveStats, normalizeStatProgress } from "./stats"
export type { PetCondition, PetCareState } from "./care"
export { DEFAULT_CARE_STATE, normalizeCareState } from "./care"
export type { PetStage, PetProfile, PetActivityRow, PetEvolutionFlavor } from "./profile"
export type { PetStreak, PetInventoryRow, PetItemCategory, PetShopItem } from "./economy"
export { DEFAULT_STREAK, normalizeStreak, normalizeCoins } from "./economy"
export type { PetVisualState, PetOneShot, PetMood } from "./visual-state"
export type { PetEventSource, PetEventKind, PetEvent } from "./events"
export type { PetConversationRow } from "./conversation"
export type { ProactiveState } from "./proactive"
export type { PetCharacterBinding } from "./binding"
export type {
  PetAchievementId,
  PetAchievementContext,
  PetAchievement,
  PetAchievementRecord,
} from "./achievements"
export type {
  PetSkin,
  PetSkinId,
  PetSkinSelection,
  PetSkinCapabilities,
  PetRenderMode,
  PetLookTarget,
  PetAssetDiagnostic,
  PetAssetDiagnosticCode,
  PetSkinRenderProps,
  PetFacing,
  PetLocomotion,
} from "./skin"
export type {
  PetAnchor,
  PetMotionPreference,
  PetSettings,
  PetDesktopOverlaySettings,
  PetWanderFrequency,
  PetWanderRange,
  PetWanderSettings,
  PetProactiveTier,
  PetProactiveSettings,
  PetSoundSettings,
  PetTwinAwarenessSettings,
} from "./settings"
export {
  DEFAULT_PET_SETTINGS,
  DEFAULT_PET_DESKTOP_OVERLAY,
  DEFAULT_PET_WANDER,
  DEFAULT_PET_PROACTIVE,
  DEFAULT_PET_SOUND,
  DEFAULT_PET_TWIN_AWARENESS,
} from "./settings"
export type {
  Live2dTransform,
  Live2dMotionOverride,
  Live2dMotionOverrides,
  Live2dParameterRole,
  Live2dParameterMapping,
} from "./live2d"
export { DEFAULT_LIVE2D_TRANSFORM } from "./live2d"
